import fs from 'node:fs';
import { browser, PAGE_FNS } from '../browser.mjs';
import { clip, resolvePath } from './util.mjs';

function normUrl(u) {
  u = String(u || '').trim();
  if (!u) throw new Error('url is required');
  if (/^[a-zA-Z]:[\\/]/.test(u)) return 'file:///' + u.replace(/\\/g, '/');
  if (/^(https?|file|about|chrome|data|view-source):/i.test(u)) return u;
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\]|\d+\.\d+\.\d+\.\d+)/i.test(u)) return 'http://' + u;
  return 'https://' + u;
}

const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);
const modMask = (s) => (s ? String(s).toLowerCase().split(/[+, ]+/).reduce((m, k) => m | ({ alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, win: 4, shift: 8 }[k] || 0), 0) : 0);
const urlGlob = (g) => new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');

function consoleLines(entries) {
  return entries.map(e => `#${e.id} ${hhmmss(e.t)} [${e.level}] ${e.text}${e.src ? `  (${e.src})` : ''}`).join('\n');
}

function recentIssues(tab, sinceId) {
  const errs = tab.console.filter(c => c.id > sinceId && (c.level === 'error' || c.level === 'exception'));
  if (!errs.length) return '';
  return `\n[new console errors: ${errs.length}]\n` + consoleLines(errs.slice(-5));
}

async function snap(opts = {}) {
  return browser.page(PAGE_FNS.pageSnapshot, { maxChars: opts.maxChars || 12000, selector: opts.selector, viewportOnly: !!opts.viewportOnly });
}

async function locate(target) {
  const loc = await browser.page(PAGE_FNS.pageLocate, target);
  if (!loc.ok) throw new Error(loc.error);
  return loc;
}
const targetOf = (a, p = '') => ({ ref: a[p + 'ref'], selector: a[p + 'selector'], text: a[p + 'text'] });
const hasTarget = (t, allowText = true) => (t.ref !== undefined && t.ref !== '') || !!t.selector || (allowText && !!t.text);

// accessibility-tree helper
function axLines(nodes, cap = 300) {
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const depthOf = (n) => { let d = 0; for (let p = byId.get(n.parentId); p && d < 20; p = byId.get(p.parentId)) if (!p.ignored && p.role?.value && !['generic', 'none', 'RootWebArea'].includes(p.role.value)) d++; return d; };
  const out = [];
  for (const n of nodes) {
    if (n.ignored) continue;
    const role = n.role?.value;
    if (!role || ['generic', 'none', 'InlineTextBox', 'LineBreak'].includes(role)) continue;
    const name = (n.name?.value || '').toString().replace(/\s+/g, ' ').trim();
    if (role === 'StaticText' && !name) continue;
    const props = (n.properties || []).filter(p => ['focused', 'disabled', 'checked', 'expanded', 'selected', 'required', 'level', 'invalid', 'readonly', 'pressed', 'hidden'].includes(p.name) && p.value?.value !== false && p.value?.value !== 'false').map(p => p.name + (p.value?.value === true ? '' : '=' + p.value?.value));
    out.push('  '.repeat(Math.min(depthOf(n), 10)) + role + (name ? ` "${name.slice(0, 80)}"` : '') + (n.value?.value ? ` value="${String(n.value.value).slice(0, 40)}"` : '') + (props.length ? ` [${props.join(' ')}]` : ''));
    if (out.length >= cap) { out.push('… [accessibility tree truncated]'); break; }
  }
  return out.join('\n');
}

