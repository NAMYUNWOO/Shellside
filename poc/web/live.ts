// Live data the app frames of one board share: channels (named values) and every tool's latest state.
// Kept outside React so one app's write reaches the other apps at once, without re-rendering the whole canvas.
// Fed by the board WebSocket (useBoard); written by app frames (AppFrame).
import { createContext, useContext } from "react";
import type { Channel, Tool } from "../shared/catalog.ts";
import type { BoardApi } from "./api.ts";

export type LiveChange =
  /** origin: the app (toolId) whose own write this is; it already shows the value. */
  | { type: "channel"; name: string; origin?: string }
  | { type: "tool"; id: string }
  | { type: "tool_deleted"; id: string }
  /** A channel write from this app failed; the channel is back to the server's value. */
  | { type: "error"; origin: string; message: string };

/** version 0 = not on the server yet (or deleted). */
export interface ChannelEntry {
  value: unknown;
  version: number;
}

interface Outbox {
  value: unknown;
  origin: string;
  asAgent: boolean;
  dirty: boolean;
  inFlight: boolean;
  timer?: number;
  lastSent: number;
  failed: boolean;
  /** Newest server copy seen while our writes were pending (someone else may have written). */
  server?: Channel;
  /** The server's answer to our latest successful write. */
  acked?: Channel;
}

// At most one write per channel in flight, and this long between writes: dragging a slider sends ~12 writes/s, not 60.
const MIN_INTERVAL_MS = 80;

export class LiveStore {
  private channels = new Map<string, ChannelEntry>();
  private tools = new Map<string, Tool>();
  private outbox = new Map<string, Outbox>();
  private listeners = new Set<(c: LiveChange) => void>();

  constructor(private api: BoardApi) {}

  subscribe(fn: (c: LiveChange) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(c: LiveChange) {
    for (const fn of this.listeners) fn(c);
  }

  // ── reads ────────────────────────────────────────────────────────────────
  channel(name: string): ChannelEntry | undefined {
    return this.channels.get(name);
  }

  allChannels(): Record<string, ChannelEntry> {
    return Object.fromEntries(this.channels);
  }

  tool(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  allTools(): Tool[] {
    return [...this.tools.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ── fed by the board WebSocket ───────────────────────────────────────────
  /** First snapshot or reconnect: take the server's view (channels with unsent local writes keep them). */
  reset(tools: Tool[], channels: Channel[]) {
    const gone = [...this.tools.keys()].filter((id) => !tools.some((t) => t.id === id));
    this.tools = new Map(tools.map((t) => [t.id, t]));
    for (const id of gone) this.emit({ type: "tool_deleted", id });
    for (const t of tools) this.emit({ type: "tool", id: t.id });
    const names = new Set([...this.channels.keys(), ...channels.map((c) => c.name)]);
    for (const name of names) {
      const c = channels.find((x) => x.name === name);
      if (c) this.serverChannel(c, true);
      else this.serverChannelDeleted(name);
    }
  }

  serverTool(t: Tool) {
    this.tools.set(t.id, t);
    this.emit({ type: "tool", id: t.id });
  }

  serverToolDeleted(id: string) {
    if (!this.tools.delete(id)) return;
    this.emit({ type: "tool_deleted", id });
  }

  /** force: adopt the server's copy even if it is not newer (after a reconnect the server is the truth). */
  serverChannel(c: Channel, force = false) {
    const box = this.outbox.get(c.name);
    if (box) {
      // Our own writes are still landing; decide once they have (settle).
      if (!box.server || c.version >= box.server.version) box.server = c;
      return;
    }
    const cur = this.channels.get(c.name);
    if (cur && (force ? cur.version === c.version : cur.version >= c.version)) return;
    this.channels.set(c.name, { value: c.value, version: c.version });
    this.emit({ type: "channel", name: c.name });
  }

  serverChannelDeleted(name: string) {
    if (this.outbox.has(name)) return; // our pending write brings it back
    if (!this.channels.delete(name)) return;
    this.emit({ type: "channel", name });
  }

  // ── written by apps ──────────────────────────────────────────────────────
  /** An app set a channel: every other app sees it now; the server gets it right after. */
  setChannel(name: string, value: unknown, origin: string, asAgent: boolean) {
    const cur = this.channels.get(name);
    this.channels.set(name, { value, version: cur?.version ?? 0 });
    this.emit({ type: "channel", name, origin });
    let box = this.outbox.get(name);
    if (!box) {
      box = { value, origin, asAgent, dirty: true, inFlight: false, lastSent: 0, failed: false };
      this.outbox.set(name, box);
    }
    Object.assign(box, { value, origin, asAgent, dirty: true });
    this.pump(name, box);
  }

  private pump(name: string, box: Outbox) {
    if (box.inFlight || box.timer !== undefined || !box.dirty) return;
    const wait = box.lastSent + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) {
      box.timer = window.setTimeout(() => {
        box.timer = undefined;
        this.pump(name, box);
      }, wait);
      return;
    }
    box.dirty = false;
    box.inFlight = true;
    box.lastSent = Date.now();
    const { value, origin, asAgent } = box;
    this.api
      .setChannel(name, value, origin, asAgent)
      .then(
        (c) => {
          box.failed = false;
          if (!box.acked || c.version > box.acked.version) box.acked = c;
        },
        (err: Error) => {
          box.failed = true;
          this.emit({ type: "error", origin, message: `channel "${name}": ${err.message}` });
        },
      )
      .finally(() => {
        box.inFlight = false;
        if (box.dirty) return this.pump(name, box);
        this.outbox.delete(name);
        this.settle(name, box);
      });
  }

  /** All our writes have landed. Keep our value, unless someone wrote after us or our last write failed. */
  private settle(name: string, box: Outbox) {
    const latest = [box.server, box.acked].filter((c): c is Channel => !!c).sort((a, b) => b.version - a.version)[0];
    if (!latest) {
      // Nothing confirmed: show what the server holds (our local value may carry the old version number).
      this.api.getChannel(name).then(
        (c) => !this.outbox.has(name) && this.adopt(name, c),
        () => this.serverChannelDeleted(name),
      );
      return;
    }
    if (!box.failed && latest.version === box.acked?.version) {
      this.channels.set(name, { value: box.value, version: latest.version });
      return;
    }
    this.adopt(name, latest);
  }

  private adopt(name: string, c: Channel) {
    this.channels.set(name, { value: c.value, version: c.version });
    this.emit({ type: "channel", name });
  }
}

const LiveContext = createContext<LiveStore | null>(null);
export const LiveProvider = LiveContext.Provider;

/** The board's live store, for app frames. */
export function useLive(): LiveStore {
  const s = useContext(LiveContext);
  if (!s) throw new Error("useLive() must be used inside <LiveProvider>");
  return s;
}
