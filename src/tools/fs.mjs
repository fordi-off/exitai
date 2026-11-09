import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolvePath, clip, fmtBytes, isBinary, decodeText, globToRegex } from './util.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.next', '.cache', 'dist', 'build', 'target', '.gradle', '.idea', '$RECYCLE.BIN', 'System Volume Information']);

export const fsTools = [
  {
    name: 'read_file',
    risk: 'safe',
    description: 'Read a text file with line numbers. Use offset/limit for big files. For images use the vision tool.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to the workspace)' },
        offset: { type: 'integer', description: '1-based first line to read (default 1)' },
        limit: { type: 'integer', description: 'Max lines (default 1500)' },
      },
      required: ['path'],
    },
    async run({ path: p, offset = 1, limit = 1500 }, ctx) {
      const fp = resolvePath(p, ctx.workspace);
      const st = await fs.stat(fp);
      if (st.isDirectory()) return `${fp} is a directory. Use list_dir.\n` + await listDir(fp, 1, 200);
      const buf = await fs.readFile(fp);
      if (isBinary(buf)) return `${fp} is a binary file (${fmtBytes(st.size)}). Use run_command (e.g. Format-Hex) or the vision tool for images.`;
      const lines = decodeText(buf).split(/\r?\n/);
      const start = Math.max(1, offset | 0);
      const end = Math.min(lines.length, start - 1 + Math.max(1, limit | 0));
      let out = '';
      for (let i = start; i <= end; i++) {
        const l = lines[i - 1];
        out += `${i}\t${l.length > 2000 ? l.slice(0, 2000) + ' …[line cut]' : l}\n`;
        if (out.length > 90000) { out += `[output size limit hit at line ${i}; continue with offset=${i + 1}]\n`; break; }
      }
      if (end < lines.length) out += `[showing lines ${start}-${end} of ${lines.length}; continue with offset=${end + 1}]`;
      else out += `[end of file: ${lines.length} lines, ${fmtBytes(st.size)}]`;
      return out;
    },
  },
  {
    name: 'write_file',
    risk: 'write',
    description: 'Create or overwrite a file with the given content (parent folders are created). Prefer edit_file for small changes to existing files.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    async run({ path: p, content }, ctx) {
      const fp = resolvePath(p, ctx.workspace);
      let before = null;
      try { before = decodeText(await fs.readFile(fp)); } catch { /* new file */ }
      await fs.mkdir(path.dirname(fp), { recursive: true });
      await fs.writeFile(fp, content ?? '', 'utf8');
      const lines = (content ?? '').split('\n').length;
      if (before !== null) {
        return `Overwrote EXISTING file ${fp} (${before.split('\n').length} lines -> ${lines} lines, ${fmtBytes(Buffer.byteLength(content ?? ''))}). Note: for changes to an existing file prefer an <edit_file> block with SEARCH/REPLACE so unchanged code is kept as-is.`;
      }
      // warn when this looks like a second copy of a file that already exists (app_v2.py, app_new.py, fixed_app.py ...)
      let hint = '';
      try {
        const dir = path.dirname(fp), ext = path.extname(fp), stem = path.basename(fp, ext).toLowerCase();
        const base = stem.replace(/([_\-. ]?(v?\d+|new|old|copy|final|fixed|fix|updated|backup|bak|tmp|test|2))+$/g, '').replace(/^(new|fixed|fix|updated|old)[_\-. ]/, '');
        if (base && base !== stem || stem.match(/^(new|fixed|fix|updated)[_\-. ]/)) {
          const sibling = (await fs.readdir(dir)).find(n => n !== path.basename(fp) && path.extname(n) === ext && path.basename(n, ext).toLowerCase() === base);
          if (sibling) hint = ` Warning: ${path.join(dir, sibling)} already exists in this folder. If you meant to change it, edit that file with <edit_file> instead of creating a variant.`;
        }
      } catch { /* ignore */ }
      return `Created ${fp} (${lines} lines, ${fmtBytes(Buffer.byteLength(content ?? ''))}).${hint}`;
    },
  },
  {
    name: 'edit_file',
    risk: 'write',
    description: 'Edit an existing file in place with exact SEARCH/REPLACE edits: each `old` text is found in the file and replaced by `new`. All edits are applied in order, or none are. Small whitespace/indentation differences are tolerated. Always read the file first and edit it instead of rewriting it or creating another copy.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: { type: 'array', items: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'] }, description: 'One or more {old, new} replacements applied in order' },
        old: { type: 'string', description: 'Single edit: exact text to find' },
        new: { type: 'string', description: 'Single edit: replacement text' },
        replace_all: { type: 'boolean', description: 'Single edit: replace every occurrence' },
      },
      required: ['path'],
    },
    async run({ path: p, edits, old, new: neu, replace_all = false }, ctx) {
      const fp = resolvePath(p, ctx.workspace);
      let list = Array.isArray(edits) && edits.length ? edits : (old !== undefined ? [{ old, new: neu ?? '', all: replace_all }] : []);
      if (!list.length) throw new Error('No edits given. Provide edits as <<<<<<< SEARCH / ======= / >>>>>>> REPLACE pairs (or old/new).');
      let exists = true, raw = '';
      try { raw = decodeText(await fs.readFile(fp)); } catch { exists = false; }
      if (!exists) {
        if (list.length === 1 && !String(list[0].old ?? '').trim()) { // empty SEARCH on a missing file = create it
          await fs.mkdir(path.dirname(fp), { recursive: true });
          await fs.writeFile(fp, list[0].new ?? '', 'utf8');
          return `Created ${fp} (${String(list[0].new ?? '').split('\n').length} lines) via an edit with an empty SEARCH.`;
        }
        throw new Error(`${fp} does not exist. To create a new file use write_file; to edit, check the path with list_dir.`);
      }
      const { text, summary } = applyEdits(raw, list);
      await fs.writeFile(fp, text, 'utf8');
      return `Edited ${fp}: ${summary}`;
    },
  },
  {
    name: 'list_dir',
    risk: 'safe',
    description: 'Show a directory tree (names, sizes). depth=1 lists one folder; larger depth gives a recursive tree. node_modules/.git etc. are collapsed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder (default: workspace)' },
        depth: { type: 'integer', description: 'Levels to show (default 2, max 8)' },
        max_entries: { type: 'integer', description: 'Cap on entries (default 300)' },
      },
    },
    async run({ path: p, depth = 2, max_entries = 300 }, ctx) {
      const fp = resolvePath(p || '.', ctx.workspace);
      return `${fp}\n` + await listDir(fp, Math.min(8, Math.max(1, depth | 0)), max_entries);
    },
  },
  {
    name: 'search_files',
    risk: 'safe',
    description: 'Search file contents with a regex (mode=content) or find files by glob/name (mode=names). Skips node_modules, .git, binaries and files over 2 MB.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex for content mode; glob like **/*.py or a substring for names mode' },
        path: { type: 'string', description: 'Folder to search (default: workspace)' },
        mode: { type: 'string', enum: ['content', 'names'] },
        glob: { type: 'string', description: 'Only search files matching this glob (content mode), e.g. *.js' },
        ignore_case: { type: 'boolean' },
        max_results: { type: 'integer', description: 'Default 100' },
      },
      required: ['pattern'],
    },
    async run({ pattern, path: p, mode = 'content', glob, ignore_case = true, max_results = 100 }, ctx) {
      const root = resolvePath(p || '.', ctx.workspace);
      const results = [];
      const max = Math.min(1000, Math.max(1, max_results | 0));
      let scanned = 0;
      let nameRe = null, contentRe = null;
      const fileGlob = glob ? globToRegex(glob.includes('/') || glob.includes('\\') ? glob : `**/${glob}`) : null;
      if (mode === 'names') {
        nameRe = /[*?{]/.test(pattern) ? globToRegex(pattern.includes('/') ? pattern : `**/${pattern}`) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      } else {
        try { contentRe = new RegExp(pattern, ignore_case ? 'i' : ''); }
        catch (e) { throw new Error('Invalid regex: ' + e.message); }
      }
      const stack = [root];
      while (stack.length && results.length < max) {
        if (ctx.signal?.aborted) throw new Error('aborted');
        const dir = stack.pop();
        let ents;
        try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
          const full = path.join(dir, e.name);
          const rel = path.relative(root, full).split(path.sep).join('/');
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) stack.push(full);
            continue;
          }
          if (nameRe) { if (nameRe.test(rel) || nameRe.test(e.name)) results.push(full); continue; }
          if (fileGlob && !fileGlob.test(rel)) continue;
          let st; try { st = await fs.stat(full); } catch { continue; }
          if (st.size > 2 * 1024 * 1024) continue;
          let buf; try { buf = await fs.readFile(full); } catch { continue; }
          if (isBinary(buf)) continue;
          scanned++;
          const lines = decodeText(buf).split(/\r?\n/);
          for (let i = 0; i < lines.length && results.length < max; i++) {
            if (contentRe.test(lines[i])) results.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
          }
        }
      }
      if (!results.length) return `No matches (${mode} mode, root ${root}${mode === 'content' ? `, ${scanned} files scanned` : ''}).`;
      return results.join('\n') + (results.length >= max ? `\n[capped at ${max} results]` : '');
    },
  },
  {
    name: 'file_ops',
    risk: 'write',
    description: 'File management: delete (goes to the Recycle Bin unless permanent=true), move/rename, copy, mkdir, stat.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['delete', 'move', 'copy', 'mkdir', 'stat'] },
        path: { type: 'string' },
        to: { type: 'string', description: 'Destination for move/copy' },
        permanent: { type: 'boolean', description: 'delete: skip the Recycle Bin' },
      },
      required: ['op', 'path'],
    },
    async run({ op, path: p, to, permanent = false }, ctx) {
      const fp = resolvePath(p, ctx.workspace);
      switch (op) {
        case 'stat': {
          const st = await fs.stat(fp);
          return JSON.stringify({ path: fp, type: st.isDirectory() ? 'dir' : 'file', size: st.size, modified: st.mtime.toISOString(), created: st.birthtime.toISOString() });
        }
        case 'mkdir': await fs.mkdir(fp, { recursive: true }); return `Created ${fp}`;
        case 'move': {
          if (!to) throw new Error('`to` required');
          const dest = resolvePath(to, ctx.workspace);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.rename(fp, dest).catch(async (e) => {
            if (e.code !== 'EXDEV') throw e;
            await fs.cp(fp, dest, { recursive: true }); await fs.rm(fp, { recursive: true });
          });
          return `Moved ${fp} -> ${dest}`;
        }
        case 'copy': {
          if (!to) throw new Error('`to` required');
          const dest = resolvePath(to, ctx.workspace);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.cp(fp, dest, { recursive: true });
          return `Copied ${fp} -> ${dest}`;
        }
        case 'delete': {
          await fs.stat(fp);
          if (permanent) { await fs.rm(fp, { recursive: true, force: true }); return `Permanently deleted ${fp}`; }
          await recycle(fp);
          return `Moved ${fp} to the Recycle Bin`;
        }
        default: throw new Error('unknown op ' + op);
      }
    },
  },
];

