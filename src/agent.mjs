import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CATALOG, DATA, guessMeta, samplingFor, getSettings } from './config.mjs';
import { chatStream, OllamaError, ensureServer } from './ollama.mjs';
import { buildSystemPrompt } from './prompt.mjs';
import { toolSchemas, resolveTool, normalizeArgs, ALL_TOOLS } from './tools/index.mjs';
import { saveSession } from './sessions.mjs';
import { clip, resolvePath, fmtBytes, isBinary, decodeText } from './tools/util.mjs';
import { listDir } from './tools/fs.mjs';
import { BlockStreamer, blockToCall } from './blocks.mjs';
import { isImagePath } from './fsapi.mjs';

export function modelMeta(id) { return CATALOG.find(m => m.id === id) || guessMeta(id); }

// Per-model capability discoveries made at runtime (e.g. a template without tool/thinking support),
// persisted so each model is probed only once.
const CAPS_FILE = path.join(DATA, 'caps.json');
const caps = (() => { try { return JSON.parse(fs.readFileSync(CAPS_FILE, 'utf8')); } catch { return {}; } })();
function saveCaps() { try { fs.writeFileSync(CAPS_FILE, JSON.stringify(caps)); } catch { /* ignore */ } }

/**
 * Some community templates make the model write its reasoning into the normal reply and close it with
 * </think> instead of using Ollama's separate "thinking" channel (and not always on every turn). When
 * thinking was requested but the very first streamed chunk is plain content, we route everything up to
 * </think> to the thinking channel. If no </think> ever arrives it was an ordinary answer after all.
 */
class ThinkRouter {
  constructor(onThink, onText) { this.onThink = onThink; this.onText = onText; this.buf = ''; this.closed = false; this.thinking = ''; this.text = ''; this.started = false; }
  push(d) {
    if (this.closed) { this.text += d; this.onText(d); return; }
    this.buf += d;
    if (!this.started) { this.buf = this.buf.replace(/^[\s̈]*(<think>)?\s*/, ''); if (!this.buf) return; this.started = true; }
    const tag = '</think>';
    const i = this.buf.indexOf(tag);
    if (i >= 0) {
      const t = this.buf.slice(0, i); if (t) { this.thinking += t; this.onThink(t); }
      const rest = this.buf.slice(i + tag.length).replace(/^\s+/, '');
      this.buf = ''; this.closed = true;
      if (rest) { this.text += rest; this.onText(rest); }
      return;
    }
    let hold = 0;
    for (let k = Math.min(tag.length - 1, this.buf.length); k > 0; k--) if (this.buf.endsWith(tag.slice(0, k))) { hold = k; break; }
    const out = this.buf.slice(0, this.buf.length - hold);
    this.buf = this.buf.slice(this.buf.length - hold);
    if (out) { this.thinking += out; this.onThink(out); }
  }
  end() { if (!this.closed && this.buf) { this.thinking += this.buf; this.onThink(this.buf); this.buf = ''; } }
}

const UI_OUTPUT_MAX = 4000;
const LLM_OUTPUT_MAX = 24000;
let toolSeq = 0;

// ---------------------------------------------------------------------------------------------
// Parsing tool calls that arrive as text (<tool_call> JSON / Qwen-coder XML) instead of natively
// ---------------------------------------------------------------------------------------------
function tryJson(s) {
  try { return JSON.parse(s); } catch { /* repair below */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1')); } catch { /* give up */ } }
  return null;
}

export function extractTextToolCalls(content) {
  const calls = [];
  let cleaned = content;
  const re = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;
  let m;
  while ((m = re.exec(content))) {
    const inner = m[1].trim();
    if (!inner) continue;
    const fx = inner.match(/<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/);
    if (fx) {
      const args = {};
      for (const pm of fx[2].matchAll(/<parameter=([\w.-]+)>\s*([\s\S]*?)\s*<\/parameter>/g)) args[pm[1]] = pm[2];
      calls.push({ function: { name: fx[1], arguments: args } });
      continue;
    }
    const j = tryJson(inner);
    if (j && (j.name || j.function)) {
      const f = j.function || j;
      calls.push({ function: { name: f.name, arguments: f.arguments ?? f.parameters ?? {} } });
    }
  }
  if (calls.length) cleaned = content.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '').trim();
  return { calls, cleaned };
}

