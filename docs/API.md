# ExitAI — HTTP/SSE contract (UI <-> server)

Server: `http://127.0.0.1:7777` (Node, zero deps). UI is static files in `ui/` served at `/`
(`index.html`, `app.js`, `style.css`). **No frameworks, no build step, no CDN** — vanilla JS/CSS only.

## Auth
The server prints/launches the UI as `http://127.0.0.1:7777/#t=<TOKEN>`. The UI must read the token
from `location.hash`, persist it in `localStorage` (`exitai_token`), strip it from the URL
(`history.replaceState`), and send it on every API call as header `x-exitai-token: <TOKEN>`.
EventSource can't set headers, so the SSE URL uses `?t=<TOKEN>`. Static files need no token.
If any API call returns 401, show a "Token missing — relaunch via start.cmd" screen.

All bodies are JSON. All responses JSON unless noted.

## GET /api/state
```json
{
  "models": [{"id":"huihui_ai/qwen3-abliterated:30b","label":"Qwen3 30B-A3B (abliterated)","desc":"...",
              "sizeGB":17.3,"vision":false,"think":"bool|levels|none","installed":true,"recommended":true}],
  "settings": {"model":"...","mode":"deep|fast","think":"off|low|medium|high","autoApprove":true,
               "workspace":"C:\\Users\\fordi","numCtx":32768,"maxSteps":60},
  "sessions": [{"id":"s_ab12","title":"...","updated":1700000000000,"model":"..."}],
  "gpu": {"name":"RTX 5060 Ti","usedMB":9000,"totalMB":16311},
  "ollama": {"up":true,"version":"0.30.6","loaded":[{"name":"...","sizeGB":18.1,"vramGB":14.2,"until":"..."}]},
  "pull": {"active":false,"model":"","percent":0,"text":""}
}
```
`GET /api/state` is cheap; the UI polls it every 4 s for the gpu/ollama/pull indicators.

## POST /api/settings
Body: any subset of `settings` fields. Returns full `settings`.

## Sessions
- `POST /api/sessions` → `{"id":"s_xxxx"}` (creates empty session using current settings.model)
- `GET /api/sessions/:id` → `{"id","title","model","timeline":[...],"plan":[...],"usage":{...},"running":false}`
- `DELETE /api/sessions/:id` → `{"ok":true}`
- `POST /api/sessions/:id/rename` `{"title":"..."}`

### timeline entries (also what live events build up)
```
{"kind":"user","text":"...","images":["<dataurl>"]?}
{"kind":"thinking","text":"..."}                       // model reasoning, render collapsed
{"kind":"assistant","text":"..."}                      // markdown
{"kind":"tool","id":"t_1","name":"run_command","args":{...},"status":"running|done|error|denied",
 "output":"... (already truncated to ~4000 chars)","ms":123}
{"kind":"note","level":"info|warn|error","text":"..."}   // compaction notices, errors
```
`plan` = `[{"text":"...","status":"pending|in_progress|done"}]`.
`usage` = `{"promptTokens":1234,"genTokens":56,"tps":28.4,"ctxUsed":9000,"ctxMax":32768}`.

## POST /api/chat
Body `{"sessionId":"s_x","text":"...","images":["data:image/png;base64,..."]?}` → `{"ok":true}` immediately;
output arrives via SSE. Returns `409` if the session is already running.

## POST /api/stop   `{"sessionId":"s_x"}` → `{"ok":true}`
## POST /api/approve `{"id":"a_1","allow":true,"always":false}` → `{"ok":true}`
(`always:true` flips `settings.autoApprove` on.)
## POST /api/models/pull `{"model":"name:tag"}` → `{"ok":true}` (progress via `state.pull`)

## GET /api/events?t=TOKEN  (Server-Sent Events, one global stream)
Each message: `data: {json}\n\n`. Every event has `type` and (usually) `sessionId`. The UI should ignore
events for sessions it isn't showing, but still update the sidebar. Auto-reconnect (EventSource does).

