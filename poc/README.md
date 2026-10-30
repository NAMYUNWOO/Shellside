# Shellside — PoC

A PoC of a Figma-like canvas board where each board has its own Claude Code session, running in that board's terminal (wterm), that builds, reads and edits tools and apps.
The tool builder is not a separate LLM. It is **the Claude Code session running in each board's terminal (wterm)**.
Internal names still use the working name (`wb` CLI, `workboard` MCP server, `WB_*` environment variables).

## Run

```bash
cd poc
npm install
npm run dev
```

Requires Node.js 22 or newer.

Open <http://127.0.0.1:5173>. The server listens only on `127.0.0.1:4100`.

## Screen

| Area | What it does |
| --- | --- |
| Left: **Work boards** list | Create boards, rename (double-click), delete (right-click). Each board shows its Claude state (idle, working, needs permission), its tool count and whether it is awaiting a reply. Collapse with `«` |
| Center: **Canvas** | Tools sit on it as frames, each with a name (`@note1`, shown on its label). Select tool (V): drag on empty space = select several (box). Hand tool (H): drag anywhere = pan. Link tool (L): drag from one frame to another (or click one, then the other) to link them; right-click a link to set its direction (none, A → B, B → A, both ways) or delete it, or select it and press Delete. Wheel / pinch = zoom (a scroll that starts over a browser page scrolls the page), Shift+wheel / Space+drag / middle button = pan, drag the name label = move, drag the right edge = width (a browser frame: its sides and bottom corners) |
| **Right-click menu** | Send to Claude… (⌘↵) · Zoom to fit · Rename · Save to library… · Copy name · Copy ID · Duplicate · Agent access · Delete. Right-click empty space = + Note here / + Checklist here / + Browser here |
| Right: **Inspector** | One selected: title, name (`@…`, unique on the board; letters of any script, digits, `_ . -`), properties, X/Y/W, access, logs, code. Several selected: bulk actions. None: layers and history |
| Top right: **Terminal button** | Opens this board's terminal window (Ctrl+\`). Shows the Shellside mark (a nautilus shell) inside the button while Claude runs in this board's terminal, and `!` when a permission prompt is waiting |
| Bottom: **Input box** | Sends straight to Claude, with the selected components attached as context. `@` suggests components by name; the ones you name are attached too |
| **Library** | Saved components. Click one or drag it onto the canvas to reuse it |

## Language

The UI is in English by default. Switch with **EN / 한국어** below the board list on the left (the browser remembers it).
Server messages and history meant for people follow the UI language too. What the agent reads (MCP responses, raw history, board rules) is in English.

## Running several boards at once

Once you open a board, it keeps running in the background when you switch to another one (canvas, apps, terminal, Claude session).
When another board has an approval or input request, a permission prompt, a sign-in prompt or a finished task, a notification at the bottom shows **Open**.
Right-click a board in the list → **Open in new window** to see two boards side by side.

## Board = workspace = Claude session

- Each board has a working folder `workspaces/<boardId>/`, one terminal shell and one Claude session.
- Each folder's `.mcp.json` points to its own board's MCP (`/mcp/<boardId>`). Other boards are not visible.
- The server creates `CLAUDE.md` and `AGENTS.md` (board usage rules) and `.claude/settings.json` (MCP approval, hooks for status reporting). It does not overwrite files you have edited.
- Claude's conversation history is also per folder, so `claude --continue` resumes that board's conversation.
- Shared across boards: Claude sign-in, `~/.claude` user settings, the component library.
- Isolation limits: everything runs with your user's permissions on the same machine. Container isolation is a later step.

## Sending to Claude (safety rules)

The board tracks each board's Claude state through Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `Notification`, `PostToolUse`, `Stop`, `StopFailure`, `SessionEnd`).
When you send:

| Claude state | What happens |
| --- | --- |
| Off (shell only) | Starts Claude with `claude $'<request>'` and opens the terminal window (a folder trust prompt may appear) |
| Idle / working | Pastes into Claude's input and presses Enter. If Claude is working, it queues the request |
| Waiting on a permission prompt or dialog / starting | **Does not send.** Enter could be taken as approving a permission. Says why and opens the terminal |

