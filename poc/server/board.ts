// Board service: the single source of truth for tools, asks and the event log.
// Browser, MCP and the wb CLI all go through this module.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import jsonpatch from "fast-json-patch";
import {
  CHANNEL_MAX_BYTES,
  CHANNEL_NAME,
  DEFAULT_WIDTH,
  describeValue,
  MAX_CHANNELS,
  type Channel,
  type Layout,
  type Actor,
  type Ask,
  type BoardEvent,
  type BoardEventType,
  type FormField,
  type Tool,
  type ToolKind,
  TOOL_KINDS,
  validateTool,
} from "../shared/catalog.ts";

export class BoardError extends Error {
  constructor(
    message: string,
    public status = 400,
    public data?: unknown,
  ) {
    super(message);
  }
}

type Change =
  | { type: "tool"; tool: Tool }
  | { type: "tool_deleted"; toolId: string }
  | { type: "ask"; ask: Ask }
  | { type: "channel"; channel: Channel }
  | { type: "channel_deleted"; name: string }
  | { type: "event"; event: BoardEvent };

interface Persisted {
  tools: Tool[];
  asks: Ask[];
  events: BoardEvent[];
  seq: number;
  channels?: Channel[];
}

const MAX_EVENTS = 500;
// Events a person caused that the agent should hear about.
const AGENT_FACING: BoardEventType[] = [
  "message",
  "stop",
  "tool_created",
  "tool_updated",
  "tool_state",
  "tool_deleted",
  "ask_answered",
  "app_event",
  "file_uploaded",
  "channel_updated",
  "channel_deleted",
];

export interface AppLog {
  at: string;
  level: string;
  message: string;
}

const now = () => new Date().toISOString();
const shortId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

export class Board {
  private tools = new Map<string, Tool>();
  private asks = new Map<string, Ask>();
  private channels = new Map<string, Channel>();
  /** The newest event, if it may absorb a repeat of itself (see log's coalesce). */
  private coalescible: { key: string; seq: number } | null = null;
  private events: BoardEvent[] = [];
  private seq = 0;
  private agentCursor = 0; // last human event seq delivered to the agent
  private acked = new Set<number>(); // events the agent already learned about another way
  private listeners = new Set<(c: Change) => void>();
  private askWaiters = new Map<string, Set<(a: Ask) => void>>();
  private eventWaiters = new Set<() => void>();
  private saveTimer: NodeJS.Timeout | null = null;
  private appLogs = new Map<string, AppLog[]>();

  constructor(
    private file: string,
    /** Compiles app source to runnable code; throws BoardError on bad code. */
    private compile: (source: string) => string,
  ) {
    this.load();
  }