/** Streams text but hides everything from the first "<tool_call>" onward. */
class TagFilter {
  constructor(emit) { this.emit = emit; this.buf = ''; this.hidden = false; }
  push(d) {
    if (this.hidden) return;
    this.buf += d;
    const tag = '<tool_call>';
    const i = this.buf.indexOf(tag);
    if (i >= 0) { if (i > 0) this.emit(this.buf.slice(0, i)); this.buf = ''; this.hidden = true; return; }
    let hold = 0;
    for (let k = Math.min(tag.length - 1, this.buf.length); k > 0; k--) if (this.buf.endsWith(tag.slice(0, k))) { hold = k; break; }
    const out = this.buf.slice(0, this.buf.length - hold);
    this.buf = this.buf.slice(this.buf.length - hold);
    if (out) this.emit(out);
  }
  end() { if (!this.hidden && this.buf) this.emit(this.buf); this.buf = ''; }
}

// ---------------------------------------------------------------------------------------------
function thinkParam(meta, settings) {
  if (caps[meta.id]?.noThink) return undefined;
  const fast = settings.mode === 'fast', max = settings.mode === 'max';
  if (meta.think === 'bool') return max ? true : !(fast || settings.think === 'off');
  if (meta.think === 'levels') return max ? 'high' : fast || settings.think === 'off' ? 'low' : (['low', 'medium', 'high'].includes(settings.think) ? settings.think : 'high');
  return undefined;
}

function estimateChars(messages) {
  let n = 0;
  for (const m of messages) { n += (m.content?.length || 0) + (m.thinking?.length || 0); if (m.tool_calls) n += JSON.stringify(m.tool_calls).length; }
  return n;
}

function clipOldToolOutputs(llm, keepLast = 8) {
  let saved = 0;
  for (let i = 0; i < llm.length - keepLast; i++) {
    const m = llm[i];
    const isTool = m.role === 'tool' || (m.role === 'user' && m._toolResp);
    if (isTool && m.content && m.content.length > 1400) {
      const before = m.content.length;
      m.content = clip(m.content, 1000, 0.6) + '\n[older output shortened to save context]';
      saved += before - m.content.length;
    }
  }
  return saved;
}

async function summarize(session, signal, settings, meta) {
  const llm = session.llm;
  // keep roughly the last 30% (by chars) verbatim, cutting at a safe boundary
  const total = estimateChars(llm);
  let acc = 0, split = llm.length;
  for (let i = llm.length - 1; i >= 0; i--) { acc += (llm[i].content?.length || 0) + (llm[i].tool_calls ? 400 : 0); if (acc > total * 0.3) { split = i; break; } }
  while (split > 0 && (llm[split]?.role === 'tool' || llm[split]?._toolResp)) split--;
  if (split <= 2) return false;
  const old = llm.slice(0, split);
  const transcript = old.map(m => {
    const role = m._toolResp ? 'TOOL RESULT' : m.role === 'tool' ? `TOOL RESULT (${m.tool_name || ''})` : m.role.toUpperCase();
    let c = m.content || '';
    if (m.tool_calls) c += ' ' + m.tool_calls.map(t => `[called ${t.function.name} ${JSON.stringify(t.function.arguments).slice(0, 300)}]`).join(' ');
    return `${role}: ${clip(c, 1800, 0.6)}`;
  }).join('\n\n');
  const res = await chatStream({
    model: meta.id,
    messages: [
      { role: 'system', content: 'You compress an agent conversation into a dense working summary so work can continue seamlessly after older messages are dropped. Be factual and specific. Never invent anything.' },
      { role: 'user', content: `Summarize the conversation below. Include: (1) the user's goal and every requirement/preference they stated, (2) what has been done so far, (3) exact file paths, commands, URLs, ports, identifiers and error messages that matter, (4) decisions made and why, (5) what is still open or failing, (6) the next steps. Use compact bullet points.\n\n<conversation>\n${transcript}\n</conversation>` },
    ],
    think: meta.think === 'bool' && !caps[meta.id]?.noThink ? false : (meta.think === 'levels' ? 'low' : undefined),
    options: { num_ctx: settings.numCtx, temperature: 0.3, num_predict: 2500 },
    signal,
  });
  const summary = res.content.trim();
  if (!summary) return false;
  session.llm = [{ role: 'user', content: `[Summary of the earlier part of this conversation — older messages were removed to free context]\n${summary}` }, ...llm.slice(split)];
  return true;
}

