# Shellside — Product Plan

Oct 28, 2026 · Yunwoo Nam

_Original planning document (working name: WorkBoard AI). The PoC in [`/poc`](../poc) has since implemented several later-stage items, such as custom code apps, live data channels between apps, and a component library._

## One-line definition

Shellside is a service where an AI agent running in a browser terminal (wterm) and the work tools a user builds on the spot with AI share one workspace and one state.

- **Users build tools by asking.** Say "Make a checklist board for this deploy" and a generative UI streams onto the board.
- **The agent can use those tools.** The agent in the terminal (Claude Code, Codex CLI, etc.) reads and writes tool values and waits for human input.
- **Two ways of working connect on one screen.** In an agent workflow, the agent leads and the human approves. In copilot mode, the human leads and the agent helps.

Product vision: let the agent, until now stuck inside the terminal, work with the screens, data and human judgment outside it.

## Problem and target users

CLI agents do good work, but their only window to people and the outside world is terminal text. So input, progress tracking and passing context all depend on humans copying and pasting.

| Problem | Current workaround | Shellside's answer |
| --- | --- | --- |
| Structured input is hard (choices, settings, tables) | Pasting into long prompts, repeated y/n questions | The agent opens a form tool and gets the values as JSON |
| Progress gets buried in scrollback | Scrolling up through logs | The agent records progress directly on a checklist or progress board |
| Context outside the terminal is invisible (team checklists, decisions) | A human copies and pastes it | The agent reads tool state on the board directly |
| No tool fits each task | Spreadsheets, notepads, requests for internal tools | Build the tool on the spot by asking |

We widen the target users in three stages.

1. **First: developers who use CLI coding agents every day.** They hand releases, migrations and incident response to Claude Code, Codex CLI, etc., but tracking progress and giving approvals is awkward.
2. **Second: DevOps, SRE and data engineers.** Their terminal-centric operations work needs checklists and human approval.
3. **Third (expansion): operations and planning roles who are new to the terminal.** They delegate work to the agent from the board alone and keep the terminal collapsed.

## Core concept

The screen has two areas, a terminal panel and a tool board, connected by a shared state bus (Board API). To the agent, the board is one MCP server. To the human, the terminal is one window next to the board.

| Element | For the human | For the agent |
| --- | --- | --- |
| Terminal panel | A real shell rendered with wterm. Run the agent and watch its output | Its own workspace (a sandboxed shell) |
| Tool board | A set of AI-built tool cards: checklists, forms, tables, charts, approval buttons | Readable, writable objects with a name, description and state schema |
| Shared state bus | Real-time sync and a history of who changed what | MCP tools, `wb` CLI, waiting for human events |

There is one core principle. **A tool is data, not a screen.** Every tool is stored as a spec (JSON) and a state (JSON). The screen is just a rendering of that spec. This is what lets the agent read and edit the same tools as the human.

Basic flow (agent workflow):

1. On the board, the user says "Make a release checklist." The tool streams in as it is generated.
2. In the terminal, the user tells the agent "Run the release following the checklist."
3. The agent reads the tool with `tool_read`, runs commands and checks off items.
4. At a step that needs approval, the agent calls the human with `board_ask` and waits. An approval card appears on the board.
5. Once the user approves, the agent continues. Every change stays in the board history.

The reverse direction (copilot) uses the same bus. The user selects part of the terminal output and sends it to a tool, or gives the agent work through a button on a tool.

## Key scenarios

Each of the four scenarios tests a different integration direction. In A and C the agent leads; in B and D the human leads.

### A. Release checklist (agent workflow)

The agent works through a checklist the human made, and the human approves only the risky steps.

1. User: "Make a v2.3 release checklist. The prod deploy needs my approval."
2. Agent: runs tests and builds and checks off items. If something fails, it attaches a log summary to the item.
3. Agent: calls `board_ask` at the prod deploy item. An approval card appears, and once approved, the agent deploys.

