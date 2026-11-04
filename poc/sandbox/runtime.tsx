// Runs inside each app iframe (sandboxed, opaque origin, no network).
// Gives agent-written code React and the `board` bridge. Everything the agent must read goes through here.
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";

type Json = any;
type Msg = { __wb: 1; id?: number; re?: number; method?: string; params?: any; result?: any; error?: string };

const init = (window as any).__WB_INIT ?? { state: {}, version: 0, toolId: "" };
const ko = init.lang === "ko";
let state: Json = init.state ?? {};
let version: number = init.version ?? 0;
const listeners = new Set<() => void>();
const actions = new Map<string, (args: any) => unknown>();
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let seq = 0;

const post = (m: Omit<Msg, "__wb">) => parent.postMessage({ __wb: 1, ...m }, "*");
const request = (method: string, params?: unknown) =>
  new Promise<any>((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    post({ id, method, params });
  });
const notify = () => listeners.forEach((fn) => fn());

// ── shared data: channels (named values every app on the board shares) and other tools' state ──
// The page sends the board's values at start (init) and then every change to what this app watches.
const CHANNEL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
type ToolSummary = { id: string; title: string; kind: string; description: string; version: number; updatedAt: string };
const summaryOf = (t: any): ToolSummary => ({ id: t.id, title: t.title, kind: t.kind, description: t.description, version: t.version, updatedAt: t.updatedAt });
const channelValues = new Map<string, unknown>(Object.entries(init.channels ?? {}).map(([name, e]: [string, any]) => [name, e.value]));
const toolValues = new Map<string, any>((init.tools ?? []).map((t: any) => [t.id, t]));
let toolList: ToolSummary[] = (init.tools ?? []).map(summaryOf);
const channelListeners = new Map<string, Set<() => void>>();
const toolListeners = new Map<string, Set<() => void>>();
const listListeners = new Set<() => void>();
const watching = { channels: new Set<string>(), tools: new Set<string>(), list: false };

const listen = (map: Map<string, Set<() => void>>, key: string, fn: () => void) => {
  const set = map.get(key) ?? new Set();
  map.set(key, set);
  set.add(fn);
  return () => {
    set.delete(fn);
  };
};
const fire = (set?: Set<() => void>) => set?.forEach((fn) => fn());

function watchChannel(name: string) {
  if (typeof name !== "string" || !CHANNEL_NAME.test(name)) throw new Error(`channel name "${name}" is not valid: use letters, digits, _ . : - (up to 64)`);
  if (watching.channels.has(name)) return;
  watching.channels.add(name);
  post({ method: "watch", params: { channels: [name] } });
}
function watchTool(id: string) {
  if (watching.tools.has(id)) return;
  watching.tools.add(id);
  post({ method: "watch", params: { tools: [id] } });
}
function watchList() {
  if (watching.list) return;
  watching.list = true;
  post({ method: "watch", params: { list: true } });
}

/** A handle on one channel. Values are JSON: what you set is what every other app gets. */
function channelHandle(name: string) {
  watchChannel(name);
  const get = () => channelValues.get(name);
  const set = (next: Json | ((prev: Json) => Json)) => {
    const v = typeof next === "function" ? next(get()) : next;
    if (v === undefined) throw new Error(`channel "${name}": value cannot be undefined (use null)`);
    const clean = JSON.parse(JSON.stringify(v));
    channelValues.set(name, clean);
    fire(channelListeners.get(name));
    post({ method: "channelSet", params: { name, value: clean } });
  };
  return {
    name,
    get,
    set,
    /** Merge top-level keys into an object value. */
    update: (partial: Record<string, unknown>) => set((prev: Json) => ({ ...(prev ?? {}), ...partial })),
    subscribe: (fn: () => void) => listen(channelListeners, name, fn),
  };
}

