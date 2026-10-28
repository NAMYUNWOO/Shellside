// Tool catalog shared by the server, the board UI and the agent docs.
// A tool is data, not code: `props` describe how it looks, `state` is what it holds.
import { z } from "zod";

export const ACTORS = ["human", "agent"] as const;
export type Actor = (typeof ACTORS)[number];

const id = z.string().min(1).max(64);

// ── checklist ────────────────────────────────────────────────────────────────
export const checklistItem = z.object({
  id,
  label: z.string().min(1).max(300),
  done: z.boolean().default(false),
  note: z.string().max(2000).optional(),
  // "human": only a person can mark it done (the agent must ask via board_ask).
  gate: z.enum(["none", "human"]).default("none"),
});
export const checklistProps = z.object({}).passthrough();
export const checklistState = z.object({ items: z.array(checklistItem).max(200) });

// ── form ─────────────────────────────────────────────────────────────────────
export const formField = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "field name must be an identifier"),
  label: z.string().min(1).max(120),
  type: z.enum(["text", "textarea", "number", "select", "checkbox"]),
  options: z.array(z.string().max(120)).max(50).optional(),
  required: z.boolean().optional(),
  placeholder: z.string().max(200).optional(),
});
export const formProps = z.object({
  fields: z.array(formField).min(1).max(30),
  submitLabel: z.string().max(40).optional(),
});
export const formState = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  submitted: z.boolean().default(false),
  submittedAt: z.string().optional(),
});

// ── table ────────────────────────────────────────────────────────────────────
export const tableColumn = z.object({
  key: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "column key must be an identifier"),
  label: z.string().min(1).max(80),
  type: z.enum(["text", "number", "select", "checkbox"]).default("text"),
  options: z.array(z.string().max(80)).max(30).optional(),
});
export const tableProps = z.object({ columns: z.array(tableColumn).min(1).max(20) });
export const tableRow = z
  .object({ id })
  .catchall(z.union([z.string(), z.number(), z.boolean(), z.null()]));
export const tableState = z.object({ rows: z.array(tableRow).max(1000) });

// ── note ─────────────────────────────────────────────────────────────────────
export const noteProps = z.object({}).passthrough();
export const noteState = z.object({ text: z.string().max(20000).default("") });

// ── app: agent-written React code, run in a sandboxed iframe on the board ─────
export const appProps = z.object({
  source: z.string().min(1).max(300_000),
  sourcePath: z.string().max(500).optional(), // workspace file the source was loaded from
  height: z.number().int().min(60).max(1600).optional(), // initial height; the iframe then follows its content
});
export const appState = z.record(z.string(), z.any());

export const KINDS = {
  checklist: { props: checklistProps, state: checklistState },
  form: { props: formProps, state: formState },
  table: { props: tableProps, state: tableState },
  note: { props: noteProps, state: noteState },
  app: { props: appProps, state: appState },
} as const;
export type ToolKind = keyof typeof KINDS;
export const TOOL_KINDS = Object.keys(KINDS) as ToolKind[];

export type ChecklistItem = z.infer<typeof checklistItem>;
export type FormField = z.infer<typeof formField>;
export type TableColumn = z.infer<typeof tableColumn>;

/** Where a tool sits on the board canvas (world px). h is the last measured height, used for placement only. */
export interface Layout {
  x: number;
  y: number;
  w: number;
  h?: number;
}

export const DEFAULT_WIDTH: Record<string, number> = { checklist: 380, form: 380, note: 380, table: 600, app: 520 };

export interface Tool {
  id: string;
  title: string;
  description: string;
  kind: ToolKind;
  props: any;
  state: any;
  agentAccess: "read" | "write";
  version: number;
  createdBy: Actor;
  updatedBy: Actor;
  createdAt: string;
  updatedAt: string;
  /** kind "app" only: the compiled module the board runs. */
  compiled?: string;
  /** Frame position on the canvas. Not part of the tool's data: moving a frame never bumps its version. */
  layout?: Layout;
}

export interface Ask {
  id: string;
  kind: "approval" | "input";
  title: string;
  message?: string;
  toolId?: string;
  itemId?: string;
  fields?: FormField[];
  status: "pending" | "answered" | "cancelled";
  answer?: { approved?: boolean; values?: Record<string, unknown>; comment?: string };
  createdAt: string;
  answeredAt?: string;
}

/** A named, board-wide value any app, tool view or the agent can read, write and watch: the pipe between apps. */
export interface Channel {
  name: string;
  value: unknown;
  version: number;
  updatedAt: string;
  updatedBy: Actor;
  /** The app that wrote it last, if an app did. */
  toolId?: string;
}
export const CHANNEL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
export const CHANNEL_MAX_BYTES = 1_000_000;
export const MAX_CHANNELS = 200;