Integrations tested: reading and writing state, human approval, history.

### B. Error log triage (copilot)

Move terminal output into a table tool, let the human triage it, and hand only the chosen rows to the agent.

1. The user selects test failure output in the terminal and clicks "Make a table." A table of failures appears.
2. The user picks "fix / ignore / later" for each row.
3. The user sends the "fix" rows to the agent. The agent fixes them and updates each row's status.

Integrations tested: terminal selection → tool, tool action → agent.

### C. A form where the agent asks the human (agent workflow)

Instead of asking y/n questions over and over in the terminal, the agent opens a form.

1. Agent: uses `board_ask` with a schema to ask for the target database, batch size and time window for a migration.
2. A form appears on the board. When the user fills it in, the agent receives validated JSON.

Integrations tested: the agent opens a tool, structured input.

### D. Monitoring a long-running job (copilot)

Watch the progress of a long job on the board instead of in terminal scrollback.

1. While running a benchmark or backfill, the agent records progress and metrics to a chart tool.
2. If something looks wrong, the user clicks "Stop." A stop event goes to the agent.

Integrations tested: agent writes, tool → agent events.

## Functional requirements

The MVP goes as far as "the agent in my terminal reads and writes the tools I built, and asks me at risky steps." It must be able to run all of scenarios A–D. Team collaboration and the local runner come in v1. Arbitrary code tools come in v2 or later.

