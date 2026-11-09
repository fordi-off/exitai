/* ExitAI UI — vanilla JS, no dependencies. Contract: docs/API.md */
(function () {
'use strict';

/* ------------------------------------------------------------------ utils */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  del(k) { try { localStorage.removeItem(k); } catch (_) {} }
};
const fmtNum = n => (n == null || isNaN(n)) ? '0' : Math.round(n).toLocaleString('en-US');
const fmtMs = ms => ms == null ? '' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
const oneLine = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > (n || 200) ? s.slice(0, n || 200) + '…' : s; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function relTime(ms) {
  if (!ms) return '';
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  const d = Math.floor(h / 24);
  return d < 7 ? d + 'd' : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function groupOf(ms) {
  const n = new Date(), sod = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (!ms || ms >= sod) return 'Today';
  if (ms >= sod - 864e5) return 'Yesterday';
  if (ms >= sod - 6 * 864e5) return 'Previous 7 days';
  return 'Older';
}

/* ------------------------------------------------------------------ icons */
const IC = {
  logo: '<path d="M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4M14 8l4 4-4 4M18 12H9"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevD: '<path d="M6 9l6 6 6-6"/>',
  chevR: '<path d="M9 6l6 6-6 6"/>',
  arrowDown: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>',
  terminal: '<path d="M4 6l6 6-6 6M12 18h8"/>',
  file: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  tool: '<path d="M15 6a4 4 0 00-5 5L4 17l3 3 6-6a4 4 0 005-5l-3 3-2-2 3-3z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  clip: '<path d="M20 11l-8.5 8.5a5 5 0 01-7-7L13 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L14 7"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  alert: '<path d="M12 4l9 16H3L12 4zM12 10v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 6.1A9.6 9.6 0 0112 6c6.5 0 10 6 10 6a16 16 0 01-3.2 3.9M6.5 6.9C3.8 8.6 2 12 2 12s3.5 6 10 6c1.5 0 2.8-.3 4-.8M9.9 9.9a3 3 0 004.2 4.2"/>',
  up: '<path d="M12 19V6M6 11l6-6 6 6"/>',
  chevL: '<path d="M15 6l-6 6 6 6"/>',
  drive: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M3 13l3-8h12l3 8M7 16.5h.01"/>',
  filePlus: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"/><path d="M14 3v5h5M12 12v6M9 15h6"/>',
  folderPlus: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/><path d="M12 10.5v5M9.5 13h5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 16l5-5 4 4 3-3 5 5M9 9h.01"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  clipDoc: '<path d="M13 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2v-4"/><path d="M17 3v6a2 2 0 004 0V5"/><path d="M9 13h4M9 17h4"/>',
  reveal: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4"/>',
  circleCheck:'<circle cx="12" cy="12" r="8"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
};
function icon(name, size) {
  size = size || 16;
  return '<svg class="i" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (IC[name] || '') + '</svg>';
}
$$('[data-i]').forEach(n => { n.innerHTML = icon(n.dataset.i, +n.dataset.s || 16); });

/* ------------------------------------------------------------------ toasts */
let lastToast = { m: '', t: 0 };
function toast(msg, kind, ms) {
  const now = Date.now();
  if (lastToast.m === msg && now - lastToast.t < 1500) return;
  lastToast = { m: msg, t: now };
  const t = el('div', 'toast ' + (kind || 'error'));
  t.setAttribute('role', kind === 'info' ? 'status' : 'alert');
  t.innerHTML = icon(kind === 'info' ? 'info' : 'alert', 15) + '<span></span>';
  t.lastChild.textContent = msg;
  $('#toasts').appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 250); }, ms || 4500);
}

/* ------------------------------------------------------------------ auth + api */
let TOKEN = '';
(function () {
  const m = /[#&]t=([^&]+)/.exec(location.hash);
  if (m) {
    try { TOKEN = decodeURIComponent(m[1]); } catch (_) { TOKEN = m[1]; }
    LS.set('exitai_token', TOKEN);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {}
  } else TOKEN = LS.get('exitai_token') || '';
})();

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
let isDown = false, is401 = false, retryTimer = 0;

async function api(path, opts) {
  opts = opts || {};
  const o = { method: opts.method || 'GET', headers: { 'x-exitai-token': TOKEN } };
  if (opts.body !== undefined) {
    o.method = opts.method || 'POST';
    o.headers['content-type'] = 'application/json';
    o.body = JSON.stringify(opts.body);
  }
  let r;
  try { r = await fetch(path, o); }
  catch (_) { setDown(); throw new ApiError(0, 'Server unreachable'); }
  if (r.status === 401) { show401(); throw new ApiError(401, 'Unauthorized'); }
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (_) {}
  if (!r.ok) throw new ApiError(r.status, (data && (data.error || data.message)) || ('HTTP ' + r.status));
  return data;
}

function show401() {
  if (is401) return;
  is401 = true;
  $('#screen401').hidden = false;
  if (es) { es.close(); es = null; }
}
function setDown() {
  if (isDown || is401) return;
  isDown = true;
  $('#screenDown').hidden = false;
  scheduleRetry(1500);
}
function scheduleRetry(ms) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/state', { headers: { 'x-exitai-token': TOKEN } });
      if (r.status === 401) { isDown = false; $('#screenDown').hidden = true; show401(); return; }
      if (r.ok) { isDown = false; $('#screenDown').hidden = true; boot(); return; }
    } catch (_) {}
    scheduleRetry(2000);
  }, ms);
}
$('#btnRetry').addEventListener('click', () => scheduleRetry(0));

/* ------------------------------------------------------------------ state */
const S = { models: [], settings: {}, sessions: [], gpu: null, ollama: null, pull: { active: false } };
const V = { id: null, title: '', timeline: [], plan: [], usage: null, running: false, loading: false, live: null };
const runningIds = new Set();
const toolById = new Map();
let stick = true;         // follow the bottom of the timeline
let sending = false;
let attachments = [];     // {dataUrl}
let booted = false;
const deletedIds = new Set();   // chats deleted (or unloadable) during this page's lifetime; never shown again
const B = { info: null, data: null, timer: 0, busy: false };   // browser panel state
const FS = { dir: null, parent: null, entries: [], shown: [], truncated: false, filter: '', req: 0, picker: null, picked: 0, file: null, dirty: false, discard: false, loaded: false, view: 'list' };
let fileAtts = [];   // composer attachments: {type:'folder'|'file', path}