  // ── persistence ────────────────────────────────────────────────────────────
  private load() {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Persisted;
      for (const t of data.tools ?? []) this.tools.set(t.id, t);
      for (const t of this.tools.values()) if (!t.layout) t.layout = this.autoPlace(t.kind, DEFAULT_WIDTH[t.kind] ?? 400, estimateHeight(t));
      for (const a of data.asks ?? []) {
        // A pending ask cannot survive a restart: nobody is waiting on it any more.
        if (a.status === "pending") a.status = "cancelled";
        this.asks.set(a.id, a);
      }
      for (const c of data.channels ?? []) this.channels.set(c.name, c);
      this.events = data.events ?? [];
      this.seq = data.seq ?? this.events.at(-1)?.seq ?? 0;
      this.agentCursor = this.seq;
    } catch (err) {
      console.error(`[board] could not read ${this.file}:`, err);
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const data: Persisted = {
        tools: [...this.tools.values()],
        asks: [...this.asks.values()].slice(-200),
        events: this.events,
        seq: this.seq,
        channels: [...this.channels.values()],
      };
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, this.file);
    }, 200);
  }

  // ── subscriptions ──────────────────────────────────────────────────────────
  subscribe(fn: (c: Change) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(c: Change) {
    for (const fn of this.listeners) fn(c);
    this.scheduleSave();
  }

  /**
   * summary: English (what the agent reads), or [English, Korean] for the board UI in Korean.
   * coalesce: a key for repeated writes (e.g. an app streaming into a channel). While the newest event has the same
   * key and the agent has not read it yet, it is updated in place instead of adding one event per write.
   */
  private log(actor: Actor, type: BoardEventType, summary: string | [string, string], extra: Partial<BoardEvent> = {}, coalesce?: string) {
    const [en, ko] = Array.isArray(summary) ? summary : [summary, undefined];
    const last = this.events.at(-1);
    const key = coalesce ? `${actor}|${coalesce}` : undefined;
    if (key && last && this.coalescible?.key === key && this.coalescible.seq === last.seq && last.seq > this.agentCursor) {
      const event: BoardEvent = { ...last, at: now(), summary: en, ...(ko ? { summaryKo: ko } : {}), ...extra };
      this.events[this.events.length - 1] = event;
      this.emit({ type: "event", event });
      return event;
    }
    const event: BoardEvent = { seq: ++this.seq, at: now(), actor, type, summary: en, ...(ko ? { summaryKo: ko } : {}), ...extra };
    this.coalescible = key ? { key, seq: event.seq } : null;
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.emit({ type: "event", event });
    if (actor === "human") for (const wake of this.eventWaiters) wake();
    return event;
  }

  // ── reads ──────────────────────────────────────────────────────────────────
  snapshot() {
    return {
      tools: [...this.tools.values()],
      asks: [...this.asks.values()].filter((a) => a.status === "pending"),
      events: this.events.slice(-100),
      channels: [...this.channels.values()],
    };
  }

  listTools() {
    return [...this.tools.values()];
  }

  getTool(toolId: string): Tool {
    const t = this.tools.get(toolId);
    if (!t) {
      const known = [...this.tools.values()].map((x) => `${x.id} (${x.title})`).join(", ") || "none";
      throw new BoardError(`tool "${toolId}" not found. Known tools: ${known}`, 404);
    }
    return t;
  }

  pendingAsks() {
    return [...this.asks.values()].filter((a) => a.status === "pending");
  }

  /** Human events the agent has not seen yet. */
  undeliveredForAgent() {
    return this.events.filter((e) => e.seq > this.agentCursor && !this.acked.has(e.seq) && e.actor === "human" && AGENT_FACING.includes(e.type));
  }

  /** The agent got this ask's answer directly, so its follow-up events are not news. */
  ackAskEvents(askId: string) {
    for (const e of this.events) if (e.seq > this.agentCursor && e.askId === askId) this.acked.add(e.seq);
  }

  // ── tool writes ────────────────────────────────────────────────────────────
  createTool(
    actor: Actor,
    input: { title: string; description?: string; kind: ToolKind; props?: unknown; state?: unknown; agentAccess?: "read" | "write"; id?: string; width?: number; at?: { x: number; y: number } },
  ): Tool {
    if (!TOOL_KINDS.includes(input.kind)) throw new BoardError(`unknown kind "${input.kind}". Use one of: ${TOOL_KINDS.join(", ")}`);
    const v = validateTool(input.kind, input.props, input.state);
    if (!v.ok) throw new BoardError(v.error);
    const id = input.id && !this.tools.has(input.id) ? input.id : shortId(input.kind);
    const compiled = input.kind === "app" ? this.compile(v.props.source) : undefined;
    const t: Tool = {
      id,
      title: input.title.trim() || "Untitled",
      description: input.description?.trim() ?? "",
      kind: input.kind,
      props: v.props,
      state: v.state,
      agentAccess: input.agentAccess ?? "write",
      version: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt: now(),
      updatedAt: now(),
      ...(compiled !== undefined ? { compiled } : {}),
    };
    const w = clampWidth(input.width ?? DEFAULT_WIDTH[t.kind] ?? 400);
    const at = input.at && Number.isFinite(input.at.x) && Number.isFinite(input.at.y) ? input.at : null;
    // A person adding a tool drops it where they are looking; the agent's tools go to the next free spot.
    t.layout = at ? { x: Math.round(at.x - w / 2), y: Math.round(at.y - 80), w } : this.autoPlace(t.kind, w, estimateHeight(t));
    this.tools.set(t.id, t);
    this.emit({ type: "tool", tool: t });
    this.log(actor, "tool_created", [`Created ${t.kind} "${t.title}"`, `"${t.title}" ${t.kind} 도구 생성`], { toolId: t.id });
    return t;
  }

  updateTool(
    actor: Actor,
    toolId: string,
    input: { title?: string; description?: string; props?: unknown; agentAccess?: "read" | "write"; baseVersion?: number },
  ): Tool {
    const t = this.getTool(toolId);
    this.checkAccess(actor, t);
    this.checkVersion(t, input.baseVersion);
    if (actor === "agent" && input.agentAccess !== undefined) throw new BoardError("the agent cannot change its own access level", 403);
    const props = input.props !== undefined ? input.props : t.props;
    const v = validateTool(t.kind, props, t.state);
    if (!v.ok) throw new BoardError(v.error);
    const compiled = t.kind === "app" && input.props !== undefined ? this.compile(v.props.source) : t.compiled;
    if (t.kind === "app" && input.props !== undefined) this.appLogs.delete(t.id); // fresh code, fresh logs
    const next: Tool = {
      ...t,
      ...(compiled !== undefined ? { compiled } : {}),
      title: input.title?.trim() || t.title,
      description: input.description?.trim() ?? t.description,
      props: v.props,
      agentAccess: input.agentAccess ?? t.agentAccess,
      version: t.version + 1,
      updatedBy: actor,
      updatedAt: now(),
    };
    this.tools.set(t.id, next);
    this.emit({ type: "tool", tool: next });
    this.log(actor, "tool_updated", [`Changed the setup of "${next.title}"`, `"${next.title}" 도구 구성 변경`], { toolId: t.id });
    return next;
  }

  /** Apply a JSON Patch to a tool's state. */
  patchState(actor: Actor, toolId: string, patch: unknown, baseVersion?: number, summary?: string | [string, string], logExtra: Partial<BoardEvent> = {}): Tool {
    const t = this.getTool(toolId);
    this.checkAccess(actor, t);
    this.checkVersion(t, baseVersion);
    if (!Array.isArray(patch) || patch.length === 0) throw new BoardError("patch must be a non-empty JSON Patch array");
    const opError = jsonpatch.validate(patch as any, t.state);
    if (opError) throw new BoardError(`invalid patch: ${opError.message} (op ${opError.index})`);
    let nextState: any;
    try {
      nextState = jsonpatch.applyPatch(structuredClone(t.state), patch as any, false, false).newDocument;
    } catch (err) {
      throw new BoardError(`patch failed: ${(err as Error).message}`);
    }
    const v = validateTool(t.kind, t.props, nextState);
    if (!v.ok) throw new BoardError(`patch would make state invalid: ${v.error}`);
    if (t.kind === "checklist" && actor === "agent") this.checkGates(t.state, v.state);
    const next: Tool = { ...t, state: v.state, version: t.version + 1, updatedBy: actor, updatedAt: now() };
    this.tools.set(t.id, next);
    this.emit({ type: "tool", tool: next });
    this.log(actor, "tool_state", summary ?? describePatch(t, patch as any[]), { toolId: t.id, ...logExtra });
    return next;
  }

  /** Move or resize a frame. Layout is presentation, not data: no version bump, no event for the agent. */
  setLayout(toolId: string, input: Partial<Layout>): Tool {
    const t = this.getTool(toolId);
    const cur = t.layout ?? { x: 0, y: 0, w: DEFAULT_WIDTH[t.kind] ?? 400 };
    const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback);
    const layout: Layout = {
      x: Math.max(-100_000, Math.min(100_000, num(input.x, cur.x))),
      y: Math.max(-100_000, Math.min(100_000, num(input.y, cur.y))),
      w: clampWidth(num(input.w, cur.w)),
      ...(input.h !== undefined || cur.h !== undefined ? { h: Math.max(40, Math.min(20_000, num(input.h, cur.h ?? 300))) } : {}),
    };
    const next = { ...t, layout };
    this.tools.set(t.id, next);
    this.emit({ type: "tool", tool: next });
    return next;
  }

  /** Next free spot: right of the newest frame, wrapping to a new row past ROW_LIMIT, never overlapping. */
  private autoPlace(kind: string, w: number, estH: number): Layout {
    const GAP = 48;
    const ROW_LIMIT = 1800;
    const frames = [...this.tools.values()]
      .filter((t) => t.layout)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((t) => ({ ...t.layout!, h: t.layout!.h ?? estimateHeight(t) }));
    if (!frames.length) return { x: 0, y: 0, w };
    const last = frames.at(-1)!;
    let x = last.x + last.w + GAP;
    let y = last.y;
    if (x + w > ROW_LIMIT) {
      x = 0;
      y = Math.max(...frames.map((f) => f.y + f.h)) + GAP * 1.5;
    }
    const hits = (r: { x: number; y: number; w: number; h: number }) =>
      frames.some((f) => r.x < f.x + f.w + GAP / 2 && f.x < r.x + r.w + GAP / 2 && r.y < f.y + f.h + GAP / 2 && f.y < r.y + r.h + GAP / 2);
    for (let i = 0; i < 200 && hits({ x, y, w, h: estH }); i++) y += 40;
    return { x, y, w };
  }

  deleteTool(actor: Actor, toolId: string) {
    const t = this.getTool(toolId);
    if (actor === "agent" && t.createdBy !== "agent") throw new BoardError("the agent can only delete tools it created", 403);
    this.tools.delete(toolId);
    this.emit({ type: "tool_deleted", toolId });
    this.log(actor, "tool_deleted", [`Deleted "${t.title}"`, `"${t.title}" 도구 삭제`], { toolId });
  }

  private checkAccess(actor: Actor, t: Tool) {
    if (actor === "agent" && t.agentAccess !== "write") {
      throw new BoardError(`"${t.title}" is read-only for the agent. Ask the person with board_ask instead.`, 403);
    }
  }

  private checkVersion(t: Tool, baseVersion?: number) {
    if (baseVersion !== undefined && baseVersion !== t.version) {
      throw new BoardError(
        `version conflict: you sent baseVersion ${baseVersion} but the tool is at version ${t.version} (last changed by ${t.updatedBy}). Re-read it and retry.`,
        409,
        { tool: t },
      );
    }
  }

  private checkGates(before: any, after: any) {
    const prev = new Map<string, any>(before.items.map((i: any) => [i.id, i]));
    for (const item of after.items) {
      const old = prev.get(item.id);
      const gated = item.gate === "human" || old?.gate === "human";
      if (gated && (old?.done ?? false) !== item.done) {
        throw new BoardError(
          `item "${item.label}" needs a person's approval. Call board_ask with kind "approval", toolId and itemId "${item.id}" instead of writing done.`,
          403,
        );
      }
      if (old?.gate === "human" && item.gate !== "human") throw new BoardError(`the agent cannot remove the human gate on "${item.label}"`, 403);
    }
  }

  // ── apps: logs, events, files ─────────────────────────────────────────────
  appendAppLog(toolId: string, level: string, message: string) {
    this.getTool(toolId);
    const logs = this.appLogs.get(toolId) ?? [];
    logs.push({ at: now(), level, message: String(message).slice(0, 4000) });
    if (logs.length > 200) logs.splice(0, logs.length - 200);
    this.appLogs.set(toolId, logs);
  }

  getAppLogs(toolId: string, clear = false): AppLog[] {
    this.getTool(toolId);
    const logs = this.appLogs.get(toolId) ?? [];
    if (clear) this.appLogs.delete(toolId);
    return logs;
  }

  appEvent(toolId: string, type: string, payload: unknown) {
    const t = this.getTool(toolId);
    let detail = "";
    try {
      detail = payload === undefined ? "" : ` ${JSON.stringify(payload)}`;
    } catch {
      detail = " (payload not serializable)";
    }
    return this.log("human", "app_event", `[${t.title} · ${t.id}] ${String(type).slice(0, 80)}${detail.slice(0, 1500)}`, { toolId });
  }

  fileUploaded(toolId: string, meta: { name: string; size: number; path: string }) {
    const t = this.getTool(toolId);
    return this.log(
      "human",
      "file_uploaded",
      [`[${t.title} · ${t.id}] Uploaded ${meta.name} (${meta.size} bytes) → ${meta.path}`, `[${t.title} · ${t.id}] 파일 업로드: ${meta.name} (${meta.size} bytes) → ${meta.path}`],
      { toolId },
    );
  }

  // ── channels: named values shared by every app on the board ──────────────
  listChannels() {
    return [...this.channels.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getChannel(name: string): Channel {
    const c = this.channels.get(name);
    if (!c) {
      const known = this.listChannels().map((x) => x.name).join(", ") || "none";
      throw new BoardError(`channel "${name}" not found. Known channels: ${known}`, 404);
    }
    return c;
  }

  /** Replace a channel's value (creating it if needed). toolId: the app that wrote it. */
  setChannel(actor: Actor, name: string, value: unknown, opts: { toolId?: string; baseVersion?: number } = {}): Channel {
    if (typeof name !== "string" || !CHANNEL_NAME.test(name)) throw new BoardError(`channel name must match ${CHANNEL_NAME} (letters, digits, _ . : -; up to 64)`);
    if (value === undefined) throw new BoardError("value is required (use channel delete to remove a channel)");
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      throw new BoardError("channel value must be JSON");
    }
    if (json.length > CHANNEL_MAX_BYTES) throw new BoardError(`channel value is ${json.length} bytes; keep it under ${CHANNEL_MAX_BYTES} (save big data as files and share the path)`, 413);
    const cur = this.channels.get(name);
    if (!cur && this.channels.size >= MAX_CHANNELS) throw new BoardError(`a board holds at most ${MAX_CHANNELS} channels; delete unused ones first`, 409);
    if (opts.baseVersion !== undefined && opts.baseVersion !== (cur?.version ?? 0)) {
      throw new BoardError(`version conflict: you sent baseVersion ${opts.baseVersion} but channel "${name}" is at version ${cur?.version ?? 0}. Re-read it and retry.`, 409, { channel: cur });
    }
    const app = opts.toolId ? this.tools.get(opts.toolId) : undefined;
    const ch: Channel = { name, value: JSON.parse(json), version: (cur?.version ?? 0) + 1, updatedAt: now(), updatedBy: actor, ...(app ? { toolId: app.id } : {}) };
    this.channels.set(name, ch);
    this.emit({ type: "channel", channel: ch });
    const by = app ? ` by [${app.title} · ${app.id}]` : "";
    const byKo = app ? ` [${app.title}]` : "";
    this.log(actor, "channel_updated", [`Channel "${name}" updated${by}: ${describeValue(ch.value)}`, `채널 "${name}" 변경${byKo}: ${describeValue(ch.value, "ko")}`], app ? { toolId: app.id } : {}, `channel:${name}:${app?.id ?? ""}`);
    return ch;
  }

  deleteChannel(actor: Actor, name: string) {
    this.getChannel(name);
    this.channels.delete(name);
    this.emit({ type: "channel_deleted", name });
    this.log(actor, "channel_deleted", [`Deleted channel "${name}"`, `채널 "${name}" 삭제`]);
  }

  // ── asks (agent → person) ──────────────────────────────────────────────────
  createAsk(
    actor: Actor,
    input: { kind: "approval" | "input"; title: string; message?: string; toolId?: string; itemId?: string; fields?: FormField[] },
  ): Ask {
    if (input.toolId) {
      const t = this.getTool(input.toolId);
      if (input.itemId && t.kind === "checklist" && !t.state.items.some((i: any) => i.id === input.itemId)) {
        throw new BoardError(`item "${input.itemId}" not found in "${t.title}"`, 404);
      }
    }
    if (input.kind === "input" && (!input.fields || input.fields.length === 0)) {
      throw new BoardError('kind "input" needs at least one field');
    }
    const ask: Ask = {
      id: shortId("ask"),
      kind: input.kind,
      title: input.title,
      message: input.message,
      toolId: input.toolId,
      itemId: input.itemId,
      fields: input.fields,
      status: "pending",
      createdAt: now(),
    };
    this.asks.set(ask.id, ask);
    this.emit({ type: "ask", ask });
    this.log(actor, "ask_created", [`${ask.kind === "approval" ? "Approval" : "Input"} request: ${ask.title}`, `${ask.kind === "approval" ? "승인" : "입력"} 요청: ${ask.title}`], {
      askId: ask.id,
      toolId: ask.toolId,
    });
    return ask;
  }

  getAsk(askId: string): Ask {
    const a = this.asks.get(askId);
    if (!a) throw new BoardError(`ask "${askId}" not found`, 404);
    return a;
  }

  /** lang: the person's UI language, for the note written onto an approved checklist item. */
  answerAsk(askId: string, answer: { approved?: boolean; values?: Record<string, unknown>; comment?: string }, lang: "en" | "ko" = "en"): Ask {
    const a = this.getAsk(askId);
    if (a.status !== "pending") throw new BoardError(`ask "${askId}" is already ${a.status}`, 409);
    const answered: Ask = { ...a, status: "answered", answer, answeredAt: now() };
    this.asks.set(a.id, answered);
    // An approved gate marks its checklist item done, as the person.
    if (a.kind === "approval" && answer.approved && a.toolId && a.itemId) {
      const t = this.tools.get(a.toolId);
      const idx = t?.kind === "checklist" ? t.state.items.findIndex((i: any) => i.id === a.itemId) : -1;
      if (t && idx >= 0) {
        const note = [lang === "ko" ? "승인됨" : "Approved", answer.comment].filter(Boolean).join(" · ");
        this.patchState(
          "human",
          t.id,
          [
            { op: "replace", path: `/items/${idx}/done`, value: true },
            { op: "add", path: `/items/${idx}/note`, value: note },
          ],
          undefined,
          [`Approved "${t.state.items[idx].label}"`, `"${t.state.items[idx].label}" 승인 완료`],
          { askId: a.id },
        );
      }
    }
    this.emit({ type: "ask", ask: answered });
    const verdict = a.kind === "approval" ? (answer.approved ? ["approved", "승인"] : ["rejected", "거절"]) : ["answered", "응답"];
    const note = answer.comment ? ` (${answer.comment})` : "";
    this.log("human", "ask_answered", [`${a.title} → ${verdict[0]}${note}`, `${a.title} → ${verdict[1]}${note}`], { askId: a.id, toolId: a.toolId });
    for (const wake of this.askWaiters.get(a.id) ?? []) wake(answered);
    this.askWaiters.delete(a.id);
    return answered;
  }

  /** Wait until an ask is answered, or the timeout passes. */
  waitAsk(askId: string, timeoutMs: number, signal?: AbortSignal): Promise<Ask> {
    const a = this.getAsk(askId);
    if (a.status !== "pending") return Promise.resolve(a);
    return new Promise((resolve) => {
      const waiters = this.askWaiters.get(askId) ?? new Set();
      this.askWaiters.set(askId, waiters);
      const done = (x: Ask) => {
        clearTimeout(timer);
        waiters.delete(done);
        signal?.removeEventListener("abort", onAbort);
        resolve(x);
      };
      const onAbort = () => done(this.getAsk(askId));
      const timer = setTimeout(() => done(this.getAsk(askId)), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.add(done);
    });
  }

  // ── human → agent events ───────────────────────────────────────────────────
  postMessage(text: string, toolId?: string) {
    const t = toolId ? this.getTool(toolId) : undefined;
    const summary = (t ? `[${t.title} · ${t.id}] ` : "") + text.slice(0, 4000);
    return this.log("human", "message", summary, t ? { toolId: t.id } : {});
  }

  /** Record (for history only) a request the person typed to the agent from the board. */
  logPrompt(text: string, toolIds: string[]) {
    const titles = toolIds.map((id) => this.tools.get(id)?.title).filter(Boolean);
    const about = titles.length ? ` [${titles.join(", ")}]` : "";
    return this.log("human", "prompt", [`Asked Claude${about}: ${text.slice(0, 300)}`, `Claude에게 요청${about}: ${text.slice(0, 300)}`], toolIds[0] ? { toolId: toolIds[0] } : {});
  }

  postStop(reason?: string) {
    return this.log("human", "stop", reason ? [`Stop requested: ${reason}`, `중단 요청: ${reason}`] : ["Stop requested", "중단 요청"]);
  }

  /** Long-poll for human events the agent has not seen. Marks them delivered. */
  async waitForAgentEvents(timeoutMs: number, signal?: AbortSignal): Promise<BoardEvent[]> {
    let pending = this.undeliveredForAgent();
    if (pending.length === 0) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.eventWaiters.delete(wake);
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        const timer = setTimeout(wake, timeoutMs);
        signal?.addEventListener("abort", wake, { once: true });
        this.eventWaiters.add(wake);
      });
      // Let a burst of edits settle so the agent gets them together.
      await new Promise((r) => setTimeout(r, 150));
      pending = this.undeliveredForAgent();
    }
    if (pending.length) {
      this.agentCursor = pending.at(-1)!.seq;
      for (const seq of this.acked) if (seq <= this.agentCursor) this.acked.delete(seq);
    }
    return pending;
  }

  /** Mark everything up to now as seen by the agent (used after it reads the board). */
  markAgentCaughtUp() {
    this.agentCursor = this.seq;
  }
}