The selected and `@`-named components are attached to the request as `[WorkBoard] … Tools: - @<name> "<title>" (<kind>, id: <id>)`,
followed by the links that touch them (`Links: - @notes → @browser1`).

Notes save themselves: what you type is the note a moment later (and when you click away), so Claude always reads
what is on screen. There is no Edit or Save button.

## Board MCP tools (per board)

`board_catalog` `board_list` `tool_read` `tool_create` `tool_update` `tool_write` `tool_delete`
`board_ask` `board_wait_answer` `board_wait_event`
`app_create` `app_update` `app_snapshot` `app_invoke` `app_logs`
`channel_list` `channel_read` `channel_write` `channel_delete`
`library_list` `library_use` `library_save`
`browser_open` `browser_snapshot` `browser_act` `browser_screenshot` `browser_handoff`
`link_create` `link_update` `link_delete`

- Wherever a tool takes a `toolId`, the tool's name works too (`research` or `@research`). `board_list` returns the
  links (`"reads": "@notes → @browser1"`, direction `none` / `forward` / `both`), `tool_read` a tool's own links, and
  `board_wait_event` tells the agent when the person adds, turns or removes one. The agent can change or remove only
  the links it made.

- Four tool kinds (checklist, form, table, note) + **apps** (React code written by the agent, run in an isolated iframe, with state, events and files only through the `board` bridge).
- The agent can't check checklist items marked `gate: "human"`. Once a human approves through `board_ask`, the board checks them.
- The `wb` CLI offers the same functions from the shell. Every terminal has `WB_BOARD` set (`wb help`).

## Live data between apps

Apps on the same board exchange data with each other in real time, without Claude passing it along. There is no need to merge them into one app.

| Path | App code | What it does |
| --- | --- | --- |
| **Channels** | `const [v, setV] = useChannel("sales", initial)` · `board.channel("sales").get/set/subscribe` | Named shared values within a board. Any app can read, write and watch them. When one app writes, other apps see it immediately (in the same tab, without waiting for the server). JSON, 1 MB per channel, saved with the board |
| **Read other tools** | `useTool(id)` · `useTools()` | Reads the state of tables, checklists, forms, notes and other apps in real time. `useTools()` returns the board's tool list, so you can build UI such as a data source picker |
| **Write other tools** | `await board.writeTool(id, jsonPatch)` | Changes another tool's state with a JSON Patch. App code is written by the agent, so this **counts as an agent write** (read-only settings and approval gates still apply) |

- Tabular data uses one common shape, `{ columns: [{ key, label, type? }], rows: [{ id, ... }] }` (the same as the table tool), so apps built separately connect directly.
- Claude: `channel_list` `channel_read` `channel_write` `channel_delete` (MCP), `wb ch ls|get|set|rm` (CLI). When Claude writes to a channel, apps update immediately.
- People: with nothing selected, the **Channels** tab in the right panel shows each channel's value, the app that last wrote it, and when.
- History: when an app keeps writing to a channel, the writes merge into one history line until Claude reads it.
- The `uses` field of `app_snapshot` lists the channels and tools that app reads.

## Board browser

A **browser** tool is a real Chrome tab on the board (toolbar **+ Browser**, right-click **+ Browser here**, or Claude's
`browser_open`). You and Claude use the same tab: you with mouse and keyboard, Claude with text snapshots and batched steps.

