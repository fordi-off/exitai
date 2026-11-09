// Streaming parser for "code blocks" the model writes straight into its reply:
//
//   <write_file path="C:\proj\app.py">
//   ...file content...
//   </write_file>
//
//   <run_code language="python">
//   ...code...
//   </run_code>
//
// Ollama only returns native tool calls after the whole call has been generated, so a long file would appear
// all at once at the end. Text streams token by token, so by taking these two "tools" out of the native tool
// protocol the user can watch the code being written live. When a block closes it is executed like any tool call.

const NAMES = ['write_file', 'run_code', 'edit_file'];
const OPEN_FULL = /<(write_file|run_code|edit_file)\b([^>]*)>/;
// Models trained on other tool formats (Qwen3-Coder's <function=..><parameter=..>) sometimes add their own closing tags
// around a block. They are never part of the file, so strip them at the end of a body and right after a block.
const JUNK = ['</parameter>', '</function>', '</tool_call>', '</arg_value>'];
const JUNK_TAIL = /(?:<\/(?:parameter|function|tool_call|arg_value)>\s*)+$/;
const JUNK_HEAD = /^\s*(?:<\/(?:parameter|function|tool_call|arg_value)>\s*)+/;
const isJunkPrefix = (s) => JUNK.some(j => j.startsWith(s));
const PENDING_TAIL = /(?:<\/(?:parameter|function|tool_call|arg_value)>\s*)*(?:<\/?[a-z_]*)?$/;

/** Strip trailing stray closers, but only UNBALANCED ones, so real XML/HTML ending in </function> etc. survives. */
function stripJunkTail(whole) {
  for (;;) {
    const m = /<\/(parameter|function|tool_call|arg_value)>\s*$/.exec(whole);
    if (!m) return whole;
    const tag = m[1];
    const opens = (whole.match(new RegExp('<' + tag + '[\\s>=]', 'g')) || []).length;
    const closes = (whole.match(new RegExp('</' + tag + '>', 'g')) || []).length;
    if (closes <= opens) return whole;
    whole = whole.slice(0, m.index);
  }
}

function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}

/** Could `s` (which starts with "<") still turn into an opening tag once more text arrives? */
function maybeOpenPrefix(s) {
  if (s.length > 600) return false;
  if (NAMES.some(n => ('<' + n).startsWith(s))) return true;
  return /^<(write_file|run_code|edit_file)\b[^>]*$/.test(s);
}

/**
 * Parse SEARCH/REPLACE pairs:
 *   <<<<<<< SEARCH
 *   exact existing text
 *   =======
 *   replacement
 *   >>>>>>> REPLACE
 * Tolerant about marker length/spacing and about the SEARCH/REPLACE words.
 */
