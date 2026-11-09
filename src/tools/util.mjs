import path from 'node:path';
import os from 'node:os';

/** Resolve a user/model supplied path against the workspace. No sandbox: absolute paths work anywhere. */
export function resolvePath(p, workspace) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('path is required');
  let s = p.trim().replace(/^["']|["']$/g, '');
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1));
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => process.env[k] ?? m);
  // Git-bash style /c/Users/... -> C:\Users\...
  const m = s.match(/^\/([a-zA-Z])\/(.*)$/);
  if (m) s = `${m[1].toUpperCase()}:\\${m[2]}`;
  return path.isAbsolute(s) ? path.normalize(s) : path.resolve(workspace || os.homedir(), s);
}

/** Keep the beginning and the end of long text (errors and summaries usually live at the end). */
export function clip(text, max = 20000, headFrac = 0.3) {
  if (text.length <= max) return text;
  const head = Math.floor(max * headFrac);
  const tail = max - head;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[... ${cut} characters cut ...]\n\n${text.slice(text.length - tail)}`;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  if (n >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false; // UTF-16 BOM
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^\uFEFF/, '');
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/\\\\]*';
    } else if (c === '?') re += '[^/\\\\]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > 0) { re += '(?:' + glob.slice(i + 1, end).split(',').map(x => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = end; }
      else re += '\\{';
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}