window.addEventListener("message", async (e) => {
  if (e.source !== parent) return;
  const m = e.data as Msg;
  if (!m || m.__wb !== 1) return;
  if (m.re !== undefined) {
    const p = pending.get(m.re);
    pending.delete(m.re);
    if (m.error) p?.reject(new Error(m.error));
    else p?.resolve(m.result);
    return;
  }
  const reply = (result: unknown, error?: string) => post({ re: m.id, result, error });
  switch (m.method) {
    case "state":
      state = m.params.state;
      version = m.params.version;
      notify();
      break;
    case "channel":
      if (m.params.version === 0 && m.params.value === undefined) channelValues.delete(m.params.name);
      else channelValues.set(m.params.name, m.params.value);
      fire(channelListeners.get(m.params.name));
      break;
    case "tool":
      if (m.params.tool) toolValues.set(m.params.id, m.params.tool);
      else toolValues.delete(m.params.id);
      fire(toolListeners.get(m.params.id));
      break;
    case "tools":
      toolList = m.params.list;
      fire(listListeners);
      break;
    case "invoke": {
      const fn = actions.get(m.params.action);
      if (!fn) return reply(null, `unknown action "${m.params.action}". Registered: ${[...actions.keys()].join(", ") || "none"}`);
      try {
        reply((await fn(m.params.args)) ?? null);
      } catch (err) {
        reply(null, String((err as Error)?.message ?? err));
      }
      break;
    }
    case "snapshot":
      reply(snapshot());
      break;
  }
});

function snapshot() {
  const fields = [...document.querySelectorAll<HTMLInputElement>("input, select, textarea")].map((el) => ({
    name: el.name || el.id || el.getAttribute("aria-label") || el.placeholder || el.tagName.toLowerCase(),
    type: el.type,
    value: el.type === "file" ? [...(el.files ?? [])].map((f) => f.name) : el.type === "checkbox" || el.type === "radio" ? el.checked : el.value,
  }));
  const buttons = [...document.querySelectorAll("button")].map((b) => ({ text: b.textContent?.trim(), disabled: b.disabled }));
  const r = document.getElementById("root")?.getBoundingClientRect();
  return {
    text: document.body.innerText.slice(0, 20000),
    fields,
    buttons,
    actions: [...actions.keys()],
    stateVersion: version,
    uses: { channels: [...watching.channels], tools: [...watching.tools] },
    size: { width: Math.round(r?.width ?? 0), height: Math.round(r?.height ?? 0), viewport: innerHeight },
  };
}

