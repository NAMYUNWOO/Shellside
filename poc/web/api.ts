// Browser side of the API. Everything here acts as the person.
// Board-scoped calls are bound to one board (makeApi / useApi), so boards running in the background never
// send to the board on screen.
import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import type { Ask, Channel, Link, LinkDirection, Section, SectionColor, SectionLayout, Tool } from "../shared/catalog.ts";
import { currentLang } from "./i18n.tsx";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: any,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, asAgent = false): Promise<T> {
  const res = await fetch(path, {
    method,
    // x-wb-lang: messages meant for the person come back in the UI language.
    headers: { "content-type": "application/json", "x-wb-client": "web", "x-wb-lang": currentLang(), ...(asAgent ? { "x-wb-actor": "agent" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  // The server no longer knows this browser (its pairing was removed): show the pairing screen again.
  if (res.status === 401 && data.data?.reason === "pair") window.dispatchEvent(new Event(UNPAIRED_EVENT));
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status, data.data);
  return data as T;
}

/** Fired when the server refuses this browser as not paired (see PairGate). */
export const UNPAIRED_EVENT = "wb:unpaired";

/** Pairing this browser with the server: only a paired browser counts as the person (server/auth.ts). */
export const authApi = {
  status: () => call<{ paired: boolean; firstRun: boolean }>("GET", "/api/auth/status"),
  pairFirst: () => call<{ paired: true }>("POST", "/api/auth/first"),
  requestCode: () => call<{ expiresAt: number }>("POST", "/api/auth/code"),
  pair: (code: string) => call<{ paired: true }>("POST", "/api/auth/pair", { code }),
};

/** none = Claude not running; starting = running but not ready (trust prompt…); permission = waiting for the person. */
export type AgentState = "none" | "starting" | "idle" | "busy" | "permission";

export interface Template {
  id: string;
  name: string;
  description: string;
  kind: Tool["kind"];
  width: number;
  createdBy: "human" | "agent";
  createdAt: string;
  uses: number;
}

export interface AgentStatus {
  claude: { installed: boolean; loggedIn: boolean; method?: string };
  terminal: { running: boolean; foreground: string; claudeRunning: boolean; agentState: AgentState; loginRequired: boolean; loginHint?: string };
}

/** Why Claude cannot be used on this board right now, or null when it can. */
export function loginProblem(s: AgentStatus | null): { kind: "install" | "account" | "terminal"; detail?: string } | null {
  if (!s) return null;
  if (!s.claude.installed) return { kind: "install" };
  if (!s.claude.loggedIn) return { kind: "account" };
  if (s.terminal.loginRequired) return { kind: "terminal", detail: s.terminal.loginHint };
  return null;
}

export interface BoardSummary {
  id: string;
  name: string;
  createdAt: string;
  workspace: string;
  tools: number;
  pendingAsks: number;
  shellRunning: boolean;
  claudeRunning: boolean;
  agentState: AgentState;
  loginRequired: boolean;
  lastEventAt?: string;
  lastAgentAt?: string;
}

/** Calls that are not about one board. */
export const api = {
  listBoards: () => call<{ boards: BoardSummary[] }>("GET", "/api/boards"),
  createBoard: (name: string) => call<BoardSummary>("POST", "/api/boards", { name }),
  renameBoard: (id: string, name: string) => call<BoardSummary>("PATCH", `/api/boards/${id}`, { name }),
  deleteBoard: (id: string) => call<{ ok: true }>("DELETE", `/api/boards/${id}`),
  renameTemplate: (id: string, patch: { name?: string; description?: string }) => call<Template>("PATCH", `/api/library/${id}`, patch),
  deleteTemplate: (id: string) => call<{ ok: true }>("DELETE", `/api/library/${id}`),
  agentStatus: (boardId: string, refresh = false) => call<AgentStatus>("GET", `/api/b/${boardId}/agent/status${refresh ? "?refresh=1" : ""}`),
};

/** Everything a board's UI calls, bound to that board. */
/** What the desktop app's window adds (desktop/preload.cjs): a dropped file's path on this machine, and opening a
 *  board file with its own app. Absent in a browser. */
export interface DesktopBridge {
  pathForFile(file: File): string;
  openPath(path: string): Promise<string>;
  showInFolder(path: string): Promise<void>;
}
export const desktop = (globalThis as { shellside?: DesktopBridge }).shellside;

export function makeApi(boardId: string) {
  const b = (path: string) => `/api/b/${encodeURIComponent(boardId)}${path}`;
  return {
    ...api,
    boardId,
    // library (save/use need a board)
    saveToLibrary: (toolId: string, opts: { name?: string; description?: string; includeState?: boolean }) => call<Template>("POST", b("/library"), { toolId, ...opts }),
    useTemplate: (id: string, at?: { x: number; y: number }) => call<Tool>("POST", b(`/library/${id}/use`), { at }),
    // the board's agent
    startLogin: () => call<{ mode: "claude" | "started" }>("POST", b("/agent/login")),
    /** Type a request into this board's Claude (or start Claude with it), with the chosen tools as context. */
    sendToAgent: (prompt: string, toolIds: string[], sectionIds: string[] = []) => call<{ mode: "claude" | "started" }>("POST", b("/agent/send"), { prompt, toolIds, sectionIds }),
    // tools
    createTool: (input: Partial<Tool> & { width?: number; at?: { x: number; y: number } }) => call<Tool>("POST", b("/tools"), input),
    /** asAgent: the write came from an app action the agent invoked, so it is the agent's change. */
    patchState: (toolId: string, patch: unknown[], baseVersion?: number, asAgent = false) => call<Tool>("POST", b(`/tools/${toolId}/patch`), { patch, baseVersion }, asAgent),
    updateTool: (toolId: string, input: Partial<Tool> & { baseVersion?: number }) => call<Tool>("PATCH", b(`/tools/${toolId}`), input),
    setLayout: (toolId: string, layout: Partial<{ x: number; y: number; w: number; h: number }>) => call<Tool>("PATCH", b(`/tools/${toolId}/layout`), layout),
    deleteTool: (toolId: string) => call<{ ok: true }>("DELETE", b(`/tools/${toolId}`)),
    // links between tools
    createLink: (from: string, to: string, direction: LinkDirection = "none") => call<Link>("POST", b("/links"), { from, to, direction }),
    createSection: (input: { id?: string; title?: string; name?: string; color?: SectionColor; around?: string[]; layout?: Partial<SectionLayout> }) => call<Section>("POST", b("/sections"), input),
    updateSection: (id: string, input: { title?: string; name?: string; color?: SectionColor }) => call<Section>("PATCH", b(`/sections/${id}`), input),
    setSectionLayout: (id: string, layout: Partial<SectionLayout>, moveContents = false) =>
      call<{ section: Section; moved: string[] }>("PATCH", b(`/sections/${id}/layout`), { ...layout, moveContents }),
    deleteSection: (id: string, withContents = false) => call<{ ok: true }>("DELETE", b(`/sections/${id}${withContents ? "?contents=1" : ""}`)),
    updateLink: (linkId: string, input: { direction?: LinkDirection; from?: string; to?: string }) => call<Link>("PATCH", b(`/links/${linkId}`), input),
    deleteLink: (linkId: string) => call<{ ok: true }>("DELETE", b(`/links/${linkId}`)),
    answerAsk: (askId: string, answer: { approved?: boolean; values?: Record<string, unknown>; comment?: string }) => call<Ask>("POST", b(`/asks/${askId}/answer`), answer),
    sendMessage: (text: string, toolId?: string) => call("POST", b("/messages"), { text, toolId }),
    stop: (reason?: string) => call("POST", b("/stop"), { reason }),
    typeIntoTerminal: (text: string) => call("POST", b("/terminal/input"), { text }),
    // channels (shared live values between apps)
    getChannel: (name: string) => call<Channel>("GET", b(`/channels/${encodeURIComponent(name)}`)),
    /** toolId: the app that wrote it. asAgent: the write came from an app action the agent invoked. */
    setChannel: (name: string, value: unknown, toolId?: string, asAgent = false) => call<Channel>("PUT", b(`/channels/${encodeURIComponent(name)}`), { value, toolId }, asAgent),
    deleteChannel: (name: string) => call<{ ok: true }>("DELETE", b(`/channels/${encodeURIComponent(name)}`)),
    // apps
    appEmit: (toolId: string, type: string, payload: unknown) => call("POST", b(`/apps/${toolId}/emit`), { type, payload }),
    appLog: (toolId: string, level: string, message: string) => call("POST", b(`/apps/${toolId}/logs`), { level, message }),
    appLogs: (toolId: string) => call<{ logs: { at: string; level: string; message: string }[] }>("GET", b(`/apps/${toolId}/logs`)),
    /** A file dropped on the board → a file tool. The desktop app copies it from its path; a browser streams it
     *  (any size, with progress). at: the drop point (the frame's top-left). */
    dropFile(file: File, at: { x: number; y: number }, onProgress: (loaded: number) => void): Promise<Tool> {
      const path = desktop?.pathForFile(file);
      if (path) return call<Tool>("POST", b("/file-tools/from-path"), { path, at });
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const q = new URLSearchParams({ name: file.name, x: String(Math.round(at.x)), y: String(Math.round(at.y)) });
        xhr.open("POST", b(`/file-tools?${q}`));
        xhr.setRequestHeader("content-type", "application/octet-stream");
        xhr.setRequestHeader("x-wb-client", "web");
        xhr.setRequestHeader("x-wb-lang", currentLang());
        xhr.upload.onprogress = (e) => onProgress(e.loaded);
        xhr.onload = () => {
          let data: { error?: string } & Partial<Tool> = {};
          try {
            data = JSON.parse(xhr.responseText);
          } catch {}
          if (xhr.status >= 200 && xhr.status < 300) resolve(data as Tool);
          else reject(new ApiError(data.error ?? `HTTP ${xhr.status}`, xhr.status));
        };
        xhr.onerror = () => reject(new ApiError("the upload was cut off", 0));
        xhr.send(file);
      });
    },
    fileUrl: (toolId: string, head?: number) => b(`/file-tools/${toolId}/content${head ? `?head=${head}` : ""}`),
    async upload(toolId: string, file: File) {
      const q = new URLSearchParams({ toolId, name: file.name, type: file.type });
      const res = await fetch(b(`/files?${q}`), { method: "POST", headers: { "content-type": "application/octet-stream", "x-wb-client": "web", "x-wb-lang": currentLang() }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status, data.data);
      return data as { path: string; relPath: string; name: string; size: number; type: string };
    },
  };
}
export type BoardApi = ReturnType<typeof makeApi>;

const ApiContext = createContext<BoardApi | null>(null);

/** Binds every useApi() below it to one board. */
export function ApiProvider({ boardId, children }: { boardId: string; children: ReactNode }) {
  const value = useMemo(() => makeApi(boardId), [boardId]);
  return createElement(ApiContext.Provider, { value }, children);
}

export function useApi(): BoardApi {
  const a = useContext(ApiContext);
  if (!a) throw new Error("useApi() must be used inside <ApiProvider boardId=…>");
  return a;
}

export const wsUrl = (path: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