async function describeImage(file, question, { settings, meta, signal }) {
  const vid = meta.vision ? meta.id : settings.visionModel;
  const b64 = fs.readFileSync(file).toString('base64');
  try {
    const r = await chatStream({
      model: vid,
      messages: [{ role: 'user', content: question, images: [b64] }],
      options: { num_ctx: 8192, temperature: 0.3, num_predict: 1500 },
      signal,
    });
    return r.content.trim() || '(vision model returned nothing)';
  } catch (e) {
    if (e instanceof OllamaError && /not found/i.test(e.message)) throw new Error(`Vision model ${vid} is not installed. Download it from the model menu.`);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
export async function runAgent({ session, userText, images = [], attachments = [], emit, signal, requestApproval }) {
  const settings = getSettings();
  const meta = modelMeta(session.model || settings.model);
  session.model = meta.id;
  const sid = session.id;
  const tl = session.timeline;
  const send = (e) => emit({ sessionId: sid, ...e });
  const isMax = settings.mode === 'max';
  const deep = settings.mode !== 'fast';          // deep and max both self-check their work
  const maxSteps = isMax ? Math.max(settings.maxSteps, 150) : settings.maxSteps;
  const maxVerifyRounds = isMax ? 3 : 2;

  const rec = {
    think(d) { let l = tl.at(-1); if (!l || l.kind !== 'thinking') { l = { kind: 'thinking', text: '' }; tl.push(l); } l.text += d; send({ type: 'thinking', delta: d }); },
    text(d) { let l = tl.at(-1); if (!l || l.kind !== 'assistant') { l = { kind: 'assistant', text: '' }; tl.push(l); } l.text += d; send({ type: 'text', delta: d }); },
    note(level, text) { tl.push({ kind: 'note', level, text }); send({ type: 'note', level, text }); },
  };

  let workspace = settings.workspace;
  try { if (!fs.statSync(workspace).isDirectory()) throw 0; } catch { workspace = os.homedir(); }

  const tctx = {
    workspace, signal, settings, session, model: meta.id,
    setPlan(items) { session.plan = items; send({ type: 'plan', items }); },
    vision: (file, q) => describeImage(file, q, { settings, meta, signal }),
  };

  // ---- user message ----
  let content = userText;
  const llmImages = [];
  if (attachments.length) {
    const lines = ['[Attached by the user. You have full read/write access to these.]'];
    for (const a of attachments) {
      try {
        const fp = resolvePath(a.path, workspace);
        const st = fs.statSync(fp);
        if (st.isDirectory()) {
          const here = path.resolve(fp) === path.resolve(workspace) ? '  (this is now your workspace)' : '';
          lines.push(`- Folder: ${fp}${here}\n${(await listDir(fp, 2, 60)).split('\n').map(l => '    ' + l).join('\n')}`);
        } else {
          const img = isImagePath(fp);
          let line = `- File: ${fp} (${fmtBytes(st.size)}${img ? '; image: use the vision tool to look at it' : ''})`;
          if (!img && st.size <= 6000) {
            const buf = fs.readFileSync(fp);
            if (!isBinary(buf)) line += `\n  contents:\n${decodeText(buf).split('\n').map(l => '    ' + l).join('\n')}`;
          }
          lines.push(line);
        }
      } catch { lines.push(`- ${a.type}: ${a.path} (not found or not accessible)`); }
    }
    content += '\n\n' + lines.join('\n');
  }
  if (images.length) {
    const b64s = images.map(d => d.replace(/^data:[^;]+;base64,/, ''));
    if (meta.vision) llmImages.push(...b64s);
    else {
      rec.note('info', `Model ${meta.label} cannot see images; describing them with the vision model first…`);
      const descs = [];
      for (let i = 0; i < b64s.length; i++) {
        const tmp = `${os.tmpdir()}\\exitai_img_${Date.now()}_${i}.png`;
        fs.writeFileSync(tmp, Buffer.from(b64s[i], 'base64'));
        try { descs.push(`[Image ${i + 1} description by vision model]\n` + await describeImage(tmp, 'Describe this image in detail. Transcribe all visible text exactly.', { settings, meta, signal })); }
        catch (e) { descs.push(`[Image ${i + 1} could not be analysed: ${e.message}]`); }
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
      content += '\n\n' + descs.join('\n\n');
    }
  }
  tl.push({ kind: 'user', text: userText, ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}) });
  session.llm.push({ role: 'user', content, ...(llmImages.length ? { images: llmImages } : {}) });
  if (session.title === 'New chat') {
    session.title = userText.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
    send({ type: 'title', title: session.title });
  }
  saveSession(session);

  // ---- loop state ----
  let steps = 0, didWork = false, phase = 'work', verifyRounds = 0, stuck = false, nudged = 0, lastCtx = session.usage?.ctxUsed || 0;
  const recent = [];           // signatures of recent tool calls
  let endReason = 'done';

  try {
    for (;;) {
      if (signal.aborted) { endReason = 'stopped'; break; }
      if (steps >= maxSteps) { rec.note('warn', `Reached the step limit (${maxSteps}). Say "continue" to keep going.`); endReason = 'max_steps'; break; }
      steps++;

      // ---- context management ----
      const sysPrompt = buildSystemPrompt({ workspace, meta, mode: settings.mode, textTools: !!session.textTools });
      const ctxMax = settings.numCtx;
      let projected = lastCtx + Math.max(0, estimateChars(session.llm.slice(-6))) / 6; // rough guard for freshly added output
      if (!lastCtx) projected = (sysPrompt.length + estimateChars(session.llm)) / 3.2 + 2500;
      if (projected > ctxMax * 0.72) {
        const saved = clipOldToolOutputs(session.llm);
        if (saved > 0) { projected -= saved / 3.2; lastCtx = Math.max(0, lastCtx - saved / 3.2); }
        if (projected > ctxMax * 0.7) {
          send({ type: 'note', level: 'info', text: 'Context is filling up — compacting earlier work…' });
          try {
            const ok = await summarize(session, signal, settings, meta);
            if (ok) { rec.note('info', 'Earlier messages were summarized to free up context.'); lastCtx = 0; }
          } catch (e) { if (signal.aborted) { endReason = 'stopped'; break; } rec.note('warn', 'Compaction failed: ' + e.message); }
        }
      }

      // ---- call the model ----
      const useNative = !session.textTools;
      const messages = [{ role: 'system', content: sysPrompt }, ...session.llm.map(({ _toolResp, ...m }) => m)];
      const thinking = thinkParam(meta, settings);
      const options = {
        num_ctx: ctxMax,
        // Max mode lets the model think for as long as it needs (bounded by the context window).
        num_predict: isMax ? Math.max(16384, Math.min(65536, Math.floor(ctxMax * 0.75))) : deep ? 16384 : 6144,
        ...samplingFor(meta, thinking === true || typeof thinking === 'string'),
      };

      const holdForVerify = phase === 'verifying';
      let held = '', gateOpen = !holdForVerify, lead = '', started = false;
      const out = (d) => {
        if (!started) { lead += d; if (!lead.trim()) return; d = lead.replace(/^\s+/, ''); lead = ''; started = true; } // never open an empty bubble
        if (gateOpen) { rec.text(d); return; }
        held += d;
        const norm = held.toLowerCase().replace(/[^a-z]/g, '');
        if (!'verified'.startsWith(norm)) { gateOpen = true; rec.text(held); held = ''; }
      };
      const filter = new TagFilter(out);

      // <write_file>/<run_code> blocks written straight into the reply stream live to the UI as the model types them
      const blockEntries = new Map();
      const bs = new BlockStreamer({
        onText: (t) => filter.push(t),
        onStart: ({ name, attrs }) => {
          const id = 't_' + (++toolSeq);
          const args = name === 'write_file' ? { path: attrs.path || attrs.file || '', content: '' }
            : name === 'edit_file' ? { path: attrs.path || attrs.file || '', patch: '' }
              : { language: attrs.language || attrs.lang || 'python', code: '' };
          if (attrs.save_as) args.save_as = attrs.save_as;
          const entry = { kind: 'tool', id, name, args, status: 'running', output: '', ms: 0, streaming: true };
          tl.push(entry); blockEntries.set(id, entry);
          send({ type: 'tool_call', id, name, args, streaming: true });
          return id;
        },
        onDelta: (id, d) => {
          const e = blockEntries.get(id); if (!e) return;
          e.args[e.name === 'write_file' ? 'content' : e.name === 'edit_file' ? 'patch' : 'code'] += d;
          send({ type: 'tool_stream', id, delta: d });
        },
        onEnd: (id, b) => {
          const e = blockEntries.get(id); if (!e) return;
          const call = blockToCall(b);
          e.args = call.arguments; e.streaming = false;
          send({ type: 'tool_stream_end', id, args: call.arguments, closed: b.closed });
        },
      });

      let router = null, firstChunk = true, sawThinkChunk = false;
      let res;
      try {
        res = await chatStream({
          model: meta.id, messages, tools: useNative ? toolSchemas() : undefined, think: thinking, options, signal,
          onThinking: (d) => { firstChunk = false; sawThinkChunk = true; rec.think(d); },
          onText: (d) => {
            if (firstChunk) {
              firstChunk = false;
              if (thinking === true && !sawThinkChunk) router = new ThinkRouter((x) => rec.think(x), (x) => bs.push(x));
            }
            if (router) router.push(d); else bs.push(d);
          },
        });
        router?.end();
        bs.end(res.stats.doneReason !== 'length');   // an unclosed block is only "cut off" if the output limit was hit
        filter.end();
        if (router) {
          if (router.closed) { res.thinking = router.thinking; res.content = router.text; }
          else if (res.toolCalls.length) { res.thinking = router.thinking; res.content = ''; }
          else { // no </think> ever came: it was a normal answer, show it as such
            const last = tl.at(-1);
            if (last?.kind === 'thinking') { last.kind = 'assistant'; send({ type: 'thinking_to_text' }); }
            res.content = router.thinking; res.thinking = '';
          }
        }
      } catch (e) {
        router?.end();
        bs.end();
        filter.end();
        if (signal.aborted || e.name === 'AbortError') { endReason = 'stopped'; break; }
        const msg = String(e.message || e);
        if (e instanceof OllamaError && /does not support tools/i.test(msg) && useNative) {
          session.textTools = true; rec.note('info', 'This model has no native tool support; switched to text-based tool calls.'); steps--; continue;
        }
        if (e instanceof OllamaError && /does not support thinking/i.test(msg) && thinking !== undefined) {
          caps[meta.id] = { ...caps[meta.id], noThink: true }; saveCaps(); steps--; continue;
        }
        if (/fetch failed|ECONNREFUSED|ECONNRESET|terminated/i.test(msg)) {
          if (await ensureServer()) { rec.note('warn', 'Ollama connection dropped; retrying…'); if (nudged++ < 3) { steps--; continue; } }
        }
        if (/not found/i.test(msg)) rec.note('error', `Model "${meta.id}" is not installed. Pick it in the model menu to download it.`);
        else rec.note('error', 'Model error: ' + msg.slice(0, 600));
        endReason = 'error'; break;
      }

      const st = res.stats;
      lastCtx = (st.promptTokens || 0) + (st.genTokens || 0);
      session.usage = { promptTokens: st.promptTokens, genTokens: st.genTokens, tps: Math.round(st.tps * 10) / 10, ctxUsed: lastCtx, ctxMax };
      send({ type: 'usage', ...session.usage });

      // ---- interpret the reply ----
      const rawContent = res.content;                       // as the model wrote it (blocks included)
      if (bs.blocks.length) res.content = bs.plain;         // the blocks become tool calls; the rest is the message
      let calls = res.toolCalls;
      let text = res.content;
      if (!calls.length && /<tool_call>/.test(text)) {
        const ex = extractTextToolCalls(text);
        if (ex.calls.length) { calls = ex.calls; text = ex.cleaned; }
      }
      if (bs.blocks.length) calls = [...bs.blocks.map(b => ({ function: blockToCall(b), _blockId: b.id, _closed: b.closed })), ...calls];
      const visibleText = text.replace(/<tool_call>[\s\S]*$/, '').trim();

      // verification gate result
      if (holdForVerify && !calls.length && /^verified\W*$/i.test(visibleText)) {
        session.llm.pop(); // model confirmed: drop the hidden self-check prompt and its acknowledgement
        break;
      }
      if (held) { rec.text(held); held = ''; }

      const asst = { role: 'assistant', content: session.textTools ? rawContent : text };
      if (meta.family === 'gpt-oss' && res.thinking && calls.length) asst.thinking = res.thinking;
      if (calls.length && !session.textTools) asst.tool_calls = calls.map(c => ({ function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? (tryJson(c.function.arguments) || {}) : (c.function.arguments || {}) } }));
      session.llm.push(asst);
      saveSession(session);

      if (!calls.length) {
        if (!visibleText && !res.thinking) {
          if (nudged++ < 2) { session.llm.pop(); session.llm.push({ role: 'user', content: 'Your last reply was empty. Continue the task, or give your final answer.' }); continue; }
        }
        if (!visibleText && res.thinking && st.doneReason === 'length') {
          if (nudged++ < 2) { session.llm.push({ role: 'user', content: 'You ran out of output budget while thinking. Be more concise: act now with a tool call or give your answer.' }); continue; }
        }
        // deep mode: one silent self-check after real work
        if (deep && didWork && phase === 'work' && verifyRounds < maxVerifyRounds && visibleText) {
          phase = 'verifying'; verifyRounds++;
          session.llm.push({ role: 'user', content: '[Self-check, automated] Re-read the original request. Was every part fully accomplished, and did you verify the result with real evidence (tests/commands run, files re-read, page checked)? If anything is incomplete, wrong or unverified, fix it now using tools. If everything is genuinely done and verified, reply with exactly the single word VERIFIED and nothing else.' });
          continue;
        }
        break;
      }

      // ---- execute tool calls ----
      for (const c of calls) {
        if (signal.aborted) break;
        const name = c.function.name;
        const rawArgs = c.function.arguments;
        const tool = resolveTool(name);
        const blockEntry = c._blockId ? blockEntries.get(c._blockId) : null;   // already on screen, streamed live
        const id = blockEntry ? blockEntry.id : 't_' + (++toolSeq);
        let args = {};
        let entry = blockEntry || { kind: 'tool', id, name: tool?.name || name, args: {}, status: 'running', output: '', ms: 0 };
        let result, ok = true;
        const t0 = Date.now();

        if (!tool) {
          args = typeof rawArgs === 'object' ? rawArgs : {};
          entry.args = args; if (!blockEntry) { tl.push(entry); send({ type: 'tool_call', id, name, args }); }
          result = `Error: unknown tool "${name}". Available tools: ${ALL_TOOLS.map(t => t.name).join(', ')}`; ok = false;
        } else {
          try { args = normalizeArgs(tool, rawArgs); } catch (e) { args = typeof rawArgs === 'object' && rawArgs ? rawArgs : {}; result = 'Error: ' + e.message; ok = false; }
          entry.args = args; if (!blockEntry) { tl.push(entry); send({ type: 'tool_call', id, name: tool.name, args }); }
          if (ok && c._closed === false) {
            result = `Error: your <${name}> block was cut off before its closing tag (output limit reached), so NOTHING was ${name === 'write_file' ? 'written' : name === 'edit_file' ? 'changed' : 'run'}. Split the work into smaller pieces (shorter files, one file per block) and try again.`;
            ok = false;
          }
          if (ok) {
            let allowed = true;
            if (!settings.autoApprove && (tool.risk === 'write' || tool.risk === 'exec')) {
              send({ type: 'approval', id, name: tool.name, args, reason: tool.risk === 'exec' ? 'Runs code on your PC' : 'Changes files' });
              const ans = await requestApproval(id, signal);
              allowed = !!ans?.allow;
            }
            if (!allowed) { result = 'The user DENIED this action. Do not retry it; choose another approach or ask what they want.'; ok = false; entry.status = 'denied'; }
            else {
              try { result = await tool.run(args, tctx); if (typeof result !== 'string') result = JSON.stringify(result, null, 2); }
              catch (e) { result = 'Error: ' + (e?.message || e); ok = false; }
            }
          }
          if (tool.risk === 'write' || tool.risk === 'exec') didWork = true;
        }

        // loop detection
        const sig = name + JSON.stringify(args).slice(0, 400);
        recent.push(sig); if (recent.length > 8) recent.shift();
        const reps = recent.filter(s => s === sig).length;
        if (reps >= 3 && !ok || reps >= 4) result += `\n[Warning: you have made this exact call ${reps} times. Repeating it will not change the outcome — try a different approach.]`;

        entry.ms = Date.now() - t0;
        if (entry.status !== 'denied') entry.status = ok ? 'done' : 'error';
        entry.output = clip(result, UI_OUTPUT_MAX, 0.5);
        send({ type: 'tool_result', id, ok, output: entry.output, ms: entry.ms });

        const forLlm = clip(result, LLM_OUTPUT_MAX, 0.35);
        if (session.textTools) session.llm.push({ role: 'user', content: `<tool_response name="${tool?.name || name}">\n${forLlm}\n</tool_response>`, _toolResp: true });
        else session.llm.push({ role: 'tool', tool_name: tool?.name || name, content: forLlm });

        if (reps >= 6) { rec.note('error', 'Stopped: the agent was stuck repeating the same action.'); endReason = 'error'; stuck = true; break; }
      }
      if (stuck) break;
      if (phase === 'verifying') phase = 'work'; // the check found something to fix; another check may follow
      saveSession(session);
    }
  } catch (e) {
    if (signal.aborted) endReason = 'stopped';
    else { rec.note('error', 'Unexpected error: ' + (e?.message || e)); endReason = 'error'; }
  } finally {
    // drop image payloads from history so they don't cost context forever
    for (const m of session.llm) if (m.images) { delete m.images; m.content += '\n[an image was attached to this message]'; }
    for (const e of tl) if (e.kind === 'tool' && e.status === 'running') e.status = 'error';
    saveSession(session, true);
  }
  return endReason;
}