const lead = (s) => (s.match(/^[ \t]*/) || [''])[0];

/** Find `needle` (array of lines) in `hay` (array of lines) comparing lines through `norm`. Returns start indexes. */
function findLines(hay, needle, norm) {
  const out = [];
  const n = needle.map(norm);
  if (!n.length) return out;
  for (let i = 0; i + n.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < n.length; j++) if (norm(hay[i + j]) !== n[j]) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * Apply SEARCH/REPLACE edits in order. All-or-nothing. Matching order: exact text, then ignoring trailing whitespace,
 * then ignoring indentation (the replacement is re-indented to the file). Throws a helpful error on 0 or >1 matches.
 */
export function applyEdits(raw, edits) {
  const crlf = raw.includes('\r\n');
  let text = raw.replace(/\r\n/g, '\n');
  let plus = 0, minus = 0;
  const firstLines = [];
  edits.forEach((e, k) => {
    const label = edits.length > 1 ? `edit ${k + 1} of ${edits.length}` : 'the edit';
    const oldT = String(e.old ?? '').replace(/\r\n/g, '\n'), newT = String(e.new ?? '').replace(/\r\n/g, '\n');
    if (!oldT.trim()) throw new Error(`${label}: SEARCH text is empty. To add code, SEARCH for a nearby existing line and include it in REPLACE.`);
    // 1) exact
    const hits = []; let i = -1;
    while ((i = text.indexOf(oldT, i + 1)) !== -1) hits.push(i);
    if (hits.length > 1 && !e.all) {
      const lns = hits.slice(0, 5).map(h => text.slice(0, h).split('\n').length);
      throw new Error(`${label}: SEARCH text matches ${hits.length} places (lines ${lns.join(', ')}). Include more surrounding lines so it is unique. Nothing was changed.`);
    }
    let replaced = false;
    if (hits.length) {
      text = e.all ? text.split(oldT).join(newT) : text.slice(0, hits[0]) + newT + text.slice(hits[0] + oldT.length);
      firstLines.push(text.slice(0, hits[0]).split('\n').length);
      replaced = true;
    }
    if (!replaced) {
      const hay = text.split('\n'), needle = oldT.split('\n');
      while (needle.length && !needle[needle.length - 1].trim()) needle.pop();
      for (const [norm, reindent] of [[(s) => s.trimEnd(), false], [(s) => s.trim(), true]]) {
        const at = findLines(hay, needle, norm);
        if (at.length > 1) throw new Error(`${label}: SEARCH text matches ${at.length} places (lines ${at.slice(0, 5).map(x => x + 1).join(', ')}) when ignoring whitespace. Include more surrounding lines. Nothing was changed.`);
        if (at.length === 1) {
          let rep = newT.split('\n');
          if (reindent) {
            const fileInd = lead(hay[at[0]]), searchInd = lead(needle.find(l => l.trim()) || '');
            rep = rep.map(l => (!l.trim() ? l : searchInd && l.startsWith(searchInd) ? fileInd + l.slice(searchInd.length) : fileInd && !searchInd ? fileInd + l : l));
          }
          hay.splice(at[0], needle.length, ...rep);
          text = hay.join('\n');
          firstLines.push(at[0] + 1);
          replaced = true;
          break;
        }
      }
    }
    if (!replaced) {
      // helpful hint: where does the first non-empty SEARCH line (loosely) occur?
      const first = oldT.split('\n').map(s => s.trim()).find(Boolean);
      const hay = text.split('\n');
      let hint = '';
      const at = first ? hay.findIndex(l => l.trim() === first) : -1;
      const near = at >= 0 ? at : (first ? hay.findIndex(l => l.includes(first.slice(0, 40))) : -1);
      if (near >= 0) hint = ` The first line of your SEARCH text does exist at line ${near + 1}; the file there reads:\n${hay.slice(Math.max(0, near - 1), near + 5).map((l, j) => `${Math.max(1, near) + j}\t${l}`).join('\n')}\nCopy the SEARCH text exactly from read_file output (without the line numbers).`;
      else hint = ' None of its lines were found; re-read the file with read_file, the code may have changed.';
      throw new Error(`${label}: SEARCH text not found.${hint} Nothing was changed.`);
    }
    minus += oldT.split('\n').length; plus += newT.split('\n').length;
  });
  const out = crlf ? text.replace(/\n/g, '\r\n') : text;
  const line = firstLines[0] || 1;
  const snippet = text.split('\n').slice(Math.max(0, line - 3), line + 6).map((l, i) => `${Math.max(1, line - 2) + i}\t${l}`).join('\n');
  return { text: out, summary: `${edits.length} edit${edits.length > 1 ? 's' : ''} applied (+${plus} −${minus} lines).\n${clip(snippet, 1500)}` };
}

export function recycle(fp) {
  const script = "Add-Type -AssemblyName Microsoft.VisualBasic; $p=$env:EXITAI_P; if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') }";
  return new Promise((resolve, reject) => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, EXITAI_P: fp }, windowsHide: true });
    let err = '';
    c.stderr.on('data', d => { err += d; });
    c.on('close', code => (code === 0 ? resolve() : reject(new Error('Recycle failed: ' + err.trim().slice(0, 300)))));
  });
}

export async function listDir(root, depth, maxEntries) {
  const lines = [];
  let count = 0;
  async function walk(dir, level, prefix) {
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { lines.push(`${prefix}[cannot read: ${e.code}]`); return; }
    ents.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of ents) {
      if (count >= maxEntries) { if (count === maxEntries) { lines.push(`${prefix}… [entry cap ${maxEntries} reached]`); count++; } return; }
      count++;
      if (e.isDirectory()) {
        const skip = SKIP_DIRS.has(e.name);
        lines.push(`${prefix}${e.name}/${skip ? '  (skipped)' : ''}`);
        if (!skip && level < depth) await walk(path.join(dir, e.name), level + 1, prefix + '  ');
      } else {
        let size = '';
        try { size = '  ' + fmtBytes((await fs.stat(path.join(dir, e.name))).size); } catch { /* ignore */ }
        lines.push(`${prefix}${e.name}${size}`);
      }
    }
  }
  await walk(root, 1, '');
  return lines.length ? lines.join('\n') : '(empty)';
}
