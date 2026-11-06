// Board service: the single source of truth for tools, asks and the event log.
// Browser, MCP and the wb CLI all go through this module.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import jsonpatch from "fast-json-patch";
import {
  BROWSER_HEIGHT,
  BROWSER_WIDTH,
  browserUrlProblem,
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
  type Link,
  type LinkDirection,
  LINK_DIRECTIONS,
  frameAnchor,
  inSection,
  SECTION_COLORS,
  SECTION_MIN,
  sectionInside,
  type Section,
  type SectionColor,
  type SectionLayout,
  fixedHeight,
  heightRange,
  TOOL_NAME,
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
  | { type: "link"; link: Link }
  | { type: "link_deleted"; linkId: string }
  | { type: "section"; section: Section }
  | { type: "section_deleted"; sectionId: string }
  | { type: "event"; event: BoardEvent };

interface Persisted {
  tools: Tool[];
  asks: Ask[];
  events: BoardEvent[];
  seq: number;
  channels?: Channel[];
  links?: Link[];
  sections?: Section[];
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
  "browser",
  "link",
  "section",
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
  private links = new Map<string, Link>();
  private sections = new Map<string, Section>();
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
  /** Where the work is, for placing the agent's new tools next to it: the tools the person selected or sent a request
   *  about, or the tool the agent last made or changed, whichever came last. Not saved. */
  private focus: string[] = [];

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
      // Boards from before names: every tool gets one, oldest first (note1, browser1, …).
      for (const t of [...this.tools.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) if (!t.name) t.name = this.defaultName(t.kind);
      for (const l of data.links ?? []) if (this.tools.has(l.from) && this.tools.has(l.to)) this.links.set(l.id, l);
      for (const sec of data.sections ?? []) this.sections.set(sec.id, sec);
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
        links: [...this.links.values()],
        sections: [...this.sections.values()],
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
      links: [...this.links.values()],
      sections: [...this.sections.values()],
    };
  }

  listTools() {
    return [...this.tools.values()];
  }

  /** A tool by id or by name ("note1" or "@note1"). */
  getTool(toolId: string): Tool {
    const t = this.tools.get(toolId) ?? this.byName(toolId);
    if (!t) {
      const known = [...this.tools.values()].map((x) => `@${x.name} (${x.id}, "${x.title}")`).join(", ") || "none";
      throw new BoardError(`tool "${toolId}" not found. Known tools: ${known}`, 404);
    }
    return t;
  }

  /** The id behind an id or a name; anything else comes back as it is (and fails later with a clear message). */
  resolveToolId(ref: string): string {
    return this.tools.has(ref) ? ref : (this.byName(ref)?.id ?? ref);
  }

  private byName(ref: string): Tool | undefined {
    const want = String(ref ?? "").trim().replace(/^@/, "").toLowerCase();
    if (!want) return undefined;
    for (const t of this.tools.values()) if (t.name?.toLowerCase() === want) return t;
    return undefined;
  }

  private sectionByName(ref: string): Section | undefined {
    const want = String(ref ?? "").trim().replace(/^@/, "").toLowerCase();
    if (!want) return undefined;
    for (const sec of this.sections.values()) if (sec.name.toLowerCase() === want) return sec;
    return undefined;
  }

  /** kind + the first free number: note1, note2, browser1, section1… (tools and sections share names) */
  private defaultName(kind: string) {
    for (let n = 1; ; n++) if (!this.byName(`${kind}${n}`) && !this.sectionByName(`${kind}${n}`)) return `${kind}${n}`;
  }

  /** A valid name nobody else on the board has, tool or section (case does not matter). */
  private checkName(name: string, self?: string): string {
    const n = String(name ?? "").trim().replace(/^@/, "");
    if (!TOOL_NAME.test(n)) throw new BoardError(`"${n}" can't be a name: use letters, digits, _ . - (no spaces), up to 40, e.g. research or 리서치_메모`);
    const other = this.byName(n);
    if (other && other.id !== self) throw new BoardError(`another tool is already named @${other.name} ("${other.title}")`, 409);
    const sec = this.sectionByName(n);
    if (sec && sec.id !== self) throw new BoardError(`a section is already named @${sec.name} ("${sec.title}")`, 409);
    if ((this.tools.has(n) || this.sections.has(n)) && n !== self) throw new BoardError(`"${n}" is an id; pick another name`, 409);
    return n;
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
    input: {
      title: string;
      name?: string;
      description?: string;
      kind: ToolKind;
      props?: unknown;
      state?: unknown;
      agentAccess?: "read" | "write";
      id?: string;
      width?: number;
      height?: number;
      at?: { x: number; y: number };
      /** A tool or section (id or name) to put it next to; without it, the agent's tools go next to the work (focus). */
      near?: string;
    },
    /** fileOk: made by the file routes (dropped, file_add) or brought back by undo, which checked the file. */
    opts: { fileOk?: boolean } = {},
  ): Tool {
    if (!TOOL_KINDS.includes(input.kind)) throw new BoardError(`unknown kind "${input.kind}". Use one of: ${TOOL_KINDS.join(", ")}`);
    // A file tool points at a file on this machine: only the file routes make one (they check the file exists).
    if (input.kind === "file" && !opts.fileOk) throw new BoardError('a file tool is made by dropping a file on the board, or with file_add (path); not with tool_create');
    if (input.kind === "code" && !opts.fileOk) throw new BoardError("a code editor is opened with code_open (path of a folder or file); not with tool_create");
    const v = validateTool(input.kind, input.props, input.state);
    if (!v.ok) throw new BoardError(v.error);
    const id = input.id && !this.tools.has(input.id) ? input.id : shortId(input.kind);
    const name = input.name ? this.checkName(input.name) : this.defaultName(input.kind);
    const compiled = input.kind === "app" ? this.compile(v.props.source) : undefined;
    const t: Tool = {
      id,
      name,
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
    const w = clampWidth(input.width ?? DEFAULT_WIDTH[t.kind] ?? 400, t.kind);
    const at = input.at && Number.isFinite(input.at.x) && Number.isFinite(input.at.y) ? input.at : null;
    // A person adding a tool drops it where they are looking; the agent's go next to what the work is about.
    const near = !at && (actor === "agent" || input.near) ? this.anchorOf(input.near) : null;
    const estH = fixedHeight(t.kind) ? clampHeight(t.kind, input.height ?? heightRange(t.kind).default) : estimateHeight(t);
    t.layout = at ? { x: Math.round(at.x - w / 2), y: Math.round(at.y - 80), w } : ((near && this.placeNear(near, w, estH)) ?? this.autoPlace(t.kind, w, estH));
    // A browser frame has a fixed height (the page scrolls inside it).
    if (fixedHeight(t.kind)) t.layout.h = clampHeight(t.kind, input.height ?? heightRange(t.kind).default);
    this.tools.set(t.id, t);
    if (near) this.growHome(near, t);
    if (actor === "agent") this.focus = [t.id]; // the next one goes next to this one
    this.emit({ type: "tool", tool: t });
    this.log(actor, "tool_created", [`Created ${t.kind} "${t.title}"`, `"${t.title}" ${t.kind} 도구 생성`], { toolId: t.id });
    return t;
  }

  updateTool(
    actor: Actor,
    toolId: string,
    input: { title?: string; name?: string; description?: string; props?: unknown; agentAccess?: "read" | "write"; baseVersion?: number },
  ): Tool {
    const t = this.getTool(toolId);
    this.checkAccess(actor, t);
    this.checkVersion(t, input.baseVersion);
    if (actor === "agent" && input.agentAccess !== undefined) throw new BoardError("the agent cannot change its own access level", 403);
    if ((t.kind === "file" || t.kind === "code") && input.props !== undefined) throw new BoardError(`a ${t.kind} tool's path is fixed; ${t.kind === "file" ? "add the file" : "open the folder"} again instead`, 400);
    const props = input.props !== undefined ? input.props : t.props;
    const v = validateTool(t.kind, props, t.state);
    if (!v.ok) throw new BoardError(v.error);
    const compiled = t.kind === "app" && input.props !== undefined ? this.compile(v.props.source) : t.compiled;
    if (t.kind === "app" && input.props !== undefined) this.appLogs.delete(t.id); // fresh code, fresh logs
    const name = input.name !== undefined && input.name !== t.name ? this.checkName(input.name, t.id) : t.name;
    const next: Tool = {
      ...t,
      ...(compiled !== undefined ? { compiled } : {}),
      name,
      title: input.title?.trim() || t.title,
      description: input.description?.trim() ?? t.description,
      props: v.props,
      agentAccess: input.agentAccess ?? t.agentAccess,
      version: t.version + 1,
      updatedBy: actor,
      updatedAt: now(),
    };
    this.tools.set(t.id, next);
    if (actor === "agent") this.focus = [t.id];
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
    if (t.kind === "browser") this.checkBrowser(actor, t, v.state);
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
      w: clampWidth(num(input.w, cur.w), t.kind),
      ...(input.h !== undefined || cur.h !== undefined ? { h: Math.max(40, Math.min(20_000, num(input.h, cur.h ?? 300))) } : {}),
    };
    if (fixedHeight(t.kind)) layout.h = clampHeight(t.kind, layout.h ?? heightRange(t.kind).default);
    const next = { ...t, layout };
    this.tools.set(t.id, next);
    this.emit({ type: "tool", tool: next });
    return next;
  }

  /** Next free spot: right of the newest frame, wrapping to a new row past ROW_LIMIT, never overlapping. */
  /** The person is working on these tools (selected them, or sent Claude a request about them). */
  setFocus(toolIds: string[]) {
    const ids = toolIds.map((id) => this.resolveToolId(id)).filter((id) => this.tools.get(id)?.layout);
    if (ids.length) this.focus = ids.slice(0, 50);
  }

  /** What a new tool of the agent goes next to: the tool or section it names, else where the work is (focus). */
  private anchorOf(near?: string): Layout[] | null {
    if (near) {
      const id = this.resolveToolId(near);
      if (this.tools.get(id)?.layout) return [this.tools.get(id)!.layout!];
      const sec = this.listSections().find((x) => x.id === near || x.name.toLowerCase() === near.replace(/^@/, "").toLowerCase());
      if (!sec) throw new BoardError(`near: no tool or section "${near}"`, 404);
      const inside = this.toolsIn(sec.id).map((t) => t.layout!);
      // An empty section: its top-left corner, inside (the spot to the right of this point).
      return inside.length ? inside : [{ x: sec.layout.x, y: sec.layout.y + 76, w: 0, h: 1 }];
    }
    const ids = this.focus.filter((id) => this.tools.get(id)?.layout);
    return ids.length ? ids.map((id) => this.tools.get(id)!.layout!) : null;
  }

  /** The free spot nearest to these frames: to their right, else below, else left or above. It overlaps no frame, and
   *  doesn't land in (or across) a section unless the frames are in it, so it doesn't join a section by accident. */
  private placeNear(anchors: Layout[], w: number, h: number): Layout | null {
    const GAP = 48;
    const STEP = 40;
    const frames = this.listTools().map((t) => ({ ...t.layout!, h: t.layout!.h ?? estimateHeight(t) }));
    const height = (l: Layout) => frames.find((f) => f.x === l.x && f.y === l.y && f.w === l.w)?.h ?? l.h ?? 200;
    const box = {
      x: Math.min(...anchors.map((a) => a.x)),
      y: Math.min(...anchors.map((a) => a.y)),
      r: Math.max(...anchors.map((a) => a.x + a.w)),
      b: Math.max(...anchors.map((a) => a.y + height(a))),
    };
    const homes = this.listSections().filter((sec) => anchors.some((a) => inSection(frameAnchor(a), sec.layout)));
    const free = (x: number, y: number) => {
      if (frames.some((f) => x < f.x + f.w + GAP / 2 && f.x < x + w + GAP / 2 && y < f.y + f.h + GAP / 2 && f.y < y + h + GAP / 2)) return false;
      for (const sec of this.sections.values()) {
        const L = sec.layout;
        const touches = x < L.x + L.w && L.x < x + w && y < L.y + L.h && L.y - 36 < y + h; // 36: its name above it
        if (!touches) continue;
        const inside = x >= L.x && y >= L.y && x + w <= L.x + L.w && y + h <= L.y + L.h;
        if (!inside || !homes.includes(sec)) return false;
      }
      return true;
    };
    // Candidates on lines through the anchors' edges, scored by distance; right of them first, then below.
    const xs = new Set<number>();
    const ys = new Set<number>();
    for (let i = -40; i <= 60; i++) {
      xs.add(box.r + GAP + i * STEP).add(box.x + i * STEP).add(box.x - w - GAP - i * STEP);
      ys.add(box.y + i * STEP).add(box.b + GAP + i * STEP).add(box.y - h - GAP - i * STEP);
    }
    const spots: { x: number; y: number; score: number }[] = [];
    for (const x of xs)
      for (const y of ys) {
        let score: number;
        if (x >= box.r + GAP) score = x - box.r + Math.abs(y - box.y) * 0.6;
        else if (y >= box.b + GAP) score = y - box.b + Math.abs(x - box.x) * 0.6 + 40;
        else if (x + w + GAP <= box.x) score = box.x - x - w + Math.abs(y - box.y) * 0.6 + 400;
        else if (y + h + GAP <= box.y) score = box.y - y - h + Math.abs(x - box.x) * 0.6 + 400;
        else continue;
        if (homes.length && !homes.some((sec) => inSection(frameAnchor({ x, y, w }), sec.layout))) score += 300; // stay in its section if there is room
        spots.push({ x, y, score });
      }
    spots.sort((a, b) => a.score - b.score);
    const spot = spots.find((p) => free(p.x, p.y));
    return spot ? { x: Math.round(spot.x), y: Math.round(spot.y), w } : null;
  }

  /** A tool put next to work in a section, but outside it (there was no room): the section grows to take it in, when
   *  that brings in no other tool and runs into no other section. */
  private growHome(anchors: Layout[], t: Tool) {
    const L = t.layout!;
    const homes = this.listSections().filter((sec) => anchors.some((a) => inSection(frameAnchor(a), sec.layout)));
    if (!homes.length) return;
    const home = homes.reduce((a, b) => (a.layout.w * a.layout.h <= b.layout.w * b.layout.h ? a : b)); // the innermost
    const S = home.layout;
    if (inSection(frameAnchor(L), S)) return;
    const PAD = 48;
    const x0 = Math.min(S.x, L.x - PAD);
    const y0 = Math.min(S.y, L.y - PAD - 28);
    const x1 = Math.max(S.x + S.w, L.x + L.w + PAD);
    const y1 = Math.max(S.y + S.h, L.y + (L.h ?? estimateHeight(t)) + PAD);
    const grown = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const members = new Set(this.toolsIn(home.id).map((x) => x.id));
    if (this.listTools().some((o) => o.id !== t.id && !members.has(o.id) && o.layout && inSection(frameAnchor(o.layout), grown))) return;
    for (const sec of this.sections.values()) {
      if (sec.id === home.id || sectionInside(sec.layout, S)) continue; // sections inside it stay inside
      const G = sec.layout;
      if (sectionInside(S, G)) {
        if (!sectionInside(grown, G)) return; // it would stick out of the section around it
        continue;
      }
      if (grown.x < G.x + G.w && G.x < grown.x + grown.w && grown.y < G.y + G.h && G.y - 36 < grown.y + grown.h) return; // 36: a name above
    }
    this.setSectionLayout(home.id, grown);
  }

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
    this.tools.delete(t.id);
    for (const l of [...this.links.values()]) {
      if (l.from !== t.id && l.to !== t.id) continue;
      this.links.delete(l.id);
      this.emit({ type: "link_deleted", linkId: l.id });
    }
    this.emit({ type: "tool_deleted", toolId: t.id });
    this.log(actor, "tool_deleted", [`Deleted "${t.title}"`, `"${t.title}" 도구 삭제`], { toolId: t.id });
  }

  // ── sections: named areas that group tools (Figma's sections) ─────────────
  // A tool belongs to a section when the middle of its top part lies inside it (frameAnchor), so a tool put there by
  // anyone belongs at once. Sections inside a section move with it.
  listSections() {
    return [...this.sections.values()];
  }

  /** A section by id or by name ("research" or "@research"). */
  getSection(ref: string): Section {
    const sec = this.sections.get(ref) ?? this.sectionByName(ref);
    if (!sec) {
      const known = this.listSections().map((x) => `@${x.name} (${x.id}, "${x.title}")`).join(", ") || "none";
      throw new BoardError(`section "${ref}" not found. Sections: ${known}`, 404);
    }
    return sec;
  }

  /** The tools in a section (sections inside it included). */
  toolsIn(sectionId: string): Tool[] {
    const sec = this.getSection(sectionId);
    return this.listTools().filter((t) => t.layout && inSection(frameAnchor(t.layout), sec.layout));
  }

  /** The smallest section a tool is in, if any. */
  sectionOf(toolId: string): Section | undefined {
    const t = this.tools.get(toolId);
    if (!t?.layout) return undefined;
    const p = frameAnchor(t.layout);
    return this.listSections()
      .filter((sec) => inSection(p, sec.layout))
      .sort((a, b) => a.layout.w * a.layout.h - b.layout.w * b.layout.h)[0];
  }

  private sectionLayout(input: Partial<SectionLayout>, cur?: SectionLayout): SectionLayout {
    const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback);
    const lim = (v: number) => Math.max(-100_000, Math.min(100_000, v));
    return {
      x: lim(num(input.x, cur?.x ?? 0)),
      y: lim(num(input.y, cur?.y ?? 0)),
      w: Math.max(SECTION_MIN.w, Math.min(40_000, num(input.w, cur?.w ?? 640))),
      h: Math.max(SECTION_MIN.h, Math.min(40_000, num(input.h, cur?.h ?? 420))),
    };
  }

  private checkColor(c: unknown): SectionColor {
    if (!SECTION_COLORS.includes(c as SectionColor)) throw new BoardError(`color must be one of: ${SECTION_COLORS.join(", ")}`);
    return c as SectionColor;
  }

  /** A new section: around some tools (with room for its label), or at a given place and size. */
  createSection(actor: Actor, input: { title?: string; name?: string; color?: SectionColor; around?: string[]; layout?: Partial<SectionLayout>; id?: string }): Section {
    let layout: SectionLayout;
    if (input.around?.length) {
      const ts = input.around.map((ref) => this.getTool(ref)).filter((t) => t.layout);
      if (!ts.length) throw new BoardError("none of those tools is on the board");
      const PAD = 48;
      const x0 = Math.min(...ts.map((t) => t.layout!.x));
      const y0 = Math.min(...ts.map((t) => t.layout!.y));
      const x1 = Math.max(...ts.map((t) => t.layout!.x + t.layout!.w));
      const y1 = Math.max(...ts.map((t) => t.layout!.y + estimateHeight(t)));
      // Above the tools: each frame's own label (about 24 px). The section's name sits outside, above it.
      layout = this.sectionLayout({ x: x0 - PAD, y: y0 - PAD - 28, w: x1 - x0 + PAD * 2, h: y1 - y0 + PAD * 2 + 28 });
    } else if (input.layout) layout = this.sectionLayout(input.layout);
    else throw new BoardError("give the tools it goes around (around: [toolId…]) or its place and size (x, y, w, h)");
    const id = input.id && !this.sections.has(input.id) && !this.tools.has(input.id) ? input.id : shortId("sec");
    const name = input.name ? this.checkName(input.name) : this.defaultName("section");
    const title = (input.title ?? "").trim().slice(0, 80) || `Section ${name.replace(/^section/, "")}`;
    const sec: Section = { id, name, title, color: input.color ? this.checkColor(input.color) : "gray", layout, createdBy: actor, createdAt: now(), updatedAt: now() };
    this.sections.set(sec.id, sec);
    this.emit({ type: "section", section: sec });
    this.log(actor, "section", [`Made section "${sec.title}" (@${sec.name})`, `"${sec.title}" 섹션 만듦`], { sectionId: sec.id });
    return sec;
  }

  updateSection(actor: Actor, ref: string, input: { title?: string; name?: string; color?: SectionColor }): Section {
    const sec = this.getSection(ref);
    const next: Section = {
      ...sec,
      ...(input.title !== undefined ? { title: String(input.title).trim().slice(0, 80) || sec.title } : {}),
      ...(input.name !== undefined ? { name: this.checkName(input.name, sec.id) } : {}),
      ...(input.color !== undefined ? { color: this.checkColor(input.color) } : {}),
      updatedAt: now(),
    };
    this.sections.set(sec.id, next);
    this.emit({ type: "section", section: next });
    if (next.title !== sec.title || next.name !== sec.name)
      this.log(actor, "section", [`Renamed section "${sec.title}" to "${next.title}" (@${next.name})`, `섹션 이름 변경: "${sec.title}" → "${next.title}"`], { sectionId: sec.id });
    return next;
  }

  /**
   * Move or resize a section. moveContents: a move takes the tools and sections in it along (by where they are before
   * it moves), as dragging a section does in Figma; a resize leaves them where they are. Presentation, like a frame's
   * layout: no event for the agent.
   */
  setSectionLayout(ref: string, input: Partial<SectionLayout>, moveContents = false): { section: Section; moved: string[] } {
    const sec = this.getSection(ref);
    const layout = this.sectionLayout(input, sec.layout);
    const dx = layout.x - sec.layout.x;
    const dy = layout.y - sec.layout.y;
    const moved: string[] = [];
    if (moveContents && (dx || dy)) {
      for (const t of this.toolsIn(sec.id)) {
        this.setLayout(t.id, { x: t.layout!.x + dx, y: t.layout!.y + dy });
        moved.push(t.id);
      }
      for (const inner of this.listSections()) {
        if (inner.id === sec.id || !sectionInside(inner.layout, sec.layout)) continue;
        const next = { ...inner, layout: { ...inner.layout, x: inner.layout.x + dx, y: inner.layout.y + dy }, updatedAt: now() };
        this.sections.set(inner.id, next);
        this.emit({ type: "section", section: next });
        moved.push(inner.id);
      }
    }
    const next = { ...sec, layout, updatedAt: now() };
    this.sections.set(sec.id, next);
    this.emit({ type: "section", section: next });
    return { section: next, moved };
  }

  /** Remove a section. withContents (the person only): its tools and the sections inside go too. */
  deleteSection(actor: Actor, ref: string, withContents = false) {
    const sec = this.getSection(ref);
    if (withContents) {
      if (actor !== "human") throw new BoardError("only the person can delete a section with what is in it; the agent removes just the section", 403);
      for (const t of this.toolsIn(sec.id)) this.deleteTool(actor, t.id);
      for (const inner of this.listSections()) {
        if (inner.id === sec.id || !sectionInside(inner.layout, sec.layout)) continue;
        this.sections.delete(inner.id);
        this.emit({ type: "section_deleted", sectionId: inner.id });
      }
    }
    this.sections.delete(sec.id);
    this.emit({ type: "section_deleted", sectionId: sec.id });
    this.log(actor, "section", [`Removed section "${sec.title}"${withContents ? " and what was in it" : ""}`, `"${sec.title}" 섹션 삭제${withContents ? " (안의 도구 포함)" : ""}`], { sectionId: sec.id });
  }

  // ── links: lines between tools ────────────────────────────────────────────
  listLinks() {
    return [...this.links.values()];
  }

  /** The links that touch a tool. */
  linksOf(toolId: string) {
    return this.listLinks().filter((l) => l.from === toolId || l.to === toolId);
  }

  /** "@note1 → @browser1" (what the agent and the history read). */
  describeLink(l: Link) {
    const a = `@${this.tools.get(l.from)?.name ?? l.from}`;
    const b = `@${this.tools.get(l.to)?.name ?? l.to}`;
    return l.direction === "forward" ? `${a} → ${b}` : l.direction === "both" ? `${a} ↔ ${b}` : `${a} — ${b}`;
  }

  getLink(linkId: string): Link {
    const l = this.links.get(linkId);
    if (!l) throw new BoardError(`link "${linkId}" not found. Links: ${this.listLinks().map((x) => `${x.id} (${this.describeLink(x)})`).join(", ") || "none"}`, 404);
    return l;
  }

  /** Link two tools. A pair that is already linked keeps its one link (it comes back as it is). */
  createLink(actor: Actor, input: { from: string; to: string; direction?: LinkDirection }): Link {
    const a = this.getTool(String(input.from ?? ""));
    const b = this.getTool(String(input.to ?? ""));
    if (a.id === b.id) throw new BoardError("a link needs two different tools");
    const direction = this.checkDirection(input.direction ?? "none");
    const same = this.listLinks().find((l) => (l.from === a.id && l.to === b.id) || (l.from === b.id && l.to === a.id));
    if (same) return same;
    const l: Link = { id: shortId("link"), from: a.id, to: b.id, direction, createdBy: actor, createdAt: now(), updatedAt: now() };
    this.links.set(l.id, l);
    this.emit({ type: "link", link: l });
    const d = this.describeLink(l);
    this.log(actor, "link", [`Linked ${d}`, `연결: ${d}`], { linkId: l.id, toolId: b.id });
    return l;
  }

  /** Change a link's direction, or which end is which (from/to swapped makes "forward" point the other way). */
  updateLink(actor: Actor, linkId: string, input: { direction?: LinkDirection; from?: string; to?: string }): Link {
    const l = this.getLink(linkId);
    if (actor === "agent" && l.createdBy !== "agent") throw new BoardError("the agent can only change links it made; ask the person", 403);
    const from = input.from !== undefined ? this.getTool(String(input.from)).id : l.from;
    const to = input.to !== undefined ? this.getTool(String(input.to)).id : l.to;
    const ends = new Set([l.from, l.to]);
    if (!ends.has(from) || !ends.has(to) || from === to) throw new BoardError("from and to must be this link's two tools (swap them to turn it around)");
    const next: Link = { ...l, from, to, direction: input.direction !== undefined ? this.checkDirection(input.direction) : l.direction, updatedAt: now() };
    if (next.from === l.from && next.direction === l.direction) return l;
    this.links.set(l.id, next);
    this.emit({ type: "link", link: next });
    const d = this.describeLink(next);
    this.log(actor, "link", [`Changed a link: ${d}`, `연결 변경: ${d}`], { linkId: l.id, toolId: next.to });
    return next;
  }

  deleteLink(actor: Actor, linkId: string) {
    const l = this.getLink(linkId);
    if (actor === "agent" && l.createdBy !== "agent") throw new BoardError("the agent can only remove links it made; ask the person", 403);
    const d = this.describeLink(l);
    this.links.delete(l.id);
    this.emit({ type: "link_deleted", linkId: l.id });
    this.log(actor, "link", [`Removed the link ${d}`, `연결 삭제: ${d}`], { linkId: l.id });
  }

  private checkDirection(d: unknown): LinkDirection {
    if (!LINK_DIRECTIONS.includes(d as LinkDirection)) throw new BoardError(`direction must be one of: ${LINK_DIRECTIONS.join(", ")}`);
    return d as LinkDirection;
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

  /** The person can always take the browser over and hand it back; the agent can hand it over but never take it back. */
  private checkBrowser(actor: Actor, t: Tool, next: any) {
    if (actor === "agent" && t.state.control === "person") {
      throw new BoardError(`The person has taken control of browser "${t.title}". Wait for them to hand it back (board_wait_event).`, 409);
    }
    if (actor === "agent" && next.control === "shared" && t.state.control !== "shared") throw new BoardError("only the person can hand the browser back", 403);
    if (next.url !== t.state.url) {
      const problem = browserUrlProblem(next.url);
      if (problem) throw new BoardError(problem);
    }
  }

  /**
   * State the system itself observed (a board browser navigated, its title changed): no actor, no history line,
   * no news for the agent. Views and apps still get the new state.
   */
  setSystemState(toolId: string, partial: Record<string, unknown>): Tool | undefined {
    const t = this.tools.get(toolId);
    if (!t) return undefined;
    const merged = { ...t.state, ...partial };
    if (JSON.stringify(merged) === JSON.stringify(t.state)) return t;
    const v = validateTool(t.kind, t.props, merged);
    if (!v.ok) return t;
    const next: Tool = { ...t, state: v.state, version: t.version + 1, updatedAt: now() };
    this.tools.set(t.id, next);
    this.emit({ type: "tool", tool: next });
    return next;
  }

  /** A history line about a board browser (what the agent did in it, a take-over, a download). */
  browserEvent(actor: Actor, toolId: string, summary: [string, string]) {
    return this.log(actor, "browser", summary, { toolId });
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

const clampWidth = (w: number, kind?: string) =>
  kind === "browser" || kind === "code" ? Math.max(BROWSER_WIDTH.min, Math.min(BROWSER_WIDTH.max, Math.round(w))) : Math.max(240, Math.min(1600, Math.round(w)));
const clampHeight = (kind: string, h: number) => {
  const r = heightRange(kind);
  return Math.max(r.min, Math.min(r.max, Math.round(Number(h) || r.default)));
};

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
    case "browser":
      return BROWSER_HEIGHT.default;
    case "file":
      return /^image\//.test(t.props?.mime ?? "") ? 320 : 170;
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
  if (t.kind === "browser") {
    const ctl = patch.find((op) => op.path === "/control");
    if (ctl?.value === "person") return [`Took over browser "${t.title}"`, `"${t.title}" 브라우저를 직접 조작`];
    if (ctl?.value === "shared") return [`Handed browser "${t.title}" back to Claude`, `"${t.title}" 브라우저를 Claude에게 돌려줌`];
    const url = patch.find((op) => op.path === "/url");
    if (url) return [`Browser "${t.title}" → ${String(url.value).slice(0, 300)}`, `"${t.title}" 브라우저 → ${String(url.value).slice(0, 300)}`];
  }
  return [`"${t.title}" state changed (${patch.length} ops)`, `"${t.title}" 상태 변경 (${patch.length}개 연산)`];
}
