import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  ROOT, PORT, TOKEN_FILE, UI_PROFILE_DIR, CATALOG, guessMeta, getSettings, updateSettings,
} from './src/config.mjs';
import * as ollama from './src/ollama.mjs';
import { createSession, getSession, saveSession, listSessions, deleteSession, flushAll } from './src/sessions.mjs';
import { runAgent, modelMeta } from './src/agent.mjs';
import { browser, findBrowserExe, PAGE_FNS } from './src/browser.mjs';
import { killAllJobs } from './src/tools/shell.mjs';
import * as fsapi from './src/fsapi.mjs';

// Log to data/server.log from inside the process (append mode, safe when two launches overlap).
const LOG_FILE = path.join(ROOT, 'data', 'server.log');
try { if (fs.statSync(LOG_FILE).size > 1024 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch { /* no log yet */ }
for (const k of ['log', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    try { fs.appendFileSync(LOG_FILE, `${new Date().toTimeString().slice(0, 8)} ${a.map(x => (typeof x === 'string' ? x : x instanceof Error ? x.stack : JSON.stringify(x))).join(' ')}\n`); } catch { /* ignore */ }
    try { orig(...a); } catch { /* no console attached */ }
  };
}

const UI_DIR = path.join(ROOT, 'ui');
const ARGS = new Set(process.argv.slice(2));
const AUTO_EXIT = process.env.EXITAI_AUTOEXIT === '1';

// ---------- auth ----------
let TOKEN;
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { /* generate */ }
if (!TOKEN || TOKEN.length < 32) { TOKEN = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(TOKEN_FILE, TOKEN); }
const tokenOk = (t) => {
  if (!t) return false;
  const a = Buffer.from(String(t)), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const APP_URL = `http://127.0.0.1:${PORT}/#t=${TOKEN}`;

// ---------- live state ----------
const sse = new Set();
const runs = new Map();       // sessionId -> AbortController
const approvals = new Map();  // approvalId -> resolve
let pullState = { active: false, model: '', percent: 0, text: '' };
let everConnected = false, exitTimer = null;

function broadcast(evt) {
  const data = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sse) { try { res.write(data); } catch { /* dropped */ } }
}
browser.onChange = (st) => broadcast({ type: 'browser', ...st });

function requestApproval(id, signal) {
  return new Promise((resolve) => {
    approvals.set(id, resolve);
    signal?.addEventListener('abort', () => { approvals.delete(id); resolve({ allow: false }); }, { once: true });
  });
}

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

let gpuCache = { t: 0, v: null };
function gpuInfo() {
  return new Promise((resolve) => {
    if (Date.now() - gpuCache.t < 3000) return resolve(gpuCache.v);
    execFile('nvidia-smi', ['--query-gpu=name,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 3000, windowsHide: true }, (err, out) => {
      let v = null;
      if (!err) {
        const [name, used, total] = out.trim().split('\n')[0].split(',').map(s => s.trim());
        v = { name: name.replace('NVIDIA GeForce ', ''), usedMB: +used, totalMB: +total };
      }
      gpuCache = { t: Date.now(), v };
      resolve(v);
    });
  });
}

const sameModel = (a, b) => a === b || a.replace(/:latest$/, '') === b.replace(/:latest$/, '');

async function buildState() {
  const [local, loaded, version, gpu] = await Promise.all([ollama.listLocal(), ollama.ps(), ollama.ping(800), gpuInfo()]);
  const names = local.map(m => m.name);
  const isInstalled = (id) => names.some(n => sameModel(n, id));
  const models = CATALOG.map(m => ({ ...m, installed: isInstalled(m.id) }));
  for (const n of names) {
    if (/embed/i.test(n) || models.some(m => sameModel(m.id, n))) continue;
    models.push({ ...guessMeta(n), installed: true });
  }
  models.sort((a, b) => (b.installed - a.installed) || ((b.recommended ? 1 : 0) - (a.recommended ? 1 : 0)));
  return {
    models,
    settings: getSettings(),
    sessions: listSessions(),
    gpu: gpu || { name: 'n/a', usedMB: 0, totalMB: 0 },
    ollama: { up: !!version, version: version || '', loaded: loaded.map(m => ({ name: m.name, sizeGB: +(m.size / 1e9).toFixed(1), vramGB: +(m.size_vram / 1e9).toFixed(1), until: m.expires_at })) },
    pull: pullState,
  };
}

function publicSession(s) {
  return { id: s.id, title: s.title, model: s.model, timeline: s.timeline, plan: s.plan || [], usage: s.usage || {}, running: runs.has(s.id) };
}

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const q = url.searchParams;

  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 1500\n\n');
    sse.add(res); everConnected = true; clearTimeout(exitTimer);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* ignore */ } }, 15000);
    req.on('close', () => {
      clearInterval(hb); sse.delete(res);
      if (AUTO_EXIT && everConnected && sse.size === 0) { clearTimeout(exitTimer); exitTimer = setTimeout(() => { if (sse.size === 0) shutdown('window closed'); }, 25000); }
    });
    return;
  }

  if (p === '/api/health' && m === 'GET') return json(res, 200, { ok: true, shuttingDown });
  if (p === '/api/state' && m === 'GET') return json(res, 200, await buildState());

  if (p === '/api/settings' && m === 'POST') {
    const b = await readBody(req);
    if (b.workspace !== undefined) {
      try { if (!fs.statSync(b.workspace).isDirectory()) throw 0; } catch { return json(res, 400, { error: `Folder not found: ${b.workspace}` }); }
    }
    return json(res, 200, updateSettings(b));
  }

  if (p === '/api/sessions' && m === 'POST') { const s = createSession(getSettings().model); return json(res, 200, { id: s.id }); }

  let mm = p.match(/^\/api\/sessions\/(s_[a-f0-9]+)(\/rename)?$/);
  if (mm && m === 'DELETE') { // idempotent: also clears stale index entries of chats whose file is already gone
    runs.get(mm[1])?.abort();
    deleteSession(mm[1]);
    return json(res, 200, { ok: true });
  }
  if (mm) {
    const s = getSession(mm[1]);
    if (!s) return json(res, 404, { error: 'no such session' });
    if (mm[2] && m === 'POST') { const b = await readBody(req); s.title = String(b.title || s.title).slice(0, 100); saveSession(s, true); return json(res, 200, { ok: true }); }
    if (m === 'GET') return json(res, 200, publicSession(s));
    if (m === 'DELETE') { runs.get(s.id)?.abort(); deleteSession(s.id); return json(res, 200, { ok: true }); }
  }

  if (p === '/api/chat' && m === 'POST') {
    const b = await readBody(req);
    const s = getSession(b.sessionId);
    if (!s) return json(res, 404, { error: 'no such session' });
    if (runs.has(s.id)) return json(res, 409, { error: 'session is already running' });
    const text = String(b.text || '').trim();
    const images = Array.isArray(b.images) ? b.images.filter(x => typeof x === 'string' && x.startsWith('data:image/')).slice(0, 6) : [];
    const attachments = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 20)
      .filter(a => a && (a.type === 'folder' || a.type === 'file') && typeof a.path === 'string' && a.path.trim())
      .map(a => ({ type: a.type, path: a.path.trim() }));
    if (!text && !images.length && !attachments.length) return json(res, 400, { error: 'empty message' });
    // attaching a folder gives the assistant that folder as its working directory
    const firstFolder = attachments.find(a => a.type === 'folder');
    if (firstFolder) {
      try { if (fs.statSync(firstFolder.path).isDirectory()) updateSettings({ workspace: path.resolve(firstFolder.path) }); }
      catch { return json(res, 400, { error: `Folder not found: ${firstFolder.path}` }); }
    }
    const settings = getSettings();
    if (s.model !== settings.model) { s.model = settings.model; s.textTools = false; }
    const controller = new AbortController();
    runs.set(s.id, controller);
    broadcast({ type: 'run_start', sessionId: s.id });
    runAgent({ session: s, userText: text || (attachments.length ? '(see the attached items)' : '(see attached image)'), images, attachments, emit: broadcast, signal: controller.signal, requestApproval })
      .then((reason) => broadcast({ type: 'run_end', sessionId: s.id, reason }))
      .catch((e) => { broadcast({ type: 'note', sessionId: s.id, level: 'error', text: String(e?.message || e) }); broadcast({ type: 'run_end', sessionId: s.id, reason: 'error' }); })
      .finally(() => runs.delete(s.id));
    return json(res, 200, { ok: true });
  }

  if (p === '/api/stop' && m === 'POST') {
    const b = await readBody(req);
    runs.get(b.sessionId)?.abort();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/approve' && m === 'POST') {
    const b = await readBody(req);
    const r = approvals.get(b.id);
    if (r) { approvals.delete(b.id); if (b.always && b.allow) updateSettings({ autoApprove: true }); r({ allow: !!b.allow }); }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/models/pull' && m === 'POST') {
    const b = await readBody(req);
    const model = String(b.model || '').trim();
    if (!/^[\w.\-/:]+$/.test(model)) return json(res, 400, { error: 'bad model name' });
    if (pullState.active) return json(res, 409, { error: `Already downloading ${pullState.model}` });
    pullState = { active: true, model, percent: 0, text: 'starting…' };
    ollama.pull(model, (pr) => { pullState = { active: true, model, percent: pr.percent, text: pr.status }; })
      .then(() => { pullState = { active: false, model, percent: 100, text: 'done' }; })
      .catch((e) => { pullState = { active: false, model, percent: 0, text: 'failed: ' + e.message }; });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/browser' && m === 'GET') {
    const st = browser.status();
    if (!st.open) return json(res, 200, { open: false, url: '', title: '', console: [], network: [], tree: '' });
    const tab = browser.tab();
    let tree = '';
    try { tree = await browser.page(PAGE_FNS.pageDom, { depth: 5, maxChars: 9000 }); } catch (e) { tree = `(DOM unavailable: ${e.message})`; }
    return json(res, 200, {
      open: true, url: st.url, title: st.title,
      console: tab.console.slice(-300).map(c => ({ t: c.t, level: c.level, text: c.text, src: c.src })),
      network: tab.net.slice(-200).map(n => ({ t: n.t, id: n.id, method: n.method, url: n.url, status: n.status, type: n.type, ms: n.ms, failed: n.failed })),
      tree,
    });
  }

  if (p === '/api/browser/screenshot' && m === 'GET') {
    if (!browser.open) return json(res, 404, { error: 'browser closed' });
    try {
      const file = await browser.screenshot();
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(file));
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ---- files (UI Files tab, uploads) ----
  if (p.startsWith('/api/fs/') || p === '/api/upload') {
    const ws = getSettings().workspace;
    try {
      if (p === '/api/fs/list' && m === 'GET') return json(res, 200, await fsapi.list(q.get('path') ?? ws, ws));
      if (p === '/api/fs/read' && m === 'GET') return json(res, 200, await fsapi.read(q.get('path') || '', ws));
      if (p === '/api/fs/raw' && m === 'GET') {
        const r = fsapi.rawStream(q.get('path') || '', ws);
        const h = { 'content-type': r.type, 'content-length': r.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" };
        if (q.get('dl')) h['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(r.fp))}`;
        res.writeHead(200, h);
        r.stream.on('error', () => res.destroy());
        return r.stream.pipe(res);
      }
      if (m === 'POST') {
        const b = await readBody(req, p === '/api/upload' ? 90 * 1024 * 1024 : undefined);
        if (p === '/api/fs/write') return json(res, 200, await fsapi.write(b.path, b.content, ws));
        if (p === '/api/fs/mkdir') return json(res, 200, await fsapi.mkdir(b.path, ws));
        if (p === '/api/fs/rename') return json(res, 200, await fsapi.rename(b.path, b.to, ws));
        if (p === '/api/fs/delete') return json(res, 200, await fsapi.del(b.path, ws));
        if (p === '/api/fs/reveal') return json(res, 200, fsapi.reveal(b.path, ws));
        if (p === '/api/upload') return json(res, 200, await fsapi.upload(b, ws));
      }
    } catch (e) { return json(res, e.status || 400, { error: e.message || String(e) }); }
  }
  if (p === '/api/open-folder' && m === 'POST') {
    const b = await readBody(req);
    try { if (!fs.statSync(b.path).isDirectory()) throw 0; } catch { return json(res, 400, { error: 'Folder not found' }); }
    return json(res, 200, updateSettings({ workspace: b.path }));
  }

  return json(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(UI_DIR, rel));
  if (!file.startsWith(UI_DIR + path.sep) && file !== UI_DIR) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const server = http.createServer(async (req, res) => {
  try {
    // DNS-rebinding / cross-site protection: only our own origin may talk to this server.
    if (!HOSTS.has(req.headers.host || '')) { res.writeHead(403); return res.end('forbidden host'); }
    const origin = req.headers.origin;
    if (origin && ![`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(origin)) { res.writeHead(403); return res.end('forbidden origin'); }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      const t = req.headers['x-exitai-token'] || url.searchParams.get('t') || url.searchParams.get('k');
      if (!tokenOk(t)) return json(res, 401, { error: 'unauthorized' });
      return await api(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e?.message || e) }); else res.end();
  }
});

// ---------- app window ----------
function openAppWindow() {
  const exe = findBrowserExe();
  if (!exe) { console.log('No Chrome/Edge found; open this URL manually:\n' + APP_URL); return; }
  fs.mkdirSync(UI_PROFILE_DIR, { recursive: true });
  const args = [`--app=${APP_URL}`, `--user-data-dir=${UI_PROFILE_DIR}`, '--window-size=1320,860', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate'];
  const t0 = Date.now();
  const c = spawn(exe, args, { detached: true, stdio: 'ignore' });
  console.log(`Opening app window with ${path.basename(exe)} (pid ${c.pid})`);
  c.on('error', (e) => console.log('Could not start the app window:', e.message));
  // Exit code 0 within a second or two is normal: Chrome handed the window to an instance already using this profile.
  // A non-zero early exit means it really failed to start, so say so in the log.
  c.on('exit', (code) => { if (code && Date.now() - t0 < 4000) console.log(`App window process failed to start (exit code ${code}).`); });
  c.unref();
}

let shuttingDown = false;
async function shutdown(why) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`Shutting down (${why})…`);
  try { server.close(); server.closeAllConnections?.(); } catch { /* ignore */ } // free the port first so a relaunch can start at once
  for (const c of runs.values()) c.abort();
  flushAll();
  killAllJobs();
  try { await Promise.race([browser.close(), new Promise(r => setTimeout(r, 2000))]); } catch { /* ignore */ }
  const loaded = await ollama.ps();
  for (const l of loaded) await ollama.unload(l.name);
  ollama.stopOwnServer();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled:', e));

// Port already taken: either a healthy instance (just open a window to it) or one that is shutting down
// (wait for it to finish, then start a fresh server) — never open a window onto a dying server.
let listenTries = 0;
server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  let healthy = false;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: { 'x-exitai-token': TOKEN }, signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    healthy = !!j.ok && !j.shuttingDown;
  } catch { /* not responding */ }
  if (healthy) {
    console.log(`ExitAI is already running on port ${PORT}; opening a window to it.`);
    if (ARGS.has('--app')) openAppWindow();
    setTimeout(() => process.exit(0), 800);
    return;
  }
  if (++listenTries > 40) { console.log(`Port ${PORT} is busy and not an ExitAI server. Giving up.`); process.exit(1); }
  if (listenTries === 1) console.log('The previous ExitAI instance is still shutting down; waiting for it…');
  setTimeout(() => server.listen(PORT, '127.0.0.1'), 1000);
});

server.on('listening', async () => {
  console.log(`ExitAI running at ${APP_URL}`);
  if (ARGS.has('--app')) openAppWindow();
  const up = await ollama.ensureServer();
  console.log(up ? `Ollama ready (${await ollama.ping()}).` : 'WARNING: could not start Ollama.');
  if (AUTO_EXIT) setTimeout(() => { if (!everConnected) shutdown('no window connected'); }, 90000);
});
server.listen(PORT, '127.0.0.1');
