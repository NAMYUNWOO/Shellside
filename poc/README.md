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

Requires Node.js 22 or newer. Works on macOS, Linux and Windows (PowerShell; see [Windows](#windows)).

Open <http://127.0.0.1:5173>. The server listens only on `127.0.0.1:4100`. Without Vite: `npm run build`, then
`npm start`, and open <http://127.0.0.1:4100>. Or use the [desktop app](#desktop-app).

## Windows

The server, Vite, Chrome and Claude Code all run as Windows programs; WSL is not needed (it still works, see
[Board browser](#board-browser)).

- **Install:** Node.js 22+ for Windows, [Claude Code](https://code.claude.com/docs/en/setup) (the native installer gives
  `claude.exe`; an npm install's `claude.cmd` works too), and Chrome or Edge. Git for Windows is optional: Claude Code
  uses Git Bash for its shell tool when it is there, PowerShell otherwise. `npm install` needs no compiler (node-pty
  ships Windows binaries).
- **Board terminal:** Windows PowerShell 5.1; set `WB_SHELL=pwsh.exe` for PowerShell 7. It loads your profile, then the
  board's setup, passed as command text (`-EncodedCommand`): an execution policy that blocks scripts can block your
  profile but not that. The setup sets UTF-8, puts `wb` on `Path`, wraps `claude` with the board's MCP config,
  settings and rules (the rules go in by file, `--append-system-prompt-file`), and records what runs in the
  foreground, which node-pty can't tell on Windows: the first word of each line you enter, `claude` while the wrapper
  runs it, and `powershell` at each prompt. So the board reports what you typed: a program started from a script, or
  `& claude.exe …` typed by hand, shows under the name you typed.
- **Sending to Claude:** PowerShell 5.1 mangles double quotes inside arguments to programs, so a request that starts
  Claude starts it bare and pastes the request once Claude Code's `SessionStart` hook says it is ready.
- **`wb`:** `bin/wb.cmd` (PowerShell and cmd) and `bin/wb` (Git Bash). In PowerShell 5.1, JSON arguments lose their
  double quotes on the way to `wb` (the same quoting bug), so pass JSON from a file or stdin (`-`) there.
- Organization-managed PCs: Chrome policies apply to the board browser's profile, including extensions they install.
  If the organization sets `allowedHttpHookUrls` or only allows managed hooks, the board can't see Claude's state.

## Desktop app

`poc/desktop/` wraps the server and the board UI into an app (Electron) for macOS and Windows. Opening it starts the
server and shows the board in the app's window; quitting stops the server, its terminals and Claude in them (the app
asks first when Claude is running). Download it from
[Releases](https://github.com/NAMYUNWOO/Shellside/releases/latest).

- **Where things are:** board folders in `~/Shellside/<boardId>` (`%USERPROFILE%\Shellside` on Windows); boards,
  sign-ins of the board browser and paired browsers in the app's data folder
  (`~/Library/Application Support/Shellside/data`, `%APPDATA%\Shellside\data`); the server log in
  `~/Library/Logs/Shellside/server.log` (`%APPDATA%\Shellside\logs`). **File** → **Show Board Folders** / **Show Logs**
  opens them. The app keeps its own boards: it doesn't share `poc/data` with `npm run dev`.
- **Port:** the first free one from 4110 (4100 stays free for `npm run dev`). **File** → **Open in Browser** opens the
  board in your browser; that browser asks to pair, and the app shows the code in a dialog.
- **Environment:** opened from the Dock or Finder, a macOS app gets none of your shell profile's settings, so the app
  asks your login shell for its environment (PATH, proxies, tokens), as VS Code does. If the profile takes longer than
  6 s, it uses `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin` instead. macOS may ask whether Shellside may
  access a folder your profile or Claude reads, as it does for any terminal app.
- **The `wb` CLI** in its terminals runs on the app's own runtime (`WB_NODE`); no separate Node.js is needed.
- **Signing:** see [Code signing](#code-signing). A build without signatures (macOS: ad-hoc only, not notarized;
  Windows: unsigned) shows a warning on first open (see the [Quick start](../README.md#desktop-app-macos-windows)). On
  macOS you can instead clear the download flag: `xattr -dr com.apple.quarantine /Applications/Shellside.app`.
- **Build it:** on the system you build for,

  ```bash
  cd poc && npm install
  cd desktop && npm install
  npm run dist      # release/: .dmg and .zip (macOS, arm64 and x64), installer and .zip (Windows)
  npm start         # or run it without packaging
  ```

  `build.mjs` stages the UI, the app sandbox runtime, the server bundled into one file (with its third-party notices,
  `server/third-party-licenses.md`), the `wb` CLI and node-pty's prebuilt binaries; electron-builder
  (`electron-builder.config.cjs`) packages them. CI (`.github/workflows/desktop.yml`) builds both on every push, runs
  each build once (`SHELLSIDE_SMOKE`), and a `v*` tag puts the builds on a draft release.

### Code signing

The policy is in the [README](../README.md#code-signing-policy). Without the credentials below, builds come out
unsigned and everything else works the same.

**macOS** (Developer ID + notarization; needs the paid Apple Developer Program, and the Account Holder makes the
certificate):

1. Xcode → Settings → Accounts → your team → **Manage Certificates…** → **+** → **Developer ID Application**.
   With it in the login keychain, `npm run dist` on that Mac signs with it (`SHELLSIDE_SIGN=0` skips signing).
2. App Store Connect → Users and Access → Integrations → **Team Keys** → **+** (access: Developer). Download the
   `AuthKey_<id>.p8` (only once) and note the key ID and the issuer ID. Locally, notarization runs when
   `APPLE_API_KEY` (path of the .p8), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are set; the app and the .dmg files
   are notarized and stapled (`notarize-dmg.cjs`). Certificates from the first Developer ID CA end on 1 February 2027;
   make a "G2 Sub-CA" one before then.
3. For CI, export the certificate from Keychain Access (My Certificates → Developer ID Application → Export, with a
   password) and add the repository secrets:

   ```bash
   base64 -i DeveloperID.p12 | gh secret set MAC_CERT_P12
   gh secret set MAC_CERT_PASSWORD             # the export password
   gh secret set APPLE_API_KEY_P8 < AuthKey_<id>.p8
   gh secret set APPLE_API_KEY_ID --body <key id>
   gh secret set APPLE_API_ISSUER --body <issuer id>
   ```

**Windows** (SignPath Foundation, free for open source; every release signing request is approved by hand):

1. Apply at [signpath.org/apply](https://signpath.org/apply). The project must already be released, and the README's
   code signing policy must be in place.
2. Once accepted, in SignPath: add the GitHub.com trusted build system, a project with the slug `shellside`, the
   artifact configurations `app` and `installer` from [`desktop/signpath/`](desktop/signpath), and a signing policy
   (`release-signing`, or set `SIGNPATH_POLICY_SLUG`). Make an API token for a CI user who may submit requests.
3. Add to the repository:

   ```bash
   gh variable set SIGNPATH_ORGANIZATION_ID --body <organization id>
   gh secret set SIGNPATH_API_TOKEN
   ```

   From then on, a `v*` tag builds the app unpacked, has SignPath sign `Shellside.exe`, builds the installer and the
   .zip from the signed app, has the installer signed, and puts those on the draft release. Branch builds stay unsigned.

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

The board tracks each board's Claude state through Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `Notification`, `PostToolUse`, `Stop`, `StopFailure`, `SessionEnd`). They are HTTP hooks (Claude Code 2.1.63 or later): Claude Code posts each event to the board's server itself, so nothing runs in a shell per hook.
When you send:

| Claude state | What happens |
| --- | --- |
| Off (shell only) | Starts Claude with `claude $'<request>'` and opens the terminal window (a folder trust prompt may appear). PowerShell: starts `claude`, then pastes the request once Claude is ready |
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
`browser_open` `browser_snapshot` `browser_act` `browser_screenshot` `browser_network` `browser_network_body` `browser_handoff`
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
  or Playwright's Chromium from `npx playwright install chromium`; set `WB_CHROME` to choose). It is driven over the
  DevTools protocol through a **pipe**, not a port, so no other program or website can connect to it. The pipe is also
  why **WSL** needs a Linux browser inside WSL: WSL doesn't pass the pipe's file descriptors to a Windows `.exe`, so
  Windows Chrome can't be used. Run `npx playwright install chromium` in WSL. If that Chrome then fails to start for
  missing libraries, run `npx playwright install-deps chromium`. The server says at start when it finds no browser, and
  an install needs no restart (**Try again** in the frame). Its profile (cookies, sign-ins) is separate from your own
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
- **What the page loaded.** `browser_network` lists the page loads and the data requests behind them (XHR/fetch, with
  status, type and size), and `browser_network_body` reads one response with the request body the page sent. Data a site
  fetches from its own API (listings, prices, search results) comes back exact instead of read off the screen; big
  responses go to the workspace's `network/` folder (`saveTo`) for a script to process. Not recorded: images, fonts,
  styles, scripts, headers (cookies, authorization) and anything while you have taken the browser over. Values under
  secret-looking keys (`password`, `token`, `apiKey`…) in addresses, request bodies and JSON responses show as
  `(hidden)`. Bodies stay in server memory within a budget; `saveTo` writes only inside `network/`, never into dot
  folders such as `.claude/` or instruction files like `CLAUDE.md`.
- **Taking turns.** **Take over** gives you the browser: Claude's browser calls are refused until you **hand it back**.
  For sign-ins, CAPTCHAs or payments Claude calls `browser_handoff`, which does the same from Claude's side and waits for
  you. While Claude acts, the frame shows a banner and a marker on what it clicks; every batch lands in History.
- **Files.** Downloads go to the board workspace's `downloads/`; Claude can upload only files inside the workspace.
- **Apps.** An app can read a browser like any tool (`useTool(id).state` → `url`, `title`) and open an address with
  `board.writeTool(id, [{ op: "replace", path: "/url", value }])`.
- CLI: `wb br open|snap|act|click|fill|press|select|eval|shot|net|body|handoff` (`wb help`).
- **Certificate errors.** When Chrome refuses a site's certificate, the server fetches the certificate itself (through
  `https_proxy` when set, as Chrome on Linux does) and says who issued it and who trusts that issuer, in the frame and to
  Claude, instead of a bare `net::ERR_CERT_AUTHORITY_INVALID`. Chrome's warning page stays: you can read it and decide,
  but Claude's steps that act inside it (click, type, press, eval…) are refused, so Claude can't go past it. It can only
  open another address or tell you.
- Settings: `WB_CHROME` (which browser), `WB_BROWSER_CA` (extra root CAs for the board browser, Linux; see below), `WB_BROWSER_SCALE` (pixel density, default 2), `WB_DEBUG_BROWSER=1` (log the person's input on the server).

### Networks that inspect HTTPS

Some networks (often at work) inspect HTTPS: a proxy re-signs sites with the organization's own root CA. The operating
system usually trusts that CA, so curl, Node, git and your own browser work, but the board browser fails on those sites
with `net::ERR_CERT_AUTHORITY_INVALID`, while sites the proxy leaves alone (often github.com) open fine. The error in
the frame says so when it finds the issuer in your system's store.

- **macOS and Windows:** Chrome uses the system's certificate store. If the CA is in the keychain (or the Windows
  store), the board browser trusts it too; if not, ask your IT team to install it there.
- **Linux and WSL:** Chrome doesn't read `/etc/ssl/certs` for added CAs; it reads the NSS database `~/.pki/nssdb`, which
  every Chrome and Chromium of your Linux user shares. To trust the CA in the **board browser only**, start the server with
  its file:

  ```bash
  WB_BROWSER_CA=/usr/local/share/ca-certificates/<org-ca>.crt npm run dev
  ```

  `WB_BROWSER_CA` takes PEM files or folders of them, separated by `:`. The server then runs Chrome with its own NSS
  database (`data/browser/home/.pki/nssdb`, rebuilt when the list changes) holding exactly those CAs, and `HOME` pointing
  there; your fonts and settings stay the same. It needs `certutil`: `sudo apt install libnss3-tools`, or without sudo
  `apt download libnss3-tools && dpkg -x libnss3-tools_*.deb ./nss` and put `./nss/usr/bin` on `PATH`. The server lists
  the extra CAs it trusts when it starts, and warns when CAs added to the system (`/usr/local/share/ca-certificates`,
  `NODE_EXTRA_CA_CERTS`) are missing from the board browser, or expire within 30 days.
- To check that a CA is the one re-signing a site: `openssl s_client -connect <site>:443 -servername <site> -CAfile <org-ca>.crt </dev/null | grep 'Verify return code'` (expect `0 (ok)`).

The board browser never weakens TLS: no `--ignore-certificate-errors`, an expired certificate or a wrong name is still
refused with a trusted CA, and trusting a CA stays your action.

## Examples

[`examples/`](examples) holds the demo boards from the top-level README:

```bash
npm run dev                        # in one terminal
node examples/seed-demo.mjs        # in another: adds four demo boards (Release v2.3, Sales analysis, DB migration, Backfill)
```

The script calls the same HTTP API the `wb` CLI uses, acting the way Claude does from a board terminal. Adding boards
is the person's job, so it first asks for the pairing code the server prints in its console. The apps in
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
bin/wb, wb.cmd, wb.mjs  The wb CLI (sh and cmd wrappers around wb.mjs)
test/terminal-check.mjs End-to-end check of a board terminal on this OS, with a fake claude (CI runs it on all three)
desktop/main.mjs     Desktop app: starts the server in a utility process, the window, menus, pairing codes
desktop/build.mjs    Stages the desktop app for electron-builder (electron-builder.config.cjs)
desktop/signpath/    SignPath artifact configurations for signing the Windows app and installer
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
- **Desktop app:** Electron (MIT) with Chromium; the app ships Electron's `LICENSE` and `LICENSES.chromium.html`, the
  board UI's list above, and `server/third-party-licenses.md` for the packages bundled into its server (the MCP SDK and
  what it brings: ajv, hono, zod-to-json-schema…, plus ws, zod, sucrase, fast-json-patch).
- **Build tools only** (TypeScript, Vite and its lightningcss under MPL-2.0, tsx, concurrently, electron-builder): not shipped.
- **This project:** [MIT](../LICENSE).

## wterm modification candidates

| Need | Current approach | Why it needs a modification |
| --- | --- | --- |
| Show widgets such as approval cards inside terminal output | Shown only on the board | The `@wterm/dom` renderer would have to insert React nodes between rows |
| Group output by command (OSC 133) | Not implemented | Not supported by the default core; needs the Ghostty core |
| Resume without flicker on reconnect | `ESC c`, then resend the last 512 KB | Sequence-number-based replay (as in wterm `examples/local`) |

## Security notes

- The server binds only to `127.0.0.1` and checks the `Host` and `Origin` headers, and refuses requests the browser marks as cross-site (`Sec-Fetch-Site`), so other websites and DNS rebinding can't reach it.
- Only a browser paired with the server counts as the person. The first browser that opens a server nobody has paired with is paired automatically (no agent can run before that: Claude starts from a board's terminal, and only a paired browser can open one). Any other browser types a one-time 8-digit code that the server prints in its own console (valid 10 minutes, five tries). Paired browsers keep an `HttpOnly`, `SameSite=Strict` cookie; the server keeps only its SHA-256 in `data/browser-sessions.json`. Every other request is the agent at most: it must say so (`x-wb-actor: agent`, as the `wb` CLI does) or it's refused, so Claude can't approve its own asks, connect to a terminal socket to answer its own permission prompts, or send messages as you. To unpair every browser, empty that file's `sessions` list and restart the server. Anyone who can read the server's console output can pair a browser, so run the server in your own terminal rather than writing its output to a file. The desktop app pairs its own window directly (the server gives it a session over Electron's private channel to the app) and shows codes for other browsers in a dialog, not in its log.
- Each board's terminal is a real shell with your user's permissions, and Claude runs in it. There is no container isolation yet. Don't expose the port (no port forwarding, no tunnels), and only run agents you trust.
- App code runs in a sandboxed iframe (opaque origin, a CSP that allows no network access) and talks to the board only through `postMessage`.
- When app code writes to other tools, those writes count as the agent's writes, so read-only settings and human approval gates still apply.
- The board UI refuses to be framed by other sites (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), so no page can overlay it to trick a click onto an approval or into the terminal.
- The board browser's Chrome is reached only through a pipe (no debugging port). It opens only `http(s)`, `file` and `about:blank` addresses. Its profile (`data/browser/profile`) holds whatever you sign in to there, readable by your user account, and Claude can use those sessions while it drives the browser: sign in only where you'd let Claude act. Take over when you type secrets; Claude can't read or act until you hand it back.
- Web page text reaches Claude as data, marked as such in every snapshot; the board rules tell it never to follow instructions found on a page.
- Claude can't go past Chrome's certificate (or other) warning pages: its in-page steps are refused there. Extra root CAs reach the board browser only through `WB_BROWSER_CA`, which you set; TLS checks are never turned off.
- `data/` and `workspaces/` hold your boards, uploads, downloads, browser profile and session files. They are git-ignored; never commit them.
