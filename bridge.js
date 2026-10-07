// Injected into the Termius primary renderer. Installs window.__kc.
// Every function returns WHITELISTED fields only: the Redux entities hold
// decrypted secrets (identity.password, private keys), so nothing is ever
// passed through wholesale.
(() => {

  const findStore = () => {
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find(k => k.startsWith('__reactContainer'));
    if (!key) return null;
    const seen = new WeakSet();
    let queue = [root[key]], depth = 0;
    while (queue.length && depth < 80) {
      const next = [];
      for (const f of queue) {
        if (!f || typeof f !== 'object' || seen.has(f)) continue;
        seen.add(f);
        const p = f.memoizedProps;
        try {
          if (p && p.store && typeof p.store.getState === 'function') return p.store;
          if (p && p.value && p.value.store && typeof p.value.store.getState === 'function') return p.value.store;
        } catch (e) {}
        if (f.child) next.push(f.child);
        if (f.sibling) next.push(f.sibling);
      }
      queue = next; depth++;
    }
    return null;
  };

  // Locate the terminalApi object (owns the xterm Terminal) behind one .xterm element.
  const apiFromElement = el => {
    const seeds = [];
    let node = el;
    for (let up = 0; node && up < 10; up++, node = node.parentElement)
      for (const k of Object.keys(node)) if (k.startsWith('__react')) seeds.push(node[k]);
    const seen = new WeakSet();
    let queue = seeds, depth = 0;
    while (queue.length && depth < 12) {
      const next = [];
      for (const obj of queue) {
        if (!obj || typeof obj !== 'object' || obj instanceof Node || seen.has(obj)) continue;
        seen.add(obj);
        try {
          if (obj.terminal && obj.terminal.buffer && typeof obj.terminal.cols === 'number' && obj.id) return obj;
        } catch (e) {}
        let keys; try { keys = Object.keys(obj); } catch (e) { continue; }
        if (keys.length > 300) continue;
        for (const k of keys) {
          let v; try { v = obj[k]; } catch (e) { continue; }
          if (v && typeof v === 'object') next.push(v);
        }
      }
      queue = next; depth++;
    }
    return null;
  };

  // Termius' mediator pool holds one mediator per live terminal, keyed by session
  // id, whether or not its tab is mounted in the DOM. It is passed down as
  // props.singletons.mediatorPool a few fiber levels below the root.
  let pool = null;
  const findPool = () => {
    if (pool && pool.mediatorMap instanceof Map) return pool;
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find(k => k.startsWith('__reactContainer'));
    if (!key) return null;
    const queue = [root[key]];
    for (let visited = 0; queue.length && visited < 20000; visited++) {
      const f = queue.shift();
      if (!f) continue;
      try {
        const mp = f.memoizedProps && f.memoizedProps.singletons
          && f.memoizedProps.singletons.mediatorPool;
        if (mp && mp.mediatorMap instanceof Map) return (pool = mp);
      } catch (e) {}
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
    }
    return null;
  };

  const usable = a => !!(a && a.terminal && a.terminal.buffer && typeof a.terminal.cols === 'number');

  const apiFromPool = id => {
    const p = findPool();
    if (!p) return null;
    let m = null;
    try { m = p.mediatorMap.get(id) || null; } catch (e) {}
    const a = m && m.terminalApi;
    return usable(a) && a.id === id ? a : null;
  };

  // Pool first (covers tabs that are not mounted); DOM scan as the fallback for
  // a Termius build where the pool is not where we expect it.
  const apis = new Map();
  const api = id => {
    const fromPool = apiFromPool(id);
    if (fromPool) return fromPool;
    const cached = apis.get(id);
    if (cached && cached.terminal && document.contains(cached.terminal.element)) return cached;
    for (const el of document.querySelectorAll('.xterm')) {
      const a = apiFromElement(el);
      if (a) apis.set(a.id, a);
    }
    return apis.get(id) || null;
  };

  let store = null;
  const state = () => {
    if (!store) store = findStore();
    if (!store) throw new Error('Termius state store not found');
    return store.getState();
  };

  // Join soft-wrapped rows back into one line. A row that continues on the next
  // keeps its trailing spaces (they are real text), except the single blank cell
  // xterm leaves when a double-width char did not fit at the end of the row.
  const logical = (b, start, end) => {
    const out = [];
    for (let i = start; i < end; i++) {
      const ln = b.getLine(i);
      if (!ln) { out.push(''); continue; }
      const next = i + 1 < end ? b.getLine(i + 1) : null;
      const cont = !!(next && next.isWrapped);
      let txt = ln.translateToString(!cont);
      const last = cont && ln.length ? ln.getCell(ln.length - 1) : null;
      // width 1 + no chars = the skipped cell; width 0 is the right half of a wide char.
      if (last && last.getWidth() === 1 && last.getChars() === ''
          && next.getCell(0) && next.getCell(0).getWidth() === 2) txt = txt.slice(0, -1);
      if (ln.isWrapped && out.length) out[out.length - 1] += txt;
      else out.push(txt);
    }
    return out;
  };

  const identityOf = cfg => (cfg && cfg.identity) || null;

  window.__kc = {
    version: 1,

    hosts() {
      return state().entities.hosts.map(h => {
        const cfg = h.ssh_config || {};
        const ident = identityOf(cfg);
        return {
          label: h.label || null,
          address: h.address || null,
          port: cfg.port || null,
          group: h.group ? h.group.label : null,
          username: ident ? ident.username || null : null,
          identity: ident ? ident.label || null : null,
          auth: ident ? (ident.ssh_key ? 'key' : ident.password ? 'password' : 'none') : 'none',
          jump_hosts: (h.connectionPath || []).length > 1 ? (h.connectionPath.length - 1) : 0,
          os: h.os_name || null,
        };
      });
    },

    keychain() {
      const e = state().entities;
      const label = o => (o && o.label) || null;
      return {
        identities: (e.visibleIdentities || []).map(i => ({
          label: i.label || null,
          username: i.username || null,
          has_password: !!i.password,
          ssh_key: label(i.ssh_key),
        })),
        ssh_keys: (e.sshKeys || []).map(k => ({ label: label(k) })),
        hardware_keys: (e.hardwareKeys || []).map(k => ({ label: label(k) })),
        known_hosts: (e.knownHosts || []).map(k => ({
          hostnames: k.hostnames || null,
          key_type: k.key ? String(k.key).split(' ')[0] : null,
        })),
      };
    },

    sessions() {
      const t = state().terminal;
      return Object.values(t.all || {}).map(s => ({
        id: s.id,
        title: s.title || null,
        // Local tabs have no saved host; their tab title is the only name.
        name: (s.host && s.host.label) || s.title || s.id.slice(0, 8),
        protocol: s.connectionProtocol || null,
        host: s.host ? s.host.label || null : null,
        address: s.host ? s.host.address || null : null,
        connected: !!s.connectionEstablished,
        active: !!s.isActive,
        // reachable = we hold its xterm (pool or DOM); mounted = its tab is in the DOM now.
        rendered: !!api(s.id),
        via: apiFromPool(s.id) ? 'pool' : (api(s.id) ? 'dom' : null),
        mounted: (() => { const a = api(s.id); return !!(a && a.terminal.element
          && document.contains(a.terminal.element)); })(),
      }));
    },

    // Logical lines (soft-wrapped rows joined) from absolute row `from`
    // (default: top of the visible screen) to the end. `prompt_row` / `prompt_line`
    // are the logical line holding the cursor.
    read(id, from) {
      const a = api(id);
      if (!a) throw new Error('terminal not found in Termius (neither mediator pool nor DOM) — switch to its tab once');
      const b = a.terminal.buffer.active;
      let start = from == null ? b.baseY : Math.max(0, from);
      while (start > 0 && b.getLine(start) && b.getLine(start).isWrapped) start--;
      let pr = b.baseY + b.cursorY;
      while (pr > 0 && b.getLine(pr) && b.getLine(pr).isWrapped) pr--;
      // Text on the cursor row up to the cursor. A real shell prompt leaves the cursor
      // just after "<symbol> "; a program's progress line ("45%") does not.
      const curRow = b.getLine(b.baseY + b.cursorY);
      return {
        lines: logical(b, start, b.length),
        prompt_row: pr,
        prompt_line: logical(b, pr, b.length)[0] || '',
        cursor_row: b.baseY + b.cursorY,
        cursor_x: b.cursorX,
        before_cursor: curRow ? curRow.translateToString(false, 0, b.cursorX) : '',
        cols: a.terminal.cols,
      };
    },

    scrollback(id) {
      const a = api(id);
      if (!a) throw new Error('terminal not found in Termius (neither mediator pool nor DOM) — switch to its tab once');
      const b = a.terminal.buffer.active;
      return { lines: logical(b, 0, b.length) };
    },

    input(id, data) {
      const a = api(id);
      if (!a) throw new Error('terminal not found in Termius (neither mediator pool nor DOM) — switch to its tab once');
      a.terminal.input(data);
      return true;
    },
  };
  return true;
})()