/** The bridge API agent-written apps import from "board". */
export const board = {
  get state() {
    return state;
  },
  get version() {
    return version;
  },
  /** Replace the whole state (like React's setState). Synced to the board; the agent reads it with tool_read. */
  setState(next: Json | ((prev: Json) => Json)) {
    state = typeof next === "function" ? next(state) : next;
    notify();
    post({ method: "setState", params: { state } });
  },
  /** Merge top-level keys into the state. */
  update(partial: Record<string, unknown>) {
    board.setState((s: Json) => ({ ...(s ?? {}), ...partial }));
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  /** Tell the agent something happened (it receives it via board_wait_event). */
  emit(type: string, payload?: unknown) {
    return request("emit", { type, payload });
  },
  /** Save a File into the agent's workspace. Resolves to { path, relPath, name, size, type }. */
  uploadFile(file: File) {
    if (!(file instanceof File)) return Promise.reject(new Error("uploadFile expects a File"));
    return request("upload", { file });
  },
  /** Let the agent drive the app: app_invoke(toolId, name, args) calls fn(args) and returns its result. */
  onAction(name: string, fn: (args: any) => unknown) {
    actions.set(name, fn);
    return () => {
      actions.delete(name);
    };
  },
  /** This app's own tool id. */
  toolId: init.toolId as string,
  /** A shared channel: get() / set(value | fn) / update(partial) / subscribe(fn). Every app on the board sees writes at once. */
  channel: channelHandle,
  /** Another tool on the board, live: { id, title, kind, props, state, version }, or undefined. */
  tool(id: string) {
    watchTool(id);
    return toolValues.get(id);
  },
  /** Every tool on the board: [{ id, title, kind, description, version }]. */
  tools() {
    watchList();
    return toolList;
  },
  /** Change another tool's state with a JSON Patch. Counts as the agent's write (checklist approval gates apply). */
  writeTool(id: string, patch: unknown[], baseVersion?: number) {
    return request("toolWrite", { id, patch, baseVersion });
  },
};

/** React hook: [state, setState], synced with the board. */
export function useBoardState<T = Json>(): [T, (next: T | ((prev: T) => T)) => void] {
  const s = React.useSyncExternalStore(board.subscribe, () => state);
  return [s as T, board.setState as any];
}

/** React hook: [value, setValue] of a shared channel. `initial` is used while the channel has no value yet. */
export function useChannel<T = Json>(name: string, initial?: T): [T, (next: T | ((prev: T) => T)) => void] {
  const ch = React.useMemo(() => channelHandle(name), [name]);
  const value = React.useSyncExternalStore(ch.subscribe, ch.get);
  const fallback = React.useRef(initial);
  fallback.current = initial;
  const set = React.useCallback(
    (next: T | ((prev: T) => T)) => ch.set(typeof next === "function" ? (prev: Json) => (next as (p: T) => T)(prev === undefined ? (fallback.current as T) : prev) : next),
    [ch],
  );
  return [(value === undefined ? initial : value) as T, set];
}

/** React hook: another tool on the board, live ({ id, title, kind, props, state, version }), or undefined. */
export function useTool(id: string): any {
  const subscribe = React.useCallback(
    (fn: () => void) => {
      watchTool(id);
      return listen(toolListeners, id, fn);
    },
    [id],
  );
  return React.useSyncExternalStore(subscribe, () => toolValues.get(id));
}

/** React hook: every tool on the board ([{ id, title, kind, description, version }]), live. */
export function useTools(): ToolSummary[] {
  const subscribe = React.useCallback((fn: () => void) => {
    watchList();
    listListeners.add(fn);
    return () => {
      listListeners.delete(fn);
    };
  }, []);
  return React.useSyncExternalStore(subscribe, () => toolList);
}

/** React hook: register an action for the agent while the component is mounted. */
export function useAction(name: string, fn: (args: any) => unknown) {
  const ref = React.useRef(fn);
  ref.current = fn;
  React.useEffect(() => board.onAction(name, (args) => ref.current(args)), [name]);
}

// ── logs and errors go to the board so the agent can read them (app_logs) ──
const fmt = (args: unknown[]) =>
  args
    .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : safeJson(a)))
    .join(" ")
    .slice(0, 4000);
function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
const log = (level: string, message: string) => post({ method: "log", params: { level, message } });
/** Monaco says it runs without web workers (an app's sandbox has none): expected, so not for the agent's logs. */
const NO_WORKERS = "shellside: apps run Monaco without web workers";
const QUIET = /^Could not create web worker|^shellside: apps run Monaco without web workers/;
for (const level of ["error", "warn", "log", "info"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    const message = fmt(args);
    if (!QUIET.test(message)) log(level, message);
  };
}
const lineOffset: number = init.lineOffset ?? 0;
window.addEventListener("error", (e) => {
  const line = e.lineno && e.lineno > lineOffset ? ` (source line ${e.lineno - lineOffset})` : "";
  log("error", `${e.message}${line}`);
});
window.addEventListener("unhandledrejection", (e) => log("error", `unhandled rejection: ${fmt([e.reason])}`));


class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    log("error", `render error: ${error.message}`);
  }
  render() {
    if (this.state.error) {
      return React.createElement("pre", { style: { color: "#c43d3d", whiteSpace: "pre-wrap", font: "12px ui-monospace, monospace" } }, `${ko ? "앱 렌더링 오류" : "App render error"}: ${this.state.error.message}`);
    }
    return this.props.children;
  }
}

