// Chrome DevTools Protocol client (zero dependencies, uses Node's built-in WebSocket).
// Launches a dedicated Chrome/Edge with its own persistent profile and records console, exceptions,
// network and gives the agent compact page trees to read and interact with.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CDP_PORT, PROFILE_DIR, SHOTS_DIR, getSettings } from './config.mjs';

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

export function findBrowserExe() { return CHROME_PATHS.find(p => fs.existsSync(p)); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function fmtRemote(o) {
  if (!o) return '';
  if ('value' in o) return typeof o.value === 'string' ? o.value : JSON.stringify(o.value);
  if (o.unserializableValue) return o.unserializableValue;
  if (o.preview) {
    const p = o.preview;
    const props = (p.properties || []).map(x => (p.subtype === 'array' ? x.value : `${x.name}: ${x.value}`));
    const body = props.join(', ') + (p.overflow ? ', …' : '');
    if (p.subtype === 'array') return `[${body}]`;
    return `${o.className && o.className !== 'Object' ? o.className + ' ' : ''}{${body}}`;
  }
  return o.description || o.type || '';
}

const KEYS = {
  Enter: { vk: 13, text: '\r' }, Tab: { vk: 9 }, Escape: { vk: 27 }, Backspace: { vk: 8 }, Delete: { vk: 46 },
  ArrowUp: { vk: 38 }, ArrowDown: { vk: 40 }, ArrowLeft: { vk: 37 }, ArrowRight: { vk: 39 },
  Home: { vk: 36 }, End: { vk: 35 }, PageUp: { vk: 33 }, PageDown: { vk: 34 }, Space: { vk: 32, text: ' ', key: ' ' },
};

export class Browser {
  constructor() {
    this.ws = null;
    this.proc = null;
    this.spawned = false;
    this.nextId = 1;
    this.pending = new Map();
    this.tabs = new Map();        // targetId -> tab
    this.bySession = new Map();   // sessionId -> tab
    this.current = null;          // targetId
    this.onChange = null;
    this.lastShot = null;
    this._changeTimer = null;
    this._launching = null;
    this.rules = [];     // network interception rules (apply to every tab)
    this.ruleSeq = 0;
  }

  get open() { return !!this.ws && this.ws.readyState === 1; }
  tab() { return this.tabs.get(this.current) || null; }

  changed() {
    if (!this.onChange) return;
    clearTimeout(this._changeTimer);
    this._changeTimer = setTimeout(() => { try { this.onChange(this.status()); } catch { /* ignore */ } }, 250);
  }

  status() {
    const t = this.tab();
    return {
      open: this.open,
      url: t?.url || '',
      title: t?.title || '',
      consoleCount: t?.console.length || 0,
      errorCount: t ? t.console.filter(c => c.level === 'error' || c.level === 'exception').length : 0,
      networkCount: t?.net.length || 0,
    };
  }

  // ---------- connection ----------
  async ensure() {
    if (this.open && this.tab()) return;
    if (this._launching) return this._launching;
    this._launching = this._launch().finally(() => { this._launching = null; });
    return this._launching;
  }

  async _launch() {
    let ver = await this._version();
    if (!ver) {
      const exe = findBrowserExe();
      if (!exe) throw new Error('Chrome/Edge not found.');
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      const args = [
        `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,MediaRouter',
        '--window-size=1280,900', 'about:blank',
      ];
      if (getSettings().headless) args.unshift('--headless=new');
      this.proc = spawn(exe, args, { stdio: 'ignore', windowsHide: false });
      this.spawned = true;
      this.proc.on('exit', () => { this.proc = null; this._teardown(); });
      for (let i = 0; i < 60 && !ver; i++) { await sleep(250); ver = await this._version(); }
      if (!ver) throw new Error('Browser did not expose the DevTools port in time.');
    }
    await this._connect(ver.webSocketDebuggerUrl);
  }

  async _version() {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(800) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  async _connect(url) {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('DevTools WebSocket connection failed'));
      ws.onmessage = (ev) => this._onMessage(ev.data);
      ws.onclose = () => { this._teardown(); };
    });
    await this.send('Target.setDiscoverTargets', { discover: true });
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const { targetInfos } = await this.send('Target.getTargets');
    for (const t of targetInfos) if (t.type === 'page' && !this.tabs.has(t.targetId)) {
      await this.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(() => {});
    }
    // wait for at least one tab to be set up
    for (let i = 0; i < 40 && !this.tab(); i++) await sleep(100);
    if (!this.tab()) {
      const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
      for (let i = 0; i < 40 && !this.tabs.has(targetId); i++) await sleep(100);
      this.current = targetId;
    }
    this.changed();
  }

  _teardown() {
    for (const [, p] of this.pending) p.reject(new Error('Browser closed'));
    this.pending.clear();
    this.ws = null;
    this.tabs.clear();
    this.bySession.clear();
    this.current = null;
    this.changed();
  }

  send(method, params = {}, sessionId) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('Browser is not open'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  _onMessage(data) {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message}`)); else p.resolve(msg.result || {});
      return;
    }
    if (!msg.method) return;
    const tab = msg.sessionId ? this.bySession.get(msg.sessionId) : null;
    try { this._onEvent(msg.method, msg.params || {}, tab, msg.sessionId); } catch { /* never crash on events */ }
  }

  async _setupTab(sessionId, info) {
    const tab = {
      targetId: info.targetId, sessionId, url: info.url || '', title: info.title || '', openerId: info.openerId,
      console: [], net: [], netById: new Map(), inflight: new Set(), loaded: false, lastNetActivity: Date.now(), seq: 0,
      inject: [], chooser: null, dragData: null,
    };
    this.tabs.set(info.targetId, tab);
    this.bySession.set(sessionId, tab);
    const s = (m, p) => this.send(m, p, sessionId).catch(() => {});
    await Promise.all([s('Page.enable'), s('Runtime.enable'), s('Log.enable'), s('Network.enable', { maxPostDataSize: 4096 }), s('Page.setLifecycleEventsEnabled', { enabled: true })]);
    if (this.rules.length) await s('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    if (!this.current || info.openerId || !this.tabs.get(this.current)) this.current = info.targetId;
    this.changed();
  }

  _pushConsole(tab, entry) {
    if (!tab) return;
    entry.t = Date.now();
    entry.id = ++tab.seq;
    tab.console.push(entry);
    if (tab.console.length > 1500) tab.console.splice(0, tab.console.length - 1500);
    this.changed();
  }

  _onEvent(method, p, tab, sessionId) {
    switch (method) {
      case 'Target.attachedToTarget': {
        const info = p.targetInfo;
        if (info.type === 'page') this._setupTab(p.sessionId, info);
        else this.send('Runtime.runIfWaitingForDebugger', {}, p.sessionId).catch(() => {});
        break;
      }
      case 'Target.targetInfoChanged': {
        const t = this.tabs.get(p.targetInfo.targetId);
        if (t) { t.url = p.targetInfo.url; t.title = p.targetInfo.title; this.changed(); }
        break;
      }
      case 'Target.targetDestroyed': {
        const t = this.tabs.get(p.targetId);
        if (t) {
          this.tabs.delete(p.targetId); this.bySession.delete(t.sessionId);
          if (this.current === p.targetId) this.current = [...this.tabs.keys()].pop() || null;
          this.changed();
        }
        break;
      }
      case 'Runtime.consoleAPICalled': {
        if (!tab) break;
        const lvl = { warning: 'warn', error: 'error', assert: 'error', info: 'info', debug: 'debug' }[p.type] || 'log';
        const f = p.stackTrace?.callFrames?.[0];
        let text = (p.args || []).map(fmtRemote).join(' ');
        if (p.type === 'assert') text = 'Assertion failed: ' + text;
        if (p.type === 'clear') break;
        this._pushConsole(tab, { level: lvl, text: text.slice(0, 2000), src: f ? `${f.url.split('/').pop() || f.url}:${f.lineNumber + 1}` : '' });
        break;
      }
      case 'Runtime.exceptionThrown': {
        if (!tab) break;
        const d = p.exceptionDetails || {};
        this._pushConsole(tab, {
          level: 'exception',
          text: (d.exception?.description || d.text || 'Uncaught exception').slice(0, 3000),
          src: d.url ? `${d.url.split('/').pop()}:${(d.lineNumber ?? 0) + 1}:${(d.columnNumber ?? 0) + 1}` : '',
        });
        break;
      }
      case 'Log.entryAdded': {
        if (!tab) break;
        const e = p.entry;
        const lvl = { verbose: 'debug', info: 'info', warning: 'warn', error: 'error' }[e.level] || 'log';
        this._pushConsole(tab, { level: lvl, text: `[${e.source}] ${e.text}`.slice(0, 2000), src: e.url ? `${e.url.split('/').pop()}:${(e.lineNumber ?? 0) + 1}` : '' });
        break;
      }
      case 'Network.requestWillBeSent': {
        if (!tab) break;
        if (p.redirectResponse) {
          const prev = tab.netById.get(p.requestId);
          if (prev) { prev.status = p.redirectResponse.status; prev.ms = Math.round((p.timestamp - prev.start) * 1000); tab.inflight.delete(p.requestId); }
        }
        const e = { id: p.requestId, method: p.request.method, url: p.request.url, type: (p.type || '').toLowerCase(), t: Date.now(), start: p.timestamp, status: null, failed: false, ms: null, postData: p.request.postData || '' };
        tab.net.push(e); tab.netById.set(p.requestId, e); tab.inflight.add(p.requestId); tab.lastNetActivity = Date.now();
        if (tab.net.length > 1500) { const old = tab.net.splice(0, tab.net.length - 1500); for (const o of old) tab.netById.delete(o.id); }
        this.changed();
        break;
      }
      case 'Network.responseReceived': {
        const e = tab?.netById.get(p.requestId);
        if (e) { e.status = p.response.status; e.mime = p.response.mimeType; e.respHeaders = p.response.headers; }
        break;
      }
      case 'Network.loadingFinished': {
        const e = tab?.netById.get(p.requestId);
        if (e) { e.ms = Math.round((p.timestamp - e.start) * 1000); e.size = p.encodedDataLength; tab.inflight.delete(p.requestId); tab.lastNetActivity = Date.now(); }
        break;
      }
      case 'Network.loadingFailed': {
        const e = tab?.netById.get(p.requestId);
        if (e) {
          e.failed = true; e.error = p.errorText + (p.blockedReason ? ` (${p.blockedReason})` : ''); e.ms = Math.round((p.timestamp - e.start) * 1000);
          tab.inflight.delete(p.requestId); tab.lastNetActivity = Date.now();
          if (!p.canceled) this._pushConsole(tab, { level: 'error', text: `[network] ${e.method} ${e.url} failed: ${e.error}`.slice(0, 600), src: '' });
        }
        break;
      }
      case 'Page.frameNavigated': {
        if (!tab || p.frame.parentId) break;
        tab.url = p.frame.url; tab.loaded = false;
        this._pushConsole(tab, { level: 'info', text: `--- navigated to ${p.frame.url} ---`, src: '' });
        break;
      }
      case 'Page.loadEventFired': if (tab) { tab.loaded = true; this.changed(); } break;
      case 'Page.fileChooserOpened': if (tab) tab.chooser = p; break;
      case 'Input.dragIntercepted': if (tab) tab.dragData = p.data; break;
      case 'Fetch.requestPaused': if (tab) this._onPaused(tab, p); break;
      case 'Page.javascriptDialogOpening': {
        if (!tab) break;
        this._pushConsole(tab, { level: 'info', text: `[dialog ${p.type}] ${p.message}`, src: '' });
        this.send('Page.handleJavaScriptDialog', { accept: true, promptText: p.defaultPrompt || '' }, sessionId).catch(() => {});
        break;
      }
      default: break;
    }
  }

  // ---------- page helpers ----------
  // repl=true allows top-level await and re-declaring `const` between calls (used for the console-style
  // browser_eval). Internal page functions use repl=false so returned promises are awaited properly.
  async ev(expression, { awaitPromise = true, repl = true } = {}) {
    await this.ensure();
    const t = this.tab();
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true, replMode: repl, timeout: 20000 }, t.sessionId);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || 'evaluation failed');
    }
    return r.result;
  }

  /** Run a function in the page with (arg, lib). */
  async page(fn, arg = {}) {
    const src = `(${fn.toString()})(${JSON.stringify(arg)}, (${pageLib.toString()})())`;
    const r = await this.ev(src, { repl: false });
    return r.value;
  }

  async navigate(url, timeoutMs = 20000) {
    await this.ensure();
    const t = this.tab();
    t.loaded = false;
    const r = await this.send('Page.navigate', { url }, t.sessionId);
    if (r.errorText) throw new Error(`Navigation failed: ${r.errorText}`);
    await this.waitIdle(timeoutMs);
  }

  async waitIdle(timeoutMs = 15000) {
    const t = this.tab();
    if (!t) return;
    const t0 = Date.now();
    await sleep(150);
    while (Date.now() - t0 < timeoutMs) {
      const quiet = t.inflight.size === 0 && Date.now() - t.lastNetActivity > 500;
      if (t.loaded && quiet) return;
      if (!t.loaded && t.url.startsWith('about:') ) return;
      await sleep(100);
    }
  }

  async key(spec) {
    const t = this.tab();
    const parts = spec.split('+');
    const k = parts.pop();
    let mods = 0;
    for (const m of parts) mods |= { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 }[m.toLowerCase()] || 0;
    const def = KEYS[k] || (k.length === 1 ? { vk: k.toUpperCase().charCodeAt(0), text: k } : { vk: 0 });
    const base = { modifiers: mods, key: def.key || k, code: k.length === 1 ? (/[a-z]/i.test(k) ? 'Key' + k.toUpperCase() : 'Digit' + k) : k, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk };
    const printable = def.text && !(mods & 6);
    await this.send('Input.dispatchKeyEvent', { type: printable ? 'keyDown' : 'rawKeyDown', ...base, ...(printable ? { text: def.text } : {}) }, t.sessionId);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, t.sessionId);
  }

  /** o: 'click' | 'hover' | { type, button: left|right|middle, clicks: 1-3, modifiers: bitmask } */
  async mouse(x, y, o = 'click') {
    if (typeof o === 'string') o = { type: o };
    const s = this.tab().sessionId;
    const button = o.button || 'left', modifiers = o.modifiers || 0;
    const buttons = { left: 1, right: 2, middle: 4 }[button] || 1;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers }, s);
    if (o.type === 'hover') return;
    for (let i = 1; i <= (o.clicks || 1); i++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: i, modifiers }, s);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i, modifiers }, s);
    }
  }

  async wheel(x, y, deltaX = 0, deltaY = 0) {
    const s = this.tab().sessionId;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, s);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY }, s);
  }

  /** Press-move-release. Works for sliders, resizers, canvases and HTML5 drag-and-drop. */
  async drag(x1, y1, x2, y2, steps = 12) {
    const t = this.tab(), s = t.sessionId;
    t.dragData = null;
    await this.send('Input.setInterceptDrags', { enabled: true }, s).catch(() => {});
    try {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 }, s);
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 }, s);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + Math.sign(x2 - x1 || 1) * 6, y: y1 + Math.sign(y2 - y1 || 1) * 6, button: 'left', buttons: 1 }, s);
      await sleep(80);
      if (t.dragData) { // native HTML5 drag started: drive the drop ourselves
        const data = t.dragData;
        await this.send('Input.dispatchDragEvent', { type: 'dragEnter', x: x2, y: y2, data }, s);
        await this.send('Input.dispatchDragEvent', { type: 'dragOver', x: x2, y: y2, data }, s);
        await this.send('Input.dispatchDragEvent', { type: 'drop', x: x2, y: y2, data }, s);
        await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 }, s).catch(() => {});
        return 'html5-dnd';
      }
      for (let i = 1; i <= steps; i++) {
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + (x2 - x1) * i / steps, y: y1 + (y2 - y1) * i / steps, button: 'left', buttons: 1 }, s);
        await sleep(12);
      }
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 }, s);
      return 'mouse';
    } finally {
      await this.send('Input.setInterceptDrags', { enabled: false }, s).catch(() => {});
    }
  }

  /** Type like a person: one real keydown/keyup pair per character, with small delays. */
  async typeKeys(text, delayMs = 20) {
    const s = this.tab().sessionId;
    for (const ch of String(text)) {
      if (ch === '\n' || ch === '\r') { await this.key('Enter'); continue; }
      if (ch === '\t') { await this.key('Tab'); continue; }
      const up = ch.toUpperCase();
      const isAlpha = /[a-z]/i.test(ch), isDigit = /[0-9]/.test(ch);
      const base = { key: ch, code: isAlpha ? 'Key' + up : isDigit ? 'Digit' + ch : '', windowsVirtualKeyCode: isAlpha || isDigit ? up.charCodeAt(0) : ch.charCodeAt(0), text: ch, unmodifiedText: ch };
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, s);
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: base.code, windowsVirtualKeyCode: base.windowsVirtualKeyCode }, s);
      if (delayMs) await sleep(delayMs * (0.5 + Math.random()));
    }
  }

  /** Real paste: put text on the clipboard and press Ctrl+V (falls back to insertText). */
  async paste(text) {
    const s = this.tab().sessionId;
    try {
      await this.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
      await this.ev(`navigator.clipboard.writeText(${JSON.stringify(String(text))}).then(() => true)`);
      const k = { modifiers: 2, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86 };
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k, commands: ['paste'] }, s);
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k }, s);
      return 'clipboard + Ctrl+V';
    } catch {
      await this.send('Input.insertText', { text: String(text) }, s);
      return 'insertText';
    }
  }

  /** Resolve a ref/selector/text target to a CDP remote object (for DOM.* / DOMDebugger.* calls). */
  async handle(arg) {
    await this.ensure();
    const t = this.tab();
    const src = `(function(){ const L = (${pageLib.toString()})(); const f = L.find(${JSON.stringify(arg)}); return f ? f.el : null; })()`;
    const r = await this.send('Runtime.evaluate', { expression: src, returnByValue: false, userGesture: true }, t.sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.objectId ? r.result : null;
  }

  async callOn(objectId, fn, args = []) {
    const t = this.tab();
    const r = await this.send('Runtime.callFunctionOn', { objectId, functionDeclaration: fn, arguments: args.map(value => ({ value })), returnByValue: true, userGesture: true }, t.sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  /** Attach local files to an <input type=file>, or to whatever file chooser the target opens. */
  async setFiles(target, files) {
    const t = this.tab();
    const h = await this.handle(target);
    if (!h) throw new Error('Element not found. Take a fresh browser_snapshot.');
    const isInput = await this.callOn(h.objectId, 'function(){ return this.tagName === "INPUT" && this.type === "file"; }');
    if (isInput) {
      await this.send('DOM.setFileInputFiles', { files, objectId: h.objectId }, t.sessionId);
      await this.callOn(h.objectId, 'function(){ this.dispatchEvent(new Event("input",{bubbles:true})); this.dispatchEvent(new Event("change",{bubbles:true})); }').catch(() => {});
      return 'file input';
    }
    t.chooser = null;
    await this.send('Page.setInterceptFileChooserDialog', { enabled: true }, t.sessionId);
    try {
      await this.callOn(h.objectId, 'function(){ this.click(); }');
      for (let i = 0; i < 50 && !t.chooser; i++) await sleep(100);
      if (!t.chooser) throw new Error('Clicking the element did not open a file chooser. Target the <input type=file> directly (try selector "input[type=file]").');
      await this.send('DOM.setFileInputFiles', { files, backendNodeId: t.chooser.backendNodeId }, t.sessionId);
      return 'file chooser';
    } finally {
      await this.send('Page.setInterceptFileChooserDialog', { enabled: false }, t.sessionId).catch(() => {});
    }
  }

  async emulate(o) {
    const t = this.tab(), s = t.sessionId, done = [];
    if (o.reset) {
      await this.send('Emulation.clearDeviceMetricsOverride', {}, s).catch(() => {});
      await this.send('Emulation.setUserAgentOverride', { userAgent: '' }, s).catch(() => {});
      await this.send('Emulation.setCPUThrottlingRate', { rate: 1 }, s).catch(() => {});
      await this.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, s).catch(() => {});
      await this.send('Emulation.setEmulatedMedia', { features: [] }, s).catch(() => {});
      return ['reset all emulation'];
    }
    if (o.width && o.height) { await this.send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: o.scale || (o.mobile ? 2 : 1), mobile: !!o.mobile }, s); done.push(`viewport ${o.width}x${o.height}${o.mobile ? ' (mobile)' : ''}`); }
    if (o.dark !== undefined) { await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: o.dark ? 'dark' : 'light' }] }, s); done.push(o.dark ? 'dark mode' : 'light mode'); }
    if (o.user_agent) { await this.send('Emulation.setUserAgentOverride', { userAgent: o.user_agent }, s); done.push('user agent'); }
    if (o.timezone) { await this.send('Emulation.setTimezoneOverride', { timezoneId: o.timezone }, s); done.push('timezone ' + o.timezone); }
    if (o.locale) { await this.send('Emulation.setLocaleOverride', { locale: o.locale }, s).catch(() => {}); done.push('locale ' + o.locale); }
    if (o.latitude !== undefined && o.longitude !== undefined) {
      await this.send('Browser.grantPermissions', { permissions: ['geolocation'] }).catch(() => {});
      await this.send('Emulation.setGeolocationOverride', { latitude: o.latitude, longitude: o.longitude, accuracy: 50 }, s); done.push(`geolocation ${o.latitude},${o.longitude}`);
    }
    if (o.cpu_throttle) { await this.send('Emulation.setCPUThrottlingRate', { rate: o.cpu_throttle }, s); done.push(`CPU ${o.cpu_throttle}x slower`); }
    if (o.network) {
      const presets = { offline: [true, 0, 0, 0], slow3g: [false, 400, 50 * 1024, 50 * 1024], fast3g: [false, 150, 200 * 1024, 90 * 1024], none: [false, 0, -1, -1] };
      const p = presets[o.network]; if (!p) throw new Error('network must be offline | slow3g | fast3g | none');
      await this.send('Network.emulateNetworkConditions', { offline: p[0], latency: p[1], downloadThroughput: p[2], uploadThroughput: p[3] }, s); done.push('network ' + o.network);
    }
    return done;
  }

  async inject(source) {
    const t = this.tab();
    const { identifier } = await this.send('Page.addScriptToEvaluateOnNewDocument', { source }, t.sessionId);
    t.inject.push({ id: identifier, size: source.length, head: source.slice(0, 80).replace(/\s+/g, ' ') });
    return identifier;
  }
  async removeInjection(id) {
    const t = this.tab();
    const list = id === 'all' ? [...t.inject] : t.inject.filter(i => i.id === id);
    for (const i of list) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: i.id }, t.sessionId).catch(() => {});
    t.inject = t.inject.filter(i => !list.includes(i));
    return list.length;
  }

  // ---- network interception (Fetch domain): block / mock / delay / modify request headers ----
  async setRules(rules) {
    this.rules = rules;
    for (const t of this.tabs.values()) {
      if (rules.length) await this.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, t.sessionId).catch(() => {});
      else await this.send('Fetch.disable', {}, t.sessionId).catch(() => {});
    }
  }
  _onPaused(tab, p) {
    const s = tab.sessionId, requestId = p.requestId, url = p.request.url;
    const rule = this.rules.find(r => r.re.test(url) && (!r.method || r.method === p.request.method));
    const go = (m, params) => this.send(m, { requestId, ...params }, s).catch(() => {});
    if (!rule) return go('Fetch.continueRequest', {});
    rule.hits = (rule.hits || 0) + 1;
    this._pushConsole(tab, { level: 'info', text: `[intercept #${rule.id} ${rule.mode}] ${p.request.method} ${url}`.slice(0, 400), src: '' });
    switch (rule.mode) {
      case 'block': return go('Fetch.failRequest', { errorReason: 'BlockedByClient' });
      case 'mock': return go('Fetch.fulfillRequest', {
        responseCode: rule.status || 200,
        responseHeaders: [{ name: 'Content-Type', value: rule.contentType || 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: '*' }, { name: 'Access-Control-Allow-Methods', value: '*' }],
        body: Buffer.from(rule.body ?? '').toString('base64'),
      });
      case 'delay': return void setTimeout(() => go('Fetch.continueRequest', {}), rule.delayMs || 2000);
      case 'headers': {
        const h = { ...p.request.headers, ...(rule.headers || {}) };
        return go('Fetch.continueRequest', { headers: Object.entries(h).map(([name, value]) => ({ name, value: String(value) })) });
      }
      default: return go('Fetch.continueRequest', {});
    }
  }

  async screenshot({ fullPage = false, clip } = {}) {
    await this.ensure();
    const t = this.tab();
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!(fullPage || clip), fromSurface: true, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, t.sessionId);
    const file = path.join(SHOTS_DIR, `shot_${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    this.lastShot = file;
    // keep the folder small
    try {
      const files = fs.readdirSync(SHOTS_DIR).filter(f => f.startsWith('shot_')).sort();
      for (const f of files.slice(0, Math.max(0, files.length - 30))) fs.unlinkSync(path.join(SHOTS_DIR, f));
    } catch { /* ignore */ }
    return file;
  }

  async newTab(url = 'about:blank') {
    await this.ensure();
    const { targetId } = await this.send('Target.createTarget', { url });
    for (let i = 0; i < 40 && !this.tabs.has(targetId); i++) await sleep(100);
    this.current = targetId;
    await this.send('Target.activateTarget', { targetId }).catch(() => {});
    if (url !== 'about:blank') await this.waitIdle(15000);
  }

  listTabs() {
    return [...this.tabs.values()].map((t, i) => ({ index: i, current: t.targetId === this.current, url: t.url, title: t.title, targetId: t.targetId }));
  }
  async switchTab(index) {
    const t = [...this.tabs.values()][index];
    if (!t) throw new Error(`No tab with index ${index}`);
    this.current = t.targetId;
    await this.send('Target.activateTarget', { targetId: t.targetId }).catch(() => {});
    this.changed();
  }
  async closeTab(index) {
    const t = index === undefined ? this.tab() : [...this.tabs.values()][index];
    if (!t) throw new Error('No such tab');
    await this.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
  }

  async close() {
    try { if (this.open) await this.send('Browser.close').catch(() => {}); } catch { /* ignore */ }
    try { this.ws?.close(); } catch { /* ignore */ }
    if (this.proc?.pid) { try { spawn('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ } }
    this.proc = null;
    this._teardown();
  }

  async responseBody(requestId) {
    const t = this.tab();
    const r = await this.send('Network.getResponseBody', { requestId }, t.sessionId);
    return r.base64Encoded ? `[binary, ${r.body.length} base64 chars]` : r.body;
  }
}

export const browser = new Browser();

// =====================================================================================
// Code below is serialised with .toString() and executed INSIDE the web page.
// It must not reference anything from this module's scope.
// =====================================================================================

function pageLib() {
  const INTER = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=combobox],[role=option],[role=treeitem],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  function* roots(rootNode, ox, oy, seen) {
    yield { root: rootNode, ox, oy };
    let all; try { all = rootNode.querySelectorAll('*'); } catch { return; }
    for (const el of all) {
      if (el.shadowRoot && !seen.has(el.shadowRoot)) { seen.add(el.shadowRoot); yield* roots(el.shadowRoot, ox, oy, seen); }
      if (el.tagName === 'IFRAME') {
        try { const d = el.contentDocument; if (d && !seen.has(d)) { seen.add(d); const r = el.getBoundingClientRect(); yield* roots(d, ox + r.left, oy + r.top, seen); } } catch { /* cross-origin */ }
      }
    }
  }
  function allRoots() { return roots(document, 0, 0, new Set()); }
  function label(el) {
    const a = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder');
    let t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (el.tagName === 'INPUT' && !t) t = el.value && el.type !== 'password' ? el.value : '';
    if (!t && el.id) { const l = (el.getRootNode().querySelector ? el.getRootNode().querySelector('label[for="' + CSS.escape(el.id) + '"]') : null); if (l) t = l.innerText.trim(); }
    if (!t) { const img = el.querySelector && el.querySelector('img[alt]'); if (img) t = img.alt; }
    const out = (t || a || '').replace(/\s+/g, ' ').trim();
    return out.length > 100 ? out.slice(0, 100) + '…' : out;
  }
  function find(arg) {
    if (arg.ref !== undefined && arg.ref !== null && arg.ref !== '') {
      for (const r of allRoots()) { const el = r.root.querySelector('[data-xref="' + String(arg.ref).replace(/[^0-9]/g, '') + '"]'); if (el) return { el, ox: r.ox, oy: r.oy }; }
      return null;
    }
    if (arg.selector) {
      for (const r of allRoots()) { let el = null; try { el = r.root.querySelector(arg.selector); } catch (e) { throw new Error('Bad selector: ' + e.message); } if (el) return { el, ox: r.ox, oy: r.oy }; }
      return null;
    }
    if (arg.text) {
      const want = arg.text.trim().toLowerCase();
      let best = null, bestScore = -1;
      for (const r of allRoots()) {
        const els = r.root.querySelectorAll('*');
        for (const el of els) {
          if (['SCRIPT', 'STYLE', 'HTML', 'BODY', 'HEAD'].includes(el.tagName)) continue;
          const rect = el.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) continue;
          const own = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const lab = label(el).toLowerCase();
          const inter = el.matches(INTER);
          let score = -1;
          if (own === want || lab === want) score = inter ? 100 : 60;
          else if (own.includes(want) || lab.includes(want)) score = inter ? 50 - Math.min(40, own.length / 10) : 10 - Math.min(9, own.length / 100);
          if (score > bestScore) { bestScore = score; best = { el, ox: r.ox, oy: r.oy }; }
        }
      }
      return best;
    }
    throw new Error('Provide ref, selector or text');
  }
  function describe(el) {
    const id = el.id ? '#' + el.id : '';
    const cls = el.classList && el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + id + cls;
  }
  return { INTER, allRoots, label, find, describe };
}

// Compact accessibility-style snapshot with [ref] ids on interactive elements.
function pageSnapshot(arg, L) {
  const max = arg.maxChars || 12000;
  const vh = innerHeight;
  let n = window.__xN || 0;
  const lines = []; let chars = 0; let truncated = false;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'PATH', 'DEFS', 'LINEARGRADIENT', 'CLIPPATH']);
  const LAND = { NAV: 'nav', MAIN: 'main', HEADER: 'header', FOOTER: 'footer', ASIDE: 'aside', FORM: 'form', DIALOG: 'dialog', TABLE: 'table', UL: 'list', OL: 'list', SECTION: 'section', ARTICLE: 'article' };
  const INLINE = new Set(['SPAN', 'B', 'I', 'EM', 'STRONG', 'SMALL', 'CODE', 'U', 'SUP', 'SUB', 'MARK', 'ABBR', 'TIME', 'FONT', 'LABEL', 'S', 'CITE', 'Q']);
  const CURSORS = new Set(['pointer', 'grab', 'grabbing', 'move', 'col-resize', 'row-resize', 'ew-resize', 'ns-resize', 'crosshair']);

  function emit(depth, s) {
    if (truncated) return;
    if (chars > max) { truncated = true; lines.push('… [snapshot truncated — use a selector, viewport_only, or browser_dom to focus]'); return; }
    const line = '  '.repeat(Math.min(depth, 12)) + s; lines.push(line); chars += line.length + 1;
  }
  function hidden(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0' && !el.matches(L.INTER)) return true;
    return false;
  }
  function inView(el) { if (!arg.viewportOnly) return true; const r = el.getBoundingClientRect(); return r.bottom >= 0 && r.top <= vh && r.right >= 0 && r.left <= innerWidth; }
  function refOf(el) { if (!el.hasAttribute('data-xref')) el.setAttribute('data-xref', String(++n)); return el.getAttribute('data-xref'); }

  function walkChildren(parent, depth, buf) {
    for (const c of parent.childNodes) { if (truncated) return; walk(c, depth, buf); }
    if (parent.shadowRoot) for (const c of parent.shadowRoot.childNodes) { if (truncated) return; walk(c, depth, buf); }
  }
  function flush(depth, buf) {
    const t = buf.t.replace(/\s+/g, ' ').trim();
    if (t) emit(depth, '"' + (t.length > 240 ? t.slice(0, 240) + '…' : t) + '"');
    buf.t = '';
  }
  function walk(node, depth, buf) {
    if (node.nodeType === 3) { buf.t += node.nodeValue; return; }
    if (node.nodeType !== 1) return;
    const el = node;
    if (SKIP.has(el.tagName.toUpperCase())) return;
    if (el.tagName === 'svg' || el.namespaceURI === 'http://www.w3.org/2000/svg') { if (el.tagName === 'svg' && el.getAttribute('aria-label')) { flush(depth, buf); emit(depth, 'icon "' + el.getAttribute('aria-label') + '"'); } return; }
    if (el.getAttribute('aria-hidden') === 'true' && !el.matches(L.INTER)) return;
    if (hidden(el)) return;
    const tag = el.tagName;
    const isInter = el.matches(L.INTER);
    if (isInter) {
      flush(depth, buf);
      if (!inView(el)) return;
      const r = refOf(el);
      const type = el.getAttribute('type');
      let s = '[' + r + '] ' + tag.toLowerCase() + (type && tag === 'INPUT' ? '[' + type + ']' : '');
      const role = el.getAttribute('role'); if (role) s += '{' + role + '}';
      const lab = L.label(el);
      if (lab) s += ' "' + lab + '"';
      if (tag === 'A' && el.getAttribute('href')) { const h = el.getAttribute('href'); s += ' -> ' + (h.length > 90 ? h.slice(0, 90) + '…' : h); }
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (type === 'checkbox' || type === 'radio') s += el.checked ? ' [checked]' : ' [unchecked]';
        else if (el.value && type !== 'password') s += ' value="' + el.value.slice(0, 80) + '"';
        if (el.name) s += ' name=' + el.name;
        if (el.required) s += ' [required]';
      }
      if (tag === 'SELECT') {
        const opts = [...el.options].slice(0, 10).map(o => (o.selected ? '*' : '') + o.text.trim().slice(0, 30));
        s += ' value="' + (el.selectedOptions[0] ? el.selectedOptions[0].text.trim() : '') + '" options: ' + opts.join(' | ') + (el.options.length > 10 ? ' …' : '');
      }
      if (el.disabled) s += ' [disabled]';
      if (el.getAttribute('aria-expanded')) s += ' [expanded=' + el.getAttribute('aria-expanded') + ']';
      if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true') s += ' [selected]';
      emit(depth, s);
      return;
    }
    // Custom widgets built from plain elements (sliders, cards, icon buttons): detect them by a pointer/grab cursor set on the
    // element itself (cursor is inherited, so compare with the parent) or the draggable attribute.
    {
      let custom = '';
      if (el.draggable) custom = 'draggable';
      else { const cur = getComputedStyle(el).cursor; if (CURSORS.has(cur)) { const pc = el.parentElement ? getComputedStyle(el.parentElement).cursor : ''; if (pc !== cur) custom = 'clickable'; } }
      if (custom && inView(el)) {
        flush(depth, buf);
        const lab = L.label(el);
        emit(depth, '[' + refOf(el) + '] ' + tag.toLowerCase() + '{' + custom + '}' + (el.id ? '#' + el.id : el.classList.length ? '.' + el.classList[0] : '') + (lab && el.children.length === 0 ? ' "' + lab + '"' : ''));
      }
    }
    if (/^H[1-6]$/.test(tag)) { flush(depth, buf); const t = L.label(el); if (t) emit(depth, tag.toLowerCase() + ' "' + t + '"'); return; }
    if (tag === 'IMG') { const a = el.getAttribute('alt'); if (a) { flush(depth, buf); emit(depth, 'img "' + a.slice(0, 100) + '"'); } return; }
    if (tag === 'IFRAME') {
      flush(depth, buf);
      let d = null; try { d = el.contentDocument; } catch { /* x-origin */ }
      emit(depth, 'iframe ' + (el.src ? el.src.slice(0, 80) : '') + (d ? '' : ' [cross-origin: not readable]'));
      if (d && d.body) { const b2 = { t: '' }; walkChildren(d.body, depth + 1, b2); flush(depth + 1, b2); }
      return;
    }
    if (tag === 'BR') { buf.t += ' '; return; }
    if (INLINE.has(tag)) { walkChildren(el, depth, buf); return; }
    // block-level container
    flush(depth, buf);
    const lm = LAND[tag] || (el.getAttribute('role') && ['navigation', 'main', 'banner', 'contentinfo', 'dialog', 'alert', 'search'].includes(el.getAttribute('role')) ? el.getAttribute('role') : null);
    if (lm && (tag !== 'SECTION' || el.getAttribute('aria-label'))) {
      emit(depth, '<' + lm + (el.getAttribute('aria-label') ? ' "' + el.getAttribute('aria-label') + '"' : '') + '>');
      const b2 = { t: '' }; walkChildren(el, depth + 1, b2); flush(depth + 1, b2);
    } else {
      const b2 = { t: '' }; walkChildren(el, depth, b2); flush(depth, b2);
    }
    if (tag === 'LI' || tag === 'TR' || tag === 'P') { /* boundary handled by flush */ }
  }

  let rootEl = document.body;
  if (arg.selector) { try { rootEl = document.querySelector(arg.selector); } catch (e) { return 'Bad selector: ' + e.message; } if (!rootEl) return 'No element matches selector ' + arg.selector; }
  const b = { t: '' };
  // With a selector the element itself is part of the answer (e.g. selector "h1" or "button#go").
  if (arg.selector) walk(rootEl, 0, b); else walkChildren(rootEl, 0, b);
  flush(0, b);
  window.__xN = n;
  const sh = document.documentElement.scrollHeight;
  const head = 'URL: ' + location.href + '\nTitle: ' + document.title + '\nScroll: ' + Math.round(scrollY) + '/' + Math.max(0, sh - vh) + 'px (viewport ' + innerWidth + 'x' + vh + ')';
  return head + '\n---\n' + (lines.join('\n') || '(page has no visible content yet)');
}

// Raw structural DOM outline ("website tree").
function pageDom(arg, L) {
  const max = arg.maxChars || 14000;
  const maxDepth = arg.depth || 6;
  const lines = []; let chars = 0; let truncated = false;
  const KEYATTR = ['id', 'name', 'type', 'href', 'src', 'role', 'aria-label', 'placeholder', 'value', 'data-testid', 'alt', 'for', 'action', 'method', 'content'];
  function sig(el) { return el.tagName + '|' + (el.className && typeof el.className === 'string' ? el.className : ''); }
  function head(el) {
    const tag = el.tagName.toLowerCase();
    let s = tag;
    if (el.id) s += '#' + el.id;
    if (el.classList && el.classList.length) s += '.' + [...el.classList].slice(0, 3).map(c => c.slice(0, 30)).join('.');
    const attrs = [];
    for (const a of KEYATTR) { if (a === 'id') continue; const v = el.getAttribute && el.getAttribute(a); if (v) attrs.push(a + '=' + JSON.stringify(v.length > 60 ? v.slice(0, 60) + '…' : v)); }
    if (attrs.length) s += ' [' + attrs.join(' ') + ']';
    return s;
  }
  function ownText(el) {
    let t = ''; for (const c of el.childNodes) if (c.nodeType === 3) t += c.nodeValue;
    t = t.replace(/\s+/g, ' ').trim();
    return t ? ' "' + (t.length > 60 ? t.slice(0, 60) + '…' : t) + '"' : '';
  }
  function flags(el) {
    let f = '';
    try { const cs = getComputedStyle(el); if (cs.display === 'none') f += ' {display:none}'; else if (cs.visibility === 'hidden') f += ' {hidden}'; } catch { /* ignore */ }
    if (el.hasAttribute && el.hasAttribute('data-xref')) f += ' (ref ' + el.getAttribute('data-xref') + ')';
    if (el.shadowRoot) f += ' {shadow-root}';
    return f;
  }
  function out(depth, s) {
    if (truncated) return;
    if (chars > max) { truncated = true; lines.push('… [outline truncated — pass a selector or smaller depth]'); return; }
    const line = '  '.repeat(depth) + s; lines.push(line); chars += line.length + 1;
  }
  function walk(el, depth) {
    if (truncated) return;
    const tag = el.tagName;
    if (tag === 'SCRIPT') { out(depth, 'script' + (el.src ? ' src=' + JSON.stringify(el.src.slice(0, 100)) : ' (inline ' + el.textContent.length + ' chars)')); return; }
    if (tag === 'STYLE') { out(depth, 'style (' + el.textContent.length + ' chars)'); return; }
    if (tag === 'svg' || el.namespaceURI === 'http://www.w3.org/2000/svg') { out(depth, 'svg'); return; }
    const kids = [...el.children];
    if (el.shadowRoot) for (const c of el.shadowRoot.children) kids.push(c);
    let doc = null; if (tag === 'IFRAME') { try { doc = el.contentDocument; } catch { /* x-origin */ } }
    out(depth, head(el) + ownText(el) + flags(el) + (tag === 'IFRAME' && !doc ? ' {cross-origin iframe}' : ''));
    if (doc && doc.documentElement) { if (depth < maxDepth) walk(doc.documentElement, depth + 1); return; }
    if (depth >= maxDepth) { if (kids.length) out(depth + 1, '(+' + kids.length + ' children not shown)'); return; }
    let i = 0;
    while (i < kids.length) {
      if (truncated) return;
      const k = kids[i]; const s = sig(k);
      let j = i + 1; while (j < kids.length && sig(kids[j]) === s && kids[j].children.length === k.children.length && j - i < 100000) j++;
      walk(k, depth + 1);
      if (j - i > 3) { out(depth + 1, '… ×' + (j - i - 1) + ' more like the above (' + head(k).split(' ')[0] + ')'); i = j; }
      else i++;
    }
  }
  let root = document.documentElement;
  if (arg.selector) { try { root = document.querySelector(arg.selector); } catch (e) { return 'Bad selector: ' + e.message; } if (!root) return 'No element matches selector ' + arg.selector; }
  walk(root, 0);
  return lines.join('\n');
}

function pageLocate(arg, L) {
  const f = L.find(arg);
  if (!f) return { ok: false, error: 'Element not found (' + JSON.stringify(arg) + '). Take a fresh browser_snapshot — refs change when the page re-renders.' };
  const { el, ox, oy } = f;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const res = { ok: true, tag: el.tagName.toLowerCase(), label: L.label(el), desc: L.describe(el), w: r.width, h: r.height };
  if (r.width === 0 && r.height === 0) { res.noBox = true; return res; }
  res.x = Math.round(ox + r.left + r.width / 2); res.y = Math.round(oy + r.top + r.height / 2);
  try {
    const doc = el.ownerDocument; const top = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (top && top !== el && !el.contains(top) && !top.contains(el) && !(el.getRootNode() !== doc && el.getRootNode().host && el.getRootNode().host.contains(top))) res.covered = L.describe(top);
  } catch { /* ignore */ }
  return res;
}

function pageFocusType(arg, L) {
  const f = L.find(arg);
  if (!f) return { ok: false, error: 'Element not found. Take a fresh browser_snapshot.' };
  const el = f.el;
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (arg.clear) {
    if ('select' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.select();
    else if (el.isContentEditable) document.execCommand('selectAll');
  } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* some input types */ } }
  return { ok: true, desc: L.describe(el), editable: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable };
}

function pageSelect(arg, L) {
  const f = L.find(arg);
  if (!f || f.el.tagName !== 'SELECT') return { ok: false, error: 'No <select> found for that ref/selector.' };
  const el = f.el;
  const v = String(arg.value).toLowerCase();
  const opt = [...el.options].find(o => o.value.toLowerCase() === v || o.text.trim().toLowerCase() === v) || [...el.options].find(o => o.text.toLowerCase().includes(v));
  if (!opt) return { ok: false, error: 'No option matches. Options: ' + [...el.options].map(o => o.text.trim()).join(' | ') };
  el.value = opt.value;
  el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, selected: opt.text.trim() };
}

function pageWaitCheck(arg, L) {
  if (arg.selector) {
    let found = false; try { for (const r of L.allRoots()) if (r.root.querySelector(arg.selector)) { found = true; break; } } catch { /* ignore */ }
    return arg.gone ? !found : found;
  }
  if (arg.text) {
    const has = (document.body.innerText || '').toLowerCase().includes(arg.text.toLowerCase());
    return arg.gone ? !has : has;
  }
  return true;
}
// Deep inspection of the page / an element. arg: { what, ref|selector|text, maxChars }
async function pageInspect(arg, L) {
  const max = arg.maxChars || 10000;
  const cut = (s, n = max) => (s.length > n ? s.slice(0, n) + '\n… [cut ' + (s.length - n) + ' chars; narrow with a selector or raise max_chars]' : s);
  const has = !!(arg.ref || arg.selector || arg.text);
  const target = (required) => {
    if (!has) { if (required) throw new Error('"' + arg.what + '" needs a ref, selector or text to know which element to inspect'); return null; }
    const f = L.find(arg); if (!f) throw new Error('Element not found. Take a fresh browser_snapshot.'); return f.el;
  };
  const path = (el) => { const p = []; while (el && el.nodeType === 1 && p.length < 12) { p.unshift(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList && el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '')); el = el.parentElement || (el.getRootNode() && el.getRootNode().host); } return p.join(' > '); };
  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  switch (arg.what) {
    case 'html': { const el = target() || document.documentElement; return cut(el.outerHTML); }
    case 'source': {
      const r = await fetch(location.href, { cache: 'no-store' });
      const t = await r.text();
      return 'Raw source as served (' + r.status + ', ' + t.length + ' chars, before JavaScript ran):\n' + cut(t);
    }
    case 'styles': {
      const el = target(true), cs = getComputedStyle(el);
      const always = ['display', 'position', 'width', 'height', 'color', 'background-color', 'font-size', 'opacity', 'visibility', 'overflow', 'z-index', 'pointer-events', 'cursor'];
      const more = ['top', 'right', 'bottom', 'left', 'min-width', 'max-width', 'min-height', 'max-height', 'margin', 'padding', 'border', 'box-sizing', 'overflow-x', 'overflow-y', 'float', 'flex', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap', 'grid-template-columns', 'grid-template-rows', 'background-image', 'font-family', 'font-weight', 'line-height', 'text-align', 'text-decoration', 'transform', 'transition', 'animation', 'user-select', 'white-space', 'text-overflow', 'filter', 'box-shadow', 'border-radius', 'content'];
      const dflt = new Set(['none', 'normal', 'auto', '0px', 'static', 'visible', 'rgba(0, 0, 0, 0)', 'baseline', 'start', 'row', 'nowrap', 'stretch', 'content-box', '0px 0px 0px 0px', 'rgba(0, 0, 0, 0) none repeat scroll 0% 0% / auto padding-box border-box', 'all 0s ease 0s', 'matrix(1, 0, 0, 1, 0, 0)', '']);
      const lines = [];
      for (const p of always) lines.push('  ' + p + ': ' + cs.getPropertyValue(p));
      for (const p of more) { const v = cs.getPropertyValue(p); if (v && !dflt.has(v)) lines.push('  ' + p + ': ' + (v.length > 120 ? v.slice(0, 120) + '…' : v)); }
      const rules = [];
      const walk = (rs, href, media) => {
        for (const r of rs) {
          try {
            if (r.cssRules && !r.selectorText) { walk(r.cssRules, href, r.conditionText || r.media?.mediaText || media); continue; }
            if (r.selectorText && el.matches(r.selectorText)) rules.push('  ' + r.selectorText + ' { ' + r.style.cssText.slice(0, 400) + ' }  /* ' + href + (media ? ' @media ' + media : '') + ' */');
          } catch { /* unmatched pseudo selectors etc. */ }
        }
      };
      let blocked = 0;
      for (const sh of document.styleSheets) { try { walk(sh.cssRules, sh.href ? sh.href.split('/').slice(-1)[0] : 'inline <style>', ''); } catch { blocked++; } }
      const inline = el.getAttribute('style');
      return path(el) + '\nComputed (non-default):\n' + lines.join('\n') + '\n\nMatching CSS rules (in cascade order, later wins):\n' + (rules.join('\n') || '  (none)') + (inline ? '\n\nInline style: ' + inline : '') + (blocked ? '\n[' + blocked + ' cross-origin stylesheets not readable]' : '');
    }
    case 'box': {
      const el = target(true), r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      const vis = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) / Math.max(1, r.width * r.height);
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      const out = [path(el), 'rect: x=' + r.x.toFixed(1) + ' y=' + r.y.toFixed(1) + ' w=' + r.width.toFixed(1) + ' h=' + r.height.toFixed(1) + '  (page y=' + (r.y + scrollY).toFixed(0) + ')',
        'visible in viewport: ' + Math.round(vis * 100) + '%', 'scrollSize: ' + el.scrollWidth + 'x' + el.scrollHeight + ' client: ' + el.clientWidth + 'x' + el.clientHeight + (el.scrollHeight > el.clientHeight + 1 ? '  (vertically scrollable)' : ''),
        'offsetParent: ' + (el.offsetParent ? el.offsetParent.tagName.toLowerCase() : 'null' + (cs.position === 'fixed' ? ' (fixed)' : cs.display === 'none' ? ' (display:none)' : '')),
        'topmost element at its centre: ' + (top ? (top === el || el.contains(top) ? 'itself/child (clickable)' : 'COVERED by ' + path(top)) : 'none')];
      out.push('ancestors that clip, scroll or create stacking contexts:');
      for (let a = el.parentElement, n = 0; a && n < 12; a = a.parentElement, n++) {
        const s = getComputedStyle(a), notes = [];
        if (s.overflow !== 'visible') notes.push('overflow:' + s.overflow); if (s.position !== 'static') notes.push('position:' + s.position);
        if (s.zIndex !== 'auto') notes.push('z-index:' + s.zIndex); if (s.transform !== 'none') notes.push('transform'); if (s.opacity !== '1') notes.push('opacity:' + s.opacity); if (s.display === 'none') notes.push('display:none');
        if (notes.length) out.push('  ' + a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + (a.classList.length ? '.' + a.classList[0] : '') + ': ' + notes.join(' '));
      }
      return out.join('\n');
    }
    case 'attrs': {
      const el = target(true);
      const out = [path(el), 'attributes:'];
      for (const a of el.attributes) out.push('  ' + a.name + '=' + JSON.stringify(a.value.length > 200 ? a.value.slice(0, 200) + '…' : a.value));
      const props = {};
      for (const k of ['value', 'checked', 'disabled', 'readOnly', 'selected', 'href', 'src', 'currentSrc', 'tabIndex', 'isContentEditable', 'innerText', 'textContent']) { try { const v = el[k]; if (v !== undefined && v !== '' && v !== null) props[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : (el.type === 'password' && k === 'value' ? '••••' : v); } catch { /* ignore */ } }
      out.push('properties: ' + JSON.stringify(props));
      if (Object.keys(el.dataset || {}).length) out.push('dataset: ' + JSON.stringify(el.dataset));
      if (el.validity) out.push('validity: ' + (el.validity.valid ? 'valid' : 'INVALID — ' + (el.validationMessage || Object.keys(Object.getPrototypeOf(el.validity)).filter(k => el.validity[k]).join(','))));
      if (el.shadowRoot) out.push('shadowRoot: open, ' + el.shadowRoot.children.length + ' children');
      try { out.push('running animations: ' + el.getAnimations().length); } catch { /* ignore */ }
      return out.join('\n');
    }
    case 'storage': {
      const fmt = (st) => Object.keys(st).map(k => '  ' + k + ' = ' + String(st.getItem(k)).slice(0, 300)).join('\n') || '  (empty)';
      const out = ['localStorage (' + localStorage.length + '):\n' + fmt(localStorage), 'sessionStorage (' + sessionStorage.length + '):\n' + fmt(sessionStorage), 'document.cookie (JS-visible only): ' + (document.cookie || '(none)')];
      try { if (indexedDB.databases) out.push('IndexedDB: ' + (JSON.stringify((await indexedDB.databases()).map(d => d.name + ' v' + d.version)) || '[]')); } catch { /* ignore */ }
      try { out.push('Cache Storage: ' + JSON.stringify(await caches.keys())); } catch { /* ignore */ }
      try { const regs = await navigator.serviceWorker.getRegistrations(); out.push('Service workers: ' + (regs.map(r => r.scope + ' [' + (r.active ? r.active.state : 'no active') + ']').join(', ') || 'none')); } catch { /* ignore */ }
      try { const e = await navigator.storage.estimate(); out.push('Storage used: ' + kb(e.usage) + ' of ' + kb(e.quota)); } catch { /* ignore */ }
      return cut(out.join('\n'));
    }
    case 'performance': {
      const nav = performance.getEntriesByType('navigation')[0], out = [];
      if (nav) out.push('navigation: ttfb=' + Math.round(nav.responseStart - nav.requestStart) + 'ms  dns=' + Math.round(nav.domainLookupEnd - nav.domainLookupStart) + 'ms  connect=' + Math.round(nav.connectEnd - nav.connectStart) + 'ms  domInteractive=' + Math.round(nav.domInteractive) + 'ms  DOMContentLoaded=' + Math.round(nav.domContentLoadedEventEnd) + 'ms  load=' + Math.round(nav.loadEventEnd) + 'ms  protocol=' + nav.nextHopProtocol + '  transfer=' + kb(nav.transferSize || 0));
      out.push('paint: ' + performance.getEntriesByType('paint').map(p => p.name + '=' + Math.round(p.startTime) + 'ms').join('  '));
      const obs = (type) => new Promise(res => { const got = []; try { new PerformanceObserver(l => got.push(...l.getEntries())).observe({ type, buffered: true }); } catch { /* unsupported */ } setTimeout(() => res(got), 120); });
      const lcp = (await obs('largest-contentful-paint')).pop(); if (lcp) out.push('LCP: ' + Math.round(lcp.startTime) + 'ms (' + (lcp.element ? lcp.element.tagName.toLowerCase() : '?') + ')');
      const cls = (await obs('layout-shift')).filter(e => !e.hadRecentInput).reduce((a, e) => a + e.value, 0); out.push('CLS: ' + cls.toFixed(3));
      const res = performance.getEntriesByType('resource'), by = {};
      let total = 0; for (const r of res) { const k = r.initiatorType || 'other'; by[k] = by[k] || { n: 0, size: 0 }; by[k].n++; by[k].size += r.transferSize || 0; total += r.transferSize || 0; }
      out.push('resources: ' + res.length + ' requests, ' + kb(total) + ' transferred — ' + Object.entries(by).map(([k, v]) => k + ':' + v.n + '/' + kb(v.size)).join('  '));
      out.push('slowest:\n' + [...res].sort((a, b) => b.duration - a.duration).slice(0, 6).map(r => '  ' + Math.round(r.duration) + 'ms ' + r.name.slice(0, 120)).join('\n'));
      out.push('largest:\n' + [...res].sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0)).slice(0, 6).map(r => '  ' + kb(r.transferSize || 0) + ' ' + r.name.slice(0, 120)).join('\n'));
      if (performance.memory) out.push('JS heap: ' + kb(performance.memory.usedJSHeapSize) + ' / ' + kb(performance.memory.totalJSHeapSize));
      out.push('DOM: ' + document.getElementsByTagName('*').length + ' elements, ' + document.scripts.length + ' scripts, ' + document.images.length + ' images');
      return out.join('\n');
    }
    case 'forms': {
      const out = [];
      const fields = (root) => [...root.querySelectorAll('input,select,textarea,button')].map(f => '    ' + f.tagName.toLowerCase() + (f.type ? '[' + f.type + ']' : '') + (f.name ? ' name=' + f.name : '') + (f.id ? ' #' + f.id : '') + (f.required ? ' required' : '') + (f.disabled ? ' disabled' : '') + (f.type === 'password' ? ' value=••••' : f.value ? ' value=' + JSON.stringify(String(f.value).slice(0, 60)) : '') + (f.validity && !f.validity.valid ? '  INVALID: ' + f.validationMessage : '')).join('\n');
      document.querySelectorAll('form').forEach((f, i) => out.push('form #' + (i + 1) + (f.id ? ' id=' + f.id : '') + ' action=' + (f.getAttribute('action') || '(same page)') + ' method=' + (f.method || 'get') + '\n' + fields(f)));
      const loose = [...document.querySelectorAll('input,select,textarea')].filter(f => !f.form);
      if (loose.length) out.push('fields outside any <form>:\n' + loose.map(f => '    ' + f.tagName.toLowerCase() + (f.type ? '[' + f.type + ']' : '') + (f.name ? ' name=' + f.name : '') + (f.id ? ' #' + f.id : '')).join('\n'));
      return cut(out.join('\n') || 'No forms or inputs on this page.');
    }
    case 'links': {
      const as = [...document.querySelectorAll('a[href]')], host = location.host;
      const out = ['links: ' + as.length + ' (' + as.filter(a => a.host !== host).length + ' external)'];
      for (const a of as.slice(0, 150)) out.push('  ' + (a.innerText || a.getAttribute('aria-label') || a.title || '(no text)').replace(/\s+/g, ' ').trim().slice(0, 50) + ' -> ' + a.href.slice(0, 130) + (a.rel ? '  rel=' + a.rel : '') + (a.target ? '  target=' + a.target : ''));
      const imgs = [...document.images];
      out.push('images: ' + imgs.length + ', missing alt: ' + imgs.filter(i => !i.hasAttribute('alt')).length + ', broken: ' + imgs.filter(i => i.complete && i.naturalWidth === 0).length);
      for (const i of imgs.filter(i => i.complete && i.naturalWidth === 0).slice(0, 10)) out.push('  broken image: ' + i.src.slice(0, 130));
      return cut(out.join('\n'));
    }
    case 'meta': {
      const out = ['title: ' + document.title, 'url: ' + location.href, 'lang: ' + (document.documentElement.lang || '(none)'), 'charset: ' + document.characterSet, 'doctype: ' + (document.doctype ? document.doctype.name : 'MISSING (quirks mode)'), 'compat mode: ' + document.compatMode, 'readyState: ' + document.readyState, 'referrer: ' + (document.referrer || '(none)')];
      document.querySelectorAll('meta').forEach(m => out.push('  meta ' + (m.name || m.getAttribute('property') || m.httpEquiv || (m.getAttribute('charset') ? 'charset' : '?')) + ' = ' + (m.content || m.getAttribute('charset') || '').slice(0, 160)));
      document.querySelectorAll('link[rel]').forEach(l => out.push('  link rel=' + l.rel + ' ' + (l.href || '').slice(0, 130)));
      document.querySelectorAll('script[type="application/ld+json"]').forEach(s => out.push('  JSON-LD: ' + s.textContent.replace(/\s+/g, ' ').slice(0, 400)));
      return cut(out.join('\n'));
    }
    case 'scripts': {
      const out = [], fw = [];
      const w = window;
      if (w.React || document.querySelector('[data-reactroot]') || [...document.querySelectorAll('div,span')].slice(0, 200).some(e => Object.keys(e).some(k => k.startsWith('__reactFiber') || k.startsWith('__reactProps')))) fw.push('React' + (w.React && w.React.version ? ' ' + w.React.version : ''));
      if (w.__NEXT_DATA__) fw.push('Next.js'); if (w.__NUXT__) fw.push('Nuxt'); if (w.Vue || w.__VUE__ || document.querySelector('[data-v-app]')) fw.push('Vue' + (w.Vue && w.Vue.version ? ' ' + w.Vue.version : ''));
      const ng = document.querySelector('[ng-version]'); if (ng) fw.push('Angular ' + ng.getAttribute('ng-version')); if (w.angular) fw.push('AngularJS');
      if (w.jQuery) fw.push('jQuery ' + w.jQuery.fn.jquery); if (w.Alpine) fw.push('Alpine'); if (w.htmx) fw.push('htmx'); if (document.querySelector('[class*="svelte-"]')) fw.push('Svelte');
      if (Object.keys(w).some(k => k.startsWith('webpackChunk'))) fw.push('webpack bundle'); if (w.dataLayer) fw.push('GTM/dataLayer'); if (w.gtag || w.ga) fw.push('Google Analytics'); if (w.__REDUX_DEVTOOLS_EXTENSION__) fw.push('Redux (devtools hook)');
      out.push('detected: ' + (fw.join(', ') || 'nothing recognisable'));
      document.querySelectorAll('script').forEach(s => out.push('  script ' + (s.src ? s.src.slice(0, 130) : '(inline ' + s.textContent.length + ' chars)') + (s.type && s.type !== 'text/javascript' ? ' type=' + s.type : '') + (s.async ? ' async' : '') + (s.defer ? ' defer' : '')));
      document.querySelectorAll('link[rel=stylesheet],style').forEach(s => out.push('  ' + (s.tagName === 'STYLE' ? 'style (inline ' + s.textContent.length + ' chars)' : 'stylesheet ' + s.href.slice(0, 130))));
      return cut(out.join('\n'));
    }
    default: throw new Error('Unknown inspect target: ' + arg.what);
  }
}
export const PAGE_FNS = { pageSnapshot, pageDom, pageLocate, pageFocusType, pageSelect, pageWaitCheck, pageInspect };
