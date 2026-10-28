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
| Center: **Canvas** | Tools sit on it as frames. Select tool (V): drag on empty space = select several (box). Hand tool (H): drag anywhere = pan. Wheel / pinch = zoom, Shift+wheel / Space+drag / middle button = pan, drag the name label = move, drag the right edge = width |
| **Right-click menu** | Send to Claude… (⌘↵) · Zoom to fit · Rename · Save to library… · Copy ID · Duplicate · Agent access · Delete. Right-click empty space = + Note here / + Checklist here |
| Right: **Inspector** | One selected: properties, X/Y/W, access, logs, code. Several selected: bulk actions. None: layers and history |
| Top right: **Terminal button** | Opens this board's terminal window (Ctrl+\`). Shows the Claude mark inside the button when signed in to Claude, and `!` when a permission prompt is waiting |
| Bottom: **Input box** | Sends straight to Claude, with the selected components attached as context |
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

The selected components are attached to the request as `[WorkBoard] … Tools: - "<title>" (<kind>, id: <id>)`.

## Board MCP tools (per board)

`board_catalog` `board_list` `tool_read` `tool_create` `tool_update` `tool_write` `tool_delete`
`board_ask` `board_wait_answer` `board_wait_event`
`app_create` `app_update` `app_snapshot` `app_invoke` `app_logs`
`channel_list` `channel_read` `channel_write` `channel_delete`
`library_list` `library_use` `library_save`

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
sandbox/runtime.tsx  React + board bridge inside the app iframe (useBoardState, useChannel, useTool …)
web/live.ts          Store for the board's channel and tool values, shared by app frames (instant app → app delivery, server sync)
web/main.tsx         App shell: board list, active board, per-board terminal windows
web/Canvas.tsx       React Flow canvas (frames, selection box, right-click, drop)
web/BoardPanel.tsx   Board view: header, menus, dialogs, library, input box
web/TerminalPane.tsx The only file that knows about wterm (the point to swap or fork it)
```

## Data

`data/boards.json` (board list), `data/boards/<id>.json` (per board: tools, history, channels), `data/library.json` (library).
Data from the single-board days (`data/board.json`, `workspace/`) is moved into a "default board" (`main`) on first run.

## Open source used

wterm (Apache-2.0), React Flow `@xyflow/react` (MIT), MCP TypeScript SDK, sucrase, esbuild, node-pty, fast-json-patch.

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
- `data/` and `workspaces/` hold your boards, uploads and session files. They are git-ignored; never commit them.
