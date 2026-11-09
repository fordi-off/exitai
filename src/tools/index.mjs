import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MEMORY_FILE, SHOTS_DIR } from '../config.mjs';
import { resolvePath } from './util.mjs';
import { fsTools } from './fs.mjs';
import { shellTools } from './shell.mjs';
import { webTools } from './web.mjs';
import { browserTools } from './browser.mjs';

const MEM_CAP = 6000;
export function readMemory() { try { return fs.readFileSync(MEMORY_FILE, 'utf8'); } catch { return ''; } }

const miscTools = [
  {
    name: 'update_plan',
    risk: 'safe',
    description: 'Create or update your visible task plan (shown to the user as a checklist). Use it at the start of any task with 3+ steps and update statuses as you progress. Send the full list every time.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } },
            required: ['text', 'status'],
          },
        },
      },
      required: ['items'],
    },
    async run({ items }, ctx) {
      if (!Array.isArray(items)) throw new Error('items must be an array');
      const clean = items.map(i => ({ text: String(i.text || i).slice(0, 200), status: ['pending', 'in_progress', 'done'].includes(i.status) ? i.status : 'pending' }));
      ctx.setPlan(clean);
      const done = clean.filter(i => i.status === 'done').length;
      return `Plan updated (${done}/${clean.length} done).`;
    },
  },
  {
    name: 'memory',
    risk: 'safe',
    description: 'Persistent notes that survive across chats (preferences, project facts, paths, lessons learned). action=read shows them; append adds a line; replace overwrites everything. They are shown to you at the start of every conversation, so keep them short and useful.',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['read', 'append', 'replace'] }, text: { type: 'string' } },
      required: ['action'],
    },
    async run({ action, text }) {
      const cur = readMemory();
      if (action === 'read') return cur || '(memory is empty)';
      if (!text) throw new Error('text required');
      const next = action === 'append' ? (cur ? cur.replace(/\s*$/, '\n') : '') + text.trim() + '\n' : text.trim() + '\n';
      if (next.length > MEM_CAP) throw new Error(`Memory would exceed ${MEM_CAP} chars; use replace with a condensed version.`);
      fs.writeFileSync(MEMORY_FILE, next, 'utf8');
      return `Memory saved (${next.length}/${MEM_CAP} chars).`;
    },
  },
  {
    name: 'screen',
    risk: 'safe',
    description: 'Capture the whole desktop (all monitors) to a PNG. Pass `question` to have the vision model look at it and answer (e.g. "what error is shown in the open window?"). Use it to see what the user sees, or to inspect native apps and games.',
    parameters: { type: 'object', properties: { question: { type: 'string' } } },
    async run({ question }, ctx) {
      const file = path.join(SHOTS_DIR, `screen_${Date.now()}.png`);
      const script = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class Dpi { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'; [void][Dpi]::SetProcessDPIAware(); $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save($env:EXITAI_OUT,[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()";
      await new Promise((resolve, reject) => {
        const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, EXITAI_OUT: file }, windowsHide: true });
        let err = ''; c.stderr.on('data', d => { err += d; });
        c.on('close', code => (code === 0 && fs.existsSync(file) ? resolve() : reject(new Error('Screen capture failed: ' + err.trim().slice(0, 300)))));
      });
      if (!question) return `Desktop screenshot saved to ${file}. Pass a question to analyse it with the vision model.`;
      return `Screenshot: ${file}\nVision model answer:\n${await ctx.vision(file, question)}`;
    },
  },
  {
    name: 'vision',
    risk: 'safe',
    description: 'Look at an image file (PNG/JPG/WebP/GIF — e.g. a screenshot, photo, diagram, UI mock-up) with the vision model and answer a question about it.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, question: { type: 'string', description: 'What to look for (default: describe in detail)' } },
      required: ['path'],
    },
    async run({ path: p, question }, ctx) {
      const fp = resolvePath(p, ctx.workspace);
      if (!fs.existsSync(fp)) throw new Error('File not found: ' + fp);
      return await ctx.vision(fp, question || 'Describe this image in detail, transcribing any visible text.');
    },
  },
];

export const ALL_TOOLS = [...shellTools, ...fsTools, ...webTools, ...browserTools, ...miscTools];
const byName = new Map(ALL_TOOLS.map(t => [t.name, t]));

const ALIASES = {
  bash: 'run_command', shell: 'run_command', powershell: 'run_command', cmd: 'run_command', exec: 'run_command', execute: 'run_command', terminal: 'run_command', run: 'run_command',
  read: 'read_file', cat: 'read_file', open_file: 'read_file', write: 'write_file', create_file: 'write_file', edit: 'edit_file', str_replace: 'edit_file',
  ls: 'list_dir', list_directory: 'list_dir', tree: 'list_dir', grep: 'search_files', find: 'search_files', search: 'web_search', fetch: 'web_fetch', browse: 'browser_navigate', navigate: 'browser_navigate',
  click: 'browser_act', screenshot: 'browser_screenshot', console: 'browser_console', network: 'browser_network', snapshot: 'browser_snapshot', dom: 'browser_dom', eval: 'browser_eval',
  todo: 'update_plan', plan: 'update_plan', delete_file: 'file_ops', move_file: 'file_ops',
};

// These two are written by the model as <write_file>/<run_code> blocks in its reply (see blocks.mjs) so the user can
// watch the code appear live; Ollama would only deliver a native tool call after the whole file is generated.
// They stay registered so executing a block (or a stray native call) works.
export const STREAMED_TOOLS = new Set(['write_file', 'run_code', 'edit_file']);

export function toolSchemas() {
  return ALL_TOOLS.filter(t => !STREAMED_TOOLS.has(t.name)).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function toolCatalogText() {
  return ALL_TOOLS.filter(t => !STREAMED_TOOLS.has(t.name)).map(t => `- ${t.name}(${Object.keys(t.parameters.properties || {}).join(', ')}): ${t.description}`).join('\n');
}

export function resolveTool(name) {
  return byName.get(name) || byName.get(ALIASES[name]) || byName.get(String(name).replace(/^functions\./, '').replace(/^tool_/, ''));
}

function coerce(schema, args) {
  const props = schema.properties || {};
  const out = { ...args };
  for (const [k, def] of Object.entries(props)) {
    if (!(k in out) || out[k] === null) { if (out[k] === null) delete out[k]; continue; }
    const v = out[k];
    if ((def.type === 'integer' || def.type === 'number') && typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) out[k] = Number(v);
    else if (def.type === 'boolean' && typeof v === 'string') out[k] = /^(true|1|yes)$/i.test(v);
    else if (def.type === 'string' && (typeof v === 'number' || typeof v === 'boolean')) out[k] = String(v);
    else if (def.type === 'array' && typeof v === 'string') { try { out[k] = JSON.parse(v); } catch { /* leave */ } }
    else if (def.type === 'object' && typeof v === 'string') { try { out[k] = JSON.parse(v); } catch { /* leave */ } }
  }
  return out;
}

export function normalizeArgs(tool, args) {
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
  args = coerce(tool.parameters, args && typeof args === 'object' ? args : {});
  const missing = (tool.parameters.required || []).filter(k => args[k] === undefined);
  if (missing.length) throw new Error(`Missing required argument(s): ${missing.join(', ')}. Expected: ${JSON.stringify(tool.parameters.properties)}`);
  return args;
}
