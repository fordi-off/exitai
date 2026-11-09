import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from '../config.mjs';
import { resolvePath, clip } from './util.mjs';

const TMP = path.join(DATA, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
let seq = 0;
const BASH = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find(p => fs.existsSync(p));

function killTree(pid) {
  try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
}

/** Write the command to a temp script file (robust against quoting/length issues) and return spawn args. */
function prepare(command, shell) {
  const id = `${process.pid}_${Date.now()}_${seq++}`;
  if (shell === 'cmd') {
    const f = path.join(TMP, `c_${id}.cmd`);
    fs.writeFileSync(f, `@echo off\r\nchcp 65001 >nul\r\n${command}\r\n`, 'utf8');
    return { exe: 'cmd.exe', args: ['/d', '/c', f], file: f };
  }
  if (shell === 'bash') {
    if (!BASH) throw new Error('bash not found (Git for Windows is not installed). Use shell=powershell.');
    const f = path.join(TMP, `c_${id}.sh`);
    fs.writeFileSync(f, command.replace(/\r\n/g, '\n'), 'utf8');
    return { exe: BASH, args: [f.replace(/\\/g, '/')], file: f };
  }
  const f = path.join(TMP, `c_${id}.ps1`);
  const body =
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'\r\n" +
    command + "\r\nif ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\r\n";
  fs.writeFileSync(f, '\uFEFF' + body, 'utf8'); // BOM so Windows PowerShell 5.1 reads UTF-8 correctly
  return { exe: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], file: f };
}

function cleanup(file) { setTimeout(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } }, 1000); }

const jobs = new Map(); // id -> {id, pid, command, started, buf, readPos, exited, code, proc}
let jobSeq = 1;

export function killAllJobs() {
  for (const j of jobs.values()) if (!j.exited && j.proc?.pid) killTree(j.proc.pid);
}

export const shellTools = [
  {
    name: 'run_command',
    risk: 'exec',
    description: 'Run a shell command on this Windows PC and wait for it to finish (default shell: PowerShell). Returns exit code and combined output. Use it for builds, tests, git, installs, system info, scripts, anything. stdin is closed, so never run interactive programs. For servers/watchers use the `process` tool.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command or multi-line script' },
        cwd: { type: 'string', description: 'Working directory (default: workspace)' },
        timeout_sec: { type: 'integer', description: 'Kill after this many seconds (default 120, max 1800)' },
        shell: { type: 'string', enum: ['powershell', 'cmd', 'bash'], description: 'Default powershell' },
      },
      required: ['command'],
    },
    async run({ command, cwd, timeout_sec = 120, shell = 'powershell' }, ctx) {
      if (typeof command !== 'string' || !command.trim()) throw new Error('command is required');
      const dir = resolvePath(cwd || '.', ctx.workspace);
      const { exe, args, file } = prepare(command, shell);
      const timeoutMs = Math.min(1800, Math.max(1, timeout_sec | 0)) * 1000;
      const t0 = Date.now();
      return await new Promise((resolve) => {
        const proc = spawn(exe, args, { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' } });
        let out = '';
        let timedOut = false, aborted = false;
        const add = (d) => { if (out.length < 3_000_000) out += d.toString('utf8'); };
        proc.stdout.on('data', add);
        proc.stderr.on('data', add);
        const timer = setTimeout(() => { timedOut = true; killTree(proc.pid); }, timeoutMs);
        const onAbort = () => { aborted = true; killTree(proc.pid); };
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        const finish = (code, err) => {
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onAbort);
          cleanup(file);
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          let head = `[exit ${code ?? '?'} · ${secs}s · cwd ${dir}]`;
          if (timedOut) head = `[TIMED OUT after ${timeout_sec}s and was killed · cwd ${dir}]`;
          if (aborted) head = `[STOPPED by user · cwd ${dir}]`;
          if (err) head += ` ${err}`;
          const text = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r\n/g, '\n').trimEnd();
          resolve(`${head}\n${clip(text || '(no output)', 16000, 0.25)}`);
        };
        proc.on('error', (e) => finish(null, `spawn error: ${e.message}`));
        proc.on('close', (code) => finish(code));
      });
    },
  },
  {
    name: 'process',
    risk: 'exec',
    description: 'Manage long-running background processes (dev servers, watchers, downloads). action=start returns a job id immediately; use action=output to read new output, stop to kill it, list to see all jobs.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'output', 'stop', 'list'] },
        command: { type: 'string', description: 'start: the command' },
        cwd: { type: 'string' },
        id: { type: 'integer', description: 'output/stop: job id' },
        shell: { type: 'string', enum: ['powershell', 'cmd', 'bash'] },
        wait_sec: { type: 'integer', description: 'start/output: wait this long first so startup output can appear (default 3)' },
      },
      required: ['action'],
    },
    async run({ action, command, cwd, id, shell = 'powershell', wait_sec = 3 }, ctx) {
      const wait = (s) => new Promise(r => setTimeout(r, Math.min(60, Math.max(0, s)) * 1000));
      if (action === 'list') {
        if (!jobs.size) return 'No background jobs.';
        return [...jobs.values()].map(j => `#${j.id} pid=${j.proc.pid} ${j.exited ? `exited(${j.code})` : 'running'} · ${j.command.slice(0, 100)}`).join('\n');
      }
      if (action === 'start') {
        if (!command) throw new Error('command required');
        const dir = resolvePath(cwd || '.', ctx.workspace);
        const { exe, args, file } = prepare(command, shell);
        const proc = spawn(exe, args, { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', PYTHONIOENCODING: 'utf-8' } });
        const job = { id: jobSeq++, command, proc, buf: '', readPos: 0, exited: false, code: null };
        const add = (d) => { job.buf += d.toString('utf8'); if (job.buf.length > 2_000_000) { const drop = job.buf.length - 1_000_000; job.buf = job.buf.slice(drop); job.readPos = Math.max(0, job.readPos - drop); } };
        proc.stdout.on('data', add); proc.stderr.on('data', add);
        proc.on('close', (c) => { job.exited = true; job.code = c; cleanup(file); });
        proc.on('error', (e) => { job.exited = true; job.buf += `\nspawn error: ${e.message}`; });
        jobs.set(job.id, job);
        await wait(wait_sec);
        return `Started job #${job.id} (pid ${proc.pid}) ${job.exited ? `— already exited with code ${job.code}` : '— running'}.\n` + readJob(job);
      }
      const job = jobs.get(id);
      if (!job) throw new Error(`No job with id ${id}. Use action=list.`);
      if (action === 'output') { if (wait_sec) await wait(Math.min(wait_sec, 10)); return `[job #${job.id} ${job.exited ? `exited ${job.code}` : 'running'}]\n` + readJob(job); }
      if (action === 'stop') { if (!job.exited) killTree(job.proc.pid); return `Stopping job #${job.id}.`; }
      throw new Error('unknown action');
    },
  },
];

