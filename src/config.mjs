import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');
export const SESSIONS_DIR = path.join(DATA, 'sessions');
export const SHOTS_DIR = path.join(DATA, 'shots');
export const PROFILE_DIR = path.join(DATA, 'browser-profile');
export const UI_PROFILE_DIR = path.join(DATA, 'ui-profile');
export const SETTINGS_FILE = path.join(DATA, 'settings.json');
export const MEMORY_FILE = path.join(DATA, 'memory.md');
export const TOKEN_FILE = path.join(DATA, 'token.txt');

for (const d of [DATA, SESSIONS_DIR, SHOTS_DIR]) fs.mkdirSync(d, { recursive: true });

export const PORT = Number(process.env.EXITAI_PORT || 7777);
export const CDP_PORT = Number(process.env.EXITAI_CDP_PORT || 9333);
// ExitAI runs its own tuned Ollama instance (flash attention, q8 KV cache, 1 parallel slot) so
// it never touches your system-wide Ollama settings. Set EXITAI_OLLAMA to reuse an existing one.
export const OWN_OLLAMA_PORT = Number(process.env.EXITAI_OLLAMA_PORT || 11500);
export const OLLAMA_URL = process.env.EXITAI_OLLAMA || `http://127.0.0.1:${OWN_OLLAMA_PORT}`;
export const SPAWN_OLLAMA = !process.env.EXITAI_OLLAMA;

/**
 * Curated models. `think`: 'bool' (on/off), 'levels' (low|medium|high), 'none'.
 * `sampling` are the vendor-recommended settings (greedy decoding makes Qwen3 loop, so never use temp 0).
 */
export const CATALOG = [
  {
    id: 'huihui_ai/qwen3-abliterated:30b',
    label: 'Qwen3 30B-A3B · abliterated',
    desc: 'Smartest all-rounder. MoE with 3B active params, so it is fast for its size. Thinking on/off.',
    sizeGB: 17.3, vision: false, think: 'bool', family: 'qwen3', recommended: true,
  },
  {
    id: 'huihui_ai/qwen3-coder-abliterated:30b',
    label: 'Qwen3-Coder 30B-A3B · abliterated',
    desc: 'Best for coding and long tool-use chains. No thinking mode (plans via the agent loop).',
    sizeGB: 17.3, vision: false, think: 'none', family: 'qwen3-coder', recommended: true,
  },
  {
    id: 'huihui_ai/gpt-oss-abliterated:20b',
    label: 'gpt-oss 20B · abliterated',
    desc: 'Fits fully in 16 GB VRAM: fastest deep reasoner. Reasoning effort low/medium/high.',
    sizeGB: 12.8, vision: false, think: 'levels', family: 'gpt-oss', recommended: true,
  },
  {
    id: 'huihui_ai/qwen3-vl-abliterated:8b',
    label: 'Qwen3-VL 8B · abliterated',
    desc: 'Vision model: reads screenshots and images. Also used by the agent to look at pages.',
    sizeGB: 5.7, vision: true, think: 'none', family: 'qwen3-vl', recommended: true,
  },
  {
    id: 'qwen3-abliterated-14b-32k:latest',
    label: 'Qwen3 14B · abliterated (32k)',
    desc: 'Your existing dense 14B. Fits fully in VRAM, solid and quick.',
    sizeGB: 9.0, vision: false, think: 'bool', family: 'qwen3',
  },
  {
    id: 'huihui_ai/qwen3-abliterated:14b',
    label: 'Qwen3 14B · abliterated',
    desc: 'Dense 14B, fits fully in VRAM.',
    sizeGB: 9.0, vision: false, think: 'bool', family: 'qwen3',
  },
  {
    id: 'qwen2.5vl:7b',
    label: 'Qwen2.5-VL 7B',
    desc: 'Older vision model.',
    sizeGB: 6.0, vision: true, think: 'none', family: 'qwen2.5vl',
  },
  {
    id: 'hermes3:8b',
    label: 'Hermes 3 8B',
    desc: 'Small and quick, decent tool use.',
    sizeGB: 4.7, vision: false, think: 'none', family: 'llama',
  },
  {
    id: 'llama3.1:8b',
    label: 'Llama 3.1 8B',
    desc: 'Small general model.',
    sizeGB: 4.9, vision: false, think: 'none', family: 'llama',
  },
];

export function guessMeta(name) {
  const n = name.toLowerCase();
  const vision = /vl|llava|vision|moondream|minicpm-v|gemma3/.test(n);
  let think = 'none', family = 'other';
  if (n.includes('gpt-oss')) { think = 'levels'; family = 'gpt-oss'; }
  else if (n.includes('coder')) { family = 'qwen3-coder'; }
  else if (n.includes('qwen3') && !vision) { think = 'bool'; family = 'qwen3'; }
  else if (n.includes('deepseek-r1') || n.includes('qwq')) { think = 'bool'; family = 'r1'; }
  return { id: name, label: name, desc: 'Installed locally.', sizeGB: 0, vision, think, family };
}

export function samplingFor(meta, thinking) {
  switch (meta.family) {
    case 'qwen3':
      return thinking
        ? { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 }
        : { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0 };
    case 'qwen3-coder':
      return { temperature: 0.7, top_p: 0.8, top_k: 20, repeat_penalty: 1.05 };
    case 'gpt-oss':
      return { temperature: 1.0, top_p: 1.0 };
    case 'qwen3-vl':
      return { temperature: 0.7, top_p: 0.8, top_k: 20 };
    case 'r1':
      return { temperature: 0.6, top_p: 0.95 };
    default:
      return { temperature: 0.6, top_p: 0.9 };
  }
}

export const DEFAULT_SETTINGS = {
  model: 'huihui_ai/qwen3-abliterated:30b',
  visionModel: 'huihui_ai/qwen3-vl-abliterated:8b',
  mode: 'deep',            // deep | fast
  think: 'high',           // off | low | medium | high
  autoApprove: true,
  workspace: os.homedir(),
  numCtx: 32768,
  maxSteps: 60,
  headless: false,         // agent browser visible by default
};

let settings = { ...DEFAULT_SETTINGS };
try {
  Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
} catch { /* first run */ }

export function getSettings() { return settings; }
export function updateSettings(patch) {
  const allowed = Object.keys(DEFAULT_SETTINGS);
  for (const k of allowed) if (k in patch) settings[k] = patch[k];
  settings.numCtx = Math.max(4096, Math.min(262144, Number(settings.numCtx) || 32768));
  settings.maxSteps = Math.max(1, Math.min(500, Number(settings.maxSteps) || 60));
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch { /* ignore */ }
  return settings;
}
