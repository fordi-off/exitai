import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SESSIONS_DIR } from './config.mjs';

const cache = new Map();
const timers = new Map();
const INDEX = path.join(SESSIONS_DIR, 'index.json');
const fileOf = (id) => path.join(SESSIONS_DIR, id + '.json');
const validId = (id) => typeof id === 'string' && /^s_[a-f0-9]+$/.test(id);

// The index is only a cache of {id, title, updated, model}. The session files are the source of truth, and
// several server processes can run at once, so we never keep the index in memory: every change re-reads it from
// disk first, and listing drops entries whose file no longer exists.
function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return rebuildIndex(); }
}
function rebuildIndex() {
  const idx = {};
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!/^s_[a-f0-9]+\.json$/.test(f)) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
        idx[s.id] = { id: s.id, title: s.title, updated: s.updated, model: s.model };
      } catch { /* skip corrupt */ }
    }
  } catch { /* ignore */ }
  return idx;
}
function updateIndex(mutator) {
  const idx = readIndex();
  mutator(idx);
  try { fs.writeFileSync(INDEX, JSON.stringify(idx)); } catch { /* ignore */ }
}

export function createSession(model) {
  const id = 's_' + crypto.randomBytes(4).toString('hex');
  const s = { id, title: 'New chat', model, created: Date.now(), updated: Date.now(), timeline: [], llm: [], plan: [], usage: {}, textTools: false };
  cache.set(id, s);
  saveNow(s);
  return s;
}

export function getSession(id) {
  if (!validId(id)) return null;
  if (cache.has(id)) return cache.get(id);
  try {
    const s = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
    cache.set(id, s);
    return s;
  } catch { return null; }
}

function saveNow(s) {
  try {
    fs.writeFileSync(fileOf(s.id), JSON.stringify(s));
    updateIndex(idx => { idx[s.id] = { id: s.id, title: s.title, updated: s.updated, model: s.model }; });
  } catch { /* ignore */ }
}

export function saveSession(s, immediate = false) {
  if (s.deleted) return; // never resurrect a chat that was deleted while its run was still finishing
  s.updated = Date.now();
  if (immediate) { clearTimeout(timers.get(s.id)); timers.delete(s.id); saveNow(s); return; }
  if (timers.has(s.id)) return;
  timers.set(s.id, setTimeout(() => { timers.delete(s.id); if (!s.deleted) saveNow(s); }, 600));
}

export function flushAll() {
  for (const [id, t] of timers) { clearTimeout(t); timers.delete(id); const s = cache.get(id); if (s && !s.deleted) saveNow(s); }
}

export function listSessions() {
  const idx = readIndex();
  const live = {};
  let pruned = false;
  for (const [id, meta] of Object.entries(idx)) {
    if (validId(id) && fs.existsSync(fileOf(id))) live[id] = meta; else pruned = true;
  }
  if (pruned) { try { fs.writeFileSync(INDEX, JSON.stringify(live)); } catch { /* ignore */ } }
  return Object.values(live).sort((a, b) => b.updated - a.updated).slice(0, 200);
}

/** Idempotent: removes the file, the cache entry and the index entry whether or not the chat still exists. */
export function deleteSession(id) {
  if (!validId(id)) return;
  const s = cache.get(id);
  if (s) s.deleted = true;
  cache.delete(id);
  clearTimeout(timers.get(id)); timers.delete(id);
  try { fs.unlinkSync(fileOf(id)); } catch { /* already gone */ }
  updateIndex(idx => { delete idx[id]; });
}