// ── CodeEditor: Monaco (VS Code's editor) in an app ──
// Loaded from the board (/sandbox/monaco.js, next to this runtime) the first time an app shows one.
const SANDBOX_BASE = (() => {
  const src = (document.currentScript as HTMLScriptElement | null)?.src;
  return src ? new URL(".", src).href : "";
})();
let monacoLoading: Promise<any> | null = null;
function loadMonaco(): Promise<any> {
  const w = window as any;
  if (w.__wbMonaco) return Promise.resolve(w.__wbMonaco);
  monacoLoading ??= new Promise((resolve, reject) => {
    // No web workers in an app: Monaco runs their work in the page (fine for an editor's worth of text).
    w.MonacoEnvironment = {
      getWorker() {
        throw new Error(NO_WORKERS);
      },
    };
    const s = document.createElement("script");
    s.src = `${SANDBOX_BASE}monaco.js`;
    s.crossOrigin = "anonymous";
    s.onload = () => (w.__wbMonaco ? resolve(w.__wbMonaco) : reject(new Error("the code editor did not start")));
    s.onerror = () => {
      monacoLoading = null;
      reject(new Error("the code editor could not be loaded from the board"));
    };
    document.head.appendChild(s);
  });
  return monacoLoading;
}

type CodeEditorProps = {
  /** The text (controlled). Or defaultValue, to start with it and only hear changes. */
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** ⌘/Ctrl+S in the editor. */
  onSave?: (value: string) => void;
  /** "javascript", "typescript", "python", "json", "sql", "markdown", "yaml", "html", "css", "go", "rust"… (colors only). */
  language?: string;
  /** Default 300 (px, or any CSS height). */
  height?: number | string;
  readOnly?: boolean;
  /** "light", "dark", or "auto" (the system's, the default). */
  theme?: "light" | "dark" | "auto";
  lineNumbers?: boolean;
  minimap?: boolean;
  wordWrap?: boolean;
  fontSize?: number;
  /** Any other Monaco editor option (editor.IStandaloneEditorConstructionOptions). */
  options?: Record<string, unknown>;
  /** The Monaco editor and the monaco API, for anything more (markers, decorations, commands). */
  onMount?: (editor: any, monaco: any) => void;
  className?: string;
  style?: React.CSSProperties;
};

const monacoTheme = (theme?: string) =>
  theme === "dark" || (theme !== "light" && typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches) ? "vs-dark" : "vs";