const clampWidth = (w: number) => Math.max(240, Math.min(1600, Math.round(w)));

/** Rough frame height before the board has measured it. */
function estimateHeight(t: Tool): number {
  if (t.layout?.h) return t.layout.h;
  switch (t.kind) {
    case "checklist":
      return 130 + 36 * (t.state?.items?.length ?? 0);
    case "table":
      return 120 + 34 * Math.min(t.state?.rows?.length ?? 0, 10);
    case "form":
      return 110 + 62 * (t.props?.fields?.length ?? 0);
    case "app":
      return t.props?.height ?? 320;
    default:
      return 180;
  }
}

function describePatch(t: Tool, patch: any[]): [string, string] {
  if (t.kind === "checklist") {
    const en: string[] = [];
    const ko: string[] = [];
    for (const op of patch) {
      const m = /^\/items\/(\d+)\/done$/.exec(op.path ?? "");
      if (m && op.op === "replace") {
        const item = t.state.items[Number(m[1])];
        if (!item) continue;
        en.push(`${op.value ? "done" : "not done"}: ${item.label}`);
        ko.push(`${op.value ? "완료" : "미완료"}: ${item.label}`);
      }
    }
    if (en.length) return [`"${t.title}" ${en.join(", ")}`, `"${t.title}" ${ko.join(", ")}`];
  }
  if (t.kind === "app") return [`"${t.title}" app state changed`, `"${t.title}" 앱 상태 변경`];
  return [`"${t.title}" state changed (${patch.length} ops)`, `"${t.title}" 상태 변경 (${patch.length}개 연산)`];
}