export function parseEdits(body) {
  const edits = [];
  const re = /^[ \t]*<{5,9}[ \t]*(?:SEARCH)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*={5,9}[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*>{5,9}[ \t]*(?:REPLACE)?[ \t]*$/gim;
  let m;
  while ((m = re.exec(body))) edits.push({ old: m[1], new: m[2] });
  return edits;
}

export class BlockStreamer {
  /**
   * onText(delta)            normal assistant text outside blocks
   * onStart({name, attrs})   a block opened; must return an id
   * onDelta(id, delta)       more of the block body
   * onEnd(id, {content, closed})  block finished (closed=false: the model was cut off before the closing tag)
   */
  constructor({ onText, onStart, onDelta, onEnd }) {
    this.onText = onText; this.onStart = onStart; this.onDelta = onDelta; this.onEnd = onEnd;
    this.buf = '';
    this.cur = null;
    this.blocks = [];   // finished blocks in order: { id, name, attrs, content, closed }
    this.plain = '';    // all text outside blocks
  }

  _text(t) {
    if (this.stripJunk && t) { // right after a block: drop stray closing tags of other tool formats
      t = t.replace(JUNK_HEAD, '');
      if (!t.trim()) return;
      this.stripJunk = false;
    }
    if (t) { this.plain += t; this.onText(t); }
  }

  _emit(t) { // body text -> UI, handling the optional leading ```lang fence and trailing newlines
    const c = this.cur;
    c.raw += t;
    if (c.lead) { // still deciding whether the body starts with a markdown fence
      c.leadBuf += t;
      const trimmed = c.leadBuf.replace(/^\s+/, '');
      if (trimmed.length < 3 && /^`*$/.test(trimmed)) return;      // too early to tell
      if (trimmed.startsWith('```')) {
        const nl = trimmed.indexOf('\n');
        if (nl < 0) return;                                          // fence line not complete yet
        c.fenced = true; c.lead = false;
        t = trimmed.slice(nl + 1); c.leadBuf = '';
      } else { c.lead = false; t = c.leadBuf.replace(/^\r?\n/, ''); c.leadBuf = ''; }
    }
    t = c.pendingNL + t; c.pendingNL = '';
    const m = t.match(/(\r?\n)+$/);                                   // hold trailing newlines: the last one belongs to the closing tag
    if (m) { c.pendingNL = m[0]; t = t.slice(0, -m[0].length); }
    if (t) { c.shown += t; this.onDelta(c.id, t); }
  }

  push(d) {
    this.buf += d;
    for (;;) {
      if (!this.cur) {
        const m = OPEN_FULL.exec(this.buf);
        if (m) {
          this._text(this.buf.slice(0, m.index));
          this.buf = this.buf.slice(m.index + m[0].length);
          const attrs = parseAttrs(m[2]);
          const id = this.onStart({ name: m[1], attrs });
          this.cur = { id, name: m[1], attrs, raw: '', shown: '', lead: true, leadBuf: '', fenced: false, pendingNL: '' };
          continue;
        }
        const lt = this.buf.lastIndexOf('<');
        const tail = lt >= 0 ? this.buf.slice(lt) : '';
        if (lt >= 0 && (maybeOpenPrefix(tail) || (this.stripJunk && isJunkPrefix(tail)))) { this._text(this.buf.slice(0, lt)); this.buf = this.buf.slice(lt); }
        else { this._text(this.buf); this.buf = ''; }
        return;
      }
      const close = `</${this.cur.name}>`;
      const i = this.buf.indexOf(close);
      if (i >= 0) {
        const whole = this.cur.raw + this.buf.slice(0, i);
        this._emit(stripJunkTail(whole).slice(this.cur.raw.length));
        this.buf = this.buf.slice(i + close.length);
        this._finish(true);
        continue;
      }
      // hold back a possibly-incomplete closing tag, and any complete stray closers at the very end (they may be junk)
      // Hold back the tail that might still become the closing tag or stray closers: any run of complete stray closers
      // followed by an optional partial tag. Over-holding is harmless (it is released with the next chunk).
      const tm = PENDING_TAIL.exec(this.buf);
      const hold = tm ? this.buf.length - tm.index : 0;
      this._emit(this.buf.slice(0, this.buf.length - hold));
      this.buf = this.buf.slice(this.buf.length - hold);
      return;
    }
  }

  _finish(closed) {
    const c = this.cur;
    let content = c.raw;
    if (c.fenced) content = content.replace(/^\s*```[^\n]*\n/, '').replace(/\n?```\s*$/, '');
    else content = content.replace(/^\r?\n/, '');
    content = stripJunkTail(content).replace(/(\r?\n)$/, '');   // stray closers and the newline before the closing tag are not part of the file
    const block = { id: c.id, name: c.name, attrs: c.attrs, content, closed };
    this.blocks.push(block);
    this.cur = null;
    this.stripJunk = true;
    this.onEnd(c.id, block);
  }

  /**
   * `completed`: the model finished its turn on its own (not stopped by the output limit). A block that is still open
   * then simply lacked a closing tag (e.g. Qwen3-Coder closes with </parameter></function> instead) and counts as complete.
   */
  end(completed = false) {
    if (this.cur) {
      if (this.buf) { const whole = this.cur.raw + this.buf; this._emit(stripJunkTail(whole).slice(this.cur.raw.length)); this.buf = ''; }
      this._finish(completed);
    } else if (this.buf) { this._text(this.buf); this.buf = ''; }
  }
}

/** Convert a finished block to the arguments of the matching tool. */
export function blockToCall(b) {
  if (b.name === 'write_file') {
    const content = b.content.endsWith('\n') || b.content === '' ? b.content : b.content + '\n';
    return { name: 'write_file', arguments: { path: b.attrs.path || b.attrs.file || b.attrs.name || '', content } };
  }
  if (b.name === 'edit_file') {
    return { name: 'edit_file', arguments: { path: b.attrs.path || b.attrs.file || b.attrs.name || '', edits: parseEdits(b.content), patch: b.content } };
  }
  const args = { language: b.attrs.language || b.attrs.lang || 'python', code: b.content };
  if (b.attrs.save_as) args.save_as = b.attrs.save_as;
  if (b.attrs.cwd) args.cwd = b.attrs.cwd;
  if (b.attrs.timeout_sec) args.timeout_sec = Number(b.attrs.timeout_sec);
  return { name: 'run_code', arguments: args };
}