| Area | Feature | Stage |
| --- | --- | --- |
| Terminal | wterm terminal panel + a sandboxed shell per workspace (WebSocket) | MVP |
| Terminal | Preinstalled CLI agents (Claude Code, etc.) with automatic Board MCP connection | MVP |
| Terminal | Session persistence and reconnect (not in wterm, so built on the server) | v1 |
| Terminal | Local runner: connect a shell on the user's machine to the board | v1 |
| Terminal | Shell integration: per-command output capture (OSC 133 in the Ghostty core) | v1 |
| Tool building | Build tools through conversation, with streaming preview (catalog-based) | MVP |
| Tool building | Edit tools through conversation ("add a column") with version history | MVP |
| Tool building | Default catalog: checklist, form, table, kanban, chart, approval card, note | MVP |
| Tool building | Custom code tools (sandboxed iframe, state saved only through the bridge) | v2+ |
| Tool building | Sharing tool templates | v2+ |
| Agent integration | Board MCP server: list, read, write, actions | MVP |
| Agent integration | `wb` CLI (for agents that can't use MCP) | MVP |
| Agent integration | Requests for human input and approval (`board_ask`) | MVP |
| Agent integration | Tool → agent events (buttons, stop, "Send to agent") | MVP |
| Agent integration | Send a terminal selection or buffer → tool | MVP |
| Agent integration | Agent creates new tools (`tool_create`) | v1 |
| Collaboration and ops | Change history (human vs. agent) and undo | MVP |
| Collaboration and ops | Per-tool agent permissions (read / write / approval required) | MVP |
| Collaboration and ops | Team-shared boards, real-time co-editing | v1 |
| Collaboration and ops | Export board tools as MCP Apps (for use in other agent hosts) | v2+ |

## System architecture

The human's screen and the agent's workspace both go through the Board service and see the same state. Terminal bytes flow only through the PTY gateway. Tool data flows only through the Board service.

_Diagram: system architecture — three layers, highlighting the agent ↔ Board MCP connection._

- **Browser:** `@wterm/react` renders the terminal into the DOM. `getSelectionText()` and `readText()` read the selection and the buffer so they can be sent to a tool.
- **PTY gateway:** wterm provides only the WebSocket transport, not a server. We build the gateway and session persistence ourselves.
- **Board service:** the single source of truth for tool specs, state, the event log and permissions. It exposes the same API to the browser as real-time sync and to the agent as MCP (Streamable HTTP). We assume Postgres for storage.
- **Tool builder:** `streamText` produces tool specs that match the catalog schema as tool calls. The client takes the tool parts from `useChat` and starts rendering from partial specs.
- **Sandbox:** one container per workspace, with the CLI agent, the `wb` CLI and the Board MCP config preinstalled.

## Agent ↔ tool integration contract

The agent works with the board through seven MCP tools. Agents that can't use MCP get the same functions through the `wb` CLI. When we create a sandbox, we include the MCP config and usage guides (`AGENTS.md`, `CLAUDE.md`), so the agent can use the board with no extra setup.

| MCP tool | `wb` CLI | What it does | Default permission |
| --- | --- | --- | --- |
| `board_list` | `wb ls` | The board's tool list, descriptions and state schemas | Read |
| `tool_read` | `wb get <tool> [path]` | Read a tool's state (JSON) | Read |
| `tool_write` | `wb set <tool> <path> <value>` | Change part of the state (JSON Patch, base version required) | Write |
| `tool_action` | `wb run <tool> <action>` | Run an action defined on the tool (e.g. complete an item) | Write |
| `board_ask` | `wb ask --schema <file>` | Ask a human for input or approval and wait for the answer | Always allowed |
| `board_wait_event` | `wb wait [--tool <tool>]` | Wait for human events such as button clicks or stop requests | Read |
| `tool_create` | `wb new "<description>"` | The agent creates a new tool (calls the builder, v1) | Approval required |

The tool manifest is a single spec that both the human and the agent read. `ui` is a tree of catalog components, and `stateSchema` is the shape of the data that screen shows.

```json
{
  "id": "release-checklist",
  "title": "v2.3 release checklist",
  "description": "Release steps and approval points. The agent checks off completed items.",
  "stateSchema": {
    "items": [{ "id": "string", "label": "string", "done": "boolean", "note": "string?" }]
  },
  "actions": {
    "complete": { "input": { "itemId": "string" } },
    "approveDeploy": { "requiresHuman": true }
  },
  "ui": { "root": "checklist", "elements": { "checklist": { "type": "Checklist", "bind": "/items" } } },
  "agentAccess": "write"
}
```

Event and concurrency rules:

- **Agent → tool is pull.** The agent reads and writes only when it makes an MCP call.
- **Tool → agent has three paths.** If the agent is waiting with `board_ask` or `board_wait_event`, the event is delivered right away. If not, it is queued, and the next MCP response carries "N pending events." If the user clicks "Send to terminal," the text goes into the shell as input. This last path is a fallback that works with any agent.
- **Versions prevent conflicts.** Every write includes a base version. If a human changed the state first, the write is rejected and the latest state is returned.
- **Every write records its actor.** Human or agent, and which session, for history and undo.
- **The agent can't run `requiresHuman` actions directly.** When the agent calls one, an approval card appears automatically, and the human's answer is returned as the result.

### Custom code tool rules (v2)

A tool that AI writes as code can go on the board only if it saves its state through the board connection (the bridge). That way the agent can read and write it just like a catalog tool.

- **Where it runs:** generated code runs only in a sandboxed iframe on a separate origin. We don't run it inside the board page, as react-live does. JSX is transformed before it goes into the iframe (sucrase, esbuild-wasm, etc.).
- **Saving state:** state is saved only through the bridge SDK. The agent can't read values kept only in variables inside the code, so this is allowed only for transient UI state such as expanded sections or scroll position.
- **Schema declaration:** a tool can't go on the board unless its manifest has `stateSchema` and `actions`. The bridge validates every write against this schema and records it in the same history as human and agent writes.
- **Protocol:** the bridge is postMessage JSON-RPC, and its methods follow MCP Apps. This lets the same code be reused as-is for "Export as MCP Apps" in v2+.

Bridge SDK example (function names are a proposal):

```ts
const board = await connectBoard();           // postMessage connection to the parent window
const state = await board.getState();         // JSON matching stateSchema
await board.patchState([{ op: "replace", path: "/items/0/done", value: true }]);
board.onStateChange((next) => render(next));  // apply values changed by the agent or a human
board.onAction("approveDeploy", async () => { /* called after human approval */ });
```

## Security and permission model

In the MVP, generated tools are specs, not code. Only components in the catalog are rendered, so an AI-built tool has no way to run arbitrary code in the browser. The remaining risk is on the agent side.

| Threat | Mitigation |
| --- | --- |
| The agent touches the host or other workspaces | One container (or microVM) per workspace, an allowlist for outbound network addresses, secrets injected at runtime and masked in output |
| The agent runs a risky action without permission | Per-tool agent permissions (none / read / write) and per-action `requiresHuman`. Without approval, the server rejects it |
| Prompt injection through board content | When tool state is given to the agent, it is tagged with its author and marked as "data." Risky commands need both the agent's own permission settings and board approval |
| Hijacking the terminal or MCP connection | The PTY WebSocket and Board MCP both use short-lived tokens scoped to the workspace. The MCP token exists only inside the sandbox |
| Malicious code in v2 custom code tools | Sandboxed iframe on a separate origin + CSP. No access to the parent DOM or cookies; communication only through postMessage JSON-RPC (the same model as MCP Apps). Running code in the same page, as react-live does, is forbidden |
| No way to trace what happened | Every write, approval and terminal session start goes into an audit log (who, when, what) |
| A v2 custom code tool keeps state outside the bridge (the agent can't read it, and it's missing from the audit log) | Load the iframe without allow-same-origin to block cookies and localStorage, and block outbound requests with CSP. State can be saved only through the bridge, and custom tools without a schema can't be published |

## Technical risks and decisions

The biggest decision is not to build the product on stream-ui (AI SDK RSC). We keep the experience stream-ui offers, where you say something and the UI streams in, but we implement it with AI SDK UI and tool specs.

- **The agent can't read it.** stream-ui's output is React nodes built on the server. The state is locked inside components, so it is hard to save and restore, and there is no data to give the agent. That means we couldn't test this product's core hypothesis.
- **It's an experimental feature, and development has stopped.** The docs state "AI SDK RSC is currently experimental. We recommend using AI SDK UI for production." The Vercel template page says "Development of AI SDK RSC is currently paused." A community forum answer (2025-12-04) also said "RSC is not a priority for us right now".
- **It doesn't fit agent-style generation.** According to the migration guide, it doesn't support parallel or multi-step tool calls, and it has known issues such as components remounting on completion (flicker) and server action streams that can't be aborted.

| Decision | Choice | Reason |
| --- | --- | --- |
| Generative UI approach | Stream tool specs (JSON) with AI SDK UI (`streamText` + `useChat`) | Specs can be stored, versioned and read by the agent. Partial specs render right away, so the streaming experience stays |
| Catalog implementation | Evaluate json-render first; build our own if it doesn't fit | Blocks components outside the catalog, zod schemas, streaming, an MCP Apps integration package. But it is pre-1.0 |
| Agent connection | Board MCP server + `wb` CLI | MCP is the common standard across major CLI agents. The CLI covers other agents and scripts |
| Terminal core | Start with wterm's default core; switch to the Ghostty core when shell integration is needed | OSC 133 (command boundaries) and OSC 7 (working directory) are supported only in the Ghostty core |
| Board text layout | Use pretext on the board, not in the terminal | Computes line counts and heights without DOM measurement (reflow). We use it to virtualize long lists, lay out cards and predict heights while streaming. The terminal is a fixed cell grid, so it gains little. MIT, v1.0.0 |

| Risk | Impact | Mitigation |
| --- | --- | --- |
| wterm is a "Vercel Labs Experiment" with no official versioning | API changes, maintenance stops | Wrap the terminal layer in an adapter so it can be swapped for xterm.js |
| wterm has no session recovery or receive-side flow control | Agent output is lost on refresh or network drop | Build server-side session persistence (tmux, etc.) and scrollback replay ourselves |
| The Escape key on mobile is a known issue | Controlling the agent on mobile is awkward | The MVP is desktop-first. On mobile, only viewing the board and approving |
| The agent ignores the board and works only in the terminal | The core value never shows | Inject `AGENTS.md` and `CLAUDE.md` automatically, and put per-tool "how the agent should use this" notes in the manifest |
| Users need tools the catalog can't express | Users leave | Grow the catalog regularly from request logs; v2 custom code tools |
| Cost of a container per workspace | Higher cost per user | Pause when idle; use the user's machine through the v1 local runner |
| pretext calculations differ from actual rendering | Rows overlap or get cut off in virtualized lists | Measure after web fonts load, use a named font (e.g. Pretendard) instead of system-ui, and check accuracy for Korean with wordBreak keep-all in the PoC |

## Roadmap and success metrics

A 4-week PoC, an 8-week MVP and an 8-week v1 lead to a team pilot in about 20 weeks (the durations are proposals). Each stage must pass a gate before the next one starts.

_Diagram: roadmap — four stages with three gates._

The PoC tests agent integration before tool generation quality. If the agent doesn't use the board, this product is no different from a no-code tool.

### Success metrics

The north star metric is the agent integration rate. The targets are proposals and will be adjusted after measuring in the PoC.

| Metric | Definition | Target at end of MVP |
| --- | --- | --- |
| Agent integration rate | Share of weekly active sessions with at least one Board MCP call from the agent | 60% |
| First-session activation | Share of users who build a tool in their first session and have the agent read or write it | 50% |
| First-generation adoption | Share of generated tools put to use within two edit turns | 70% |
| Tool reuse rate | Share of tools used again within 7 days of creation | 30% |
| 4-week retention | Share of users who use it at least once a week in their fourth week after signup | 40% (Gate 2) |
| Approval round-trip time | Median time from a `board_ask` request to the human's answer | Baseline measured in the PoC |

## Open questions

- [ ] Where the agent runs: cloud sandbox first, or local runner first? Security, cost and use cases depend on this.
- [ ] Agents supported first: start with Claude Code only, or include Codex CLI and Gemini CLI in the MVP?
- [ ] Which model to use for the tool builder, and a cost cap per generation
- [ ] Whether to adopt json-render: how much to depend on a pre-1.0 library
- [ ] Deployment: SaaS or on-premises?
- [ ] Scope and timing for bringing external integrations (Jira, Slack, GitHub) into board tools
- [x] Product name: Shellside (was the working name WorkBoard AI)

## Sources

- [vercel-labs/wterm (GitHub)](https://github.com/vercel-labs/wterm)
- [wterm API reference](https://wterm.dev/api-reference)
- [AI SDK RSC: streamUI reference](https://ai-sdk.dev/docs/reference/ai-sdk-rsc/stream-ui)
- [AI SDK: Migrating from RSC to UI](https://ai-sdk.dev/docs/ai-sdk-rsc/migrating-to-ui)
- [AI SDK UI: Generative User Interfaces](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces)
- [AI SDK RSC overview (v4 docs)](https://v4.ai-sdk.dev/docs/ai-sdk-rsc/overview)
- [Vercel template: Generative UI Chatbot with React Server Components](https://vercel.com/templates/next.js/rsc-genui)
- [Vercel Community: AI SDK RSC & useAIState](https://community.vercel.com/t/ai-sdk-rsc-useaistate/29082)
- [vercel-labs/json-render (GitHub)](https://github.com/vercel-labs/json-render)
- [MCP Apps (Model Context Protocol)](https://modelcontextprotocol.io/docs/extensions/apps)
- [chenglou/pretext (GitHub)](https://github.com/chenglou/pretext)