- **Engine.** The server starts one headless Chrome on first use (your installed Google Chrome, Chromium, Edge or Brave,
  or Playwright's Chromium; set `WB_CHROME` to choose). It is driven over the DevTools protocol through a **pipe**, not a
  port, so no other program or website can connect to it. Its profile (cookies, sign-ins) is separate from your own
  Chrome and lives in `data/browser/profile`. Tabs nobody has used for 10 minutes close (the address is kept), and
  Chrome quits when no tab is left. To websites it presents itself as the browser it is (brand, version and platform
  in the user agent and `Sec-CH-UA` headers, a clean language list, your screen's size, and no `navigator.webdriver`
  flag). Sites still decide on their own: a fresh profile without cookies gets more CAPTCHAs, and signing in to
  Google in the board browser usually calms them.
- **You.** The frame shows the page live (screencast frames over `/ws/browser`, rendered at 2× so text stays sharp on
  high-density screens). A view acknowledges each frame it draws and gets the next only then, so a slow screen skips
  frames instead of falling behind. Clicks, scrolling, keys, paste and IME input (Korean, Japanese…) go to the page; IME
  composition happens in the page itself, as in a normal browser. A scroll that starts over the page scrolls it (as far
  as your fingers move, at any board zoom) until the gesture ends, even if the pointer slides off; one that starts on
  the board keeps zooming the board as it passes over a page; a pinch always zooms the board. Headless Chrome draws
  no dropdowns or dialogs, so the board draws them: `<select>` lists, `alert/confirm/prompt`, file pickers (files go
  through the board's upload). Links that open new windows become tabs. The page is as big as its frame: drag the
  frame's left, right or bottom edge or a bottom corner (no need to select it first), or pick a size (Desktop 1280×800,
  Full HD 1920×1080, phone width…) from the page-size button in the address bar. Frames go up to 2400 px wide.
- **Claude.** `browser_snapshot` turns the page into compact text where everything actionable gets a ref:
  `[@5 textbox "Email" placeholder="you@example.com"]`, `[@10 button "Send"]`. `browser_act` runs a list of steps in one
  call (`goto`, `click`, `fill`, `select`, `check`, `press`, `waitFor`, `eval`, `upload`, `dialog`, tabs…) and returns what
  each did plus a fresh snapshot, in the spirit of [ego-lite](https://github.com/citrolabs/ego-lite): fewer round trips
  than one tool call per click. Targets are `@N`, `css:<selector>` or `text:<visible text>`. The snapshot is built by a
  script in an isolated world, so page scripts can't see or tamper with it; password values are never included.
- **Taking turns.** **Take over** gives you the browser: Claude's browser calls are refused until you **hand it back**.
  For sign-ins, CAPTCHAs or payments Claude calls `browser_handoff`, which does the same from Claude's side and waits for
  you. While Claude acts, the frame shows a banner and a marker on what it clicks; every batch lands in History.
- **Files.** Downloads go to the board workspace's `downloads/`; Claude can upload only files inside the workspace.
- **Apps.** An app can read a browser like any tool (`useTool(id).state` → `url`, `title`) and open an address with
  `board.writeTool(id, [{ op: "replace", path: "/url", value }])`.
- CLI: `wb br open|snap|act|click|fill|press|select|eval|shot|handoff` (`wb help`).
- Settings: `WB_CHROME` (which browser), `WB_BROWSER_SCALE` (pixel density, default 2), `WB_DEBUG_BROWSER=1` (log the person's input on the server).

## Examples

[`examples/`](examples) holds the demo boards from the top-level README:

```bash
npm run dev                        # in one terminal
node examples/seed-demo.mjs        # in another: adds four demo boards (Release v2.3, Sales analysis, DB migration, Backfill)
```

The script calls the same HTTP API the `wb` CLI uses, acting the way Claude does from a board terminal. The apps in
[`examples/apps/`](examples/apps) show channels in practice: `sales-data.jsx` writes the `sales` channel, and
`scatter-plot.jsx` and `region-summary.jsx` read it; clicking a row or a point writes `selection`, which all three highlight.

## Structure

```
server/index.ts      HTTP, WebSocket and MCP routing, origin checks, Send to Claude
server/boards.ts     Board list, per-board runtime (board data + shell + browser tabs + Claude state)
server/board.ts      Board data: tools, approval requests, events, JSON Patch, approval gates, frame placement
server/library.ts    Component library (shared by all boards)
server/agent.ts      Claude sign-in check, hook → state, composing the request text
server/apps.ts       App compilation (sucrase), sandbox runtime build (esbuild)
server/mcp.ts        Board MCP (per board, stateless Streamable HTTP)
server/pty.ts        Shell sessions (node-pty), output replay on reconnect, foreground process
server/workspace.ts  Working folder setup (.mcp.json, CLAUDE.md, settings + hooks)
server/cdp.ts        Finds and starts the one headless Chrome; DevTools protocol over a pipe
server/browser.ts    Board browsers: tabs, screencast to the board, the person's input, the agent's snapshot/act/handoff
server/browser-inpage.js  Runs in each page (isolated world): page → text with @refs, finding and preparing elements
sandbox/runtime.tsx  React + board bridge inside the app iframe (useBoardState, useChannel, useTool …)
web/live.ts          Store for the board's channel and tool values, shared by app frames (instant app → app delivery, server sync)
web/main.tsx         App shell: board list, active board, per-board terminal windows
web/Canvas.tsx       React Flow canvas (frames, selection box, right-click, drop)
web/BoardPanel.tsx   Board view: header, menus, dialogs, library, input box
web/BrowserView.tsx  A browser frame: live page, address bar, tabs, take over, dropdown/dialog/file overlays
web/TerminalPane.tsx The only file that knows about wterm (the point to swap or fork it)
```

## Data

`data/boards.json` (board list), `data/boards/<id>.json` (per board: tools, history, channels), `data/library.json` (library),
`data/browser/` (the board browser's Chrome profile: cookies and sign-ins).
Data from the single-board days (`data/board.json`, `workspace/`) is moved into a "default board" (`main`) on first run.

## Open source used

| Package | License | Used for |
| --- | --- | --- |
| wterm (`@wterm/core`, `@wterm/dom`, `@wterm/react`) | Apache-2.0 | The board terminal |
| React Flow (`@xyflow/react`) | MIT | The canvas |
| React, ReactDOM | MIT | The board UI and the app sandbox runtime |
| MCP TypeScript SDK (`@modelcontextprotocol/sdk`) | MIT | The agent's workboard tools |
| sucrase | MIT | Compiling the apps the agent writes |
| esbuild | MIT | Bundling the app sandbox runtime |
| node-pty | MIT | The terminal process |
| ws | MIT | WebSockets (terminal, live board, board browser) |
| zod | MIT | Checking tool input |
| fast-json-patch | MIT | State patches |

- **Full list:** `npm run build` writes `dist/third-party-licenses.md`. It lists every package bundled into the board UI with its license text, including the ones that come in through React Flow: d3 modules (ISC; d3-ease BSD-3-Clause) and zustand (MIT). The server serves it at `/third-party-licenses.md`, and the boards panel links to it ("Open source licenses"). The app sandbox runtime keeps React's own license headers.
- **Not bundled:** the board browser drives the Chrome installed on the machine. Its design follows [ego-lite](https://github.com/citrolabs/ego-lite) (MIT), but no code was copied from it.
- **Build tools only** (TypeScript, Vite and its lightningcss under MPL-2.0, tsx, concurrently): not shipped.
- **This project:** [MIT](../LICENSE).

## wterm modification candidates

| Need | Current approach | Why it needs a modification |
| --- | --- | --- |
| Show widgets such as approval cards inside terminal output | Shown only on the board | The `@wterm/dom` renderer would have to insert React nodes between rows |
| Group output by command (OSC 133) | Not implemented | Not supported by the default core; needs the Ghostty core |
| Resume without flicker on reconnect | `ESC c`, then resend the last 512 KB | Sequence-number-based replay (as in wterm `examples/local`) |

## Security notes

- The server binds only to `127.0.0.1` and checks the `Host` and `Origin` headers, and refuses requests the browser marks as cross-site (`Sec-Fetch-Site`), so other websites and DNS rebinding can't reach it.
- Each board's terminal is a real shell with your user's permissions, and Claude runs in it. There is no container isolation yet. Don't expose the port (no port forwarding, no tunnels), and only run agents you trust.
- App code runs in a sandboxed iframe (opaque origin, a CSP that allows no network access) and talks to the board only through `postMessage`.
- When app code writes to other tools, those writes count as the agent's writes, so read-only settings and human approval gates still apply.
- The board UI refuses to be framed by other sites (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), so no page can overlay it to trick a click onto an approval or into the terminal.
- The board browser's Chrome is reached only through a pipe (no debugging port). It opens only `http(s)`, `file` and `about:blank` addresses. Its profile (`data/browser/profile`) holds whatever you sign in to there, readable by your user account, and Claude can use those sessions while it drives the browser: sign in only where you'd let Claude act. Take over when you type secrets; Claude can't read or act until you hand it back.
- Web page text reaches Claude as data, marked as such in every snapshot; the board rules tell it never to follow instructions found on a page.
- `data/` and `workspaces/` hold your boards, uploads, downloads, browser profile and session files. They are git-ignored; never commit them.