/* ------------------------------------------------------------------ markdown */
function codeBlock(code, lang) {
  return '<div class="cb"><div class="cb-h"><span class="cb-lang">' + esc(lang || 'text') +
    '</span><button class="cb-copy" type="button" aria-label="Copy code">' + icon('copy', 12) + '<span>Copy</span></button></div><pre><code>' + esc(code) + '</code></pre></div>';
}
function fmt(s) {
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]+?)(?<!\s)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]+?)(?<!\s)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  return s;
}
function inline(raw) {
  let s = esc(raw);
  const st = [];
  const keep = h => '\u0000' + (st.push(h) - 1) + '\u0000';
  s = s.replace(/`([^`\n]+?)`/g, (m, c) => keep('<code>' + c + '</code>'));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)(?:\s+&quot;[^)]*?&quot;)?\)/g,
    (m, t, u) => keep('<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + fmt(t) + '</a>'));
  s = s.replace(/\bhttps?:\/\/[^\s<>\u0000]+/g, m => {
    const tail = (/[.,;:!?)\]'"]+$|&(?:quot|#39);$/.exec(m) || [''])[0];
    const u = tail ? m.slice(0, m.length - tail.length) : m;
    return keep('<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>') + tail;
  });
  s = fmt(s);
  for (let i = 0; i < 3 && /\u0000\d+\u0000/.test(s); i++) s = s.replace(/\u0000(\d+)\u0000/g, (m, n) => st[+n]);
  return s.replace(/\n/g, '<br>');
}
const LI = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TSEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
function splitRow(r) { return r.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|')); }
function buildList(items) {
  let pos = 0;
  function level(base) {
    const first = items[pos];
    const tag = first.ordered ? 'ol' : 'ul';
    let html = '<' + tag + (first.ordered && first.num !== 1 ? ' start="' + first.num + '"' : '') + '>';
    while (pos < items.length) {
      const it = items[pos];
      if (it.indent < base) break;
      if (it.indent === base && it.ordered !== first.ordered) break;
      pos++;
      let t = it.text, cls = '';
      const tk = /^\[( |x|X)\]\s+/.exec(t);
      if (tk) { cls = ' class="task"'; t = '<input type="checkbox" disabled' + (tk[1] !== ' ' ? ' checked' : '') + '> ' + inline(t.slice(tk[0].length)); }
      else t = inline(t);
      if (pos < items.length && items[pos].indent > it.indent) t += level(items[pos].indent);
      html += '<li' + cls + '>' + t + '</li>';
    }
    return html + '</' + tag + '>';
  }
  let html = '';
  while (pos < items.length) html += level(items[pos].indent);
  return html;
}
function renderMd(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [], i = 0, m;
  const flush = () => { if (para.length) { out.push('<p>' + inline(para.join('\n')) + '</p>'); para = []; } };
  while (i < lines.length) {
    const ln = lines[i];
    if ((m = /^\s*(```+|~~~+)\s*([\w+#.\-]*)[^\n]*$/.exec(ln))) {
      flush();
      const fence = m[1], lang = m[2], buf = [];
      const closeRe = new RegExp('^\\s*' + fence[0] + '{' + fence.length + ',}\\s*$');
      i++;
      while (i < lines.length) { if (closeRe.test(lines[i])) { i++; break; } buf.push(lines[i]); i++; }
      out.push(codeBlock(buf.join('\n'), lang));
      continue;
    }
    if (/^\s*$/.test(ln)) { flush(); i++; continue; }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(ln))) { flush(); out.push('<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>'); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(ln)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(ln)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote>' + renderMd(buf.join('\n')) + '</blockquote>');
      continue;
    }
    if (ln.indexOf('|') >= 0 && i + 1 < lines.length && lines[i + 1].indexOf('-') >= 0 && TSEP.test(lines[i + 1])) {
      flush();
      const head = splitRow(ln), al = splitRow(lines[i + 1]).map(c => /^:-*:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : '');
      i += 2;
      let h = '<div class="tbl"><table><thead><tr>' + head.map((c, k) => '<th' + (al[k] ? ' style="text-align:' + al[k] + '"' : '') + '>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>';
      while (i < lines.length && lines[i].indexOf('|') >= 0 && !/^\s*$/.test(lines[i])) {
        const cells = splitRow(lines[i]);
        h += '<tr>' + head.map((c, k) => '<td' + (al[k] ? ' style="text-align:' + al[k] + '"' : '') + '>' + inline(cells[k] || '') + '</td>').join('') + '</tr>';
        i++;
      }
      out.push(h + '</tbody></table></div>');
      continue;
    }
    if (LI.test(ln)) {
      flush();
      const items = [];
      while (i < lines.length) {
        const l = lines[i], mm = LI.exec(l);
        if (mm) { items.push({ indent: mm[1].replace(/\t/g, '    ').length, ordered: /\d/.test(mm[2][0]), num: parseInt(mm[2], 10), text: mm[3] }); i++; continue; }
        if (/^\s*$/.test(l)) {
          let j = i + 1; while (j < lines.length && /^\s*$/.test(lines[j])) j++;
          if (j < lines.length && LI.test(lines[j])) { i = j; continue; }
          break;
        }
        if (/^\s+\S/.test(l) && !/^\s*(```|~~~)/.test(l)) { items[items.length - 1].text += '\n' + l.trim(); i++; continue; }
        break;
      }
      out.push(buildList(items));
      continue;
    }
    para.push(ln); i++;
  }
  flush();
  return out.join('');
}

/* ------------------------------------------------------------------ tool helpers */
function toolIconName(name) {
  name = String(name || '');
  if (/browser|web|navigate|url|fetch|screenshot|dom|console|page|click/i.test(name)) return 'globe';
  if (/command|shell|exec|bash|powershell|terminal|run|script|python|node/i.test(name)) return 'terminal';
  if (/write|edit|patch|create|append|replace|save|delete|move|rename/i.test(name)) return 'pencil';
  if (/read|list|dir|glob|file|cat|open|tree/i.test(name)) return 'file';
  if (/search|grep|find/i.test(name)) return 'search';
  if (/plan|todo/i.test(name)) return 'list';
  return 'tool';
}
function toolSummary(name, args) {
  if (args == null) return '';
  if (typeof args === 'string') return oneLine(args);
  if (typeof args !== 'object') return String(args);
  if (name === 'run_code') return 'run ' + (args.language || 'code') + (args.save_as ? ' \u2192 ' + args.save_as : '');
  const keys = ['command', 'cmd', 'path', 'file_path', 'filepath', 'file', 'url', 'query', 'selector', 'pattern', 'text', 'expression', 'script', 'code', 'title', 'dir', 'directory'];
  for (const k of keys) if (typeof args[k] === 'string' && args[k]) return oneLine(args[k]);
  for (const k of Object.keys(args)) if (typeof args[k] === 'string' && args[k]) return oneLine(args[k]);
  const j = JSON.stringify(args);
  return j === '{}' ? '' : oneLine(j);
}
function fmtArgs(args) {
  if (args == null) return '(none)';
  if (typeof args !== 'object') return String(args);
  const multi = Object.keys(args).some(k => typeof args[k] === 'string' && args[k].indexOf('\n') >= 0);
  if (!multi) return JSON.stringify(args, null, 2);
  return Object.keys(args).map(k => {
    const v = args[k];
    if (typeof v === 'string' && v.indexOf('\n') >= 0) return k + ':\n' + v;
    return k + ': ' + JSON.stringify(v);
  }).join('\n\n');
}

/* ------------------------------------------------------------------ timeline */
const tlWrap = $('#tlWrap'), tl = $('#timeline'), emptyEl = $('#empty'), jumpBtn = $('#jump');

function nearBottom() { return tlWrap.scrollHeight - tlWrap.scrollTop - tlWrap.clientHeight < 56; }
function scrollBottom() { tlWrap.scrollTop = tlWrap.scrollHeight; }
tlWrap.addEventListener('scroll', () => { stick = nearBottom(); jumpBtn.hidden = stick || !V.timeline.length; }, { passive: true });
tlWrap.addEventListener('wheel', e => { if (e.deltaY < 0) stick = false; }, { passive: true });
jumpBtn.addEventListener('click', () => { stick = true; scrollBottom(); jumpBtn.hidden = true; });
/* code boxes: follow the stream while at the bottom, pause when the user scrolls up */
function codeEntryOf(t) { const b = t.closest && t.closest('.cbx'); const c = b && b.closest('.entry'); return c && c._e ? c._e : null; }
tl.addEventListener('scroll', ev => { const b = ev.target, e = b.classList && b.classList.contains('cbx') && codeEntryOf(b); if (e) e._follow = b.scrollHeight - b.scrollTop - b.clientHeight < 24; }, true);
tl.addEventListener('wheel', ev => { if (ev.deltaY < 0) { const e = codeEntryOf(ev.target); if (e) e._follow = false; } }, { capture: true, passive: true });

function buildUser(e) {
  const n = el('div', 'entry user');
  const b = el('div', 'bubble');
  if (e.images && e.images.length) {
    const g = el('div', 'u-imgs');
    e.images.forEach(src => { if (typeof src === 'string' && src.startsWith('data:image/')) { const im = new Image(); im.src = src; im.alt = 'Attached image'; im.loading = 'lazy'; g.appendChild(im); } });
    b.appendChild(g);
  }
  if (Array.isArray(e.attachments) && e.attachments.length) {
    const g = el('div', 'u-atts');
    g.innerHTML = e.attachments.filter(a => a && typeof a.path === 'string').map(a => chipHtml(a)).join('');
    b.appendChild(g);
  }
  if (e.text) { const t = el('div', 'u-text'); t.textContent = e.text; b.appendChild(t); }
  n.appendChild(b);
  return n;
}
function buildAssistant(e) {
  const n = el('div', 'entry assistant');
  const md = el('div', 'md'); md.innerHTML = renderMd(e.text);
  n.appendChild(md);
  e.ui = { md };
  return n;
}
function buildThinking(e) {
  const d = el('details', 'entry think');
  d.innerHTML = '<summary>' + icon('spark', 14) + '<span class="think-label">Thinking…</span>' + icon('chevR', 12) + '</summary><div class="think-body"></div>';
  const body = d.lastChild, tn = document.createTextNode(e.text || '');
  body.appendChild(tn);
  e.ui = { body, tn, label: d.querySelector('.think-label') };
  return d;
}
function thinkDoneLabel(e) {
  const w = (e.text || '').trim().split(/\s+/).filter(Boolean).length;
  return 'Thought' + (w ? ' · ' + fmtNum(w) + ' words' : '');
}
function buildNote(e) {
  const lvl = e.level === 'error' || e.level === 'warn' ? e.level : 'info';
  const n = el('div', 'entry note ' + lvl);
  n.innerHTML = icon(lvl === 'info' ? 'info' : 'alert', 13) + '<span></span>';
  n.lastChild.textContent = e.text || '';
  return n;
}
function buildTool(e) {
  e._code = isCodeTool(e);
  if (e._code && e.streaming && e._open === undefined) e._open = true;
  const n = el('div', 'entry tool-card' + (e._code ? ' code-card' : ''));
  n.innerHTML =
    '<button class="tool-h" type="button" aria-expanded="false">' +
      '<span class="t-ico">' + icon(toolIconName(e.name), 15) + '</span>' +
      '<span class="t-name"></span><span class="t-sum"></span><span class="t-live" hidden></span><span class="t-ms"></span><span class="t-st"></span>' + icon('chevR', 13) +
    '</button>' +
    '<div class="tool-appr" hidden></div>' +
    (e._code
      ? '<div class="tool-b code" hidden><div class="cb-err" hidden><pre></pre></div><div class="cbx"><div class="cbx-in"></div></div><div class="cb-outw" hidden><div class="lbl">Output</div><pre class="out"></pre></div></div>'
      : '<div class="tool-b" hidden><div class="lbl">Arguments</div><pre class="args"></pre><div class="lbl">Output</div><pre class="out"></pre></div>');
  e.ui = {
    head: n.firstChild, name: $('.t-name', n), sum: $('.t-sum', n), ms: $('.t-ms', n), st: $('.t-st', n),
    appr: $('.tool-appr', n), body: $('.tool-b', n), args: $('.args', n), out: $('.out', n), live: $('.t-live', n), outw: $('.cb-outw', n), errw: $('.cb-err', n), errp: $('.cb-err pre', n)
  };
  e.ui.name.textContent = e.name || 'tool';
  return n;
}
const ST_ICON = { done: 'check', error: 'x', denied: 'ban' };
function renderTool(e) {
  const n = e.el, u = e.ui;
  if (!n || !u) return;
  const st = e.status || 'running';
  if (e._st !== st) {
    n.classList.remove('st-running', 'st-done', 'st-error', 'st-denied');
    n.classList.add('st-' + st);
    u.st.innerHTML = st === 'running' ? '<span class="spin" aria-hidden="true"></span>' : icon(ST_ICON[st] || 'check', 14);
    u.st.setAttribute('title', st);
    u.st.setAttribute('aria-label', st);
    e._st = st;
  }
  const sum = toolSummary(e.name, e.args);
  if (e._sum !== sum) { u.sum.textContent = sum; u.sum.title = sum; e._sum = sum; }
  if (!e._code) u.ms.textContent = e.ms != null && st !== 'running' ? fmtMs(e.ms) : '';
  const ap = e.approval, pending = ap && ap.state === 'pending';
  n.classList.toggle('needs-appr', !!pending);
  if (ap && ap.state !== 'none') {
    u.appr.hidden = false;
    if (pending) {
      if (e._apprShown !== 'pending') {
        u.appr.innerHTML = '<div class="appr-t">' + icon('shield', 14) + '<b>Approval needed</b><span class="appr-reason"></span></div>' +
          '<pre class="appr-cmd"></pre>' +
          '<div class="appr-btns"><button class="btn ok" type="button" data-a="allow">Allow</button><button class="btn" type="button" data-a="always">Always allow</button><button class="btn danger" type="button" data-a="deny">Deny</button></div>';
        $('.appr-reason', u.appr).textContent = ap.reason ? ' · ' + oneLine(ap.reason, 160) : '';
        const cmdEl = $('.appr-cmd', u.appr), a = e.args;
        cmdEl.textContent = e._code ? sum + ' (' + fmtNum(codeText(e) ? countNL(codeText(e)) + 1 : 0) + ' lines)' : a && typeof a === 'object' && typeof (a.command || a.cmd) === 'string' ? String(a.command || a.cmd) : (a == null ? '' : fmtArgs(a));
        if (!cmdEl.textContent || cmdEl.textContent === '{}') cmdEl.hidden = true;
        e._apprShown = 'pending';
      }
    } else if (e._apprShown !== ap.state) {
      u.appr.innerHTML = '<div class="appr-t done">' + icon(ap.state === 'denied' ? 'ban' : 'check', 13) + '<span>' +
        (ap.state === 'denied' ? 'Denied' : ap.state === 'always' ? 'Always allowed' : 'Allowed') + '</span></div>';
      e._apprShown = ap.state;
    }
  } else if (!u.appr.hidden) { u.appr.hidden = true; e._apprShown = null; }
  u.head.setAttribute('aria-expanded', e._open ? 'true' : 'false');
  n.classList.toggle('open', !!e._open);
  u.body.hidden = !e._open;
  if (e._code) renderCode(e);
  else if (e._open) {
    u.args.textContent = fmtArgs(e.args);
    u.out.textContent = e.output ? e.output : (st === 'running' ? 'Running…' : '(no output)');
  }
}

/* ------------------------------------------------------------------ live code cards (write_file / run_code) */
const CODE_TOOLS = { write_file: 'content', run_code: 'code', edit_file: 'patch' };
const isEdit = e => e.name === 'edit_file';
const isCodeTool = e => e.kind === 'tool' && !!CODE_TOOLS[e.name] && (!!e.streaming || (!!e.args && typeof e.args === 'object'));
const bodyKey = e => CODE_TOOLS[e.name];
const codeText = e => (e.args && typeof e.args[bodyKey(e)] === 'string') ? e.args[bodyKey(e)] : '';
const countNL = s => { let n = 0, i = -1; while ((i = s.indexOf('\n', i + 1)) >= 0) n++; return n; };
const codeLive = new Set();
let codeTimer = 0;
function trackCode(e) {
  codeLive.add(e);
  if (!codeTimer) codeTimer = setInterval(() => {
    codeLive.forEach(x => { if (!x.streaming && x.status !== 'running') codeLive.delete(x); else codeHeader(x); });
    if (!codeLive.size) { clearInterval(codeTimer); codeTimer = 0; }
  }, 500);
}
function codeLang(e) {
  const a = e.args || {};
  const raw = e.name === 'run_code' ? String(a.language || '') : ((/\.([A-Za-z0-9]+)$/.exec(String(a.path || '')) || [])[1] || '');
  return ({ py: 'py', pyw: 'py', python: 'py', js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', javascript: 'js', node: 'js', json: 'json', html: 'html', htm: 'html', css: 'css', ps1: 'ps1', powershell: 'ps1', pwsh: 'ps1' })[raw.toLowerCase()] || null;
}

/* --- tiny per-line highlighter (runs once per completed line, never on the whole file) --- */
const KW_PY = /^(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|True|False|None|self|print)$/;
const KW_JS = /^(?:async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|yield|true|false|null|undefined)$/;
const KW_PS = /^(?:begin|break|catch|class|continue|do|else|elseif|end|exit|filter|finally|for|foreach|function|if|in|param|process|return|switch|throw|trap|try|until|using|while)$/i;
const LANGS = {
  py: { re: /(#.*)|('''|""")|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d[\d_.]*\b)|([A-Za-z_]\w*)/g, kw: KW_PY, fn: 1 },
  js: { re: /(\/\/.*)|(\/\*)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)/g, kw: KW_JS, fn: 1 },
  json: { re: /((?!))|((?!))|("(?:[^"\\]|\\.)*"?)|(-?\b\d[\d.eE+-]*\b)|([A-Za-z_]+)/g, kw: /^(?:true|false|null)$/, key: 1 },
  css: { re: /((?!))|(\/\*)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(#[0-9a-fA-F]{3,8}\b|\b\d[\d.]*(?:px|em|rem|vh|vw|ms|s|%)?)|(@?[A-Za-z_-][\w-]*)/g, kw: /^@/ },
  html: { re: /(<!--.*?(?:-->|$))|((?!))|("[^"]*"?|'[^']*'?)|((?!))|(<\/?[A-Za-z][\w-]*|\/?>)/g, kw: /^[<\/]/ },
  ps1: { re: /(#.*)|(<#)|("(?:[^"\\`]|[`\\].)*"?|'[^']*'?)|(\b\d[\d.]*\b)|([A-Za-z_][\w-]*)|(\$\{[^}]*\}|\$\w+)/g, kw: KW_PS, cm: 1 }
};
const MULTI = { '/*': ['*/', 'c'], '<#': ['#>', 'c'], '"""': ['"""', 's'], "'''": ["'''", 's'] };
function hlLine(line, L, st) {
  if (line.length > 500) return esc(line);
  let out = '', i = 0, m;
  if (st.o) {
    const j = line.indexOf(st.c);
    if (j < 0) return '<i class="' + st.k + '">' + esc(line) + '</i>';
    i = j + st.c.length; st.o = 0;
    out = '<i class="' + st.k + '">' + esc(line.slice(0, i)) + '</i>';
  }
  const re = L.re;
  re.lastIndex = i;
  while ((m = re.exec(line))) {
    if (m.index > i) out += esc(line.slice(i, m.index));
    const t = m[0];
    i = m.index + t.length;
    let cls = null;
    if (m[1] !== undefined) cls = 'c';
    else if (m[2] !== undefined) {
      const mu = MULTI[t], j = line.indexOf(mu[0], i);
      if (j < 0) { st.o = 1; st.c = mu[0]; st.k = mu[1]; out += '<i class="' + mu[1] + '">' + esc(t + line.slice(i)) + '</i>'; i = line.length; break; }
      out += '<i class="' + mu[1] + '">' + esc(t + line.slice(i, j + mu[0].length)) + '</i>';
      i = j + mu[0].length; re.lastIndex = i; continue;
    } else if (m[3] !== undefined) cls = L.key && /^\s*:/.test(line.slice(i, i + 8)) ? 'f' : 's';
    else if (m[4] !== undefined) cls = 'n';
    else if (m[5] !== undefined) cls = L.kw.test(t) ? 'k' : (L.fn && line.charCodeAt(i) === 40) || (L.cm && /^[A-Z][a-z]+-\w+$/.test(t)) ? 'f' : null;
    else if (m[6] !== undefined) cls = 'v';
    out += cls ? '<i class="' + cls + '">' + esc(t) + '</i>' : esc(t);
  }
  if (i < line.length) out += esc(line.slice(i));
  return out;
}

/* --- incremental code view: one <div> per line, line numbers via CSS counters --- */
/* --- edit_file: SEARCH/REPLACE patches shown as a diff --- */
function editsOf(e) {
  const a = e.args || {};
  if (Array.isArray(a.edits) && a.edits.length) return a.edits.map(x => ({ old: String((x && x.old) == null ? '' : x.old), new: String((x && x.new) == null ? '' : x.new) }));
  if (typeof a.old === 'string' || typeof a.new === 'string') return [{ old: String(a.old || ''), new: String(a.new || '') }];   // legacy single edit
  return typeof a.patch === 'string' && a.patch ? parsePatch(a.patch) : [];
}
function parsePatch(t) {
  const out = []; let st = 0, o = [], n = [];
  t.replace(/\r/g, '').split('\n').forEach(l => {
    if (/^<{7}\s*SEARCH\s*$/.test(l)) { st = 1; o = []; n = []; }
    else if (st === 1 && /^={7}\s*$/.test(l)) st = 2;
    else if (st === 2 && /^>{7}\s*REPLACE\s*$/.test(l)) { out.push({ old: o.join('\n'), new: n.join('\n') }); st = 0; }
    else if (st === 1) o.push(l); else if (st === 2) n.push(l);
  });
  return out;
}
const diffLines = t => t === '' ? [] : t.replace(/\n$/, '').split('\n');
function editStats(e) {
  if (e._c && e._c.edit) return { n: e._c.edit.pairs, a: e._c.edit.adds, d: e._c.edit.dels };
  if (e._esA !== e.args) {
    let n = 0, a = 0, d = 0;
    editsOf(e).forEach(x => { n++; a += diffLines(x.new).length; d += diffLines(x.old).length; });
    e._es = { n, a, d }; e._esA = e.args;
  }
  return e._es;
}
function buildDiff(e, edits) {
  const box = $('.cbx', e.el), inn = $('.cbx-in', e.el);
  box.classList.add('diff');
  let h = '', total = 0;
  edits.forEach((x, i) => {
    if (total > 4000) return;
    h += '<div class="cl2 dv' + (i ? ' sep' : '') + '">edit ' + (i + 1) + ' of ' + edits.length + '</div>';
    diffLines(x.old).forEach(l => { h += '<div class="cl2 del">' + esc(l) + '</div>'; total++; });
    diffLines(x.new).forEach(l => { h += '<div class="cl2 add">' + esc(l) + '</div>'; total++; });
  });
  if (total > 4000) h += '<div class="cl2 dv">… diff truncated</div>';
  inn.innerHTML = h;
  box.scrollTop = 0;
  e._c = { box, inn, lines: total, caret: null, tn: null, stat: true };
  e._follow = false;
  return e._c;
}
function editFinish(c) {
  const ed = c.edit, t = c.tn.data, d = c.cur;
  if (/^<{7}\s*SEARCH\s*$/.test(t)) { ed.state = 'S'; ed.pairs++; d.className = 'cl2 dv' + (ed.pairs > 1 ? ' sep' : ''); c.tn.data = 'replace this'; }
  else if (ed.state === 'S' && /^={7}\s*$/.test(t)) { ed.state = 'R'; d.className = 'cl2 dv'; c.tn.data = 'with this'; }
  else if (ed.state === 'R' && /^>{7}\s*REPLACE\s*$/.test(t)) { ed.state = 'out'; d.className = 'cl2 dv'; d.hidden = true; }
  else if (ed.state === 'S') { ed.dels++; d.className = 'cl2 del'; }
  else if (ed.state === 'R') { ed.adds++; d.className = 'cl2 add'; }
  else { d.className = 'cl2 ctx'; if (!t.trim()) d.hidden = true; }
}
function startLine(c) {
  const d = document.createElement('div');
  d.className = 'cl2';
  if (c.edit) d.className = 'cl2 ' + (c.edit.state === 'S' ? 'del' : c.edit.state === 'R' ? 'add' : 'ctx');
  c.tn = document.createTextNode('');
  d.appendChild(c.tn);
  c.inn.appendChild(d);
  c.cur = d; c.lines++;
  if (c.caret) d.appendChild(c.caret);
}
function finishLine(c) {
  if (c.edit) { editFinish(c); return; }
  const t = c.tn.data;
  if (c.lang && !c.plain && t) c.cur.innerHTML = hlLine(t, c.lang, c.st);
}
function codeAppend(c, s) {
  let i = 0;
  s = s.indexOf('\r') >= 0 ? s.replace(/\r/g, '') : s;
  for (;;) {
    const j = s.indexOf('\n', i), seg = j < 0 ? s.slice(i) : s.slice(i, j);
    if (seg) { c.tn.appendData(seg); if (c.edit && c.tn.data.length < 22 && /^[<=>]{2,}/.test(c.tn.data)) c.cur.className = 'cl2 mk'; }
    if (j < 0) break;
    finishLine(c); startLine(c); i = j + 1;
  }
  if (c.lines > 4000) c.plain = true;
}
function newCode(e) {
  const box = $('.cbx', e.el), inn = $('.cbx-in', e.el);
  inn.textContent = '';
  const c = { box, inn, lang: LANGS[codeLang(e)] || null, st: { o: 0 }, lines: 0, cur: null, tn: null, caret: null, plain: false };
  e._c = c; e._follow = true;
  if (isEdit(e)) { c.edit = { state: 'out', pairs: 0, adds: 0, dels: 0 }; box.classList.add('diff'); }
  startLine(c);
  return c;
}
function addCaret(c) { if (!c.caret) { c.caret = el('span', 'caret'); c.cur.appendChild(c.caret); } }
function dropCaret(e) { const c = e._c; if (c && c.caret) { c.caret.remove(); c.caret = null; } }
function ensureCode(e) {
  if (e._c) return e._c;
  if (isEdit(e) && !e.streaming) { const ed = editsOf(e); if (ed.length) return buildDiff(e, ed); }
  const c = newCode(e);
  let t = codeText(e);
  if (t.length > 400000) t = t.slice(0, 400000);
  c.plain = t.length > 150000;
  codeAppend(c, t);
  if (e.streaming) addCaret(c);
  return c;
}
function codeFlush(e) {
  const p = e._pend;
  if (!p) return;
  e._pend = '';
  const c = e._c;
  if (!c) return;
  codeAppend(c, p);
  if (e._follow) c.box.scrollTop = c.box.scrollHeight;
}
function codeHeader(e) {
  const u = e.ui;
  if (!u || !e._code) return;
  const live = !!e.streaming, running = !live && e.status === 'running';
  const key = live ? 'w' : running ? (e._closed === false ? 'c' : 'r') : '';
  if (e._lk !== key) {
    e._lk = key;
    u.live.hidden = !key;
    u.live.className = 't-live' + (key === 'c' ? ' warn' : '');
    u.live.innerHTML = key === 'w' ? '<i class="pdot"></i>' + (isEdit(e) ? 'editing…' : 'writing…') : key === 'r' ? '<span class="spin sm"></span>running…' : key === 'c' ? 'cut off' : '';
    e.el.classList.toggle('cs-live', !!key);
  }
  if (isEdit(e)) {
    const st = editStats(e), df = '+' + fmtNum(st.a) + ' \u2212' + fmtNum(st.d);
    let s2;
    if (live || running) s2 = df + ' \u00b7 ' + Math.max(0, Math.round((Date.now() - (e._t0 || Date.now())) / 1000)) + 's';
    else s2 = (st.n ? st.n + (st.n === 1 ? ' edit' : ' edits') + ' \u00b7 ' + df : '') + (e.ms != null ? (st.n ? ' \u00b7 ' : '') + fmtMs(e.ms) : '');
    if (e._ms !== s2) { u.ms.textContent = s2; e._ms = s2; }
    return;
  }
  if (e._nl == null) { const t = codeText(e); e._nl = countNL(t); e._bytes = t.length; }
  const has = e._bytes > 0, lines = has ? e._nl + 1 : 0;
  let s;
  if (live || running) s = fmtNum(lines) + ' lines · ' + fmtSize(e._bytes) + ' · ' + Math.max(0, Math.round((Date.now() - (e._t0 || Date.now())) / 1000)) + 's';
  else s = (has ? fmtNum(lines) + ' lines' : '') + (e.ms != null ? (has ? ' · ' : '') + fmtMs(e.ms) : '');
  if (e._ms !== s) { u.ms.textContent = s; e._ms = s; }
}
function renderCode(e) {
  const u = e.ui;
  if (e._open) {
    ensureCode(e);
    const o = e.output || '', bad = isEdit(e) && e.status === 'error' && !!o;
    u.outw.hidden = !o || bad;
    u.errw.hidden = !bad;
    if (o && e._outShown !== o) { u.out.textContent = o; u.errp.textContent = o; e._outShown = o; }
  } else if (e._c && !e.streaming) { e._c.inn.textContent = ''; e._c = null; }   // free the DOM of collapsed cards
  codeHeader(e);
}
function endCode(e) {
  if (e.streaming) { codeFlush(e); e.streaming = false; }
  dropCaret(e);
}
function onToolStream(ev) {
  const e = toolById.get(ev.id);
  if (!e || !ev.delta) return;
  const k = bodyKey(e);
  if (!k) return;
  if (!e.args || typeof e.args !== 'object') e.args = {};
  e.args[k] = (typeof e.args[k] === 'string' ? e.args[k] : '') + ev.delta;
  e._pend = (e._pend || '') + ev.delta;
  e._nl = (e._nl || 0) + countNL(ev.delta);
  e._bytes = (e._bytes || 0) + ev.delta.length;
  e.streaming = true;
  markDirty(e);
}
function onToolStreamEnd(ev) {
  const e = toolById.get(ev.id);
  if (!e) return;
  codeFlush(e);
  e.streaming = false;
  e._closed = ev.closed !== false;
  if (ev.args && typeof ev.args === 'object') {
    const k = bodyKey(e), cur = codeText(e);
    e.args = Object.assign({}, e.args, ev.args);
    const fin = codeText(e);
    if (fin !== cur) { e._nl = countNL(fin); e._bytes = fin.length; e._pend = ''; if (e._c) { e._c = null; if (e._open) ensureCode(e); } }
  }
  if (isEdit(e) && ev.args && Array.isArray(ev.args.edits)) { e._c = null; e._esA = null; }
  dropCaret(e);
  renderTool(e);
  trackCode(e);
}

function buildEntry(e) {
  switch (e.kind) {
    case 'user': return buildUser(e);
    case 'assistant': return buildAssistant(e);
    case 'thinking': return buildThinking(e);
    case 'tool': return buildTool(e);
    case 'note': return buildNote(e);
  }
  return null;
}
function setLive(e) {
  if (V.live === e) return;
  endLive(e);
  V.live = e;
  if (e.kind === 'thinking') { e.el.classList.add('live'); e.el.open = true; e.ui.label.textContent = 'Thinking…'; }
  else if (e.kind === 'assistant') e.el.classList.add('streaming');
}
function endLive(except) {
  const l = V.live;
  if (!l || l === except) return;
  V.live = null;
  if (l.kind === 'thinking') {
    flushEntry(l);
    l.el.classList.remove('live'); l.el.open = false;
    l.ui.label.textContent = thinkDoneLabel(l);
  } else if (l.kind === 'assistant') {
    l.el.classList.remove('streaming');
    l.ui.md.innerHTML = renderMd(l.text);
    dirty.delete(l);
  }
}
function addEntry(e, frag) {
  const n = buildEntry(e);
  if (!n) return false;
  if (!frag) endLive();
  e.el = n; n._e = e;
  if (!frag) n.classList.add('anim');
  else if (e.kind === 'thinking') e.ui.label.textContent = thinkDoneLabel(e);
  V.timeline.push(e);
  (frag || tl).appendChild(n);
  if (e.kind === 'tool') {
    if (e.id) toolById.set(e.id, e);
    if (e._code && (e.streaming || e.status === 'running')) { e._t0 = e._t0 || Date.now(); trackCode(e); }
    renderTool(e);
  }
  if (!frag) { hideEmpty(); afterChange(); }
  return true;
}
function removeEntry(e) {
  const i = V.timeline.indexOf(e);
  if (i >= 0) V.timeline.splice(i, 1);
  if (e.el) e.el.remove();
  if (e.id) toolById.delete(e.id);
  if (V.live === e) V.live = null;
  showEmptyIfNeeded();
}
function resetTimeline() {
  tl.textContent = '';
  V.timeline = []; V.plan = []; V.usage = null; V.live = null;
  toolById.clear(); dirty.clear();
  renderPlan(); renderCtx();
}
function showEmptyIfNeeded() {
  const empty = !V.timeline.length && !V.loading;
  emptyEl.hidden = !empty;
  tl.hidden = !V.timeline.length;
  if (empty) jumpBtn.hidden = true;
}
function hideEmpty() { emptyEl.hidden = true; tl.hidden = false; }
function afterChange() { if (stick) requestAnimationFrame(scrollBottom); else jumpBtn.hidden = false; }

/* --- streaming (batched with rAF) --- */
const dirty = new Set();
let raf = 0;
function markDirty(e) { dirty.add(e); if (!raf) raf = requestAnimationFrame(flush); }
function flushEntry(e) {
  if (e.kind === 'thinking') {
    if (e._pend) { e.ui.tn.appendData(e._pend); e._pend = ''; if (V.live === e) e.ui.body.scrollTop = e.ui.body.scrollHeight; }
  } else if (e.kind === 'assistant') e.ui.md.innerHTML = renderMd(e.text);
  else if (e.kind === 'tool') { if (e._code) codeFlush(e); renderTool(e); }
}
function flush() {
  raf = 0;
  const now = performance.now();
  let again = false;
  dirty.forEach(e => {
    if (e.kind === 'assistant') {
      const gap = e.text.length > 24000 ? 140 : e.text.length > 8000 ? 70 : 0;
      if (gap && e._t && now - e._t < gap) { again = true; return; }
      e._t = now;
    }
    flushEntry(e);
    dirty.delete(e);
  });
  if (again) raf = requestAnimationFrame(flush);
  if (stick) scrollBottom();
}
function appendStream(kind, delta) {
  if (!delta) return;
  let last = V.timeline[V.timeline.length - 1];
  if (!last || last.kind !== kind) {
    last = { kind, text: '' };
    addEntry(last);
  }
  setLive(last);
  last.text += delta;
  if (kind === 'thinking') last._pend = (last._pend || '') + delta;
  markDirty(last);
}

/* --- tool + approval events --- */
function onToolCall(ev) {
  const ex = ev.id && toolById.get(ev.id);
  if (ex) { if (ev.args && !ex.streaming && !ex._pend) ex.args = ev.args; renderTool(ex); return; }
  let e = null;
  // adopt a placeholder created by an earlier approval event
  for (let i = V.timeline.length - 1; i >= 0 && i > V.timeline.length - 8; i--) {
    const t = V.timeline[i];
    if (t.kind === 'tool' && t._placeholder && t.name === ev.name) { e = t; break; }
  }
  if (e) { e._placeholder = false; e.id = ev.id; e.args = ev.args; toolById.set(ev.id, e); renderTool(e); return; }
  endLive();
  const ne = { kind: 'tool', id: ev.id, name: ev.name, args: ev.args, status: 'running' };
  if (ev.streaming && CODE_TOOLS[ev.name]) {
    ne.streaming = true; ne._open = true; ne._nl = 0; ne._bytes = 0; ne._t0 = Date.now();
    ne.args = ne.args && typeof ne.args === 'object' ? ne.args : {};
    if (typeof ne.args[CODE_TOOLS[ev.name]] !== 'string') ne.args[CODE_TOOLS[ev.name]] = '';
  }
  addEntry(ne);
}
function onToolResult(ev) {
  let e = toolById.get(ev.id);
  if (!e) { addEntry(e = { kind: 'tool', id: ev.id, name: ev.name || 'tool', args: ev.args, status: 'running' }); }
  const denied = e.approval && e.approval.state === 'denied';
  e.status = ev.ok ? 'done' : (denied ? 'denied' : 'error');
  e.output = ev.output != null ? String(ev.output) : e.output;
  e.ms = ev.ms;
  if (e.approval && e.approval.state === 'pending') e.approval.state = 'allowed';
  if (e._code) { endCode(e); if (!e._userToggled) e._open = isEdit(e) && e.status === 'error'; }
  renderTool(e);
  afterChange();
}
function onApproval(ev) {
  let e = null;
  for (let i = V.timeline.length - 1; i >= 0; i--) {
    const t = V.timeline[i];
    if (t.kind === 'tool' && t.status === 'running' && !(t.approval && t.approval.state === 'pending') && (!ev.name || t.name === ev.name)) { e = t; break; }
  }
  if (!e) {
    endLive();
    e = { kind: 'tool', id: 'a:' + ev.id, name: ev.name, args: ev.args, status: 'running', _placeholder: true };
    addEntry(e);
  }
  e.approval = { id: ev.id, reason: ev.reason, state: 'pending' };
  e._apprShown = null;
  renderTool(e);
  afterChange();
}
async function answerApproval(e, mode) {
  const ap = e.approval;
  if (!ap || ap.state !== 'pending') return;
  const allow = mode !== 'deny', always = mode === 'always';
  ap.state = allow ? (always ? 'always' : 'allowed') : 'denied';
  renderTool(e);
  if (always) { S.settings.autoApprove = true; renderTop(); }
  try { await api('/api/approve', { body: { id: ap.id, allow, always } }); }
  catch (err) {
    if (err.status !== 401 && err.status !== 0) toast('Could not send approval: ' + err.message);
    ap.state = 'pending'; e._apprShown = null; renderTool(e);
  }
}

/* delegated clicks inside the timeline */
tl.addEventListener('click', ev => {
  const t = ev.target;
  if (ui.ht && t.closest && t.closest('.think > summary')) { ev.preventDefault(); return; }  // thinking hidden: not expandable
  const cp = t.closest && t.closest('.cb-copy');
  if (cp) {
    const code = cp.closest('.cb').querySelector('code').textContent;
    copyText(code).then(ok => {
      const s = cp.querySelector('span');
      s.textContent = ok ? 'Copied' : 'Failed';
      setTimeout(() => { s.textContent = 'Copy'; }, 1300);
    });
    return;
  }
  const btn = t.closest && t.closest('.appr-btns button');
  if (btn) { const card = btn.closest('.entry'); if (card && card._e) answerApproval(card._e, btn.dataset.a); return; }
  const h = t.closest && t.closest('.tool-h');
  if (h) {
    const card = h.closest('.entry'), e = card && card._e;
    if (e) { e._userToggled = true; e._open = !e._open; renderTool(e); }
  }
});
async function copyText(s) {
  try { await navigator.clipboard.writeText(s); return true; }
  catch (_) {
    try {
      const ta = el('textarea'); ta.value = s; ta.style.cssText = 'position:fixed;opacity:0;top:0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (__) { return false; }
  }
}

/* ------------------------------------------------------------------ plan */
function renderPlan() {
  const ol = $('#planList'), items = V.plan || [];
  ol.textContent = '';
  const frag = document.createDocumentFragment();
  let done = 0;
  items.forEach(it => {
    const s = it.status === 'done' || it.status === 'in_progress' ? it.status : 'pending';
    if (s === 'done') done++;
    const li = el('li', 'p-' + s);
    li.innerHTML = '<span class="p-ico">' + (s === 'done' ? icon('circleCheck', 17) : s === 'in_progress' ? '<span class="spin" aria-hidden="true"></span>' : icon('circle', 17)) + '</span><span class="p-txt"></span>';
    li.lastChild.textContent = it.text || '';
    li.setAttribute('aria-label', (it.text || '') + ', ' + s.replace('_', ' '));
    frag.appendChild(li);
  });
  ol.appendChild(frag);
  $('#planEmpty').hidden = items.length > 0;
  const c = $('#planCount');
  c.hidden = !items.length;
  c.textContent = done + '/' + items.length;
}

/* ------------------------------------------------------------------ settings pill + popover */
const app = $('#app');
const setBtn = $('#setBtn'), setPop = $('#setPop'), modelMenu = $('#modelMenu'), popModel = $('#popModel');
const MODE_HINT = { max: 'Thinks as long as it needs, double-checks, up to 150 steps.', deep: 'Careful, thinks longer.', fast: 'Quick answers.' };
const MODE_NAME = { max: 'Max', deep: 'Deep', fast: 'Fast' };
function curModel() { return S.models.find(m => m.id === S.settings.model); }
function shortModel(m, id) { const l = (m && m.label) || id || 'Model'; return l.replace(/\s*\(.*?\)\s*/g, ' ').trim() || l; }
function shortPath(p) { return p.length > 36 ? p.slice(0, 3) + '…' + p.slice(-30) : p; }
let topSig = '';
function renderTop() {
  const st = S.settings, m = curModel();
  const sig = JSON.stringify([st, S.models.map(x => [x.id, x.installed, x.think, x.vision]), S.pull && S.pull.active && [S.pull.model, Math.round(S.pull.percent || 0)]]);
  if (sig === topSig) return;
  topSig = sig;
  const kind = m ? m.think : 'levels', mode = MODE_NAME[st.mode] ? st.mode : 'deep';
  const thinkOn = kind !== 'none' && st.think && st.think !== 'off';
  /* pill */
  $('#pillModel').textContent = shortModel(m, st.model);
  $('#pillMode').textContent = MODE_NAME[mode];
  $('#pillIcons').innerHTML = (thinkOn ? '<span class="on" title="Thinking on">' + icon('spark', 12) + '</span>' : '') + (st.autoApprove ? '<span class="warn" title="Auto-approve on">' + icon('shield', 12) + '</span>' : '');
  setBtn.title = 'Model: ' + (st.model || '?') + '\nMode: ' + MODE_NAME[mode] + '\nThinking: ' + (kind === 'none' ? 'n/a' : st.think || 'off') + '\nContext: ' + Math.round((st.numCtx || 0) / 1024) + 'k\nAuto-approve: ' + (st.autoApprove ? 'on' : 'off') + '\nWorkspace: ' + (st.workspace || '');
  /* popover controls */
  $('#popModelName').textContent = shortModel(m, st.model);
  const vis = $('#popVis'); vis.hidden = !(m && m.vision); if (m && m.vision) vis.innerHTML = icon('eye', 11) + 'Vision';
  $$('.seg button').forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  $('#modeHint').textContent = MODE_HINT[mode];
  const sel = $('#thinkSel');
  let opts = [['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
  if (kind === 'bool') opts = [['off', 'Off'], ['medium', 'On']];
  if (kind === 'none') opts = [['off', 'N/A']];
  if (sel._k !== kind) { sel.innerHTML = opts.map(o => '<option value="' + o[0] + '">' + o[1] + '</option>').join(''); sel._k = kind; }
  let v = st.think || 'off';
  if (kind === 'bool' && v !== 'off') v = 'medium';
  if (kind === 'none') v = 'off';
  sel.value = v;
  sel.disabled = kind === 'none';
  const cs = $('#ctxSel');
  if (!$$('option', cs).some(o => +o.value === +st.numCtx)) cs.insertAdjacentHTML('beforeend', '<option value="' + (+st.numCtx) + '">' + Math.round(st.numCtx / 1024) + 'k</option>');
  cs.value = String(st.numCtx);
  $('#autoSw').checked = !!st.autoApprove;
  $('#popWs').textContent = shortPath(st.workspace || '') || 'Not set';
  $('#popWs').title = st.workspace || '';
  const p = S.pull || {};
  $('#popPull').hidden = !p.active;
  if (p.active) { $('#popPullName').textContent = p.model || 'model'; $('#popPullPct').textContent = Math.round(p.percent || 0) + '%'; $('#popPullBar').style.width = Math.max(0, Math.min(100, p.percent || 0)) + '%'; }
  if (!modelMenu.hidden) buildModelMenu();
  renderCtx();
  updateAttachWarn();
}

async function setSetting(patch) {
  Object.assign(S.settings, patch);
  renderTop();
  try { const r = await api('/api/settings', { body: patch }); if (r && typeof r === 'object') { Object.assign(S.settings, r.settings || r); renderTop(); } }
  catch (err) { if (err.status !== 401 && err.status !== 0) toast('Could not save settings: ' + err.message); pollState(); }
}
$$('.seg button').forEach(b => b.addEventListener('click', () => setSetting({ mode: b.dataset.mode })));
$('#thinkSel').addEventListener('change', e => setSetting({ think: e.target.value }));
$('#ctxSel').addEventListener('change', e => setSetting({ numCtx: +e.target.value }));
$('#autoSw').addEventListener('change', e => setSetting({ autoApprove: e.target.checked }));
$('#showThinkSw').addEventListener('change', e => { ui.ht = e.target.checked ? 0 : 1; saveUi(); applyThink(); });
$('#popWsBtn').addEventListener('click', () => { closePop(false); setRp(true); setTab('files', true); filesOpened(); });

/* open / close */
function popOpen() { return !setPop.hidden; }
function openPop() {
  if (popOpen()) return;
  topSig = ''; renderTop();
  setPop.hidden = false;
  app.classList.add('pop-open');
  setBtn.setAttribute('aria-expanded', 'true');
  popModel.focus({ preventScroll: true });
}
function closePop(focusPill) {
  if (!popOpen()) return false;
  setPop.hidden = true;
  modelMenu.hidden = true; popModel.setAttribute('aria-expanded', 'false');
  app.classList.remove('pop-open');
  setBtn.setAttribute('aria-expanded', 'false');
  if (focusPill) setBtn.focus();
  return true;
}
setBtn.addEventListener('click', () => popOpen() ? closePop(true) : openPop());
document.addEventListener('mousedown', ev => { if (popOpen() && !ev.target.closest('#setPop') && !ev.target.closest('#setBtn')) closePop(false); });
setPop.addEventListener('focusout', ev => { if (ev.relatedTarget && !setPop.contains(ev.relatedTarget) && ev.relatedTarget !== setBtn) closePop(false); });
$('#setScrim').addEventListener('click', () => closePop(true));

/* model list (inline in the popover) */
function buildModelMenu() {
  const cur = S.settings.model, pull = S.pull || {};
  const frag = document.createDocumentFragment();
  const list = S.models.slice().sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0));
  list.forEach(m => {
    const row = el('div', 'mi' + (m.installed ? '' : ' off') + (m.id === cur ? ' sel' : ''));
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', m.id === cur ? 'true' : 'false');
    if (!m.installed) row.setAttribute('aria-disabled', 'true');
    const main = el('button', 'mi-main');
    main.type = 'button'; main.dataset.id = m.id; main.disabled = !m.installed;
    main.innerHTML = '<span class="mi-l"><span class="mi-name"></span>' +
      (m.vision ? '<span class="tag vis" title="Understands images">' + icon('eye', 11) + 'Vision</span>' : '') +
      (m.recommended ? '<span class="tag rec">Recommended</span>' : '') +
      '</span><span class="mi-d"></span>';
    $('.mi-name', main).textContent = m.label || m.id;
    $('.mi-d', main).textContent = [m.desc, m.sizeGB ? m.sizeGB + ' GB' : ''].filter(Boolean).join(' · ');
    row.appendChild(main);
    if (m.id === cur) row.insertAdjacentHTML('beforeend', '<span class="mi-ck">' + icon('check', 15) + '</span>');
    if (!m.installed) {
      const pulling = pull.active && pull.model === m.id;
      const dl = el('button', 'btn sm mi-dl');
      dl.type = 'button'; dl.dataset.dl = m.id; dl.disabled = pulling;
      dl.innerHTML = pulling ? '<span class="spin"></span><span>' + Math.round(pull.percent || 0) + '%</span>' : icon('download', 13) + '<span>Download</span>';
      dl.setAttribute('aria-label', 'Download ' + (m.label || m.id));
      row.appendChild(dl);
    }
    frag.appendChild(row);
  });
  if (!S.models.length) frag.appendChild(el('div', 'mi-none', 'No models reported by the server.'));
  modelMenu.textContent = '';
  modelMenu.appendChild(frag);
}
popModel.addEventListener('click', () => {
  const open = modelMenu.hidden;
  if (open) buildModelMenu();
  modelMenu.hidden = !open;
  popModel.setAttribute('aria-expanded', open);
  if (open) { const s = $('.mi.sel .mi-main', modelMenu) || $('.mi-main:not(:disabled)', modelMenu); if (s) s.focus(); }
});
modelMenu.addEventListener('click', async ev => {
  const dl = ev.target.closest('[data-dl]');
  if (dl) {
    const id = dl.dataset.dl;
    try { await api('/api/models/pull', { body: { model: id } }); toast('Downloading ' + id + '…', 'info', 3000); pollState(); }
    catch (err) { if (err.status !== 401 && err.status !== 0) toast('Download failed: ' + err.message); }
    return;
  }
  const mi = ev.target.closest('.mi-main');
  if (mi && !mi.disabled) { closePop(true); if (mi.dataset.id !== S.settings.model) setSetting({ model: mi.dataset.id }); }
});
modelMenu.addEventListener('keydown', ev => {
  if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
  const items = $$('button:not(:disabled)', modelMenu), i = items.indexOf(document.activeElement);
  if (!items.length) return;
  ev.preventDefault();
  items[(i + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
});

/* context meter */
function renderCtx() {
  const u = V.usage || {}, max = u.ctxMax || S.settings.numCtx || 0, used = u.ctxUsed || 0;
  const f = max ? Math.min(1, used / max) : 0, C = 2 * Math.PI * 9;
  const ring = $('#ctxRing');
  ring.style.strokeDasharray = (f * C).toFixed(2) + ' ' + C.toFixed(2);
  $('#ctx').dataset.lvl = f > 0.9 ? 'hi' : f > 0.7 ? 'mid' : 'lo';
  const pct = Math.round(f * 100);
  $('#ctxText').textContent = (max ? pct + '%' : '') + (u.tps ? (max ? ' · ' : '') + u.tps.toFixed(1) + ' t/s' : '');
  const tip = 'Context: ' + fmtNum(used) + ' / ' + fmtNum(max) + ' tokens (' + pct + '%)' +
    (u.promptTokens != null ? '\nPrompt: ' + fmtNum(u.promptTokens) + ' tokens' : '') +
    (u.genTokens != null ? '\nGenerated: ' + fmtNum(u.genTokens) + ' tokens' : '') +
    (u.tps ? '\nSpeed: ' + u.tps.toFixed(1) + ' tok/s' : '');
  $('#ctx').title = tip;
  $('#ctx').setAttribute('aria-label', tip.replace(/\n/g, '. '));
}

/* ------------------------------------------------------------------ sidebar */
let sessSig = '', renaming = null, sessDirty = false;
function currentSessions() { return S.sessions.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0)); }
function renderSessions(force) {
  if (renaming) { sessDirty = true; return; }
  const list = currentSessions();
  const sig = JSON.stringify([list.map(s => [s.id, s.title, relTime(s.updated)]), V.id, Array.from(runningIds)]);
  if (sig === sessSig && !force) return;
  sessSig = sig;
  const box = $('#sessions');
  box.textContent = '';
  if (!list.length) { box.appendChild(el('div', 'sess-empty', 'No chats yet')); return; }
  let grp = '';
  const frag = document.createDocumentFragment();
  list.forEach(s => {
    const g = groupOf(s.updated);
    if (g !== grp) { grp = g; frag.appendChild(el('div', 'sess-grp', esc(g))); }
    const row = el('div', 's-item' + (s.id === V.id ? ' active' : '') + (runningIds.has(s.id) ? ' busy' : ''));
    row.dataset.id = s.id;
    row.innerHTML = '<button class="s-main" type="button" data-act="open"><span class="s-run" aria-hidden="true"></span><span class="s-title"></span><span class="s-time"></span></button>' +
      '<span class="s-acts"><button class="icon-btn sm" type="button" data-act="rename" aria-label="Rename chat">' + icon('pencil', 13) + '</button>' +
      '<button class="icon-btn sm" type="button" data-act="delete" aria-label="Delete chat">' + icon('trash', 13) + '</button></span>';
    $('.s-title', row).textContent = s.title || 'New chat';
    $('.s-time', row).textContent = relTime(s.updated);
    if (s.id === V.id) $('.s-main', row).setAttribute('aria-current', 'true');
    frag.appendChild(row);
  });
  box.appendChild(frag);
}
$('#sessions').addEventListener('click', ev => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const row = b.closest('.s-item'), id = row.dataset.id;
  if (b.dataset.act === 'open') { openSession(id); if (mqSb.matches) setSb(false); }
  else if (b.dataset.act === 'rename') startRename(id, row);
  else if (b.dataset.act === 'delete') {
    if (b.classList.contains('armed')) deleteSession(id);
    else {
      b.classList.add('armed'); b.innerHTML = icon('check', 13); b.setAttribute('aria-label', 'Confirm delete');
      setTimeout(() => { if (b.isConnected) { b.classList.remove('armed'); b.innerHTML = icon('trash', 13); b.setAttribute('aria-label', 'Delete chat'); } }, 3000);
    }
  }
});
function startRename(id, row) {
  const s = S.sessions.find(x => x.id === id);
  const t = $('.s-title', row);
  const inp = el('input', 'rename-in');
  inp.value = s ? (s.title || '') : ''; inp.setAttribute('aria-label', 'Chat title'); inp.maxLength = 120;
  t.replaceWith(inp);
  renaming = id;
  inp.focus(); inp.select();
  let done = false;
  const finish = async commit => {
    if (done) return; done = true;
    renaming = null;
    const v = inp.value.trim();
    if (commit && v && s && v !== s.title) {
      const old = s.title; s.title = v; if (V.id === id) setTitle(v);
      try { await api('/api/sessions/' + encodeURIComponent(id) + '/rename', { body: { title: v } }); }
      catch (err) { s.title = old; if (V.id === id) setTitle(old); if (err.status !== 401 && err.status !== 0) toast('Rename failed: ' + err.message); }
    }
    renderSessions(true);
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } });
  inp.addEventListener('blur', () => finish(true));
}
async function deleteSession(id) {
  deletedIds.add(id);                                   // never resurrect it from a poll
  S.sessions = S.sessions.filter(x => x.id !== id);
  runningIds.delete(id);
  if (V.id === id) { const next = currentSessions()[0]; if (next) openSession(next.id); else newChat(true); }
  renderSessions(true);
  try { await api('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' }); }
  catch (err) {
    if (err.status === 401 || err.status === 404) return;
    deletedIds.delete(id);                              // genuinely failed (server down / 5xx): bring it back
    toast('Delete failed: ' + err.message);
    pollState();
  }
}
function setTitle(t) { V.title = t || ''; document.title = (t ? t + ' — ' : '') + 'ExitAI'; const c = $('#chatTitle'); c.textContent = t || 'New chat'; c.title = t || ''; c.classList.toggle('muted', !t); }

function renderFoot() {
  const g = S.gpu;
  $('#gpuBox').hidden = !g;
  if (g) {
    const f = g.totalMB ? Math.min(1, g.usedMB / g.totalMB) : 0;
    $('#gpuName').textContent = g.name || '';
    $('#gpuVal').textContent = (g.usedMB / 1024).toFixed(1) + ' / ' + (g.totalMB / 1024).toFixed(1) + ' GB';
    const b = $('#gpuBar'); b.style.width = (f * 100).toFixed(1) + '%'; b.className = f > 0.92 ? 'hi' : f > 0.8 ? 'mid' : '';
    $('#gpuBox .bar').setAttribute('aria-valuenow', Math.round(f * 100));
  }
  const o = S.ollama;
  $('#ollDot').className = 'dot ' + (o ? (o.up ? 'ok' : 'bad') : '');
  $('#ollText').textContent = o ? (o.up ? 'Ollama' + (o.version ? ' ' + o.version : '') : 'Ollama is offline') : 'Ollama';
  const ld = $('#ollLoaded');
  const loaded = (o && o.loaded) || [];
  ld.innerHTML = '';
  if (o && o.up) {
    if (!loaded.length) ld.appendChild(el('div', 'small', 'No model loaded'));
    loaded.forEach(m => {
      const r = el('div', 'ld');
      r.innerHTML = '<span class="ld-n"></span><span class="ld-v"></span>';
      r.firstChild.textContent = m.name;
      r.lastChild.textContent = m.vramGB != null ? m.vramGB.toFixed(1) + ' GB VRAM' : (m.sizeGB ? m.sizeGB.toFixed(1) + ' GB' : '');
      r.title = m.name + (m.until ? ' · until ' + m.until : '');
      ld.appendChild(r);
    });
  }
  const p = S.pull || {};
  $('#pullBox').hidden = !p.active;
  if (p.active) {
    $('#pullName').textContent = p.model || 'model';
    $('#pullPct').textContent = Math.round(p.percent || 0) + '%';
    $('#pullBar').style.width = Math.max(0, Math.min(100, p.percent || 0)) + '%';
    $('#pullBox .bar').setAttribute('aria-valuenow', Math.round(p.percent || 0));
    $('#pullText').textContent = p.text || '';
  }
}

/* ------------------------------------------------------------------ layout (sidebar / right panel) */
const mqSb = window.matchMedia('(max-width: 960px)'), mqRp = window.matchMedia('(max-width: 1100px)');
let ui = { sb: 1, rp: 0, tab: 'plan', st: 'console', ht: 0 };
try { Object.assign(ui, JSON.parse(LS.get('exitai_ui') || '{}')); } catch (_) {}
function saveUi() { LS.set('exitai_ui', JSON.stringify(ui)); }
function updateScrim() {
  const on = (mqSb.matches && app.classList.contains('sb-open')) || (mqRp.matches && app.classList.contains('rp-open'));
  app.classList.toggle('scrim-on', on);
}
function setSb(open, persist) {
  app.classList.toggle('sb-open', !!open);
  if (persist && !mqSb.matches) { ui.sb = open ? 1 : 0; saveUi(); }
  $('#btnSb').setAttribute('aria-expanded', !!open);
  updateScrim();
}
function setRp(open, persist) {
  app.classList.toggle('rp-open', !!open);
  if (persist && !mqRp.matches) { ui.rp = open ? 1 : 0; saveUi(); }
  $('#btnRp').setAttribute('aria-expanded', !!open);
  if (open) { $('#rpDot').hidden = true; if (ui.tab === 'browser') browserOpened(); else if (ui.tab === 'files') filesOpened(); }
  updateScrim();
}
function toggleSb() { setSb(!app.classList.contains('sb-open'), true); }
function toggleRp() { setRp(!app.classList.contains('rp-open'), true); }
mqSb.addEventListener('change', () => { if (mqSb.matches) setSb(false); else setSb(!!ui.sb); });
mqRp.addEventListener('change', () => { if (mqRp.matches) setRp(false); else setRp(!!ui.rp); });
setSb(!mqSb.matches && !!ui.sb);
setRp(!mqRp.matches && !!ui.rp);
$('#btnSb').addEventListener('click', toggleSb);
$('#btnSbClose').addEventListener('click', () => setSb(false, true));
$('#btnRp').addEventListener('click', toggleRp);
$('#btnRpClose').addEventListener('click', () => setRp(false, true));
$('#scrim').addEventListener('click', () => { if (mqSb.matches) setSb(false); if (mqRp.matches) setRp(false); });

function setTab(t, persist) {
  ui.tab = t;
  $$('.tab').forEach(b => { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  $('#panePlan').hidden = t !== 'plan';
  $('#paneBr').hidden = t !== 'browser';
  $('#paneFiles').hidden = t !== 'files';
  if (persist) saveUi();
  if (t === 'browser') { $('#brDot').hidden = true; browserOpened(); }
  else if (t === 'files' && app.classList.contains('rp-open')) filesOpened();
}
$$('.tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab, true)));
setTab(ui.tab === 'browser' || ui.tab === 'files' ? ui.tab : 'plan');

/* ------------------------------------------------------------------ browser panel */
function panelVisible() { return app.classList.contains('rp-open') && ui.tab === 'browser'; }
function browserOpened() { fetchBrowser(); }
function scheduleBrowser() { clearTimeout(B.timer); B.timer = setTimeout(fetchBrowser, 450); }
async function fetchBrowser() {
  if (B.busy) { scheduleBrowser(); return; }
  B.busy = true;
  try { B.data = await api('/api/browser'); renderBrowser(); }
  catch (err) { if (err.status !== 401 && err.status !== 0) { B.data = null; renderBrowser(); } }
  finally { B.busy = false; }
}
function onBrowserEvent(ev) {
  B.info = ev;
  renderBrowserHead();
  if (panelVisible()) scheduleBrowser();
  else if (ev.open && (ev.errorCount > 0 || ev.consoleCount > 0)) $('#brDot').hidden = false;
}
function setBadge(id, n, text) { const b = $('#' + id); b.hidden = !n; b.textContent = text; }
function renderBrowserHead() {
  const d = B.data, i = B.info || {};
  const open = d ? d.open !== false : (i.open !== false && !!B.info);
  const url = (d && d.url) || i.url || '', title = (d && d.title) || i.title || '';
  $('#brState').className = 'dot ' + (open ? 'ok' : '');
  $('#brTitle').textContent = open ? (title || 'Browser') : 'Browser closed';
  $('#brUrl').textContent = open ? url : '';
  $('#brUrl').title = url;
  const nc = d && d.console ? d.console.length : (i.consoleCount || 0);
  const ne = d && d.console ? d.console.filter(c => c.level === 'error' || c.level === 'exception').length : (i.errorCount || 0);
  const nn = d && d.network ? d.network.length : (i.networkCount || 0);
  setBadge('bgErr', open && ne, ne + (ne === 1 ? ' error' : ' errors'));
  setBadge('bgCon', open && nc, nc + ' logs');
  setBadge('bgNet', open && nn, nn + ' req');
  $('#cCon').textContent = nc || ''; $('#cNet').textContent = nn || '';
}
function tStr(t) {
  if (!t) return '';
  if (t > 1e11) { const d = new Date(t); return d.toTimeString().slice(0, 8); }
  return '+' + fmtMs(t);
}
function renderBrowser() {
  renderBrowserHead();
  const d = B.data, open = d ? d.open !== false : false;
  $('#brClosed').hidden = open;
  $$('#brBody > .view').forEach(v => { v.hidden = !open || v.dataset.v !== ui.st; });
  $$('.stab').forEach(b => { const on = b.dataset.st === ui.st; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  if (!open) return;
  if (ui.st === 'console') {
    const box = $('#vConsole'), atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const rows = (d.console || []).slice(-500);
    box.innerHTML = rows.length ? rows.map(c => {
      const lv = c.level === 'exception' ? 'error' : (c.level || 'log');
      return '<div class="cl l-' + esc(lv) + '"><span class="cl-t">' + esc(tStr(c.t)) + '</span><span class="cl-m">' + esc(c.text) + '</span>' + (c.src ? '<span class="cl-s">' + esc(c.src) + '</span>' : '') + '</div>';
    }).join('') : '<div class="pane-empty"><p>No console output.</p></div>';
    if (atEnd) box.scrollTop = box.scrollHeight;
  } else if (ui.st === 'network') {
    const rows = (d.network || []).slice(-400);
    $('#vNetwork').innerHTML = rows.length ? rows.map(r => {
      const s = r.failed ? 'ERR' : (r.status || '…'), cls = r.failed || r.status >= 500 ? 'bad' : r.status >= 400 ? 'warn' : r.status >= 300 ? 'mute' : 'ok';
      return '<div class="nr"><span class="n-s ' + cls + '">' + esc(s) + '</span><span class="n-m">' + esc(r.method || '') + '</span><span class="n-u" title="' + esc(r.url) + '">' + esc(r.url) + '</span><span class="n-x">' + esc(r.type || '') + '</span><span class="n-ms">' + (r.ms != null ? esc(fmtMs(r.ms)) : '') + '</span></div>';
    }).join('') : '<div class="pane-empty"><p>No network requests.</p></div>';
  } else if (ui.st === 'tree') {
    $('#vTree').textContent = d.tree || '(empty)';
  } else if (ui.st === 'shot') loadShot();
}
function loadShot() {
  const img = $('#shotImg'), msg = $('#shotMsg');
  img.onload = () => { img.hidden = false; msg.hidden = true; };
  img.onerror = () => { img.hidden = true; msg.hidden = false; msg.innerHTML = '<p>No screenshot available.</p>'; };
  msg.hidden = img.hidden; if (img.hidden) msg.innerHTML = '<span class="spin"></span>';
  img.src = '/api/browser/screenshot?k=' + encodeURIComponent(TOKEN) + '&c=' + Date.now();
}
$$('.stab').forEach(b => b.addEventListener('click', () => { ui.st = b.dataset.st; saveUi(); if (B.data) renderBrowser(); else fetchBrowser(); }));
$('#shotRefresh').addEventListener('click', loadShot);
$$('#brBody > .view').forEach((v, i) => { v.dataset.v = ['console', 'network', 'tree', 'shot'][i]; });
if (!['console', 'network', 'tree', 'shot'].includes(ui.st)) ui.st = 'console';

/* ------------------------------------------------------------------ files panel (v2) */
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|json|py|rb|go|rs|c|h|cpp|hpp|cs|java|kt|php|sh|bat|cmd|ps1|html?|css|scss|xml|ya?ml|toml|ini|sql|lua|md)$/i;
const flRows = $('#flRows'), flNew = $('#flNew'), fvText = $('#fvText');
function joinPath(dir, name) { return dir ? dir.replace(/[\\/]+$/, '') + '\\' + name : name; }
function baseName(p) { const t = String(p).replace(/[\\/]+$/, ''); const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/')); return t && i >= 0 ? t.slice(i + 1) : String(p); }
function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  return (n / 1073741824).toFixed(1) + ' GB';
}
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms), n = new Date();
  if (d.toDateString() === n.toDateString()) return d.toTimeString().slice(0, 5);
  return d.toLocaleDateString(undefined, d.getFullYear() === n.getFullYear() ? { month: 'short', day: 'numeric' } : { year: '2-digit', month: 'short', day: 'numeric' });
}
const fsRaw = (p, dl) => '/api/fs/raw?path=' + encodeURIComponent(p) + '&k=' + encodeURIComponent(TOKEN) + (dl ? '&dl=1' : '');
async function fsCall(path, body) {
  try { return await api(path, body !== undefined ? { body } : {}); }
  catch (err) { if (err.status !== 401 && err.status !== 0) toast(err.message || 'Request failed'); return null; }
}
function filesVisible() { return app.classList.contains('rp-open') && ui.tab === 'files'; }
function filesOpened() {
  if (!FS.loaded) { if (S.settings.workspace !== undefined) fsLoad(S.settings.workspace || ''); }
  else renderFiles();
}
function showFlView(v) {
  FS.view = v;
  $('#flList').hidden = v !== 'list';
  $('#flView').hidden = v !== 'file';
}

/* --- listing --- */
async function fsLoad(path, keepFilter) {
  const my = ++FS.req;
  $('#flList').classList.add('busy');
  const d = await fsCall('/api/fs/list?path=' + encodeURIComponent(path || ''));
  if (my !== FS.req) return;
  $('#flList').classList.remove('busy');
  if (!d) {
    if (FS.dir === null) { FS.dir = ''; FS.entries = []; FS.loaded = true; renderFiles(); fsLoad(''); }
    return;
  }
  FS.dir = d.path || ''; FS.parent = d.parent == null ? null : d.parent;
  FS.entries = d.entries || []; FS.truncated = !!d.truncated; FS.loaded = true;
  if (!keepFilter) { FS.filter = ''; $('#flFilter').value = ''; }
  cancelInline();
  renderFiles();
  if (!keepFilter) flRows.scrollTop = 0;
}
function crumbs() {
  const p = FS.dir || '', out = [];
  const unc = p.startsWith('\\\\');
  const parts = p.split(/[\\/]+/).filter(Boolean);
  let acc = unc ? '\\\\' : '';
  parts.forEach((part, i) => {
    const drive = i === 0 && !unc && /^[A-Za-z]:$/.test(part);
    acc = acc && !acc.endsWith('\\') ? acc + '\\' + part : acc + part;
    if (drive) acc += '\\';
    out.push({ name: drive ? part + '\\' : part, path: acc });
  });
  return out;
}
function renderFiles() {
  const root = FS.dir === '' || FS.dir === null;
  $('#flUp').disabled = root;
  $('#flNewFile').disabled = $('#flNewDir').disabled = $('#flWs').disabled = $('#flAttDir').disabled = root;
  const cr = $('#flCrumb');
  cr.innerHTML = '<button type="button" data-p="">This PC</button>' + crumbs().map(c => '<i aria-hidden="true">›</i><button type="button" data-p="' + esc(c.path) + '">' + esc(c.name) + '</button>').join('');
  cr.scrollLeft = cr.scrollWidth;
  renderPick();
  renderRows();
}
function renderRows() {
  const f = FS.filter.trim().toLowerCase();
  FS.shown = f ? FS.entries.filter(e => e.name.toLowerCase().includes(f)) : FS.entries;
  if (!FS.shown.length) {
    flRows.innerHTML = '<div class="pane-empty"><p>' + (f ? 'No matches.' : FS.dir === '' ? 'No drives found.' : 'This folder is empty.') + '</p></div>';
    return;
  }
  const pick = FS.picker, root = FS.dir === '';
  let h = '';
  for (let i = 0; i < FS.shown.length; i++) {
    const e = FS.shown[i], path = joinPath(FS.dir, e.name);
    const added = e.dir ? hasAtt('folder', path) : hasAtt('file', path);
    const ic = e.dir ? (root ? 'drive' : 'folder') : IMG_EXT.test(e.name) ? 'image' : CODE_EXT.test(e.name) ? 'code' : 'file';
    let act = '';
    if (pick) {
      if ((pick === 'folder') === !!e.dir) act = '<span class="fr-a pk"><button class="btn sm' + (added ? '' : ' ok') + '" type="button" data-a="add"' + (added ? ' disabled' : '') + '>' + (added ? 'Added' : 'Add') + '</button></span>';
    } else {
      act = '<span class="fr-a"><button class="icon-btn sm" type="button" data-a="attach" aria-label="Attach to chat" title="Attach to chat">' + icon('clip', 14) + '</button>' +
        (root ? '' : '<button class="icon-btn sm" type="button" data-a="rename" aria-label="Rename" title="Rename">' + icon('pencil', 14) + '</button><button class="icon-btn sm" type="button" data-a="delete" aria-label="Delete" title="Delete (Recycle Bin)">' + icon('trash', 14) + '</button>') +
        '<button class="icon-btn sm" type="button" data-a="reveal" aria-label="Reveal in Explorer" title="Reveal in Explorer">' + icon('reveal', 14) + '</button></span>';
    }
    h += '<div class="fr' + (e.dir ? ' dir' : '') + (added ? ' added' : '') + '" role="listitem" tabindex="0" data-i="' + i + '"><span class="fi">' + icon(ic, 16) + '</span><span class="fr-n" title="' + esc(e.name) + '">' + esc(e.name) + '</span><span class="fr-s">' + (e.dir ? '' : fmtSize(e.size)) + '</span><span class="fr-d">' + fmtDate(e.mtime) + '</span>' + act + '</div>';
  }
  if (FS.truncated) h += '<div class="fr-note">List truncated. Use the filter or open a subfolder.</div>';
  flRows.innerHTML = h;
}
flRows.addEventListener('click', ev => {
  const row = ev.target.closest('.fr');
  if (!row || row.classList.contains('editing')) return;
  const e = FS.shown[+row.dataset.i];
  if (!e) return;
  const path = joinPath(FS.dir, e.name), btn = ev.target.closest('[data-a]');
  if (btn) { rowAction(btn, btn.dataset.a, e, path, row); return; }
  if (e.dir) fsLoad(path);
  else if (FS.picker === 'file') { if (addAtt('file', path)) { FS.picked++; renderPick(); renderRows(); } }
  else fsOpen(path);
});
flRows.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.classList && ev.target.classList.contains('fr')) ev.target.click(); });
function rowAction(btn, a, e, path, row) {
  if (a === 'add') {
    if (addAtt(e.dir ? 'folder' : 'file', path)) FS.picked++;
    if (FS.picker === 'folder') exitPicker(); else { renderPick(); renderRows(); }
  } else if (a === 'attach') { if (addAtt(e.dir ? 'folder' : 'file', path)) toast('Added to your message: ' + e.name, 'info', 2200); }
  else if (a === 'reveal') fsCall('/api/fs/reveal', { path });
  else if (a === 'rename') startRename(row, e, path);
  else if (a === 'delete') {
    if (btn.classList.contains('armed')) {
      fsCall('/api/fs/delete', { path }).then(r => { if (r) { toast('Moved to the Recycle Bin: ' + e.name, 'info', 2500); fsLoad(FS.dir, true); } });
    } else {
      btn.classList.add('armed'); btn.innerHTML = icon('check', 14); btn.setAttribute('aria-label', 'Confirm delete');
      row.classList.add('arming');
      setTimeout(() => { if (btn.isConnected) { btn.classList.remove('armed'); btn.innerHTML = icon('trash', 14); btn.setAttribute('aria-label', 'Delete'); row.classList.remove('arming'); } }, 3000);
    }
  }
}
function startRename(row, e, path) {
  const n = $('.fr-n', row), inp = el('input', 'rename-in');
  inp.value = e.name; inp.setAttribute('aria-label', 'New name');
  n.replaceWith(inp); row.classList.add('editing'); inp.focus();
  const dot = e.name.lastIndexOf('.');
  inp.setSelectionRange(0, e.dir || dot <= 0 ? e.name.length : dot);
  let done = false;
  const fin = async ok => {
    if (done) return; done = true;
    const v = inp.value.trim();
    if (ok && v && v !== e.name) {
      const r = await fsCall('/api/fs/rename', { path, to: joinPath(FS.dir, v) });
      if (r) { fsLoad(FS.dir, true); return; }
    }
    renderRows();
  };
  inp.addEventListener('keydown', k => { if (k.key === 'Enter') { k.preventDefault(); fin(true); } else if (k.key === 'Escape') { k.preventDefault(); k.stopPropagation(); fin(false); } });
  inp.addEventListener('blur', () => fin(false));
}
function cancelInline() { flNew.hidden = true; flNew.textContent = ''; }
function startCreate(kind) {
  if (!FS.dir) return;
  flNew.hidden = false;
  flNew.innerHTML = '<span class="fi">' + icon(kind === 'dir' ? 'folder' : 'file', 16) + '</span>';
  const inp = el('input', 'rename-in');
  inp.placeholder = kind === 'dir' ? 'New folder name' : 'New file name';
  inp.setAttribute('aria-label', inp.placeholder);
  flNew.appendChild(inp); inp.focus();
  let done = false;
  const fin = async ok => {
    if (done) return; done = true;
    const v = inp.value.trim();
    cancelInline();
    if (!ok || !v) return;
    const path = joinPath(FS.dir, v);
    const r = kind === 'dir' ? await fsCall('/api/fs/mkdir', { path }) : await fsCall('/api/fs/write', { path, content: '' });
    if (!r) return;
    await fsLoad(FS.dir, true);
    if (kind === 'file') fsOpen(path);
  };
  inp.addEventListener('keydown', k => { if (k.key === 'Enter') { k.preventDefault(); fin(true); } else if (k.key === 'Escape') { k.preventDefault(); k.stopPropagation(); fin(false); } });
  inp.addEventListener('blur', () => fin(false));
}
$('#flNewFile').addEventListener('click', () => startCreate('file'));
$('#flNewDir').addEventListener('click', () => startCreate('dir'));
$('#flUp').addEventListener('click', () => { if (FS.dir) fsLoad(FS.parent == null ? '' : FS.parent); });
$('#flDrives').addEventListener('click', () => fsLoad(''));
$('#flRefresh').addEventListener('click', () => fsLoad(FS.dir || '', true));
$('#flCrumb').addEventListener('click', ev => { const b = ev.target.closest('button[data-p]'); if (b) fsLoad(b.dataset.p); });
$('#flFilter').addEventListener('input', e => { FS.filter = e.target.value; cancelAnimationFrame(FS.rf); FS.rf = requestAnimationFrame(renderRows); });
$('#flFilter').addEventListener('keydown', e => { if (e.key === 'Escape' && e.target.value) { e.stopPropagation(); e.target.value = ''; FS.filter = ''; renderRows(); } });
$('#flWs').addEventListener('click', () => { if (FS.dir) { setSetting({ workspace: FS.dir }); toast('Workspace set to ' + FS.dir, 'info', 2500); } });
$('#flAttDir').addEventListener('click', () => { if (FS.dir && addAtt('folder', FS.dir)) toast('Folder added to your message', 'info', 2200); });

/* --- preview / editor --- */
async function fsOpen(path) {
  const d = await fsCall('/api/fs/read?path=' + encodeURIComponent(path));
  if (!d) return;
  if (!d.path) d.path = path;
  FS.file = d; FS.dirty = false; FS.discard = false;
  showFlView('file');
  $('#fvName').textContent = d.name || baseName(path);
  $('#fvName').title = d.path;
  const text = d.kind === 'text', img = d.kind === 'image', ro = text && !!d.truncated;
  fvText.hidden = !text; $('#fvImg').hidden = !img; $('#fvBin').hidden = text || img;
  $('#fvSave').hidden = !text || ro;
  const note = $('#fvNote');
  note.hidden = !ro;
  if (ro) note.textContent = 'Large file: showing the first part only. Truncated, read-only.';
  if (text) { fvText.value = d.content || ''; fvText.readOnly = ro; fvText.scrollTop = 0; fvText.scrollLeft = 0; }
  if (img) { const im = $('#fvImg img'); im.removeAttribute('src'); im.src = fsRaw(d.path); }
  if (!text && !img) {
    const b = $('#fvBin');
    b.innerHTML = '<div class="pane-empty" style="padding:0">' + icon('file', 26) + '<p>' + esc(d.name || '') + '</p><small>Binary file · ' + esc(fmtSize(d.size)) + (d.mtime ? ' · ' + esc(fmtDate(d.mtime)) : '') + '</small></div>' +
      '<div class="fv-bin-a"><a class="btn" download href="' + esc(fsRaw(d.path, true)) + '">' + icon('download', 13) + 'Download</a><button class="btn" type="button" id="fvBinReveal">' + icon('reveal', 13) + 'Reveal in Explorer</button></div>';
    $('#fvBinReveal').addEventListener('click', () => fsCall('/api/fs/reveal', { path: d.path }));
  }
  updateFv();
}
function updateFv() {
  const d = FS.file;
  if (!d) return;
  $('#fvDirty').hidden = !FS.dirty;
  $('#fvSave').disabled = !FS.dirty;
  $('#fvInfo').textContent = d.kind === 'text' ? fmtNum((fvText.value.match(/\n/g) || []).length + 1) + ' lines · ' + fmtSize(d.size) : fmtSize(d.size);
}
fvText.addEventListener('input', () => {
  FS.dirty = fvText.value !== (FS.file.content || ''); FS.discard = false;
  updateFv();
});
async function fsSave() {
  const d = FS.file;
  if (!d || d.kind !== 'text' || d.truncated || !FS.dirty) return;
  const content = fvText.value;
  $('#fvSave').disabled = true;
  const r = await fsCall('/api/fs/write', { path: d.path, content });
  if (!r) { $('#fvSave').disabled = false; return; }
  d.content = content; if (r.size != null) d.size = r.size;
  FS.dirty = fvText.value !== content;
  updateFv();
  toast('Saved ' + (d.name || ''), 'info', 1800);
}
$('#fvSave').addEventListener('click', fsSave);
$('#fvBack').addEventListener('click', () => {
  if (FS.dirty && !FS.discard) { FS.discard = true; toast('Unsaved changes. Press Back again to discard them.', 'info', 3000); return; }
  FS.file = null; FS.dirty = false; showFlView('list'); fsLoad(FS.dir || '', true);
});
$('#fvAtt').addEventListener('click', () => { if (FS.file && addAtt('file', FS.file.path)) toast('Added to your message', 'info', 2000); });
$('#fvReveal').addEventListener('click', () => { if (FS.file) fsCall('/api/fs/reveal', { path: FS.file.path }); });
window.addEventListener('beforeunload', e => { if (FS.dirty) { e.preventDefault(); e.returnValue = ''; } });

/* --- picker mode (used by the composer buttons) --- */
function openPicker(mode) {
  FS.picker = mode; FS.picked = 0;
  setRp(true); setTab('files');
  if (FS.view !== 'list' && !FS.dirty) showFlView('list');
  filesOpened(); renderPick(); if (FS.loaded) renderRows();
}
function exitPicker() { FS.picker = null; renderPick(); renderRows(); }
function renderPick() {
  const m = FS.picker, b = $('#pickBanner');
  b.hidden = !m;
  if (!m) return;
  $('#pickText').textContent = m === 'folder' ? 'Choose a folder to give the assistant access' : 'Choose files to attach';
  const add = $('#pickAdd');
  add.hidden = m !== 'folder'; add.disabled = !FS.dir;
  const done = m === 'file' && FS.picked > 0;
  $('#pickCancel').textContent = done ? 'Done' : 'Cancel';
  $('#pickCancel').className = 'btn sm' + (done ? ' ok' : '');
}
$('#pickCancel').addEventListener('click', exitPicker);
$('#pickAdd').addEventListener('click', () => { if (!FS.dir) return; if (addAtt('folder', FS.dir)) toast('Folder added to your message', 'info', 2200); exitPicker(); });

/* --- uploads (drag and drop from Explorer) --- */
const readDataURL = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
function showUp(t) { $('#upPill').hidden = !t; if (t) $('#upText').textContent = t; }
function dropFiles(dt) {
  const files = [];
  let dirs = 0;
  const items = dt.items ? Array.from(dt.items) : [];
  if (items.length && items[0].webkitGetAsEntry) {
    items.forEach(it => {
      if (it.kind !== 'file') return;
      const en = it.webkitGetAsEntry();
      if (en && en.isDirectory) dirs++; else { const f = it.getAsFile(); if (f) files.push(f); }
    });
  } else Array.from(dt.files).forEach(f => files.push(f));
  if (dirs) toast('Folders cannot be uploaded. Use "Add folder" to give the assistant access to a folder.', 'info', 5000);
  return files;
}
async function uploadFiles(files, dir, onEach) {
  let ok = 0, i = 0;
  for (const f of files) {
    i++;
    if (f.size > 50 * 1024 * 1024) { toast(f.name + ' is larger than 50 MB'); continue; }
    showUp('Uploading ' + i + '/' + files.length + ': ' + f.name);
    try {
      const body = { name: f.name, data: await readDataURL(f) };
      if (dir) body.dir = dir;
      const r = await api('/api/upload', { body });
      ok++;
      if (onEach && r && r.path) onEach(r.path, f);
    } catch (err) {
      if (err.status === 401 || err.status === 0) break;
      toast('Upload failed: ' + f.name + ' (' + err.message + ')');
    }
  }
  showUp('');
  return ok;
}
function hasFiles(e) { return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'); }
let dragMain = 0, dragFl = 0;
function clearDrag() { dragMain = dragFl = 0; $('#dropOv').hidden = true; $('#flDrop').hidden = true; }
document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', e => { if (hasFiles(e)) e.preventDefault(); clearDrag(); });
document.addEventListener('dragend', clearDrag);
const mainEl = $('#main');
mainEl.addEventListener('dragenter', e => { if (hasFiles(e)) { dragMain++; $('#dropOv').hidden = false; } });
mainEl.addEventListener('dragleave', e => { if (hasFiles(e) && --dragMain <= 0) { dragMain = 0; $('#dropOv').hidden = true; } });
mainEl.addEventListener('drop', async e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); clearDrag();
  const files = dropFiles(e.dataTransfer);
  if (!files.length) return;
  const n = await uploadFiles(files, '', p => addAtt('file', p));
  if (n) { toast(n + (n === 1 ? ' file' : ' files') + ' attached', 'info', 2200); input.focus(); }
});
const flList = $('#flList');
flList.addEventListener('dragenter', e => { if (hasFiles(e) && FS.dir) { dragFl++; $('#flDrop').hidden = false; } });
flList.addEventListener('dragleave', e => { if (hasFiles(e) && --dragFl <= 0) { dragFl = 0; $('#flDrop').hidden = true; } });
flList.addEventListener('drop', async e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); clearDrag();
  if (!FS.dir) { toast('Open a folder first, then drop files into it', 'info'); return; }
  const files = dropFiles(e.dataTransfer);
  if (!files.length) return;
  const dir = FS.dir;
  const n = await uploadFiles(files, dir);
  if (n) { toast(n + (n === 1 ? ' file' : ' files') + ' uploaded to ' + baseName(dir), 'info', 2500); if (FS.dir === dir) fsLoad(dir, true); }
});

/* --- composer attachment chips (folders / files by path) --- */
function hasAtt(type, path) { const p = String(path).toLowerCase(); return fileAtts.some(a => a.type === type && a.path.toLowerCase() === p); }
function addAtt(type, path) {
  if (hasAtt(type, path)) return false;
  if (fileAtts.length >= 20) { toast('Up to 20 attachments per message', 'info'); return false; }
  fileAtts.push({ type, path });
  renderChips();
  return true;
}
function chipHtml(a, removable, i) {
  const n = baseName(a.path);
  return '<span class="achip ' + (a.type === 'folder' ? 'folder' : 'file') + '" title="' + esc(a.path) + '">' + icon(a.type === 'folder' ? 'folder' : 'file', 13) + '<span class="achip-n">' + esc(n) + '</span>' +
    (removable ? '<button type="button" class="achip-x" data-i="' + i + '" aria-label="Remove ' + esc(n) + '">' + icon('x', 11) + '</button>' : '') + '</span>';
}
function renderChips() {
  const b = $('#chipBar');
  b.hidden = !fileAtts.length;
  b.innerHTML = fileAtts.map((a, i) => chipHtml(a, true, i)).join('');
  updateSend();
}
$('#chipBar').addEventListener('click', e => {
  const x = e.target.closest('.achip-x');
  if (!x) return;
  fileAtts.splice(+x.dataset.i, 1);
  renderChips();
  if (FS.picker) renderRows();
  input.focus();
});
$('#btnAddFolder').addEventListener('click', () => openPicker('folder'));
$('#btnAttachFile').addEventListener('click', () => openPicker('file'));

/* --- hide thinking --- */
function applyThink() {
  app.classList.toggle('hide-think', !!ui.ht);
  $('#showThinkSw').checked = !ui.ht;
}

/* ------------------------------------------------------------------ run state + composer */
const input = $('#input'), btnSend = $('#btnSend'), btnStop = $('#btnStop'), cmpBox = $('#cmpBox');
function setRunning(r) {
  V.running = r;
  btnStop.hidden = !r;
  btnStop.disabled = false;
  btnStop.lastChild.textContent = 'Stop';
  input.disabled = r;
  input.placeholder = r ? 'Working… press Esc to stop' : 'Message ExitAI';
  cmpBox.classList.toggle('busy', r);
  updateSend();
  if (!r && document.activeElement === document.body) input.focus();
}
function updateSend() {
  if (V.running) {
    btnSend.disabled = false; btnSend.classList.add('is-stop');
    btnSend.innerHTML = icon('stop', 14); btnSend.setAttribute('aria-label', 'Stop');
  } else {
    btnSend.classList.remove('is-stop');
    btnSend.innerHTML = icon('send', 16); btnSend.setAttribute('aria-label', 'Send');
    btnSend.disabled = !(input.value.trim() || attachments.length || fileAtts.length) || sending;
  }
}
function autoGrow() { if (!input.value) { input.style.height = ''; return; } input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; }
input.addEventListener('input', () => { autoGrow(); updateSend(); });
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
btnSend.addEventListener('click', () => { if (V.running) stopRun(); else send(); });
btnStop.addEventListener('click', stopRun);

async function stopRun() {
  if (!V.running || !V.id) return;
  btnStop.disabled = true; btnStop.lastChild.textContent = 'Stopping…';
  try { await api('/api/stop', { body: { sessionId: V.id } }); }
  catch (err) { btnStop.disabled = false; btnStop.lastChild.textContent = 'Stop'; if (err.status !== 401 && err.status !== 0) toast('Could not stop: ' + err.message); }
}

async function send(textArg) {
  const text = (textArg != null ? textArg : input.value).trim();
  if ((!text && !attachments.length && !fileAtts.length) || V.running || sending) return;
  sending = true; updateSend();
  const images = attachments.map(a => a.dataUrl);
  const atts = fileAtts.map(a => ({ type: a.type, path: a.path }));
  let entry = null;
  try {
    if (!V.id) {
      const r = await api('/api/sessions', { body: {} });
      V.id = r.id; LS.set('exitai_session', V.id);
      if (!S.sessions.some(s => s.id === r.id)) S.sessions.unshift({ id: r.id, title: '', updated: Date.now(), model: S.settings.model });
      renderSessions(true);
    }
    entry = { kind: 'user', text, images: images.length ? images : undefined, attachments: atts.length ? atts : undefined };
    stick = true;
    addEntry(entry);
    const savedText = input.value, savedAtt = attachments, savedFiles = fileAtts;
    if (textArg == null) { input.value = ''; autoGrow(); }
    attachments = []; renderAttach();
    fileAtts = []; renderChips();
    setRunning(true);
    try {
      await api('/api/chat', { body: { sessionId: V.id, text, images: images.length ? images : undefined, attachments: atts.length ? atts : undefined } });
      if (atts.some(a => a.type === 'folder')) { pollState(); setTimeout(pollState, 900); }
    } catch (err) {
      removeEntry(entry); entry = null;
      if (err.status === 409) { toast('This chat is already running', 'info'); setRunning(true); }
      else {
        setRunning(false);
        if (err.status !== 401 && err.status !== 0) toast('Send failed: ' + err.message);
        if (textArg == null) { input.value = savedText; autoGrow(); }
        attachments = savedAtt; renderAttach(); fileAtts = savedFiles; renderChips();
      }
    }
  } catch (err) {
    if (err.status !== 401 && err.status !== 0) toast('Could not start chat: ' + err.message);
  } finally { sending = false; updateSend(); }
}

/* attachments */
const attachBar = $('#attachBar'), fileIn = $('#fileIn');
function updateAttachWarn() { const m = curModel(); $('#attachWarn').hidden = !(attachments.length && m && !m.vision); }
function renderAttach() {
  attachBar.textContent = '';
  attachBar.hidden = !attachments.length;
  attachments.forEach((a, i) => {
    const t = el('div', 'thumb');
    const im = new Image(); im.src = a.dataUrl; im.alt = 'Attachment ' + (i + 1);
    const b = el('button', 'thumb-x'); b.type = 'button'; b.setAttribute('aria-label', 'Remove attachment ' + (i + 1)); b.innerHTML = icon('x', 11);
    b.addEventListener('click', () => { attachments.splice(i, 1); renderAttach(); input.focus(); });
    t.append(im, b); attachBar.appendChild(t);
  });
  updateAttachWarn(); updateSend();
}
function readImage(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => {
      const url = fr.result;
      if (file.size < 1.5e6) return resolve(url);
      const img = new Image();
      img.onerror = () => resolve(url);
      img.onload = () => {
        const sc = Math.min(1, 1600 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * sc)); c.height = Math.max(1, Math.round(img.height * sc));
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.88));
      };
      img.src = url;
    };
    fr.readAsDataURL(file);
  });
}
async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    if (attachments.length >= 6) { toast('Up to 6 images per message', 'info'); break; }
    try { attachments.push({ dataUrl: await readImage(f) }); } catch (_) { toast('Could not read image'); }
  }
  renderAttach();
}
input.addEventListener('paste', e => {
  const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter(f => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); addFiles(files); }
});
$('#btnAttach').addEventListener('click', () => fileIn.click());
fileIn.addEventListener('change', () => { addFiles(Array.from(fileIn.files)); fileIn.value = ''; });

/* empty state */
const SUGGEST = [
  { t: 'Analyze this project folder and summarize it', i: 'folder', go: 1 },
  { t: 'Open https://example.com and check the browser console for errors', i: 'globe', go: 1 },
  { t: 'Write a Python script that ', i: 'terminal', go: 0 },
  { t: 'Find the largest files on my C: drive', i: 'search', go: 1 }
];
(function () {
  const box = $('#chips');
  SUGGEST.forEach(s => {
    const b = el('button', 'sugg'); b.type = 'button';
    b.innerHTML = icon(s.i, 16) + '<span></span>';
    b.lastChild.textContent = s.go ? s.t : s.t.trim() + '…';
    b.addEventListener('click', () => {
      if (s.go) send(s.t);
      else { input.value = s.t; autoGrow(); updateSend(); input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    });
    box.appendChild(b);
  });
})();

/* ------------------------------------------------------------------ sessions: open / load / new */
function newChat(force) {
  if (!force && V.id && !V.timeline.length && !V.running) { input.focus(); return; }
  V.id = null; setTitle(''); LS.del('exitai_session');
  resetTimeline(); setRunning(false); stick = true;
  showEmptyIfNeeded(); renderSessions(true);
  if (mqSb.matches) setSb(false);
  input.focus();
}
function openSession(id) {
  if (!id) return;
  if (V.id === id && V.timeline.length) return;
  V.id = id; LS.set('exitai_session', id);
  renderSessions(true);
  return loadSession(id);
}
async function loadSession(id) {
  V.loading = true;
  let data;
  try { data = await api('/api/sessions/' + encodeURIComponent(id)); }
  catch (err) {
    V.loading = false;
    if (V.id !== id) return;
    if (err.status === 401 || err.status === 0) return;
    deletedIds.add(id);                                 // missing or unreadable: drop it quietly and move on
    S.sessions = S.sessions.filter(x => x.id !== id);
    runningIds.delete(id);
    const next = currentSessions()[0];
    if (next) openSession(next.id); else newChat(true);
    renderSessions(true);
    return;
  }
  if (V.id !== id) return;
  V.loading = false;
  resetTimeline();
  setTitle(data.title || '');
  const frag = document.createDocumentFragment();
  const list = data.timeline || [];
  list.forEach((e, i) => {
    e = Object.assign({}, e);
    if (e.kind === 'tool' && e.approval && e.approval.id && !e.approval.state) e.approval = { id: e.approval.id, reason: e.approval.reason, state: 'pending' };
    if (addEntry(e, frag) && i < list.length - 24) e.el.classList.add('cv');
  });
  tl.appendChild(frag);
  V.plan = data.plan || [];
  V.usage = data.usage || null;
  renderPlan(); renderCtx();
  if (data.model && !S.settings.model) S.settings.model = data.model;
  if (data.running) runningIds.add(id); else runningIds.delete(id);
  setRunning(!!data.running);
  if (!data.running) V.timeline.forEach(e => {   // a stale in-flight code card from an interrupted run: finalize it
    if (!e._code || !(e.streaming || e.status === 'running')) return;
    endCode(e); e._open = false;
    if (e.status === 'running') { e.status = 'error'; if (!e.output) e.output = 'Interrupted before the tool finished.'; }
    renderTool(e);
  });
  showEmptyIfNeeded();
  stick = true; scrollBottom(); jumpBtn.hidden = true;
  renderSessions(true);
}

/* ------------------------------------------------------------------ SSE */
let es = null, sseErr = false, sseSeen = false;
function connectSSE() {
  if (es) es.close();
  if (!TOKEN || is401) return;
  es = new EventSource('/api/events?t=' + encodeURIComponent(TOKEN));
  es.onopen = () => {
    if (sseSeen && sseErr) { pollState(); if (V.id) loadSession(V.id); }
    sseSeen = true; sseErr = false;
  };
  es.onmessage = m => {
    let ev; try { ev = JSON.parse(m.data); } catch (_) { return; }
    try { onEvent(ev); } catch (err) { console.error('event error', err, ev); }
  };
  es.onerror = () => {
    sseErr = true;
    if (es && es.readyState === 2) { es.close(); es = null; setTimeout(connectSSE, 2500); }
  };
}
function touchSession(id, patch) {
  const s = S.sessions.find(x => x.id === id);
  if (s) Object.assign(s, patch);
  return s;
}
function onEvent(ev) {
  const sid = ev.sessionId;
  switch (ev.type) {
    case 'browser': onBrowserEvent(ev); return;
    case 'title':
      touchSession(sid, { title: ev.title });
      if (sid === V.id) setTitle(ev.title);
      renderSessions(); return;
    case 'run_start':
      runningIds.add(sid); touchSession(sid, { updated: Date.now() });
      if (sid === V.id) { setRunning(true); }
      renderSessions(); return;
    case 'run_end':
      runningIds.delete(sid); touchSession(sid, { updated: Date.now() });
      if (sid === V.id) {
        endLive();
        if (ev.reason === 'stopped' || ev.reason === 'max_steps') {
          const last = V.timeline[V.timeline.length - 1];
          if (!last || last.kind !== 'note') addEntry({ kind: 'note', level: 'warn', text: ev.reason === 'stopped' ? 'Stopped.' : 'Reached the maximum number of steps.' });
        }
        V.timeline.forEach(e => {
          if (e.kind !== 'tool') return;
          if (e.approval && e.approval.state === 'pending') { e.approval.state = 'denied'; renderTool(e); }
          if (e._code && (e.streaming || e._lk)) { endCode(e); if (e.status === 'running') { e.status = 'error'; if (!e.output) e.output = 'Interrupted before the tool finished.'; } renderTool(e); }
        });
        setRunning(false);
      }
      renderSessions(); pollState(); return;
  }
  if (sid && sid !== V.id) return;
  if (V.loading) return;
  switch (ev.type) {
    case 'thinking': appendStream('thinking', ev.delta); break;
    case 'text': appendStream('assistant', ev.delta); break;
    case 'thinking_to_text': { // a streamed "thinking" block turned out to be the normal answer
      const last = V.timeline[V.timeline.length - 1];
      if (last && last.kind === 'thinking') { const txt = last.text; removeEntry(last); appendStream('assistant', txt); }
      break;
    }
    case 'tool_call': onToolCall(ev); break;
    case 'tool_stream': onToolStream(ev); break;
    case 'tool_stream_end': onToolStreamEnd(ev); break;
    case 'tool_result': onToolResult(ev); break;
    case 'approval': onApproval(ev); break;
    case 'plan':
      V.plan = ev.items || []; renderPlan();
      if (V.plan.length && !app.classList.contains('rp-open')) $('#rpDot').hidden = false;
      break;
    case 'usage': V.usage = ev; renderCtx(); break;
    case 'note': addEntry({ kind: 'note', level: ev.level, text: ev.text }); break;
  }
}

/* ------------------------------------------------------------------ polling / boot */
async function refreshState() {
  const st = await api('/api/state');
  S.models = st.models || S.models;
  S.settings = st.settings || S.settings;
  S.gpu = st.gpu || null; S.ollama = st.ollama || null; S.pull = st.pull || { active: false };
  let sess = (st.sessions || []).filter(x => !deletedIds.has(x.id));
  if (V.id && !deletedIds.has(V.id) && !sess.some(x => x.id === V.id)) {
    const local = S.sessions.find(x => x.id === V.id);
    if (local && V.timeline.length) sess = sess.concat([local]);
  }
  S.sessions = sess;
  return st;
}
let polling = false, lastPullActive = false;
async function pollState() {
  if (polling || isDown || is401) return;
  polling = true;
  try {
    await refreshState();
    if (lastPullActive && !S.pull.active) toast('Model download finished', 'info', 3000);
    lastPullActive = !!S.pull.active;
    renderTop(); renderFoot(); renderSessions();
  } catch (_) {} finally { polling = false; }
}
async function boot() {
  try { await refreshState(); }
  catch (_) { return; }
  lastPullActive = !!S.pull.active;
  topSig = ''; renderTop(); renderFoot();
  if (filesVisible()) filesOpened();
  $('#emptySub').textContent = S.settings.workspace ? 'Working in ' + S.settings.workspace : 'Local model. Runs commands, edits files, browses the web.';
  if (!booted) {
    booted = true;
    const saved = LS.get('exitai_session');
    const pick = (saved && S.sessions.some(s => s.id === saved) && saved) || (currentSessions()[0] || {}).id;
    if (pick) { V.id = pick; renderSessions(true); await loadSession(pick); }
    else { V.loading = false; showEmptyIfNeeded(); renderSessions(true); }
    setInterval(() => { if (!document.hidden) pollState(); }, 4000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollState(); });
    setInterval(() => { renderSessions(); }, 30000);
    fetchBrowser().then(() => {});
  } else if (V.id) { await loadSession(V.id); }
  connectSSE();
}

/* ------------------------------------------------------------------ keyboard */
document.addEventListener('keydown', e => {
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.shiftKey && !e.altKey && (k === 'm' || k === 'M')) { e.preventDefault(); popOpen() ? closePop(true) : openPop(); return; }
  if (ctrl && e.shiftKey && !e.altKey && (k === 'f' || k === 'F')) { e.preventDefault(); setRp(true); setTab('files', true); setTimeout(() => { if (FS.view === 'list') $('#flFilter').focus(); }, 60); return; }
  if (ctrl && (k === 's' || k === 'S') && FS.view === 'file' && filesVisible()) { e.preventDefault(); fsSave(); return; }
  if (ctrl && !e.shiftKey && !e.altKey) {
    if (k === 'n' || k === 'N') { e.preventDefault(); newChat(); return; }
    if (k === 'k' || k === 'K') { e.preventDefault(); input.focus(); return; }
    if (k === 'b' || k === 'B') { e.preventDefault(); toggleSb(); return; }
    if (k === '.') { e.preventDefault(); toggleRp(); return; }
  }
  if (k === 'Escape') {
    if (closePop(true)) return;
    if (FS.picker) { exitPicker(); return; }
    if (mqRp.matches && app.classList.contains('rp-open')) { setRp(false); return; }
    if (mqSb.matches && app.classList.contains('sb-open')) { setSb(false); return; }
    if (V.running) stopRun();
  }
});

/* ------------------------------------------------------------------ init */
renderPlan(); renderCtx(); renderAttach(); renderChips(); applyThink();
app.classList.add('no-anim');
requestAnimationFrame(() => { autoGrow(); requestAnimationFrame(() => app.classList.remove('no-anim')); });
window.addEventListener('resize', autoGrow);
V.loading = true; showEmptyIfNeeded(); emptyEl.hidden = true;
if (!TOKEN) show401(); else boot();
window.addEventListener('beforeunload', () => { if (es) es.close(); });
})();