| type | fields | meaning |
|---|---|---|
| `run_start` | sessionId | agent run began (disable send, show Stop) |
| `thinking` | sessionId, delta | append to current thinking entry (create if last entry isn't thinking) |
| `text` | sessionId, delta | append to current assistant entry (create if last entry isn't assistant) |
| `tool_call` | sessionId, id, name, args | new tool entry, status `running` |
| `tool_result` | sessionId, id, ok, output, ms | finish tool entry (status `done`/`error`) |
| `approval` | sessionId, id, name, args, reason | show Allow / Always / Deny; answer via /api/approve; tool entry status stays `running` until result |
| `plan` | sessionId, items | replace plan panel |
| `usage` | sessionId, promptTokens, genTokens, tps, ctxUsed, ctxMax | update context meter + tok/s |
| `tool_call` (streaming) | sessionId, id, name (`write_file`\|`run_code`), args (body empty so far), **streaming:true** | v3: the model is writing a file/script live. Create the tool card now, status `running`, and show a live code view |
| `tool_call` (streaming, `edit_file`) | sessionId, id, name `edit_file`, args `{path, patch:''}`, streaming:true | v5: the model is editing an existing file. `tool_stream` deltas append to **`args.patch`**, raw text in SEARCH/REPLACE format: `<<<<<<< SEARCH\n…old lines…\n=======\n…new lines…\n>>>>>>> REPLACE` (one or more pairs). `tool_stream_end` then gives final `args` = `{path, edits:[{old,new}], patch}` |
| `tool_stream` | sessionId, id, delta | v3: append `delta` to the code body — `args.content` for `write_file`, `args.code` for `run_code`. Fires many times per second |
| `tool_stream_end` | sessionId, id, args, closed | v3: the block finished (`closed:false` = the model was cut off; the tool will report an error). `args` holds the final arguments. Stop the typing cursor; the normal `tool_result` follows once the tool has run |
| `note` | sessionId, level, text | add note entry |
| `title` | sessionId, title | session got auto-titled |
| `browser` | url, title, consoleCount, errorCount, networkCount, open | browser panel badge updates |
| `run_end` | sessionId, reason (`done|stopped|error|max_steps`) | re-enable send |

## Browser panel endpoints
- `GET /api/browser` → `{"open":true,"url":"","title":"","console":[{"t":123,"level":"error|warn|log|info|exception","text":"...","src":"url:line"}],"network":[{"t":123,"method":"GET","url":"","status":200,"type":"xhr","ms":50,"failed":false}],"tree":"indented DOM outline text"}`
- `GET /api/browser/screenshot` → `image/png` (404 if closed). Add `?t=<cache-bust>` client-side; token via `?t=` isn't
  usable here (it's cache-bust) — so this endpoint accepts the token as `?k=TOKEN`.

## Files (v2) — all paths are absolute or relative to the workspace; no sandbox (full PC access)
- `GET /api/fs/list?path=<dir>` → `{"path":"C:\\Users\\fordi","parent":"C:\\Users"|null,"entries":[{"name","dir":true|false,"size":123,"mtime":1700000000000}],"truncated":false}`.
  Folders first, then files, each alphabetical. **Empty `path` lists the drives** (`{"path":"","parent":null,"entries":[{"name":"C:\\","dir":true},…]}`).
  Errors: 400 `{error}`.
- `GET /api/fs/read?path=<file>` → `{"path","name","kind":"text|image|binary","size","mtime","content":"…"?,"truncated":bool?}`.
  `content` only for `kind:"text"` (first 300 KB). Errors: 400/404 `{error}`.
- `GET /api/fs/raw?path=<file>&k=TOKEN` → the raw bytes with a proper Content-Type (use as `<img src>` for images, or as a download link
  with `&dl=1`). Token goes in `k`, not a header.
- `POST /api/fs/write` `{"path","content"}` → `{"ok":true,"size":n}` (creates parent folders; overwrites).
- `POST /api/fs/mkdir` `{"path"}` · `POST /api/fs/rename` `{"path","to"}` · `POST /api/fs/delete` `{"path"}` (goes to the Recycle Bin)
  · `POST /api/fs/reveal` `{"path"}` (opens Windows Explorer with the item selected) → each `{"ok":true}` or 400 `{error}`.
- `POST /api/upload` `{"name":"photo.png","data":"data:image/png;base64,…","dir":"optional target folder"}` → `{"path":"C:\\…\\file"}`.
  Without `dir` the file is saved in the app's uploads folder. Max ~50 MB. Name collisions get a numeric suffix.
- `POST /api/open-folder` `{"path":"..."}` sets the workspace (same as `POST /api/settings {workspace}`).

### Attachments on chat (v2)
`POST /api/chat` accepts an extra field `attachments: [{"type":"folder"|"file","path":"C:\\…"}]` (max 20).
The server tells the model about them (folder → listing + full-access note; file → path), and if a **folder** is attached it becomes the
workspace (`settings.workspace` changes; the next `/api/state` shows it). The user timeline entry then contains the same
`"attachments":[{type,path}]` so the bubble can show chips.
