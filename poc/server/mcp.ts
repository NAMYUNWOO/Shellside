// Board MCP server: how the agent in the terminal sees and changes the board.
// Stateless Streamable HTTP: a fresh server per request, all state lives in Board.
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { CATALOG_DOC, TOOL_KINDS, describeValue, formField, type Tool } from "../shared/catalog.ts";
import { Board, BoardError } from "./board.ts";
import { loadSource } from "./apps.ts";
import type { Library } from "./library.ts";

export interface McpContext {
  workspace: string;
  /** Ask the board open in a browser to run something inside an app iframe. */
  browserRpc: (method: "app_snapshot" | "app_invoke", toolId: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
  library: Library;
}

/** What the agent sees of a tool: everything but the compiled bundle. */
const forAgent = ({ compiled, ...t }: Tool) => t;

const patchOp = z.object({
  op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
  path: z.string().describe('JSON Pointer into state, e.g. "/items/0/done" or "/rows/-"'),
  value: z.any().optional(),
  from: z.string().optional(),
});

function summarize(t: Tool) {
  const s = t.state;
  const counts =
    t.kind === "checklist"
      ? { items: s.items.length, done: s.items.filter((i: any) => i.done).length }
      : t.kind === "table"
        ? { rows: s.rows.length }
        : t.kind === "form"
          ? { submitted: s.submitted }
          : t.kind === "app"
            ? { stateKeys: Object.keys(s ?? {}).slice(0, 20), sourcePath: t.props.sourcePath }
            : { chars: s.text?.length ?? 0 };
  return { id: t.id, title: t.title, kind: t.kind, description: t.description, version: t.version, agentAccess: t.agentAccess, updatedBy: t.updatedBy, ...counts };
}

export function createBoardMcp(board: Board, ctx: McpContext) {
  const server = new McpServer(
    { name: "workboard", version: "0.0.1" },
    {
      instructions:
        "WorkBoard is the person's tool board next to this terminal. Tools (checklists, forms, tables, notes, apps) are JSON you can read and write. " +
        "Use it to show progress, ask for approval or structured input, and pick up what the person changed. Call board_catalog once to learn the tool shapes. " +
        "Apps share data live through channels (useChannel) and can read any tool (useTool): connect apps that way instead of merging them or relaying data yourself.",
    },
  );

  const reply = (data: unknown) => {
    const pending = board.undeliveredForAgent();
    const content = [{ type: "text" as const, text: JSON.stringify(data, null, 2) }];
    if (pending.length) {
      content.push({
        type: "text" as const,
        text: `[board] ${pending.length} new event(s) from the person (latest: "${pending.at(-1)!.summary}"). Call board_wait_event to read them.`,
      });
    }
    return { content };
  };

  const run = async (fn: () => unknown | Promise<unknown>) => {
    try {
      return reply(await fn());
    } catch (err) {
      const msg = err instanceof BoardError ? err.message : `internal error: ${(err as Error).message}`;
      return { isError: true, content: [{ type: "text" as const, text: msg }] };
    }
  };

  server.registerTool(
    "board_catalog",
    { description: "Describe the tool kinds you can create (props/state shapes) and how to write state. Read this before creating tools." },
    async () => ({ content: [{ type: "text", text: CATALOG_DOC }] }),
  );

  server.registerTool(
    "board_list",
    { description: "List the tools on the board (id, title, kind, version, counts) and any approvals still waiting for the person." },
    async () =>
      run(() => ({
        tools: board.listTools().map(summarize),
        channels: board.listChannels().map(channelSummary),
        pendingAsks: board.pendingAsks().map((a) => ({ id: a.id, kind: a.kind, title: a.title, toolId: a.toolId, itemId: a.itemId })),
      })),
  );

  server.registerTool(
    "tool_read",
    { description: "Read one tool in full: props (layout) and state (data), plus its version for baseVersion.", inputSchema: { toolId: z.string() } },
    async ({ toolId }) => run(() => forAgent(board.getTool(toolId))),
  );

  server.registerTool(
    "tool_create",
    {
      description:
        "Create a tool on the person's board. kind is one of checklist | form | table | note; props and state follow board_catalog. " +
        "Give checklist items stable ids (e.g. step1, step2) and set gate: \"human\" on steps that need the person's approval.",
      inputSchema: {
        title: z.string().min(1).max(120),
        description: z.string().max(500).optional().describe("One line: what the tool is for and how you will use it"),
        kind: z.enum(TOOL_KINDS as [string, ...string[]]),
        props: z.record(z.string(), z.any()).optional(),
        state: z.record(z.string(), z.any()).optional(),
        width: z.number().int().min(240).max(1600).optional().describe("Frame width in px on the board canvas"),
      },
    },
    async (args) => run(() => forAgent(board.createTool("agent", args as any))),
  );

  server.registerTool(
    "tool_update",
    {
      description: "Change a tool's title, description or props (e.g. add a table column or form field). Use tool_write for data.",
      inputSchema: {
        toolId: z.string(),
        title: z.string().max(120).optional(),
        description: z.string().max(500).optional(),
        props: z.record(z.string(), z.any()).optional(),
        baseVersion: z.number().int().optional(),
      },
    },
    async ({ toolId, ...rest }) => run(() => forAgent(board.updateTool("agent", toolId, rest))),
  );

  server.registerTool(
    "tool_write",
    {
      description:
        "Change a tool's state with a JSON Patch (RFC 6902), e.g. [{\"op\":\"replace\",\"path\":\"/items/0/done\",\"value\":true}]. " +
        "Pass baseVersion from tool_read so you never overwrite the person's newer edit. Gated checklist items cannot be marked done here: use board_ask.",
      inputSchema: {
        toolId: z.string(),
        patch: z.array(patchOp).min(1).max(100),
        baseVersion: z.number().int().optional(),
      },
    },
    async ({ toolId, patch, baseVersion }) =>
      run(() => {
        const t = board.patchState("agent", toolId, patch, baseVersion);
        return { ok: true, id: t.id, version: t.version, state: t.state };
      }),
  );

  server.registerTool(
    "tool_delete",
    { description: "Delete a tool you created. Tools the person created cannot be deleted by you.", inputSchema: { toolId: z.string() } },
    async ({ toolId }) =>
      run(() => {
        board.deleteTool("agent", toolId);
        return { ok: true };
      }),
  );

  // ── apps: free-form UI written as React code ─────────────────────────────
  server.registerTool(
    "app_create",
    {
      description:
        "Create a free-form app on the board from React code (see board_catalog, kind \"app\", for the rules). " +
        "Prefer sourcePath: write the component to a .jsx/.tsx file in the workspace first, so you can edit it and call app_update. " +
        "Syntax errors and disallowed imports come back immediately. Afterwards call app_logs / app_snapshot to confirm it rendered. " +
        "Apps that need each other's data connect through channels (useChannel) or read other tools (useTool): see board_catalog.",
      inputSchema: {
        title: z.string().min(1).max(120),
        description: z.string().max(500).optional(),
        source: z.string().max(300_000).optional().describe("Component source; export default function App()"),
        sourcePath: z.string().max(500).optional().describe("Path to the source file, relative to the workspace"),
        state: z.record(z.string(), z.any()).optional().describe("Initial board state for the app"),
        height: z.number().int().min(60).max(1600).optional(),
        width: z.number().int().min(240).max(1600).optional().describe("Frame width in px on the board canvas (default 520)"),
      },
    },
    async ({ title, description, source, sourcePath, state, height, width }) =>
      run(() => {
        const src = loadSource(ctx.workspace, { source, sourcePath });
        const t = board.createTool("agent", { kind: "app", title, description, props: { ...src, height }, state: state ?? {}, width });
        return { ...forAgent(t), props: { sourcePath: t.props.sourcePath, height: t.props.height, sourceChars: t.props.source.length } };
      }),
  );

  server.registerTool(
    "app_update",
    {
      description:
        "Replace an app's code (and optionally title/description). With no source and no sourcePath, reloads from the app's saved sourcePath. " +
        "State is kept. Logs are cleared; check app_logs afterwards.",
      inputSchema: {
        toolId: z.string(),
        source: z.string().max(300_000).optional(),
        sourcePath: z.string().max(500).optional(),
        title: z.string().max(120).optional(),
        description: z.string().max(500).optional(),
        height: z.number().int().min(60).max(1600).optional(),
      },
    },
    async ({ toolId, source, sourcePath, title, description, height }) =>
      run(() => {
        const t = board.getTool(toolId);
        if (t.kind !== "app") throw new BoardError(`"${t.title}" is a ${t.kind}, not an app`);
        const src = loadSource(ctx.workspace, { source, sourcePath: sourcePath ?? (source ? undefined : t.props.sourcePath) });
        const next = board.updateTool("agent", toolId, { title, description, props: { ...t.props, ...src, ...(height ? { height } : {}) } });
        return { id: next.id, version: next.version, sourcePath: next.props.sourcePath, sourceChars: next.props.source.length };
      }),
  );

  server.registerTool(
    "app_snapshot",
    {
      description: "See what an app shows right now: visible text, form fields with their values, buttons, and the actions it registered. Needs the board open in a browser.",
      inputSchema: { toolId: z.string() },
    },
    async ({ toolId }) =>
      run(async () => {
        const t = board.getTool(toolId);
        if (t.kind !== "app") throw new BoardError(`"${t.title}" is a ${t.kind}, not an app. Use tool_read.`);
        return ctx.browserRpc("app_snapshot", toolId, {});
      }),
  );

  server.registerTool(
    "app_invoke",
    {
      description: "Call an action the app registered with useAction/board.onAction, and get its return value. Use it to drive the app (reset, load data, switch views).",
      inputSchema: {
        toolId: z.string(),
        action: z.string(),
        args: z.any().optional(),
        timeoutSec: z.number().int().min(1).max(120).optional(),
      },
    },
    async ({ toolId, action, args, timeoutSec }) =>
      run(async () => {
        const t = board.getTool(toolId);
        if (t.kind !== "app") throw new BoardError(`"${t.title}" is a ${t.kind}, not an app`);
        if (t.agentAccess !== "write") throw new BoardError(`"${t.title}" is read-only for the agent`, 403);
        return { result: await ctx.browserRpc("app_invoke", toolId, { action, args }, (timeoutSec ?? 15) * 1000) };
      }),
  );

  server.registerTool(
    "app_logs",
    {
      description: "Runtime errors and console output from an app (newest last). Check after app_create/app_update.",
      inputSchema: { toolId: z.string(), clear: z.boolean().optional() },
    },
    async ({ toolId, clear }) => run(() => ({ logs: board.getAppLogs(toolId, clear) })),
  );

  // ── channels: the live pipe between apps ────────────────────────────────
  server.registerTool(
    "channel_list",
    { description: "List the board's channels (named values apps share live): name, version, a short shape summary, and which app wrote last." },
    async () => run(() => ({ channels: board.listChannels().map(channelSummary) })),
  );

  server.registerTool(
    "channel_read",
    { description: "Read a channel's full value and version.", inputSchema: { name: z.string() } },
    async ({ name }) => run(() => board.getChannel(name)),
  );

  server.registerTool(
    "channel_write",
    {
      description:
        "Set a channel's value (JSON, under 1 MB); creates it if missing. Every app using it (useChannel) updates at once. " +
        "Pass baseVersion from channel_read to avoid overwriting a newer write. For tables use { columns: [{ key, label, type? }], rows: [{ id, ... }] }.",
      inputSchema: {
        name: z.string().max(64),
        value: z.any(),
        baseVersion: z.number().int().optional().describe("0 = create only if it does not exist yet"),
      },
    },
    async ({ name, value, baseVersion }) =>
      run(() => {
        const c = board.setChannel("agent", name, value, { baseVersion });
        return { ok: true, name: c.name, version: c.version, summary: describeValue(c.value) };
      }),
  );

  server.registerTool(
    "channel_delete",
    { description: "Delete a channel. Apps reading it fall back to their default value.", inputSchema: { name: z.string() } },
    async ({ name }) =>
      run(() => {
        board.deleteChannel("agent", name);
        return { ok: true };
      }),
  );

  // ── library: reuse saved components ─────────────────────────────────────
  server.registerTool(
    "library_list",
    {
      description: "List saved components (templates) the person or you kept for reuse. Check this before building a new tool or app.",
      inputSchema: { query: z.string().max(200).optional().describe("Words to match in name/description/kind") },
    },
    async ({ query }) =>
      run(() => ({
        items: ctx.library.list(query).map((t) => ({ id: t.id, name: t.name, description: t.description, kind: t.kind, uses: t.uses, createdBy: t.createdBy })),
      })),
  );

  server.registerTool(
    "library_use",
    {
      description: "Put a saved component on the board as a new tool. Optionally give a title and a starting state (otherwise the saved one).",
      inputSchema: {
        templateId: z.string(),
        title: z.string().max(120).optional(),
        state: z.record(z.string(), z.any()).optional(),
      },
    },
    async ({ templateId, title, state }) =>
      run(() => {
        const tpl = ctx.library.get(templateId);
        const t = board.createTool("agent", { kind: tpl.kind, title: title ?? tpl.name, description: tpl.description, props: tpl.props, state: state ?? tpl.state, width: tpl.width });
        ctx.library.markUsed(tpl.id);
        return { id: t.id, title: t.title, kind: t.kind, version: t.version, fromTemplate: tpl.id };
      }),
  );

  server.registerTool(
    "library_save",
    {
      description: "Save a board tool to the library for reuse. includeState false (default) keeps the structure but clears progress and entered data.",
      inputSchema: {
        toolId: z.string(),
        name: z.string().max(120).optional(),
        description: z.string().max(500).optional().describe("What it is for, so it can be found later"),
        includeState: z.boolean().optional(),
      },
    },
    async ({ toolId, name, description, includeState }) =>
      run(() => {
        const t = ctx.library.save("agent", board.getTool(toolId), { name, description, includeState });
        return { id: t.id, name: t.name, kind: t.kind };
      }),
  );

  server.registerTool(
    "board_ask",
    {
      description:
        "Ask the person on the board and WAIT for the answer. kind \"approval\" shows Approve/Reject (pass toolId+itemId to unlock a gated checklist item; " +
        "approving marks it done). kind \"input\" shows a form built from fields and returns the values. " +
        "If the wait times out, the result has status \"pending\": call board_wait_answer with the askId to keep waiting. Do not proceed past a gate without approval.",
      inputSchema: {
        kind: z.enum(["approval", "input"]),
        title: z.string().min(1).max(160),
        message: z.string().max(4000).optional().describe("Context the person needs to decide: what will happen, risks, evidence"),
        toolId: z.string().optional(),
        itemId: z.string().optional(),
        fields: z.array(formField).max(20).optional(),
        timeoutSec: z.number().int().min(5).max(600).optional().describe("How long to wait in this call (default 120)"),
      },
    },
    async ({ timeoutSec, ...input }, extra) =>
      run(async () => {
        const ask = board.createAsk("agent", input as any);
        const result = await board.waitAsk(ask.id, (timeoutSec ?? 120) * 1000, extra.signal);
        board.ackAskEvents(ask.id);
        return askResult(result);
      }),
  );

  server.registerTool(
    "board_wait_answer",
    {
      description: "Keep waiting for an answer to an earlier board_ask (when it returned status \"pending\").",
      inputSchema: { askId: z.string(), timeoutSec: z.number().int().min(5).max(600).optional() },
    },
    async ({ askId, timeoutSec }, extra) =>
      run(async () => {
        const result = await board.waitAsk(askId, (timeoutSec ?? 120) * 1000, extra.signal);
        board.ackAskEvents(askId);
        return askResult(result);
      }),
  );

  server.registerTool(
    "board_wait_event",
    {
      description:
        "Wait for what the person does on the board: messages sent to you, stop requests, and their edits to tools. " +
        "Returns immediately if something is already waiting. Use it when you are idle or between long steps.",
      inputSchema: { timeoutSec: z.number().int().min(1).max(600).optional().describe("Default 60") },
    },
    async ({ timeoutSec }, extra) =>
      run(async () => {
        const events = await board.waitForAgentEvents((timeoutSec ?? 60) * 1000, extra.signal);
        return { events: events.map((e) => ({ seq: e.seq, at: e.at, type: e.type, toolId: e.toolId, summary: e.summary })) };
      }),
  );

  return server;
}

function channelSummary(c: ReturnType<Board["getChannel"]>) {
  return { name: c.name, version: c.version, summary: describeValue(c.value), updatedBy: c.updatedBy, toolId: c.toolId, updatedAt: c.updatedAt };
}

function askResult(a: ReturnType<Board["getAsk"]>) {
  if (a.status === "pending") return { askId: a.id, status: "pending", hint: "Not answered yet. Call board_wait_answer with this askId to keep waiting." };
  if (a.status === "cancelled") return { askId: a.id, status: "cancelled" };
  return { askId: a.id, status: "answered", ...a.answer };
}

export async function handleMcp(board: Board, ctx: McpContext, req: IncomingMessage, res: ServerResponse, body: unknown) {
  const server = createBoardMcp(board, ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
