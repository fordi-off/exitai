import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OLLAMA_URL, OWN_OLLAMA_PORT, SPAWN_OLLAMA } from './config.mjs';

let child = null;

export class OllamaError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function findOllamaExe() {
  const cands = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'),
    'C:\\Program Files\\Ollama\\ollama.exe',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return 'ollama';
}

/**
 * Ollama runs each model in a child process (llama-server.exe). If its parent `ollama serve` is killed abruptly
 * (crash, End Task, force-kill) the runner survives and keeps the whole model in VRAM. Kill runners whose parent
 * no longer exists. Runners of a living Ollama (e.g. the tray app) are left alone.
 */
export function killOrphanRunners() {
  try {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | Where-Object { -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000, encoding: 'utf8' }).trim();
    return out ? out.split(/\s+/).length : 0;
  } catch { return 0; }
}

export async function ping(timeoutMs = 1500) {
  try {
    const r = await fetch(OLLAMA_URL + '/api/version', { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return (await r.json()).version;
  } catch { return null; }
}

/** Make sure an Ollama server is reachable; spawn our own tuned one if needed. */
export async function ensureServer() {
  if (await ping()) return true;
  if (!SPAWN_OLLAMA) return false;
  const freed = killOrphanRunners(); // a previous crash may have left a model sitting in VRAM
  if (freed) console.log(`Freed ${freed} orphaned model runner(s) left over from a previous session.`);
  const env = {
    ...process.env,
    OLLAMA_HOST: `127.0.0.1:${OWN_OLLAMA_PORT}`,
    OLLAMA_FLASH_ATTENTION: '1',
    OLLAMA_KV_CACHE_TYPE: 'q8_0',
    OLLAMA_KEEP_ALIVE: '30m',
    OLLAMA_MAX_LOADED_MODELS: '1',
    OLLAMA_NUM_PARALLEL: '1',
    OLLAMA_NO_CLOUD: '1',
  };
  child = spawn(findOllamaExe(), ['serve'], { env, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => { child = null; });
  child.on('exit', () => { child = null; });
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await ping()) return true;
  }
  return false;
}

export function stopOwnServer() {
  if (child && child.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch { /* ignore */ }
    child = null;
    killOrphanRunners(); // belt and braces: make sure no runner outlives its server
  }
}

async function jget(p) {
  const r = await fetch(OLLAMA_URL + p, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new OllamaError(r.status, await r.text());
  return r.json();
}

export async function listLocal() {
  try { return (await jget('/api/tags')).models || []; } catch { return []; }
}
export async function ps() {
  try { return (await jget('/api/ps')).models || []; } catch { return []; }
}
export async function unload(model) {
  try {
    await fetch(OLLAMA_URL + '/api/generate', {
      method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }), signal: AbortSignal.timeout(5000),
    });
  } catch { /* ignore */ }
}

async function* ndjson(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { yield JSON.parse(line); } catch { /* skip partial */ } }
    }
  }
  const tail = buf.trim();
  if (tail) { try { yield JSON.parse(tail); } catch { /* ignore */ } }
}

/**
 * Streaming chat. Returns { content, thinking, toolCalls, stats }.
 * onThinking(delta) / onText(delta) are called as tokens arrive.
 */
export async function chatStream({ model, messages, tools, think, options, signal, onThinking, onText }) {
  const body = { model, messages, stream: true, keep_alive: '30m', options };
  if (tools && tools.length) body.tools = tools;
  if (think !== undefined) body.think = think;

  const res = await fetch(OLLAMA_URL + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  if (!res.ok) {
    let msg = await res.text();
    try { msg = JSON.parse(msg).error || msg; } catch { /* keep raw */ }
    throw new OllamaError(res.status, msg);
  }

  let content = '', thinking = '';
  const toolCalls = [];
  let stats = {};
  for await (const chunk of ndjson(res)) {
    if (chunk.error) throw new OllamaError(500, chunk.error);
    const m = chunk.message;
    if (m) {
      if (m.thinking) { thinking += m.thinking; onThinking?.(m.thinking); }
      if (m.content) { content += m.content; onText?.(m.content); }
      if (m.tool_calls) for (const tc of m.tool_calls) toolCalls.push(tc);
    }
    if (chunk.done) {
      stats = {
        promptTokens: chunk.prompt_eval_count || 0,
        genTokens: chunk.eval_count || 0,
        tps: chunk.eval_duration ? (chunk.eval_count / (chunk.eval_duration / 1e9)) : 0,
        loadSec: (chunk.load_duration || 0) / 1e9,
        doneReason: chunk.done_reason,
      };
    }
  }
  return { content, thinking, toolCalls, stats };
}

/** Pull with progress callback: onProgress({status, percent}) */
export async function pull(model, onProgress, signal) {
  const res = await fetch(OLLAMA_URL + '/api/pull', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true }), signal,
  });
  if (!res.ok) throw new OllamaError(res.status, await res.text());
  for await (const c of ndjson(res)) {
    if (c.error) throw new OllamaError(500, c.error);
    const percent = c.total ? Math.round((c.completed || 0) / c.total * 100) : 0;
    onProgress?.({ status: c.status, percent });
  }
}