// ---- run_code: run a snippet in Python / Node / PowerShell / ... without hand-crafting shell commands ----
const LANGS = {
  python: { ext: '.py', cmd: (f, a) => `python -u -X utf8 "${f}"${a}` },
  node: { ext: '.js', cmd: (f, a) => `node "${f}"${a}` },
  powershell: { ext: '.ps1', shell: 'powershell' },
  cmd: { ext: '.bat', shell: 'cmd' },
  bash: { ext: '.sh', shell: 'bash' },
};
const LANG_ALIAS = { py: 'python', python3: 'python', js: 'node', javascript: 'node', mjs: 'node', ps: 'powershell', ps1: 'powershell', pwsh: 'powershell', bat: 'cmd', batch: 'cmd', sh: 'bash', shell: 'bash' };

shellTools.push({
  name: 'run_code',
  risk: 'exec',
  description: 'Write a code snippet to a file and run it: python, node (javascript), powershell, cmd or bash. Best for calculations, data processing, scraping, quick scripts and tests: you get stdout, stderr and the exit code. Pass save_as to keep the script as a real file (e.g. "C:\\\\work\\\\tool.py") instead of a temp file. For bigger programs write files with write_file and run them with run_command.',
  parameters: {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['python', 'node', 'powershell', 'cmd', 'bash'] },
      code: { type: 'string', description: 'The source code' },
      args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments (python/node)' },
      cwd: { type: 'string', description: 'Working directory (default: workspace)' },
      timeout_sec: { type: 'integer', description: 'Default 120, max 1800' },
      save_as: { type: 'string', description: 'Keep the script at this path' },
    },
    required: ['language', 'code'],
  },
  async run({ language, code, args = [], cwd, timeout_sec = 120, save_as }, ctx) {
    const lang = LANGS[LANG_ALIAS[String(language).toLowerCase()] || String(language).toLowerCase()];
    if (!lang) throw new Error(`Unsupported language "${language}". Use: ${Object.keys(LANGS).join(', ')}`);
    if (typeof code !== 'string' || !code.trim()) throw new Error('The <run_code> block was empty: the source code must be inside the block. To run a file that already exists, use the run_command tool (e.g. python path\\to\\file.py).');
    let file = save_as ? resolvePath(save_as, ctx.workspace) : path.join(TMP, `code_${Date.now()}_${seq++}${lang.ext}`);
    if (lang.ext === '.js' && /^\s*(import|export)\s/m.test(code)) file = file.replace(/\.js$/, '.mjs'); // ES modules
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lang.shell === 'powershell' ? '\uFEFF' + code : code, 'utf8');
    const argStr = (Array.isArray(args) ? args : []).map(a => ` "${String(a).replace(/"/g, '\\"')}"`).join('');
    try {
      let result;
      if (lang.shell) result = await shellTools[0].run({ command: lang.shell === 'powershell' ? `& "${file}"${argStr}` : lang.shell === 'cmd' ? `call "${file}"${argStr}` : code, cwd, timeout_sec, shell: lang.shell }, ctx);
      else result = await shellTools[0].run({ command: lang.cmd(file, argStr), cwd, timeout_sec }, ctx);
      return `[${language} · ${save_as ? 'saved at ' + file : 'temp script'}]\n${result}`;
    } finally {
      if (!save_as) setTimeout(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } }, 2000);
    }
  },
});

function readJob(job) {
  const text = job.buf.slice(job.readPos).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r\n/g, '\n');
  job.readPos = job.buf.length;
  return clip(text.trimEnd() || '(no new output)', 8000, 0.2);
}