/** A code editor for an app: Monaco, the editor of VS Code. */
export function CodeEditor(props: CodeEditorProps) {
  const host = React.useRef<HTMLDivElement>(null);
  const editorRef = React.useRef<any>(null);
  const monacoRef = React.useRef<any>(null);
  const latest = React.useRef(props);
  latest.current = props;
  const applying = React.useRef(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  React.useEffect(() => {
    let gone = false;
    loadMonaco().then(
      (monaco) => {
        if (gone || !host.current) return;
        const p = latest.current;
        monacoRef.current = monaco;
        const editor = monaco.editor.create(host.current, {
          value: p.value ?? p.defaultValue ?? "",
          language: p.language ?? "plaintext",
          readOnly: !!p.readOnly,
          theme: monacoTheme(p.theme),
          automaticLayout: true,
          minimap: { enabled: !!p.minimap },
          lineNumbers: p.lineNumbers === false ? "off" : "on",
          wordWrap: p.wordWrap ? "on" : "off",
          fontSize: p.fontSize ?? 13,
          scrollBeyondLastLine: false,
          fixedOverflowWidgets: true,
          ...p.options,
        });
        editorRef.current = editor;
        editor.onDidChangeModelContent(() => {
          if (!applying.current) latest.current.onChange?.(editor.getValue());
        });
        editor.onKeyDown((e: any) => {
          if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.keyCode === monaco.KeyCode.KeyS && latest.current.onSave) {
            e.preventDefault();
            latest.current.onSave(editor.getValue());
          }
        });
        p.onMount?.(editor, monaco);
      },
      (err) => !gone && setProblem((err as Error).message),
    );
    return () => {
      gone = true;
      const editor = editorRef.current;
      editorRef.current = null;
      editor?.getModel()?.dispose();
      editor?.dispose();
    };
  }, []);

  // A new value from outside (state, another app, the agent): take it, keeping undo and the cursor.
  React.useEffect(() => {
    const editor = editorRef.current;
    if (!editor || props.value === undefined || props.value === editor.getValue()) return;
    const model = editor.getModel();
    applying.current = true;
    try {
      editor.pushUndoStop();
      model.pushEditOperations(editor.getSelections(), [{ range: model.getFullModelRange(), text: props.value }], () => editor.getSelections());
      editor.pushUndoStop();
    } finally {
      applying.current = false;
    }
  }, [props.value]);
  React.useEffect(() => {
    const editor = editorRef.current;
    if (editor && props.language) monacoRef.current.editor.setModelLanguage(editor.getModel(), props.language);
  }, [props.language]);
  React.useEffect(() => {
    editorRef.current?.updateOptions({
      readOnly: !!props.readOnly,
      minimap: { enabled: !!props.minimap },
      lineNumbers: props.lineNumbers === false ? "off" : "on",
      wordWrap: props.wordWrap ? "on" : "off",
      fontSize: props.fontSize ?? 13,
    });
  }, [props.readOnly, props.minimap, props.lineNumbers, props.wordWrap, props.fontSize]);
  React.useEffect(() => {
    if (editorRef.current) monacoRef.current.editor.setTheme(monacoTheme(props.theme));
  }, [props.theme]);

  const height = props.height ?? 300;
  return React.createElement(
    "div",
    {
      className: props.className,
      style: { position: "relative", height: typeof height === "number" ? `${height}px` : height, border: "1px solid rgba(128,128,128,.3)", borderRadius: 6, overflow: "hidden", ...props.style },
    },
    React.createElement("div", { ref: host, style: { position: "absolute", inset: 0 } }),
    problem && React.createElement("pre", { style: { position: "absolute", inset: 0, margin: 0, padding: 8, color: "#c43d3d", whiteSpace: "pre-wrap", font: "12px ui-monospace, monospace" } }, problem),
  );
}

// ── module loader for the compiled (CommonJS) app ──
const modules: Record<string, unknown> = {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "react-dom": ReactDOM,
  "react-dom/client": ReactDOMClient,
  board: { board, useBoardState, useAction, useChannel, useTool, useTools, CodeEditor, default: board },
};

(window as any).__wbRun = (factory: (require: (n: string) => unknown, module: any, exports: any) => void) => {
  const module = { exports: {} as any };
  try {
    factory((name) => {
      if (!(name in modules)) throw new Error(`module "${name}" is not available in WorkBoard apps`);
      return modules[name];
    }, module, module.exports);
    // The iframe follows the app's own height (the document is at least as tall as the iframe, so measure the root).
    const root = document.getElementById("root")!;
    const measure = () => {
      const pad = parseFloat(getComputedStyle(document.body).paddingTop) + parseFloat(getComputedStyle(document.body).paddingBottom);
      post({ method: "resize", params: { height: Math.ceil(root.getBoundingClientRect().height + pad) } });
    };
    new ResizeObserver(measure).observe(root);
    const App = module.exports.default ?? module.exports;
    if (typeof App !== "function") throw new Error("the app must `export default` a React component");
    ReactDOMClient.createRoot(document.getElementById("root")!).render(
      React.createElement(ErrorBoundary, null, React.createElement(App)),
    );
    post({ method: "ready" });
  } catch (err) {
    log("error", `startup error: ${(err as Error).message}`);
    document.getElementById("root")!.textContent = `${ko ? "앱 시작 오류" : "App failed to start"}: ${(err as Error).message}`;
  }
};
