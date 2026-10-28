// Runs an agent-written app in a sandboxed iframe and keeps its state in sync with the board.
// The iframe has an opaque origin (no allow-same-origin), no network, and talks only through postMessage.
import { useEffect, useMemo, useRef, useState } from "react";
import jsonpatch from "fast-json-patch";
import { publicTool, type Tool } from "../shared/catalog.ts";
import { useApi } from "./api.ts";
import { currentLang, useT } from "./i18n.tsx";
import { useLive, type LiveStore } from "./live.ts";

type RpcHandler = (method: string, params: any) => Promise<unknown>;
/** Mounted apps, so requests from the agent (snapshot, invoke) can reach them. */
export const appRegistry = new Map<string, RpcHandler>();

const json = (v: unknown) => JSON.stringify(v ?? null);
const hash = (s = "") => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

const toolSummaries = (live: LiveStore) => live.allTools().map((t) => ({ id: t.id, title: t.title, kind: t.kind, description: t.description, version: t.version, updatedAt: t.updatedAt }));
const listSig = (live: LiveStore) => live.allTools().map((t) => `${t.id}:${t.version}`).join("|");

function buildSrcDoc(tool: Tool, live: LiveStore) {
  const origin = location.origin;
  const lang = currentLang();
  const head = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${origin}; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'">
<style>
html{color-scheme:light dark}
body{margin:0;padding:2px;background:transparent;color:#1d1d1b;font:14px/1.5 "Pretendard","Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif}
@media (prefers-color-scheme: dark){body{color:#ecebe7}}
</style>
`;
  const bodyStart = `</head><body><div id="root"></div>
<script>__wbRun(function (require, module, exports) {
`;
  // Tell the runtime where the app's line 1 sits, so error line numbers match the agent's source.
  const prefixLines = (head + "<script>X</script>\n<script crossorigin src=\"x\"></script>\n" + bodyStart).split("\n").length - 1;
  // lang lets the sandbox runtime show its own error text in the UI language.
  // The board's channels and tools as they are now, so the app's first render already has them.
  const init = json({
    state: tool.state,
    version: tool.version,
    toolId: tool.id,
    lineOffset: prefixLines,
    lang,
    channels: live.allChannels(),
    tools: live.allTools().map(publicTool),
  }).replace(/</g, "\\u003c");
  const code = (tool.compiled ?? "").replace(/<\/script/gi, "<\\/script");
  return `${head}<script>window.__WB_INIT=${init}</script>
<script crossorigin="anonymous" src="${origin}/sandbox/runtime.js"></script>
${bodyStart}${code}
});</script></body></html>`;
}

export function AppFrame({ tool, onNotice, onErrors }: { tool: Tool; onNotice: (m: string) => void; onErrors: (n: number) => void }) {
  const api = useApi();
  const live = useLive();
  const t = useT();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>(tool.props.height ?? 160);
  const srcDoc = useMemo(() => buildSrcDoc(tool, live), [tool.id, tool.compiled]); // eslint-disable-line react-hooks/exhaustive-deps
  const codeKey = useMemo(() => hash(tool.compiled), [tool.compiled]);

  // Sync bookkeeping. `base` = what the app's edits are diffed against; `local` = the app's latest state.
  const server = useRef({ state: tool.state, version: tool.version });
  const base = useRef<any>(tool.state);
  const local = useRef<any>(tool.state);
  const dirty = useRef(false);
  const flushing = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const reqs = useRef(new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>());
  const seq = useRef(0);
  const errors = useRef(0);
  const agentDrivenUntil = useRef(0); // writes right after an agent-invoked action are the agent's
  // What the app reads besides its own state. tools: id → version the app last got.
  const watch = useRef({ channels: new Set<string>(), tools: new Map<string, number>(), list: false, listSig: "" });

  const post = (msg: object) => frameRef.current?.contentWindow?.postMessage({ __wb: 1, ...msg }, "*");
  const pushServerState = () => {
    base.current = server.current.state;
    local.current = server.current.state;
    post({ method: "state", params: server.current });
  };

  // New code → new iframe → start from the server's state.
  useEffect(() => {
    server.current = { state: tool.state, version: tool.version };
    base.current = local.current = tool.state;
    dirty.current = false;
    watch.current = { channels: new Set(), tools: new Map(), list: false, listSig: "" };
    errors.current = 0;
    onErrors(0);
  }, [tool.compiled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Someone else (the agent, another tab) changed the state.
  useEffect(() => {
    server.current = { state: tool.state, version: tool.version };
    if (dirty.current || flushing.current) return; // reconciled after our own write lands
    pushServerState();
  }, [tool.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = async () => {
    if (flushing.current || !dirty.current) return;
    flushing.current = true;
    dirty.current = false;
    const target = local.current;
    const ops = jsonpatch.compare(base.current ?? {}, target ?? {});
    try {
      if (ops.length) {
        // No baseVersion: the app's diff is merged onto whatever the agent wrote meanwhile.
        const t = await api.patchState(tool.id, ops, undefined, Date.now() < agentDrivenUntil.current);
        server.current = { state: t.state, version: t.version };
      }
      base.current = target;
    } catch (err) {
      onNotice(t(`Could not save app state: ${(err as Error).message}`, `앱 상태 저장 실패: ${(err as Error).message}`));
      dirty.current = false;
    } finally {
      flushing.current = false;
      if (dirty.current) schedule();
      else if (json(server.current.state) !== json(local.current)) pushServerState();
    }
  };
  const schedule = () => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 250);
  };

  const requestApp = (method: string, params: unknown, timeoutMs = 12000) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++seq.current;
      const t = window.setTimeout(() => {
        reqs.current.delete(id);
        reject(new Error("the app did not answer (is it still loading or stuck?)"));
      }, timeoutMs);
      reqs.current.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      post({ id, method, params });
    });

  // Channels and tools this app watches changed (another app, the agent, another tab): pass the new value in.
  useEffect(
    () =>
      live.subscribe((c) => {
        const w = watch.current;
        if (c.type === "channel") {
          if (c.origin === tool.id || !w.channels.has(c.name)) return; // its own write: it already has it
          const e = live.channel(c.name);
          post({ method: "channel", params: { name: c.name, value: e?.value, version: e?.version ?? 0 } });
          return;
        }
        if (c.type === "error") {
          if (c.origin !== tool.id) return;
          onErrors(++errors.current);
          onNotice(t(`App "${tool.title}": ${c.message}`, `앱 "${tool.title}": ${c.message}`));
          api.appLog(tool.id, "error", c.message).catch(() => {});
          return;
        }
        if (w.tools.has(c.id)) {
          const other = live.tool(c.id);
          const v = other?.version ?? 0;
          if (w.tools.get(c.id) !== v) {
            w.tools.set(c.id, v); // moving a frame does not bump the version, so the app is not bothered
            post({ method: "tool", params: { id: c.id, tool: other ? publicTool(other) : null } });
          }
        }
        if (w.list) {
          const sig = listSig(live);
          if (sig !== w.listSig) {
            w.listSig = sig;
            post({ method: "tools", params: { list: toolSummaries(live) } });
          }
        }
      }),
    [live, tool.id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    appRegistry.set(tool.id, async (method, params) => {
      if (method !== "app_invoke") return requestApp("snapshot", params);
      agentDrivenUntil.current = Date.now() + 60_000;
      try {
        return await requestApp("invoke", params);
      } finally {
        agentDrivenUntil.current = Date.now() + 1000; // cover the debounced write that follows
      }
    });
    return () => {
      appRegistry.delete(tool.id);
    };
  }, [tool.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      const m = e.data;
      if (!m || m.__wb !== 1) return;
      if (m.re !== undefined) {
        const r = reqs.current.get(m.re);
        reqs.current.delete(m.re);
        if (m.error) r?.reject(new Error(m.error));
        else r?.resolve(m.result);
        return;
      }
      const reply = (result: unknown, error?: string) => post({ re: m.id, result, error });
      switch (m.method) {
        case "ready":
          if (!dirty.current) pushServerState();
          break;
        case "setState":
          local.current = m.params.state;
          dirty.current = true;
          schedule();
          break;
        case "watch": {
          // First use of a channel or tool in the app: send what it holds now (the start values may be stale).
          const w = watch.current;
          for (const name of m.params.channels ?? []) {
            w.channels.add(name);
            const e = live.channel(name);
            post({ method: "channel", params: { name, value: e?.value, version: e?.version ?? 0 } });
          }
          for (const id of m.params.tools ?? []) {
            const other = live.tool(id);
            w.tools.set(id, other?.version ?? 0);
            post({ method: "tool", params: { id, tool: other ? publicTool(other) : null } });
          }
          if (m.params.list) {
            w.list = true;
            w.listSig = listSig(live);
            post({ method: "tools", params: { list: toolSummaries(live) } });
          }
          break;
        }
        case "channelSet":
          watch.current.channels.add(m.params.name);
          live.setChannel(m.params.name, m.params.value, tool.id, Date.now() < agentDrivenUntil.current);
          break;
        case "toolWrite":
          // App code is the agent's code: its writes to other tools are the agent's, so access levels and gates apply.
          try {
            reply(publicTool(await api.patchState(m.params.id, m.params.patch, m.params.baseVersion, true)));
          } catch (err) {
            reply(null, (err as Error).message);
          }
          break;
        case "emit":
          try {
            await api.appEmit(tool.id, m.params.type, m.params.payload);
            reply(true);
          } catch (err) {
            reply(null, (err as Error).message);
          }
          break;
        case "upload":
          try {
            reply(await api.upload(tool.id, m.params.file));
          } catch (err) {
            reply(null, (err as Error).message);
          }
          break;
        case "log":
          if (m.params.level === "error") onErrors(++errors.current);
          api.appLog(tool.id, m.params.level, m.params.message).catch(() => {});
          break;
        case "resize":
          setHeight(Math.min(Math.max(Math.ceil(m.params.height) + 2, 40), 1600));
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [tool.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <iframe
      ref={frameRef}
      key={codeKey}
      className="app-frame"
      title={tool.title}
      sandbox="allow-scripts allow-forms allow-modals"
      srcDoc={srcDoc}
      style={{ height }}
    />
  );
}