/** What apps see of another tool (no compiled bundle, no app source). */
export function publicTool(t: Tool) {
  const { source: _s, ...props } = t.kind === "app" ? (t.props ?? {}) : {};
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    kind: t.kind,
    props: t.kind === "app" ? props : t.props,
    state: t.state,
    version: t.version,
    updatedBy: t.updatedBy,
    updatedAt: t.updatedAt,
  };
}
export type PublicTool = ReturnType<typeof publicTool>;

/** A few words about a value's shape, for history lines: "6 rows × 2 columns", "list of 12", "keys: a, b". */
export function describeValue(v: unknown, lang: "en" | "ko" = "en"): string {
  const ko = lang === "ko";
  if (Array.isArray(v)) return ko ? `목록 ${v.length}개` : `list of ${v.length}`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.rows)) {
      const cols = Array.isArray(o.columns) ? o.columns.length : undefined;
      return ko ? `${o.rows.length}행${cols !== undefined ? ` × ${cols}열` : ""}` : `${o.rows.length} rows${cols !== undefined ? ` × ${cols} columns` : ""}`;
    }
    const keys = Object.keys(o);
    const list = `${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", …" : ""}`;
    return keys.length ? (ko ? `키: ${list}` : `keys: ${list}`) : ko ? "빈 객체" : "empty object";
  }
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

export type BoardEventType =
  | "tool_created"
  | "tool_updated"
  | "tool_state"
  | "tool_deleted"
  | "ask_created"
  | "ask_answered"
  | "message"
  | "stop"
  | "app_event"
  | "file_uploaded"
  | "channel_updated"
  | "channel_deleted"
  | "prompt"; // the person sent a request to the agent in the terminal (it already has it)

export interface BoardEvent {
  seq: number;
  at: string;
  actor: Actor;
  type: BoardEventType;
  toolId?: string;
  askId?: string;
  /** English: what the agent reads (board_wait_event) and the default UI text. */
  summary: string;
  /** Korean, for the board UI in Korean. */
  summaryKo?: string;
}

/** Validate props/state for a kind. Returns parsed values (defaults applied) or an error string. */
export function validateTool(kind: ToolKind, props: unknown, state: unknown):
  | { ok: true; props: any; state: any }
  | { ok: false; error: string } {
  const def = KINDS[kind];
  if (!def) return { ok: false, error: `unknown kind "${kind}". Use one of: ${TOOL_KINDS.join(", ")}` };
  const p = def.props.safeParse(props ?? {});
  if (!p.success) return { ok: false, error: `props: ${z.prettifyError(p.error)}` };
  const s = def.state.safeParse(state ?? defaultState(kind));
  if (!s.success) return { ok: false, error: `state: ${z.prettifyError(s.error)}` };
  if (kind === "checklist") {
    const ids = new Set<string>();
    for (const it of (s.data as any).items) {
      if (ids.has(it.id)) return { ok: false, error: `state: duplicate item id "${it.id}"` };
      ids.add(it.id);
    }
  }
  if (kind === "app" && JSON.stringify(s.data).length > 1_000_000) {
    return { ok: false, error: "state: app state must stay under 1 MB of JSON. Save big data as files." };
  }
  if (kind === "table") {
    const ids = new Set<string>();
    for (const r of (s.data as any).rows) {
      if (ids.has(r.id)) return { ok: false, error: `state: duplicate row id "${r.id}"` };
      ids.add(r.id);
    }
  }
  return { ok: true, props: p.data, state: s.data };
}

export function defaultState(kind: ToolKind): unknown {
  switch (kind) {
    case "checklist":
      return { items: [] };
    case "form":
      return { values: {}, submitted: false };
    case "table":
      return { rows: [] };
    case "note":
      return { text: "" };
    case "app":
      return {};
  }
}

/** For saving a reusable component: keep the structure, drop progress and entered data. */
export function resetState(kind: ToolKind, state: any): unknown {
  switch (kind) {
    case "checklist":
      return { items: (state?.items ?? []).map(({ note: _n, ...it }: any) => ({ ...it, done: false })) };
    case "form":
      return { values: {}, submitted: false };
    case "table":
      return { rows: [] };
    case "note":
      return { text: state?.text ?? "" };
    case "app":
      return {};
  }
}