export const browserTools = [
  {
    name: 'browser_navigate',
    risk: 'safe',
    description: 'Open a URL in the agent browser (a real Chrome window with its own persistent profile; launched on demand). Waits for load, then returns a compact page snapshot with [ref] ids for interactive elements, plus console error counts. Also accepts local files (C:\\path\\file.html) and http://localhost:PORT.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    async run({ url }) {
      await browser.ensure();
      const before = browser.tab().seq;
      await browser.navigate(normUrl(url));
      const tab = browser.tab();
      const s = await snap({ maxChars: 7000 });
      const errs = tab.console.filter(c => c.id > before && (c.level === 'error' || c.level === 'exception')).length;
      const failed = tab.net.filter(n => n.failed || (n.status && n.status >= 400)).length;
      return `${s}\n---\n[console: ${tab.console.length - before} new messages, ${errs} errors · network: ${tab.net.length} requests, ${failed} failed/4xx/5xx · use browser_console / browser_network / browser_inspect / browser_dom for details]`;
    },
  },
  {
    name: 'browser_snapshot',
    risk: 'safe',
    description: 'Get a compact text view of the current page: headings, text, landmarks and every interactive element with a [ref] number you can pass to browser_act. Re-take after the page changes. Optional CSS selector to focus on one part (the element itself is included); viewport_only to see just what is on screen.',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string' }, viewport_only: { type: 'boolean' }, max_chars: { type: 'integer', description: 'Default 12000' } },
    },
    async run({ selector, viewport_only, max_chars }) {
      await browser.ensure();
      return await snap({ selector, viewportOnly: viewport_only, maxChars: max_chars });
    },
  },
  {
    name: 'browser_dom',
    risk: 'safe',
    description: 'Get the raw DOM tree of the page as an indented outline (tag#id.class [key attrs] "text"), with repeated siblings collapsed, hidden elements flagged and shadow roots / same-origin iframes expanded. Use it to understand page structure, find selectors, or debug layout. Narrow with selector and depth.',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'Subtree root (default: <html>)' }, depth: { type: 'integer', description: 'Default 6' }, max_chars: { type: 'integer', description: 'Default 14000' } },
    },
    async run({ selector, depth, max_chars }) {
      await browser.ensure();
      return await browser.page(PAGE_FNS.pageDom, { selector, depth, maxChars: max_chars });
    },
  },
  {
    name: 'browser_inspect',
    risk: 'safe',
    description: `Deep inspection of the page or one element (like the DevTools panels). what=
- html: outerHTML of the element (or whole page) · source: raw HTML as served, before JS ran
- styles: computed CSS + every matching CSS rule with its source (needs ref/selector/text)
- box: position, size, visibility %, what COVERS it, clipping/scrolling ancestors, stacking contexts
- attrs: attributes, properties, dataset, form validity, shadow root
- listeners: JS event listeners attached to the element (or to window/document) with handler source
- a11y: accessibility tree (roles, names, states)
- cookies: all cookies incl. HttpOnly, with flags · storage: localStorage, sessionStorage, IndexedDB, caches, service workers
- headers: response headers of the main document (CSP, CORS, cache…)
- performance: load timings, LCP/CLS, resource weight, slowest/largest requests, JS heap, DOM size · metrics: raw Chrome performance counters
- forms: every form and field with validation state · links: links and broken/alt-less images
- meta: title, meta/link tags, JSON-LD, doctype · scripts: scripts, stylesheets and detected frameworks (React/Vue/Angular/jQuery…) · frames: iframe tree`,
    parameters: {
      type: 'object',
      properties: {
        what: { type: 'string', enum: ['html', 'source', 'styles', 'box', 'attrs', 'listeners', 'a11y', 'cookies', 'storage', 'headers', 'performance', 'metrics', 'forms', 'links', 'meta', 'scripts', 'frames'] },
        ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string', description: 'visible text of the element' },
        max_chars: { type: 'integer', description: 'Default 10000' },
      },
      required: ['what'],
    },
    async run({ what, ref, selector, text, max_chars }) {
      await browser.ensure();
      const tab = browser.tab(), s = tab.sessionId;
      const target = { ref, selector, text };
      const has = hasTarget(target);
      switch (what) {
        case 'cookies': {
          const { cookies } = await browser.send('Network.getCookies', { urls: [tab.url] }, s);
          const rows = cookies.map(c => `${c.name} = ${String(c.value).slice(0, 80)}  [${c.domain}${c.path}${c.httpOnly ? ' HttpOnly' : ''}${c.secure ? ' Secure' : ''} SameSite=${c.sameSite || '-'} ${c.session ? 'session' : 'expires ' + new Date(c.expires * 1000).toISOString().slice(0, 16)}]`);
          return `${rows.length} cookies sent to ${tab.url}:\n${rows.join('\n') || '(none)'}`;
        }
        case 'listeners': {
          const items = [];
          const grab = async (label, objectId) => {
            const { listeners } = await browser.send('DOMDebugger.getEventListeners', { objectId, depth: 1 }, s);
            for (const l of listeners) items.push(`${label}  ${l.type}${l.useCapture ? ' (capture)' : ''}${l.passive ? ' passive' : ''}${l.once ? ' once' : ''}  line ${l.lineNumber + 1}:${l.columnNumber}  ${(l.handler?.description || '').replace(/\s+/g, ' ').slice(0, 220)}`);
          };
          if (has) {
            const h = await browser.handle(target); if (!h) throw new Error('Element not found. Take a fresh browser_snapshot.');
            await grab('element', h.objectId);
          } else {
            for (const g of ['window', 'document']) { const r = await browser.send('Runtime.evaluate', { expression: g, returnByValue: false }, s); await grab(g, r.result.objectId); }
          }
          return items.length ? clip(items.join('\n'), max_chars || 10000, 0.8) : 'No event listeners found on that target.';
        }
        case 'a11y': {
          if (has) {
            const h = await browser.handle(target); if (!h) throw new Error('Element not found.');
            const { nodes } = await browser.send('Accessibility.getPartialAXTree', { objectId: h.objectId, fetchRelatives: false }, s);
            return axLines(nodes) || '(element is not exposed to assistive technology)';
          }
          await browser.send('Accessibility.enable', {}, s).catch(() => {});
          const { nodes } = await browser.send('Accessibility.getFullAXTree', {}, s);
          return axLines(nodes);
        }
        case 'frames': {
          const { frameTree } = await browser.send('Page.getFrameTree', {}, s);
          const lines = [];
          const walk = (t, d) => { lines.push('  '.repeat(d) + `${t.frame.name || '(unnamed)'} — ${t.frame.url}${t.frame.unreachableUrl ? ' [unreachable: ' + t.frame.unreachableUrl + ']' : ''}  origin=${t.frame.securityOrigin}`); (t.childFrames || []).forEach(c => walk(c, d + 1)); };
          walk(frameTree, 0);
          return lines.join('\n');
        }
        case 'headers': {
          const doc = tab.net.find(n => n.type === 'document' && n.respHeaders) || tab.net.find(n => n.respHeaders);
          if (!doc) return 'No response headers captured yet (reload the page after the browser is open).';
          return `${doc.method} ${doc.url} -> ${doc.status}\n` + Object.entries(doc.respHeaders).map(([k, v]) => `${k}: ${String(v).slice(0, 300)}`).join('\n');
        }
        case 'metrics': {
          await browser.send('Performance.enable', {}, s);
          const { metrics } = await browser.send('Performance.getMetrics', {}, s);
          return metrics.filter(m => !/Timestamp|NavigationStart|DomContentLoaded|FirstMeaningfulPaint/.test(m.name) && m.value !== 0).map(m => `${m.name}: ${/Size|Heap/.test(m.name) ? (m.value / 1048576).toFixed(2) + ' MB' : /Duration/.test(m.name) ? m.value.toFixed(3) + ' s' : m.value}`).join('\n');
        }
        default:
          return await browser.page(PAGE_FNS.pageInspect, { what, ...target, maxChars: max_chars });
      }
    },
  },
  {
    name: 'browser_console',
    risk: 'safe',
    description: 'Read the browser DevTools console of the current tab: console.log/warn/error output, uncaught exceptions with stack traces, and browser-reported errors (CORS, CSP, failed resource loads, deprecations). Messages persist across navigations until cleared.',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['all', 'error', 'warn', 'log'], description: "'error' includes exceptions; 'warn' = warnings and errors. Default all" },
        search: { type: 'string', description: 'Only messages containing this text' },
        limit: { type: 'integer', description: 'Most recent N (default 50)' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading' },
      },
    },
    async run({ level = 'all', search, limit = 50, clear = false }) {
      await browser.ensure();
      const tab = browser.tab();
      let es = tab.console;
      if (level === 'error') es = es.filter(e => e.level === 'error' || e.level === 'exception');
      else if (level === 'warn') es = es.filter(e => ['warn', 'error', 'exception'].includes(e.level));
      else if (level === 'log') es = es.filter(e => ['log', 'info', 'debug'].includes(e.level));
      if (search) es = es.filter(e => e.text.toLowerCase().includes(search.toLowerCase()));
      const total = es.length;
      es = es.slice(-Math.max(1, limit | 0));
      const counts = tab.console.reduce((a, e) => { a[e.level] = (a[e.level] || 0) + 1; return a; }, {});
      const out = es.length ? consoleLines(es) : '(no matching console messages)';
      if (clear) { tab.console.length = 0; browser.changed(); }
      return clip(`[${tab.url}] console totals: ${JSON.stringify(counts)}; showing ${es.length}/${total}\n${out}`, 14000, 0.2);
    },
  },
  {
    name: 'browser_network',
    risk: 'safe',
    description: 'Inspect network requests of the current tab (DevTools Network panel). List requests with status/timing, filter to failures, or pass request_id to see headers, POST data and the response body of one request.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'URL substring' },
        only_failed: { type: 'boolean', description: 'Only failed requests and HTTP status >= 400' },
        type: { type: 'string', description: 'document, script, stylesheet, image, xhr, fetch, font, websocket…' },
        limit: { type: 'integer', description: 'Default 40' },
        request_id: { type: 'string', description: 'Show details and response body for this request id' },
        clear: { type: 'boolean' },
      },
    },
    async run({ filter, only_failed, type, limit = 40, request_id, clear }) {
      await browser.ensure();
      const tab = browser.tab();
      if (request_id) {
        const e = tab.netById.get(String(request_id));
        if (!e) throw new Error('Unknown request_id (ids come from the list output).');
        let body = '';
        try { body = clip(await browser.responseBody(e.id), 8000, 0.7); } catch (err) { body = `(body unavailable: ${err.message})`; }
        return `${e.method} ${e.url}\nstatus: ${e.status ?? 'pending'}${e.failed ? ' FAILED: ' + e.error : ''} · ${e.ms ?? '?'}ms · ${e.mime || e.type}\nresponse headers: ${JSON.stringify(e.respHeaders || {}).slice(0, 1500)}\n${e.postData ? 'request body: ' + e.postData.slice(0, 1500) + '\n' : ''}--- response body ---\n${body}`;
      }
      let es = tab.net;
      if (filter) es = es.filter(e => e.url.toLowerCase().includes(filter.toLowerCase()));
      if (only_failed) es = es.filter(e => e.failed || (e.status && e.status >= 400));
      if (type) es = es.filter(e => e.type === type.toLowerCase());
      const total = es.length;
      es = es.slice(-Math.max(1, limit | 0));
      const lines = es.map(e => `${e.id}  ${e.failed ? 'FAIL' : (e.status ?? '...')}  ${e.method} ${e.url.length > 140 ? e.url.slice(0, 140) + '…' : e.url}  [${e.type || '?'}] ${e.ms ?? '?'}ms${e.failed ? ' ' + e.error : ''}`);
      if (clear) { tab.net.length = 0; tab.netById.clear(); browser.changed(); }
      return `[${tab.url}] ${total} matching requests (showing ${es.length}); inflight: ${tab.inflight.size}\n${lines.join('\n') || '(none)'}`;
    },
  },
  {
    name: 'browser_act',
    risk: 'safe',
    description: `Control the page exactly like a person. Target elements by ref (from browser_snapshot), CSS selector, or visible text. Actions:
- click / double_click / right_click / hover (options: button left|middle|right, clicks 1-3, modifiers "ctrl+shift"); click_at (x,y in viewport pixels, for canvases/maps)
- type (insert text fast; clear:true replaces; submit:true presses Enter) · type_keys (real per-key keystrokes with delays, for sites that need key events) · paste (real clipboard paste, Ctrl+V) · clear · focus · copy (returns the current selection)
- press (key or combo: Enter, Tab, Escape, ArrowDown, Backspace, F5, Control+a, Control+Shift+Tab…) · select (dropdown option)
- scroll (direction up/down/left/right/top/bottom, amount px or "page", uses the real mouse wheel over the target element or the page centre) · wheel (delta_x, delta_y at x,y)
- drag (from target or from_x/from_y, to to_ref/to_selector/to_text or to_x/to_y or delta_x/delta_y: sliders, resizers, canvas, HTML5 drag-and-drop)
- upload (files: absolute paths, onto an input[type=file] or a button that opens the file picker)
- wait (text/selector appears, or gone:true, or ms) · back · forward · reload · new_tab · tabs · switch_tab · close_tab · close_browser`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'click_at', 'hover', 'type', 'type_keys', 'paste', 'clear', 'focus', 'copy', 'press', 'select', 'scroll', 'wheel', 'drag', 'upload', 'wait', 'back', 'forward', 'reload', 'new_tab', 'tabs', 'switch_tab', 'close_tab', 'close_browser'] },
        ref: { type: 'string', description: 'Element ref number from the last snapshot' },
        selector: { type: 'string' },
        text: { type: 'string', description: 'type/type_keys/paste: text to enter. click/hover/wait: visible text to find' },
        value: { type: 'string', description: 'select: option text or value' },
        key: { type: 'string' },
        clear: { type: 'boolean' }, submit: { type: 'boolean' },
        button: { type: 'string', enum: ['left', 'middle', 'right'] }, clicks: { type: 'integer' }, modifiers: { type: 'string', description: 'e.g. ctrl, shift, ctrl+shift, alt' },
        x: { type: 'number' }, y: { type: 'number' },
        to_ref: { type: 'string' }, to_selector: { type: 'string' }, to_text: { type: 'string' }, to_x: { type: 'number' }, to_y: { type: 'number' },
        from_x: { type: 'number' }, from_y: { type: 'number' },
        delta_x: { type: 'number' }, delta_y: { type: 'number' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] },
        amount: { type: 'string', description: 'pixels or "page"' },
        files: { type: 'array', items: { type: 'string' }, description: 'upload: file paths' },
        delay_ms: { type: 'integer', description: 'type_keys: average delay between keystrokes (default 20)' },
        ms: { type: 'integer' },
        gone: { type: 'boolean', description: 'wait: wait for disappearance' },
        timeout_sec: { type: 'integer', description: 'wait timeout, default 10' },
        index: { type: 'integer', description: 'tab index' },
        url: { type: 'string', description: 'new_tab url' },
      },
      required: ['action'],
    },
    async run(a, ctx = {}) {
      const { action } = a;
      if (action === 'close_browser') { await browser.close(); return 'Browser closed.'; }
      await browser.ensure();
      let tab = browser.tab();
      const sinceId = tab.seq;
      const urlBefore = tab.url;
      const target = targetOf(a);
      const has = hasTarget(target, ['click', 'double_click', 'right_click', 'hover', 'wait', 'focus', 'scroll', 'wheel', 'drag', 'type', 'type_keys', 'paste', 'clear', 'upload'].includes(action));
      const mods = modMask(a.modifiers);
      const pick = async (t, label) => { const l = await locate(t); if (l.noBox) throw new Error(`${label} has no layout box (hidden?)`); return l; };
      let msg = '';
      switch (action) {
        case 'click': case 'double_click': case 'right_click': case 'hover': case 'click_at': {
          const clicks = action === 'double_click' ? 2 : (a.clicks || 1);
          const button = action === 'right_click' ? 'right' : (a.button || 'left');
          const type = action === 'hover' ? 'hover' : 'click';
          let loc;
          if (action === 'click_at') {
            if (a.x === undefined || a.y === undefined) throw new Error('x and y are required');
            loc = { ok: true, x: a.x, y: a.y, desc: `point (${a.x}, ${a.y})`, label: '' };
          } else {
            if (!has) throw new Error('Provide ref, selector or text');
            loc = await locate(target);
          }
          const verb = { click: 'Clicked', double_click: 'Double-clicked', right_click: 'Right-clicked', hover: 'Hovered', click_at: 'Clicked' }[action];
          if (loc.noBox) {
            await browser.ev(`(()=>{const e=document.querySelector('[data-xref="${String(a.ref).replace(/[^0-9]/g, '')}"]'); if(e) e.click();})()`);
            msg = `Clicked (via script, element has no layout box): ${loc.desc} "${loc.label}"`;
          } else if (loc.covered && type === 'click' && button === 'left' && clicks === 1 && a.ref !== undefined) {
            msg = `Note: ${loc.desc} is covered by <${loc.covered}>; used a direct DOM click instead. `;
            await browser.ev(`(()=>{const e=document.querySelector('[data-xref="${String(a.ref).replace(/[^0-9]/g, '')}"]'); if(e) e.click();})()`);
            msg += `${verb} ${loc.desc} "${loc.label}"`;
          } else {
            await browser.mouse(loc.x, loc.y, { type, button, clicks, modifiers: mods });
            msg = `${verb} ${loc.desc}${loc.label ? ` "${loc.label}"` : ''}${mods ? ` with ${a.modifiers}` : ''}`;
          }
          await browser.waitIdle(type === 'click' ? 6000 : 800);
          break;
        }
        case 'type': case 'type_keys': case 'paste': {
          if (a.text === undefined) throw new Error('text is required');
          let desc = 'the focused element';
          if (has) {
            const f = await browser.page(PAGE_FNS.pageFocusType, { ...target, text: undefined, clear: !!a.clear });
            if (!f.ok) throw new Error(f.error);
            desc = f.desc + (f.editable ? '' : ' (warning: element may not be editable)');
          } else if (a.clear) { await browser.key('Control+a'); await browser.key('Delete'); }
          if (action === 'type') { await browser.send('Input.insertText', { text: String(a.text) }, tab.sessionId); msg = `Typed ${String(a.text).length} chars into ${desc}`; }
          else if (action === 'type_keys') { await browser.typeKeys(a.text, a.delay_ms ?? 20); msg = `Typed ${String(a.text).length} keystrokes into ${desc}`; }
          else { const how = await browser.paste(a.text); msg = `Pasted ${String(a.text).length} chars into ${desc} (${how})`; }
          if (a.submit) { await browser.key('Enter'); msg += ' and pressed Enter'; await browser.waitIdle(6000); }
          break;
        }
        case 'clear': {
          if (has) { const f = await browser.page(PAGE_FNS.pageFocusType, { ...target, clear: true }); if (!f.ok) throw new Error(f.error); }
          else await browser.key('Control+a');
          await browser.key('Delete'); msg = 'Cleared the field'; break;
        }
        case 'focus': {
          if (!has) throw new Error('Provide ref, selector or text');
          const f = await browser.page(PAGE_FNS.pageFocusType, target); if (!f.ok) throw new Error(f.error);
          msg = `Focused ${f.desc}`; break;
        }
        case 'copy': {
          const r = await browser.ev('getSelection().toString()');
          return `Selected text (${(r.value || '').length} chars):\n${clip(r.value || '(nothing selected — select text first: triple-click it, or press Control+a)', 6000)}`;
        }
        case 'select': {
          const r = await browser.page(PAGE_FNS.pageSelect, { ...target, value: a.value });
          if (!r.ok) throw new Error(r.error);
          msg = `Selected "${r.selected}"`;
          await browser.waitIdle(1500);
          break;
        }
        case 'press': {
          if (!a.key) throw new Error('key is required');
          await browser.key(a.key);
          msg = `Pressed ${a.key}`;
          await browser.waitIdle(/Enter|F5/.test(a.key) ? 4000 : 500);
          break;
        }
        case 'scroll': case 'wheel': {
          const dir = a.direction || 'down';
          if (action === 'scroll' && (dir === 'top' || dir === 'bottom')) {
            await browser.ev(dir === 'top' ? 'scrollTo(0,0)' : 'scrollTo(0,document.documentElement.scrollHeight)');
          } else {
            let x = a.x, y = a.y;
            if (has) { const l = await locate(target); x = l.x; y = l.y; }
            if (x === undefined || y === undefined) { const v = (await browser.ev('({x:Math.round(innerWidth/2),y:Math.round(innerHeight/2)})')).value; x = v.x; y = v.y; }
            let dx = 0, dy = 0;
            if (action === 'wheel') { dx = a.delta_x || 0; dy = a.delta_y || 0; }
            else {
              const amt = a.amount === 'page' || !a.amount ? (await browser.ev('Math.round(innerHeight*0.85)')).value : Number(a.amount) || 600;
              if (dir === 'down') dy = amt; else if (dir === 'up') dy = -amt; else if (dir === 'right') dx = amt; else if (dir === 'left') dx = -amt;
            }
            await browser.wheel(x, y, dx, dy);
            await new Promise(r => setTimeout(r, 350));
          }
          const pos = (await browser.ev('({y:Math.round(scrollY),max:Math.round(document.documentElement.scrollHeight-innerHeight)})')).value;
          msg = `${action === 'wheel' ? 'Wheel' : 'Scrolled ' + dir}; page position ${pos.y}/${pos.max}px`;
          break;
        }
        case 'drag': {
          let x1 = a.from_x, y1 = a.from_y;
          if (hasTarget(target)) { const l = await pick(target, 'Drag source'); x1 = l.x; y1 = l.y; }
          if (x1 === undefined || y1 === undefined) throw new Error('Drag needs a source (ref/selector/text or from_x/from_y)');
          let x2 = a.to_x, y2 = a.to_y;
          const to = targetOf(a, 'to_');
          if (hasTarget(to)) { const l = await pick(to, 'Drag destination'); x2 = l.x; y2 = l.y; }
          if ((x2 === undefined || y2 === undefined) && (a.delta_x !== undefined || a.delta_y !== undefined)) { x2 = x1 + (a.delta_x || 0); y2 = y1 + (a.delta_y || 0); }
          if (x2 === undefined || y2 === undefined) throw new Error('Drag needs a destination (to_ref/to_selector/to_text, to_x/to_y or delta_x/delta_y)');
          const how = await browser.drag(Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2));
          msg = `Dragged (${Math.round(x1)},${Math.round(y1)}) -> (${Math.round(x2)},${Math.round(y2)}) [${how}]`;
          await browser.waitIdle(1500);
          break;
        }
        case 'upload': {
          if (!Array.isArray(a.files) || !a.files.length) throw new Error('files (array of paths) is required');
          const files = a.files.map(f => resolvePath(f, ctx.workspace));
          for (const f of files) if (!fs.existsSync(f)) throw new Error('File not found: ' + f);
          if (!has) throw new Error('Provide ref, selector or text of the file input / upload button');
          const how = await browser.setFiles(target, files);
          msg = `Attached ${files.length} file(s) via ${how}: ${files.join(', ')}`;
          await browser.waitIdle(2000);
          break;
        }
        case 'wait': {
          const timeout = Math.min(60, a.timeout_sec || 10) * 1000;
          if (!a.selector && !a.text) { await new Promise(r => setTimeout(r, Math.min(30000, a.ms || 1000))); msg = `Waited ${a.ms || 1000}ms`; break; }
          const t0 = Date.now(); let ok = false;
          while (Date.now() - t0 < timeout) {
            ok = await browser.page(PAGE_FNS.pageWaitCheck, { selector: a.selector, text: a.text, gone: !!a.gone });
            if (ok) break;
            await new Promise(r => setTimeout(r, 250));
          }
          if (!ok) throw new Error(`Timed out after ${timeout / 1000}s waiting for ${a.selector || `text "${a.text}"`}${a.gone ? ' to disappear' : ''}`);
          msg = `Condition met after ${((Date.now() - t0) / 1000).toFixed(1)}s`;
          break;
        }
        case 'back': case 'forward': {
          await browser.ev(`history.${action === 'back' ? 'back' : 'forward'}()`);
          await browser.waitIdle(8000); msg = `Navigated ${action}`; break;
        }
        case 'reload': { await browser.send('Page.reload', {}, tab.sessionId); tab.loaded = false; await browser.waitIdle(15000); msg = 'Reloaded'; break; }
        case 'new_tab': { await browser.newTab(a.url ? normUrl(a.url) : 'about:blank'); tab = browser.tab(); return `Opened new tab (${browser.tabs.size} total). Current: ${tab.url}`; }
        case 'tabs': return browser.listTabs().map(t => `${t.current ? '*' : ' '} [${t.index}] ${t.title || '(untitled)'} — ${t.url}`).join('\n') || '(no tabs)';
        case 'switch_tab': { await browser.switchTab(a.index ?? 0); tab = browser.tab(); return `Switched to [${a.index ?? 0}] ${tab.title} — ${tab.url}`; }
        case 'close_tab': { await browser.closeTab(a.index); await new Promise(r => setTimeout(r, 300)); return `Closed tab. ${browser.tabs.size} remaining.`; }
        default: throw new Error('Unknown action ' + action);
      }
      tab = browser.tab() || tab;
      let out = `${msg}\nPage: ${tab.title || '(untitled)'} — ${tab.url}`;
      out += recentIssues(tab, sinceId);
      if (tab.url !== urlBefore && ['click', 'double_click', 'press', 'type', 'type_keys', 'paste', 'back', 'forward', 'reload'].includes(action)) {
        out += '\n--- new page snapshot ---\n' + clip(await snap({ maxChars: 5000 }), 5200, 0.9);
      }
      return out;
    },
  },
  {
    name: 'browser_eval',
    risk: 'safe',
    description: 'Run JavaScript in the current page (like typing in the DevTools console) and return the result. Supports top-level await and re-declaring variables between calls. Use it to read app state, call functions, query storage, measure things, extract data, or modify the page. Provide `expression`, or `file` to run a local .js file in the page. Return JSON-serialisable values.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'JavaScript; the last expression value is returned' }, file: { type: 'string', description: 'Path of a local JavaScript file to run instead' } },
    },
    async run({ expression, file }, ctx = {}) {
      if (file) expression = fs.readFileSync(resolvePath(file, ctx.workspace), 'utf8');
      if (!expression) throw new Error('Provide expression or file');
      await browser.ensure();
      const tab = browser.tab();
      const since = tab.seq;
      const r = await browser.ev(expression);
      let v;
      if (r.type === 'undefined') v = 'undefined';
      else if ('value' in r) v = typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2);
      else v = r.description || r.type;
      return clip(String(v), 12000, 0.7) + recentIssues(tab, since);
    },
  },
  {
    name: 'browser_inject',
    risk: 'safe',
    description: 'Insert code into the page. action=add: inject JavaScript and/or CSS (inline, or from a local file) — it runs now AND automatically before every future page load in this tab (use it to patch fetch, add logging hooks, override functions, restyle). action=list/remove/clear manage persistent injections.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove', 'clear'] },
        script: { type: 'string', description: 'JavaScript source' },
        css: { type: 'string', description: 'CSS source' },
        file: { type: 'string', description: 'Local .js or .css file to inject' },
        persist: { type: 'boolean', description: 'Also run on future navigations (default true)' },
        id: { type: 'string', description: 'remove: injection id' },
      },
      required: ['action'],
    },
    async run({ action, script, css, file, persist = true, id }, ctx = {}) {
      await browser.ensure();
      const tab = browser.tab();
      if (action === 'list') return tab.inject.length ? tab.inject.map(i => `${i.id}  ${i.size} chars  ${i.head}`).join('\n') : 'No persistent injections on this tab.';
      if (action === 'clear') return `Removed ${await browser.removeInjection('all')} injection(s).`;
      if (action === 'remove') { if (!id) throw new Error('id required'); return `Removed ${await browser.removeInjection(id)} injection(s).`; }
      let js = script || '';
      let styles = css || '';
      if (file) { const src = fs.readFileSync(resolvePath(file, ctx.workspace), 'utf8'); if (/\.css$/i.test(file)) styles += '\n' + src; else js += '\n' + src; }
      if (styles) js += `\n;(function(){ const css = ${JSON.stringify(styles)}; const add = () => { const s = document.createElement('style'); s.setAttribute('data-exitai-injected', ''); s.textContent = css; (document.head || document.documentElement).appendChild(s); }; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add(); })();`;
      if (!js.trim()) throw new Error('Provide script, css or file');
      const since = tab.seq;
      let ident = '';
      if (persist) ident = await browser.inject(js);
      let result = '';
      try { const r = await browser.ev(js); result = 'value' in r && r.value !== undefined ? '\nresult: ' + String(typeof r.value === 'string' ? r.value : JSON.stringify(r.value)).slice(0, 500) : ''; }
      catch (e) { result = '\nran with an error in the current page: ' + e.message.slice(0, 400); }
      return `Injected ${js.length} chars${persist ? ` (persistent id ${ident}; re-runs on every navigation)` : ' (one-time)'}.${result}${recentIssues(tab, since)}`;
    },
  },
  {
    name: 'browser_intercept',
    risk: 'safe',
    description: 'Intercept network requests made by the page (all tabs). Rules match a URL glob (* wildcard): mode=block (fail the request), mock (return your own status/body — e.g. fake an API response or error), delay (slow it down), headers (add/override request headers). action=add/list/remove/clear. Rules stay active until removed.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove', 'clear'] },
        url: { type: 'string', description: 'URL glob, e.g. *api/users* or https://example.com/*.png' },
        mode: { type: 'string', enum: ['block', 'mock', 'delay', 'headers'] },
        method: { type: 'string', description: 'Only this HTTP method' },
        status: { type: 'integer', description: 'mock: HTTP status (default 200)' },
        body: { type: 'string', description: 'mock: response body' },
        body_file: { type: 'string', description: 'mock: read the body from this local file' },
        content_type: { type: 'string', description: 'mock: default application/json' },
        delay_ms: { type: 'integer' },
        headers: { type: 'object', description: 'headers: name→value to set on the request' },
        id: { type: 'integer', description: 'remove: rule id' },
      },
      required: ['action'],
    },
    async run({ action, url, mode, method, status, body, body_file, content_type, delay_ms, headers, id }, ctx = {}) {
      await browser.ensure();
      const list = () => browser.rules.map(r => `#${r.id} ${r.mode}${r.method ? ' ' + r.method : ''} ${r.glob}${r.mode === 'mock' ? ` -> ${r.status || 200} ${String(r.body || '').slice(0, 60)}` : ''}${r.mode === 'delay' ? ` ${r.delayMs}ms` : ''}  (hits: ${r.hits || 0})`).join('\n');
      if (action === 'list') return list() || 'No interception rules.';
      if (action === 'clear') { await browser.setRules([]); return 'All interception rules removed.'; }
      if (action === 'remove') { await browser.setRules(browser.rules.filter(r => r.id !== id)); return `Removed rule #${id}.\n${list() || '(no rules left)'}`; }
      if (!url || !mode) throw new Error('url and mode are required');
      if (body_file) body = fs.readFileSync(resolvePath(body_file, ctx.workspace), 'utf8');
      const rule = { id: ++browser.ruleSeq, glob: url, re: urlGlob(url), mode, method: method?.toUpperCase(), status, body, contentType: content_type, delayMs: delay_ms, headers, hits: 0 };
      await browser.setRules([...browser.rules, rule]);
      return `Rule #${rule.id} added: ${mode} ${url}. Reload the page or trigger the request to see the effect.\n${list()}`;
    },
  },
  {
    name: 'browser_emulate',
    risk: 'safe',
    description: 'Change how the browser presents itself, for testing: viewport size / mobile device, dark or light mode, user agent, timezone, locale, GPS location, network speed (slow3g, fast3g, offline), CPU slowdown. Applies to the current tab. reset=true clears everything.',
    parameters: {
      type: 'object',
      properties: {
        width: { type: 'integer' }, height: { type: 'integer' }, mobile: { type: 'boolean' }, scale: { type: 'number', description: 'device pixel ratio' },
        dark: { type: 'boolean' }, user_agent: { type: 'string' }, timezone: { type: 'string', description: 'e.g. Europe/Paris' }, locale: { type: 'string', description: 'e.g. fr-FR' },
        latitude: { type: 'number' }, longitude: { type: 'number' },
        network: { type: 'string', enum: ['offline', 'slow3g', 'fast3g', 'none'] }, cpu_throttle: { type: 'number', description: 'e.g. 4 = 4x slower' },
        reset: { type: 'boolean' },
      },
    },
    async run(a) {
      await browser.ensure();
      const done = await browser.emulate(a);
      return done.length ? 'Applied: ' + done.join(', ') + '. Reload the page to see layout changes take full effect.' : 'Nothing to change (pass width/height, dark, user_agent, network, …).';
    },
  },
  {
    name: 'browser_screenshot',
    risk: 'safe',
    description: 'Take a screenshot of the current page, or of one element (ref/selector) — shown in the app UI. Pass `question` to have the vision model look at it and answer (e.g. "is the layout broken?", "what does the error banner say?").',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string' }, full_page: { type: 'boolean' }, ref: { type: 'string' }, selector: { type: 'string' } },
    },
    async run({ question, full_page, ref, selector }, ctx) {
      let clipRect;
      if (hasTarget({ ref, selector })) {
        await browser.ensure();
        const r = await browser.page(function (arg, L) {
          const f = L.find(arg); if (!f) return null; f.el.scrollIntoView({ block: 'center' });
          const b = f.el.getBoundingClientRect(); return { x: f.ox + b.left + scrollX, y: f.oy + b.top + scrollY, width: b.width, height: b.height };
        }, { ref, selector });
        if (!r || !r.width) throw new Error('Element not found or has no size. Take a fresh browser_snapshot.');
        clipRect = r;
      }
      const file = await browser.screenshot({ fullPage: !!full_page, clip: clipRect });
      browser.changed();
      if (!question) return `Screenshot saved to ${file} (visible in the Browser panel). Pass a question to have the vision model analyse it.`;
      const answer = await ctx.vision(file, question);
      return `Screenshot: ${file}\nVision model answer:\n${answer}`;
    },
  },
];
