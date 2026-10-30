// Live board state over /ws/board, with reconnect.
import { useEffect, useMemo, useReducer, useState } from "react";
import type { Ask, BoardEvent, Channel, Link, Tool } from "../shared/catalog.ts";
import { makeApi, wsUrl, type Template } from "./api.ts";
import { appRegistry } from "./AppFrame.tsx";
import { LiveStore } from "./live.ts";

interface State {
  tools: Record<string, Tool>;
  asks: Record<string, Ask>;
  events: BoardEvent[];
  library: Template[];
  channels: Record<string, Channel>;
  links: Record<string, Link>;
}

type Msg =
  | { type: "snapshot"; tools: Tool[]; asks: Ask[]; events: BoardEvent[]; library?: Template[]; channels?: Channel[]; links?: Link[] }
  | { type: "library"; items: Template[] }
  | { type: "tool"; tool: Tool }
  | { type: "tool_deleted"; toolId: string }
  | { type: "ask"; ask: Ask }
  | { type: "channel"; channel: Channel }
  | { type: "channel_deleted"; name: string }
  | { type: "link"; link: Link }
  | { type: "link_deleted"; linkId: string }
  | { type: "event"; event: BoardEvent };

function reduce(s: State, m: Msg): State {
  switch (m.type) {
    case "snapshot":
      return {
        tools: Object.fromEntries(m.tools.map((t) => [t.id, t])),
        asks: Object.fromEntries(m.asks.map((a) => [a.id, a])),
        events: m.events,
        library: m.library ?? [],
        channels: Object.fromEntries((m.channels ?? []).map((c) => [c.name, c])),
        links: Object.fromEntries((m.links ?? []).map((l) => [l.id, l])),
      };
    case "link":
      return { ...s, links: { ...s.links, [m.link.id]: m.link } };
    case "link_deleted": {
      const { [m.linkId]: _, ...rest } = s.links;
      return { ...s, links: rest };
    }
    case "channel":
      return { ...s, channels: { ...s.channels, [m.channel.name]: m.channel } };
    case "channel_deleted": {
      const { [m.name]: _, ...rest } = s.channels;
      return { ...s, channels: rest };
    }
    case "library":
      return { ...s, library: m.items };
    case "tool":
      return { ...s, tools: { ...s.tools, [m.tool.id]: m.tool } };
    case "tool_deleted": {
      const { [m.toolId]: _, ...rest } = s.tools;
      return { ...s, tools: rest };
    }
    case "ask": {
      const { [m.ask.id]: _, ...rest } = s.asks;
      return { ...s, asks: m.ask.status === "pending" ? { ...rest, [m.ask.id]: m.ask } : rest };
    }
    case "event":
      // Repeated writes (an app streaming into a channel) update the newest event in place.
      if (s.events.at(-1)?.seq === m.event.seq) return { ...s, events: [...s.events.slice(0, -1), m.event] };
      return { ...s, events: [...s.events.slice(-199), m.event] };
  }
}

export function useBoard(boardId: string) {
  const [state, dispatch] = useReducer(reduce, { tools: {}, asks: {}, events: [], library: [], channels: {}, links: {} });
  // Channels and tool states for the app frames, updated before React renders (see live.ts).
  const live = useMemo(() => new LiveStore(makeApi(boardId)), [boardId]);
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false); // first snapshot received

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: number | undefined;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(wsUrl(`/ws/board?board=${encodeURIComponent(boardId)}`));
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "rpc") return answerRpc(ws!, msg);
        if (msg.type === "snapshot") setReady(true);
        feed(live, msg);
        dispatch(msg);
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        timer = window.setTimeout(connect, Math.min(500 * 2 ** retry++, 8000));
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [boardId, live]);

  const tools = Object.values(state.tools).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const asks = Object.values(state.asks).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const channels = Object.values(state.channels).sort((a, b) => a.name.localeCompare(b.name));
  const links = useMemo(() => Object.values(state.links), [state.links]);
  return { tools, toolsById: state.tools, asks, events: state.events, library: state.library, channels, links, live, connected, ready };
}

function feed(live: LiveStore, m: Msg) {
  switch (m.type) {
    case "snapshot":
      return live.reset(m.tools, m.channels ?? []);
    case "tool":
      return live.serverTool(m.tool);
    case "tool_deleted":
      return live.serverToolDeleted(m.toolId);
    case "channel":
      return live.serverChannel(m.channel);
    case "channel_deleted":
      return live.serverChannelDeleted(m.name);
  }
}

/** The agent asked (through the server) to look into or drive an app mounted in this tab. */
async function answerRpc(ws: WebSocket, msg: { id: string; method: string; toolId: string; params: unknown }) {
  const reply = (body: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "rpc_result", id: msg.id, ...body }));
  const handler = appRegistry.get(msg.toolId);
  if (!handler) return reply({ error: "the app is not mounted in the open board" });
  try {
    reply({ result: (await handler(msg.method, msg.params)) ?? null });
  } catch (err) {
    reply({ error: (err as Error).message });
  }
}

/** Re-render every few seconds so relative times stay fresh. */
export function useNow(intervalMs = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