/** Human-readable catalog for agents (returned by board_catalog and written into CLAUDE.md). */
export const CATALOG_DOC = `# WorkBoard tool catalog

A tool is JSON: { title, description, kind, props, state }. The board renders it; you read and write its state.
The board is a canvas like Figma: each tool is a frame, placed automatically in free space. Pass width (px, 240–1600)
when creating wide content (big tables, dashboards); height follows the content.

## kind: "checklist"
props: {}
state: { items: [{ id, label, done: boolean, note?: string, gate?: "none" | "human" }] }
- gate "human" = only a person may mark it done. To get it done, call board_ask with
  kind "approval", toolId and itemId. If the person approves, the board marks it done.

## kind: "form"
props: { fields: [{ name, label, type: "text"|"textarea"|"number"|"select"|"checkbox", options?, required?, placeholder? }], submitLabel? }
state: { values: { [name]: value }, submitted: boolean, submittedAt? }
- Use a form when you need structured input that persists on the board.
  For a one-off question, prefer board_ask with kind "input" and fields.

## kind: "table"
props: { columns: [{ key, label, type: "text"|"number"|"select"|"checkbox", options? }] }
state: { rows: [{ id, [key]: value }] }

## kind: "note"
props: {}
state: { text: string }   (plain text / light markdown, shown as-is)

## kind: "app"  — free-form UI you write as React code
Use an app when the 4 kinds above cannot do the job (file input, custom layout, charts, calculators, buttons
that call you, anything interactive). Create it with app_create (source, or sourcePath = a .jsx/.tsx file
you wrote in the workspace). The board compiles it, runs it in a sandboxed iframe, and you control it.

Rules for the source:
- \`export default function App() { ... }\` — one React 19 component (JSX/TSX ok).
- Imports allowed: "react", "react-dom", "board". Nothing else; no network (fetch is blocked), no external CSS.
- Style with inline styles or a <style> tag. The iframe grows with its content. Keep text Korean if the person writes Korean.
- ALL data you need to read must live in board state:
    import { useBoardState, useAction, board } from "board";
    const [state, setState] = useBoardState();         // synced with the board; you read it via tool_read
    setState(s => ({ ...s, step: 2 }));                // replace the whole state object (merge yourself)
    board.update({ step: 2 });                          // shallow merge shortcut
- Let the person reach you: await board.emit("submitted", { ... })  → you get it from board_wait_event.
- Files: const meta = await board.uploadFile(file)  → { path, relPath, name, size, type }; the file is saved
  in your workspace, so read it from \`path\`. Store meta in state so you can find it later.
- Let yourself drive the app: useAction("reset", (args) => { ...; return result })  → app_invoke(toolId, "reset", args).

Reading and controlling an app:
- tool_read → its state (what the person entered).  tool_write → change state; the app re-renders at once.
- app_snapshot → the text, form fields and buttons currently on screen.  app_logs → runtime errors and console output.
- After creating or updating an app, call app_logs (and app_snapshot) to check it rendered without errors, and fix it if not.

## Sharing data between apps and tools (live, no relaying)
Apps on the same board exchange data directly, in real time. Never merge apps or relay data by hand just so they
can share it: keep each app focused and connect them with a channel.

1. Channels — named shared values on the board. Any app reads, writes and watches any channel; changes reach
   every other app at once. Values are JSON (≤ 1 MB each) and survive reloads.
     import { useChannel, board } from "board";
     const [data, setData] = useChannel("sales", { columns: [], rows: [] });   // 2nd arg = default while empty
     setData(d => ({ ...d, rows: [...d.rows, row] }));                          // every app using "sales" re-renders
     board.channel("sales").get() / .set(value | fn) / .subscribe(fn)           // outside React
   The producer writes, any number of consumers read; two-way is fine too (last write wins). Pick clear names
   ("sales", "selection", "filters"), and say in each app's description which channels it reads and writes.
   You read and write them too: channel_list, channel_read, channel_write (the apps update at once).

2. Any tool's state — an app can read any tool on the board live (tables, checklists, forms, notes, other apps):
     import { useTool, useTools, board } from "board";
     const sheet = useTool("table_ab12cd34");    // { id, title, kind, props, state, version } or undefined; re-renders on change
     const all = useTools();                     // [{ id, title, kind, version }] — e.g. let the person pick a data source
     await board.writeTool(id, [{ op: "add", path: "/rows/-", value: { id: "r9", name: "x" } }]);   // JSON Patch; counts as your write
   board.toolId is the app's own id.

Shared shape for tabular data, so separately built apps connect without glue code (it matches the table tool):
  { columns: [{ key, label, type?: "text"|"number"|"select"|"checkbox" }], rows: [{ id, [key]: value }] }
Producers publish this shape; consumers accept it (and may also accept a table tool via useTool).

## Library (reuse before you build)
Saved components live in the library. Before creating a new tool or app, call library_list (with a query) and,
if something fits, library_use it instead of writing it again. When the person asks to keep a tool for later,
library_save it with a clear name and description.

## Writing state
tool_write takes a JSON Patch (RFC 6902) against state, e.g.
  [{ "op": "replace", "path": "/items/2/done", "value": true }]
  [{ "op": "add", "path": "/rows/-", "value": { "id": "r7", "name": "x" } }]
Pass baseVersion (from tool_read) to avoid overwriting a person's newer edit.
`;
