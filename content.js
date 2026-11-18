// Epic claude usage tracker — session & weekly limits, always visible on claude.ai.
// Data: GET /api/organizations/{orgId}/usage — the same JSON that Settings → Usage renders.
// Click: refresh · double-click: compact · drag: move · top-right corner or pinch: resize
// (double-click the corner: default size). Position, size and mode are remembered.
(() => {
  'use strict';

  const HOST_ID = 'epic-claude-usage-tracker';
  const FONT = 'Epic Tracker Mono';
  const POLL_MS = 60_000; // background refresh while the tab is visible
  const REPLY_RX = /\/(retry_)?completion\b|StreamTimeline|PerformAction/; // requests that carry a Claude reply
  const MIN_SCALE = 0.5;
  const MAX_SCALE = 5;
  const DEFAULTS = { pos: { left: 12, bottom: 72 }, compact: false, scale: 1 };
  const NAMES = {
    five_hour: ['Session', '5h'],
    seven_day: ['Week', '7d'],
    seven_day_opus: ['Week · Opus', '7d Opus'],
    seven_day_sonnet: ['Week · Sonnet', '7d Sonnet'],
    seven_day_oauth_apps: ['Week · Apps', '7d Apps'],
    extra_usage: ['Extra usage', 'Extra'],
  };
  const ORDER = ['five_hour', 'seven_day'];

  const CSS = `
:host { all: initial; }
.tracker {
  position: relative; box-sizing: border-box; width: 280px; padding: 9px 11px 10px;
  font: 400 10px/1.4 "${FONT}", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  text-transform: lowercase; letter-spacing: 0; font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased; color: #E6E6E6;
  background: rgba(10, 10, 10, .9);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, .1); border-radius: 3px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .3);
  cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none;
  transition: opacity .2s;
}
.tracker.dragging { cursor: grabbing; }
.tracker.scaling { cursor: nesw-resize; }
.tracker.stale { opacity: .55; }
/* one grid for all rows: label | % | reset time */
.rows { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: baseline; }
.row, .top { display: contents; }
.label { min-width: 0; padding-right: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pct { text-align: right; }
.reset { padding-left: 24px; text-align: right; white-space: nowrap; }
.bar { grid-column: 1 / -1; height: 3px; margin: 5px 0 9px; background: rgba(255, 255, 255, .07); overflow: hidden; }
.row:last-child .bar { margin-bottom: 0; }
.fill { height: 100%; background: var(--f); transition: width .5s ease, background-color .3s; }
.ok { --f: #767676; }    /* grey */
.warn { --f: #BFA867; }  /* soft yellow, from 70% */
.hot { --f: #C0766C; }   /* soft red, from 90% */
.msg { grid-column: 1 / -1; }
/* resize corner: keeps the same on-screen size at any zoom */
.grip {
  position: absolute; top: 0; right: 0;
  width: calc(14px / var(--z, 1)); height: calc(14px / var(--z, 1));
  cursor: nesw-resize; opacity: 0; transition: opacity .15s;
}
.grip::before {
  content: ''; position: absolute;
  top: calc(3px / var(--z, 1)); right: calc(3px / var(--z, 1));
  width: calc(6px / var(--z, 1)); height: calc(6px / var(--z, 1));
  border-top: calc(1px / var(--z, 1)) solid #8A8A8A; border-right: calc(1px / var(--z, 1)) solid #8A8A8A;
}
.tracker:hover .grip, .tracker.scaling .grip { opacity: 1; }
.tracker.compact { width: auto; padding: 6px 10px; }
.tracker.compact .rows { display: flex; gap: 14px; }
.tracker.compact .row { display: flex; align-items: center; gap: 6px; }
.tracker.compact .top { display: flex; align-items: baseline; gap: 6px; }
.tracker.compact .label { padding-right: 0; }
.tracker.compact .bar { flex: none; width: 22px; margin: 0; }
.tracker.compact .reset { display: none; }
`;

  document.getElementById(HOST_ID)?.remove(); // leftover from a reloaded/updated extension

  // Bundled font (font.js) is registered from bytes: no network request, so the page CSP can't block it.
  try {
    if (self.__ECUT_FONT__) {
      const bytes = Uint8Array.from(atob(self.__ECUT_FONT__), (c) => c.charCodeAt(0));
      document.fonts.add(new FontFace(FONT, bytes.buffer, { weight: '400', style: 'normal' }));
    }
  } catch {}

  let state = structuredClone(DEFAULTS);
  let rows = [];
  let orgId = null;
  let lastError = null;
  let updatedAt = null;
  let inflight = null;
  let lastFetch = 0;

  /* ---------- UI ---------- */
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;';
  const shadow = host.attachShadow({ mode: 'open' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    shadow.append(el('style', '', CSS));
  }
  const box = el('div', 'tracker');
  const list = el('div', 'rows');
  const grip = el('div', 'grip');
  grip.title = 'Drag: resize · Double-click: default size';
  box.append(list, grip);
  shadow.append(box);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function render() {
    box.classList.toggle('compact', !!state.compact);
    box.classList.toggle('stale', !!lastError && rows.length > 0);
    list.replaceChildren();
    if (!rows.length) list.append(el('div', 'msg', lastError ? 'Usage: n/a' : 'Usage…'));
    for (const r of rows) {
      const pct = Math.round(r.pct);
      const row = el('div', `row ${pct >= 90 ? 'hot' : pct >= 70 ? 'warn' : 'ok'}`);
      const top = el('div', 'top');
      top.append(el('span', 'label', state.compact ? r.short : r.label), el('span', 'pct', `${pct}%`));
      const when = fmtReset(r.reset);
      if (when) top.append(el('span', 'reset', `→ ${when}`));
      const bar = el('div', 'bar');
      const fill = el('div', 'fill');
      fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
      bar.append(fill);
      row.append(top, bar);
      list.append(row);
    }
    box.title = tooltip();
    place();
  }

  function tooltip() {
    const lines = rows.map((r) => {
      const d = toDate(r.reset);
      return `${r.label}: ${Math.round(r.pct)}%${d ? ` — resets in ${fmtIn(d)} (${fmtDay(d)})` : ''}`;
    });
    if (lastError) lines.push(`⚠ ${lastError.message || lastError}`);
    if (updatedAt) lines.push(`Updated ${fmtTime(updatedAt)}`);
    lines.push('Click: refresh · Double-click: compact · Drag: move · Corner or pinch: resize');
    return lines.join('\n');
  }

  /* ---------- time ---------- */
  function toDate(v) {
    if (v == null || v === '') return null;
    const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function fmtTime(d) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/[  ]/g, ' ');
  }
  function fmtDay(d) {
    return `${d.toLocaleDateString([], { weekday: 'short' })} ${fmtTime(d)}`;
  }
  function fmtReset(v) {
    const d = toDate(v);
    if (!d) return '';
    const soon = d.toDateString() === new Date().toDateString() || d - Date.now() < 12 * 3600e3;
    return soon ? fmtTime(d) : fmtDay(d);
  }
  function fmtIn(d) {
    let m = Math.max(0, Math.round((d - Date.now()) / 60000));
    const days = Math.floor(m / 1440);
    m %= 1440;
    const h = Math.floor(m / 60);
    m %= 60;
    return days ? `${days}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }

  /* ---------- data ---------- */
  function cookie(name) {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function getJSON(path) {
    const res = await fetch(path, { credentials: 'include', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
    return res.json();
  }

  function names(key) {
    if (NAMES[key]) return NAMES[key];
    const nice = (s) => s.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    if (key.startsWith('seven_day_')) return [`Week · ${nice(key.slice(10))}`, `7d ${nice(key.slice(10))}`];
    if (key.startsWith('five_hour_')) return [`Session · ${nice(key.slice(10))}`, `5h ${nice(key.slice(10))}`];
    return [nice(key), nice(key)];
  }

  function parse(data) {
    const out = [];
    if (!data || typeof data !== 'object') return out;
    // Classic shape: { five_hour: {utilization, resets_at}, seven_day: {...}, seven_day_<model>: {...}, ... }
    for (const [key, v] of Object.entries(data)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      if (typeof v.utilization !== 'number' || !Number.isFinite(v.utilization)) continue;
      if (v.is_enabled === false) continue;
      const [label, short] = names(key);
      out.push({ key, label, short, pct: v.utilization, reset: v.resets_at ?? null });
    }
    // Fallback: the newer `limits` array (shape undocumented) — used only if the classic keys disappear.
    if (!out.length && Array.isArray(data.limits)) {
      data.limits.forEach((l, i) => {
        if (!l || typeof l !== 'object') return;
        let u = [l.utilization, l.percent_used, l.percentage, l.percent].find((x) => typeof x === 'number');
        if (u == null) return;
        if (u > 0 && u < 1) u *= 100;
        const key = String(l.key || l.id || l.type || l.window || `limit_${i + 1}`);
        const [label, short] = names(key);
        out.push({
          key,
          label: String(l.label || l.title || l.display_name || label),
          short,
          pct: u,
          reset: l.resets_at ?? l.reset_at ?? null,
        });
      });
    }
    const rank = (k) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);
    return out.sort((a, b) => rank(a.key) - rank(b.key));
  }

  async function loadUsage() {
    const tried = new Set();
    let err = null;
    const attempt = async (id) => {
      if (!id || tried.has(id)) return null;
      tried.add(id);
      try {
        const found = parse(await getJSON(`/api/organizations/${encodeURIComponent(id)}/usage`));
        if (found.length) {
          orgId = id;
          return found;
        }
        err = new Error('No limits in the response (Free plan?)');
      } catch (e) {
        err = e;
      }
      return null;
    };
    for (const id of [orgId, cookie('lastActiveOrg')]) {
      const found = await attempt(id);
      if (found) return found;
    }
    try {
      const orgs = await getJSON('/api/organizations');
      const all = Array.isArray(orgs) ? orgs : [];
      const chat = all.filter((o) => !Array.isArray(o?.capabilities) || o.capabilities.includes('chat'));
      for (const o of chat.length ? chat : all) {
        const found = await attempt(o?.uuid);
        if (found) return found;
      }
    } catch (e) {
      err = err || e;
    }
    throw err || new Error('Usage endpoint unavailable');
  }

  function refresh(force = false) {
    if (!alive()) return Promise.resolve();
    if (inflight) return inflight;
    if (!force && Date.now() - lastFetch < 5000) return Promise.resolve();
    lastFetch = Date.now();
    inflight = loadUsage()
      .then((found) => {
        rows = found;
        lastError = null;
        updatedAt = new Date();
      })
      .catch((e) => {
        lastError = e;
      })
      .finally(() => {
        inflight = null;
        render();
      });
    return inflight;
  }

  /* ---------- position, size, drag ---------- */
  function place() {
    const w = host.offsetWidth || 280 * state.scale;
    const h = host.offsetHeight || 60 * state.scale;
    const left = Math.min(Math.max(0, state.pos.left), Math.max(0, innerWidth - w));
    const bottom = Math.min(Math.max(0, state.pos.bottom), Math.max(0, innerHeight - h));
    host.style.left = `${left}px`;
    host.style.bottom = `${bottom}px`;
  }

  function setScale(s) {
    state.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(s) || 1));
    box.style.zoom = String(state.scale);
    box.style.setProperty('--z', String(state.scale));
    place();
  }

  function save() {
    try {
      chrome.storage.local.set({ tracker: state }).catch(() => {});
    } catch {}
  }

  let drag = null;
  let downOnGrip = false; // pointer capture retargets click/dblclick to the box, so remember where the press started
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    downOnGrip = e.target === grip;
    const r = host.getBoundingClientRect();
    drag = {
      mode: downOnGrip ? 'scale' : 'move',
      x: e.clientX,
      y: e.clientY,
      left: r.left,
      bottom: innerHeight - r.bottom,
      anchorX: r.left, // the bottom-left corner stays put while resizing
      anchorY: r.bottom,
      reach: Math.max(1, e.clientX - r.left + (r.bottom - e.clientY)),
      scale: state.scale,
      moved: false,
    };
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    if (drag.mode === 'scale') {
      box.classList.add('scaling');
      const reach = e.clientX - drag.anchorX + (drag.anchorY - e.clientY);
      setScale((drag.scale * Math.max(1, reach)) / drag.reach);
    } else {
      box.classList.add('dragging');
      state.pos = { left: drag.left + dx, bottom: drag.bottom - dy };
      place();
    }
  });
  box.addEventListener('pointerup', () => {
    if (!drag) return;
    const { mode, moved } = drag;
    drag = null;
    box.classList.remove('dragging', 'scaling');
    if (!moved) {
      if (mode === 'move') refresh(true);
      return;
    }
    if (mode === 'move') {
      state.pos = { left: parseFloat(host.style.left) || 0, bottom: parseFloat(host.style.bottom) || 0 };
    }
    save();
  });
  box.addEventListener('pointercancel', () => {
    drag = null;
    box.classList.remove('dragging', 'scaling');
  });
  box.addEventListener('dblclick', () => {
    if (downOnGrip) {
      setScale(1);
    } else {
      state.compact = !state.compact;
      render();
    }
    save();
  });
  // Pinch on a trackpad arrives as ctrl+wheel; ⌥/Alt + wheel works with a mouse.
  let wheelSave = 0;
  box.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.altKey) return;
      e.preventDefault();
      setScale(state.scale * Math.exp(Math.max(-0.1, Math.min(0.1, -e.deltaY * 0.01))));
      clearTimeout(wheelSave);
      wheelSave = setTimeout(save, 300);
    },
    { passive: false },
  );

  /* ---------- lifecycle ---------- */
  function alive() {
    try {
      return !!chrome.runtime?.id; // false after the extension is reloaded/removed
    } catch {
      return false;
    }
  }

  // Hide while a dropdown menu is open (e.g. the account menu that pops up over the nickname).
  let menuCheck = 0;
  const mo = new MutationObserver(() => {
    if (menuCheck) return;
    menuCheck = requestAnimationFrame(() => {
      menuCheck = 0;
      const open = [...document.querySelectorAll('[role="menu"]')].some((m) => m.getClientRects().length);
      host.style.visibility = open ? 'hidden' : '';
    });
  });

  // Refresh ~1.5 s after a Claude reply finishes streaming.
  let po = null;
  try {
    let t = 0;
    po = new PerformanceObserver((entries) => {
      if (entries.getEntries().some((e) => REPLY_RX.test(e.name) && !e.name.includes('/usage'))) {
        clearTimeout(t);
        t = setTimeout(() => refresh(true), 1500);
      }
    });
    po.observe({ type: 'resource' });
  } catch {}

  const timers = [
    setInterval(() => {
      if (!alive()) return teardown();
      if (!host.isConnected) (document.body || document.documentElement).append(host); // SPA re-render
    }, 2000),
    setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, POLL_MS),
  ];

  function teardown() {
    timers.forEach(clearInterval);
    mo.disconnect();
    po?.disconnect();
    host.remove();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  window.addEventListener('focus', () => refresh());
  window.addEventListener('resize', place);

  (async () => {
    try {
      const { tracker: saved } = await chrome.storage.local.get('tracker');
      if (saved && typeof saved === 'object') {
        state = { ...state, ...saved, pos: { ...state.pos, ...(saved.pos || {}) } };
      }
    } catch {}
    (document.body || document.documentElement).append(host);
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setScale(state.scale);
    render();
    refresh(true);
  })();
})();
