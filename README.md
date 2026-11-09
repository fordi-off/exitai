# ExitAI

Lightweight local AI agent for Windows. Zero npm dependencies: a small Node server, a vanilla-JS UI in a
chromeless Chrome window, and Ollama running the model.

## Launch
- Double-click `ExitAI.vbs` (silent) or `start.cmd` (with console). Closing the window shuts everything down
  and unloads the model.
- ExitAI starts its **own** tuned Ollama on port 11500 (flash attention, q8 KV cache, 1 slot). Your normal
  Ollama is untouched. Set `EXITAI_OLLAMA=http://127.0.0.1:11434` to use an existing one instead.

## What the agent can do (27 tools)
- **Shell and code**: PowerShell / cmd / bash, background processes (`run_command`, `process`), and `run_code` to
  write and run Python / Node / PowerShell / cmd / bash snippets (with real tracebacks; `save_as` keeps the script)
- **Files**: read, write, exact-edit, tree, regex/glob search, move/copy/delete (delete goes to the Recycle Bin)
- **Web**: `web_search` (Bing, DuckDuckGo fallback), `web_fetch`
- **Browser**: a real Chrome window with its own persistent profile.
  - *See*: `browser_snapshot` (compact page view with clickable refs), `browser_dom` (full DOM tree),
    `browser_console` (logs, exceptions with stacks, CORS/CSP errors), `browser_network` (with response bodies),
    `browser_screenshot` (page or one element), and **`browser_inspect`**: styles + matching CSS rules, box/covering
    element, attributes and validity, event listeners, accessibility tree, cookies, storage, headers, performance
    (LCP/CLS, slowest/largest requests), forms, links, meta, scripts/framework detection, frames, raw source.
  - *Act like a person* (`browser_act`): click, double-click, right-click, hover, modifiers, drag (sliders, canvas,
    HTML5 drag-and-drop), mouse-wheel scroll, fast `type`, real per-key `type_keys`, real clipboard `paste`,
    key combos, select, file upload, tabs, waits.
  - *Change the page*: `browser_eval` (DevTools-console style JS, or a local file), `browser_inject` (JS/CSS that also
    re-runs on every reload), `browser_intercept` (block / mock / delay / modify requests), `browser_emulate`
    (mobile, dark mode, slow network, geolocation, timezone, CPU throttle).
- **Vision**: `vision`, `screen` (whole desktop), and screenshot questions, answered by the vision model
- **Planning and memory**: `update_plan`, persistent `memory`

## Models (top-bar selector)
| Model | Use |
|---|---|
| Qwen3 30B-A3B abliterated | smartest all-rounder, thinking on/off |
| Qwen3-Coder 30B-A3B abliterated | coding and long tool chains |
| gpt-oss 20B abliterated | fits fully in 16 GB VRAM, fastest deep reasoner |
| Qwen3-VL 8B abliterated | looks at screenshots/images |

Close games before using the 30B models: 18 GB of weights need the whole 16 GB GPU plus RAM.

## Modes and context
- **Max**: thinking forced on at the highest level, output budget up to 75% of the context window (so it can think
  for tens of thousands of tokens), up to 150 steps, a prompt that demands alternatives and two independent checks,
  and up to 3 silent self-check rounds. Slowest, smartest. Pair it with a bigger **Ctx** (64k) for long tasks.
- **Deep**: thinking on, up to 60 steps, silent self-check after real work.
- **Fast**: thinking off, short answers.
- **Ctx** (top bar): context window, 16k to 128k. Bigger remembers more but uses more VRAM, so the 30B models slow
  down because more layers spill to the CPU. 32k is the sweet spot on 16 GB; try 64k for Max.
- **Auto-approve** switch: off means Allow / Deny prompts before commands and file writes.

## Settings (`data/settings.json`)
`numCtx` (default 32768; raise for longer tasks, costs VRAM), `maxSteps`, `workspace`, `headless` (hide the agent browser).
Long chats are compacted automatically (old tool output is clipped, then summarised) at about 70% of the context.

## Security
The server binds to 127.0.0.1 only, checks Host/Origin, and every API call needs the token in
`data/token.txt`, so websites in your browsers cannot drive it. The agent itself has full access to this PC.

Contract between UI and server: `docs/API.md`.
