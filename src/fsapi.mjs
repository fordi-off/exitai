// File-browser backend used by the UI's Files tab, uploads and chat attachments.
// No sandbox on purpose: the app owner has full access to this PC.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA } from './config.mjs';
import { resolvePath, isBinary, decodeText } from './tools/util.mjs';
import { recycle } from './tools/fs.mjs';

export const UPLOADS = path.join(DATA, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif']);
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.avif': 'image/avif', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.html': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.zip': 'application/zip',
};
export const mimeFor = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';
export const isImagePath = (f) => IMAGE_EXT.has(path.extname(f).toLowerCase());

const wrap = (e) => (e instanceof HttpError ? e : new HttpError(e.code === 'ENOENT' ? 404 : e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 400, e.code === 'ENOENT' ? 'Not found' : e.code === 'EACCES' || e.code === 'EPERM' ? 'Access denied' : (e.message || String(e))));

export async function list(p, workspace) {
  try {
    if (!p) { // drives
      const entries = [];
      for (let c = 65; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { if (fs.existsSync(d)) entries.push({ name: d, dir: true }); } catch { /* ignore */ } }
      return { path: '', parent: null, entries, truncated: false };
    }
    const dir = resolvePath(p, workspace);
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) throw new HttpError(400, 'Not a folder');
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const cap = 3000;
    const slice = ents.slice(0, cap);
    const entries = await Promise.all(slice.map(async (e) => {
      let size = 0, mtime = 0, isDir = e.isDirectory();
      try { const s = await fsp.stat(path.join(dir, e.name)); size = s.size; mtime = s.mtimeMs; isDir = s.isDirectory(); } catch { /* broken link / locked */ }
      return { name: e.name, dir: isDir, size: isDir ? 0 : size, mtime };
    }));
    entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const parent = path.dirname(dir);
    return { path: dir, parent: parent === dir ? '' : parent, entries, truncated: ents.length > cap };
  } catch (e) { throw wrap(e); }
}

export async function read(p, workspace) {
  try {
    const fp = resolvePath(p, workspace);
    const st = await fsp.stat(fp);
    if (st.isDirectory()) throw new HttpError(400, 'Is a folder');
    const base = { path: fp, name: path.basename(fp), size: st.size, mtime: st.mtimeMs };
    if (isImagePath(fp)) return { ...base, kind: 'image' };
    const LIMIT = 300 * 1024;
    const fh = await fsp.open(fp, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, LIMIT));
      await fh.read(buf, 0, buf.length, 0);
      if (isBinary(buf)) return { ...base, kind: 'binary' };
      return { ...base, kind: 'text', content: decodeText(buf), truncated: st.size > LIMIT };
    } finally { await fh.close(); }
  } catch (e) { throw wrap(e); }
}

export function rawStream(p, workspace) {
  const fp = resolvePath(p, workspace);
  const st = fs.statSync(fp);
  if (st.isDirectory()) throw new HttpError(400, 'Is a folder');
  return { fp, size: st.size, stream: fs.createReadStream(fp), type: mimeFor(fp) };
}

export async function write(p, content, workspace) {
  try {
    if (typeof content !== 'string') throw new HttpError(400, 'content must be a string');
    if (content.length > 8 * 1024 * 1024) throw new HttpError(400, 'File too large for the editor (8 MB)');
    const fp = resolvePath(p, workspace);
    await fsp.mkdir(path.dirname(fp), { recursive: true });
    await fsp.writeFile(fp, content, 'utf8');
    return { ok: true, size: Buffer.byteLength(content) };
  } catch (e) { throw wrap(e); }
}

export async function mkdir(p, workspace) { try { await fsp.mkdir(resolvePath(p, workspace), { recursive: true }); return { ok: true }; } catch (e) { throw wrap(e); } }

export async function rename(p, to, workspace) {
  try {
    const a = resolvePath(p, workspace);
    const b = path.isAbsolute(to) ? path.normalize(to) : path.join(path.dirname(a), to);
    if (fs.existsSync(b)) throw new HttpError(400, 'A file with that name already exists');
    await fsp.rename(a, b);
    return { ok: true, path: b };
  } catch (e) { throw wrap(e); }
}

export async function del(p, workspace) {
  try { const fp = resolvePath(p, workspace); await fsp.stat(fp); await recycle(fp); return { ok: true }; } catch (e) { throw wrap(e); }
}

export function reveal(p, workspace) {
  const fp = resolvePath(p, workspace);
  const isDir = fs.existsSync(fp) && fs.statSync(fp).isDirectory();
  spawn('explorer.exe', isDir ? [fp] : [`/select,${fp}`], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
}

function uniquePath(dir, name) {
  const ext = path.extname(name), stem = path.basename(name, ext);
  let f = path.join(dir, name), i = 1;
  while (fs.existsSync(f)) f = path.join(dir, `${stem} (${i++})${ext}`);
  return f;
}

export async function upload({ name, data, dir }, workspace) {
  try {
    if (!name || typeof data !== 'string') throw new HttpError(400, 'name and data are required');
    const clean = path.basename(String(name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'file';
    const m = data.match(/^data:[^;,]*(;base64)?,(.*)$/s);
    const buf = m ? (m[1] ? Buffer.from(m[2], 'base64') : Buffer.from(decodeURIComponent(m[2]))) : Buffer.from(data, 'base64');
    if (buf.length > 60 * 1024 * 1024) throw new HttpError(400, 'File too large (60 MB)');
    const target = dir ? resolvePath(dir, workspace) : UPLOADS;
    await fsp.mkdir(target, { recursive: true });
    const fp = uniquePath(target, clean);
    await fsp.writeFile(fp, buf);
    return { path: fp, size: buf.length };
  } catch (e) { throw wrap(e); }
}
