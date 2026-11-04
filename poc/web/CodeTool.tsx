// A code editor on the board (kind "code"): Monaco, on a folder (file tree + tabs) or on one file. The person edits and
// saves (⌘/Ctrl+S); Claude edits the same files with its own tools, and the editor reloads them when they change on
// disk (or asks, when the person has unsaved changes there). The open tabs live in the tool's state, so Claude sees
// what is open and can open a file for the person.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import type { Tool } from "../shared/catalog.ts";
import { ApiError, useApi } from "./api.ts";
import { useT } from "./i18n.tsx";
import { isMod, kbd } from "./keys.ts";
import { codeEditors } from "./codeFocus.ts";

type Patch = (ops: unknown[]) => Promise<void>;
type Entry = { name: string; dir: boolean; size: number };
interface Doc {
  model: Monaco.editor.ITextModel;
  mtime: number;
  saved: number; // the model's alternative version id when it last matched the disk
  view: Monaco.editor.ICodeEditorViewState | null;
}

const dark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
const baseName = (p: string) => p.split("/").pop() || p;

export default function CodeTool({ tool, patch, onNotice }: { tool: Tool; patch: Patch; onNotice: (m: string) => void }) {
  const api = useApi();
  const t = useT();
  const code = useMemo(() => api.code(tool.id), [api, tool.id]);
  const root: string = tool.props.root;
  const single: boolean = tool.props.single === true;
  const open: string[] = single ? [""] : (tool.state.open ?? []);
  const active: string = single ? "" : (tool.state.active ?? open[0] ?? "");

  const [monaco, setMonaco] = useState<typeof Monaco | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const docs = useRef(new Map<string, Doc>());
  const shown = useRef<string | null>(null);
  const [dirty, setDirty] = useState<string[]>([]);
  const [conflict, setConflict] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // ── Monaco, loaded the first time a code editor shows ──
  useEffect(() => {
    let live = true;
    import("./monaco.ts").then((m) => live && setMonaco(m.default), (err) => setProblem(String(err)));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!monaco || !host.current || editor.current) return;
    editor.current = monaco.editor.create(host.current, {
      model: null,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      tabSize: 2,
      scrollBeyondLastLine: false,
      theme: dark() ? "vs-dark" : "vs",
      fixedOverflowWidgets: true,
    });
    const ed = editor.current;
    codeEditors.add(ed);
    return () => {
      codeEditors.delete(ed);
      editor.current?.dispose();
      editor.current = null;
      for (const d of docs.current.values()) d.model.dispose();
      docs.current.clear();
    };
  }, [monaco]);

  const markDirty = useCallback(() => {
    setDirty([...docs.current].filter(([, d]) => d.model.getAlternativeVersionId() !== d.saved).map(([p]) => p));
  }, []);

  // ── the tab in front: load it (once), then show it ──
  useEffect(() => {
    const ed = editor.current;
    if (!monaco || !ed) return;
    if (!open.length) {
      ed.setModel(null);
      shown.current = null;
      return;
    }
    const path = active;
    let live = true;
    (async () => {
      let doc = docs.current.get(path);
      if (!doc) {
        setLoading(true);
        try {
          const f = await code.read(path);
          if (!live) return;
          // Each editor has its own copy (two editors on one file must not share undo, or closing one blanks the other).
          // The path keeps the file's name, so Monaco picks the language from it.
          const uri = monaco.Uri.from({ scheme: "file", path: `/${tool.id}/${single ? baseName(root) : path}` });
          monaco.editor.getModel(uri)?.dispose();
          const model = monaco.editor.createModel(f.text, undefined, uri);
          doc = { model, mtime: f.mtime, saved: model.getAlternativeVersionId(), view: null };
          model.onDidChangeContent(markDirty);
          docs.current.set(path, doc);
          setProblem(null);
        } catch (err) {
          if (live) setProblem(`${path || baseName(root)}: ${(err as Error).message}`);
          return;
        } finally {
          if (live) setLoading(false);
        }
      }
      if (shown.current !== null && docs.current.has(shown.current)) docs.current.get(shown.current)!.view = ed.saveViewState();
      ed.setModel(doc.model);
      if (doc.view) ed.restoreViewState(doc.view);
      shown.current = path;
    })();
    return () => {
      live = false;
    };
  }, [monaco, active, open.join("\n"), code, root, single, markDirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const setTabs = (nextOpen: string[], nextActive: string) => {
    if (single) return;
    void patch([
      { op: "replace", path: "/open", value: nextOpen },
      { op: "replace", path: "/active", value: nextActive },
    ]);
  };
  const openFile = (path: string) => setTabs(open.includes(path) ? open : [...open, path].slice(-30), path);
  const closeTab = (path: string) => {
    const doc = docs.current.get(path);
    if (doc && doc.model.getAlternativeVersionId() !== doc.saved && !confirm(t(`Close ${baseName(path)} without saving?`, `${baseName(path)}을(를) 저장하지 않고 닫을까요?`))) return;
    doc?.model.dispose();
    docs.current.delete(path);
    markDirty();
    const rest = open.filter((p) => p !== path);
    setTabs(rest, active === path ? (rest.at(-1) ?? "") : active);
  };

  // ── save (⌘/Ctrl+S); a file changed on disk meanwhile is not overwritten without asking ──
  const save = useCallback(
    async (force = false) => {
      const path = shown.current;
      const doc = path !== null ? docs.current.get(path) : undefined;
      if (path === null || !doc) return;
      try {
        const r = await code.write(path, doc.model.getValue(), doc.mtime, force);
        doc.mtime = r.mtime;
        doc.saved = doc.model.getAlternativeVersionId();
        setConflict(null);
        markDirty();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) setConflict(path);
        else onNotice((err as Error).message);
      }
    },
    [code, markDirty, onNotice],
  );
  // ⌘/Ctrl+S, on this editor's own keys (Monaco's keybindings are shared by every editor on the page: the last
  // one registered would save for all of them).
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const ed = editor.current;
    if (!monaco || !ed) return;
    const sub = ed.onKeyDown((e) => {
      if (isMod(e) && !e.altKey && !e.shiftKey && e.keyCode === monaco.KeyCode.KeyS) {
        e.preventDefault();
        e.stopPropagation();
        void saveRef.current();
      }
    });
    return () => sub.dispose();
  }, [monaco]);

  /** The disk's version of a file, keeping undo (it is one more edit). */
  const reload = useCallback(
    async (path: string) => {
      const doc = docs.current.get(path);
      if (!doc) return;
      const f = await code.read(path);
      doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: f.text }], () => null);
      doc.mtime = f.mtime;
      doc.saved = doc.model.getAlternativeVersionId();
      setConflict(null);
      markDirty();
    },
    [code, markDirty],
  );

  // ── changes on disk (Claude editing the same file): check the tab in front every 2 s while it shows ──
  useEffect(() => {
    if (!monaco) return;
    const id = window.setInterval(async () => {
      const path = shown.current;
      const doc = path !== null ? docs.current.get(path) : undefined;
      if (path === null || !doc || document.hidden || !host.current?.isConnected) return;
      try {
        const st = await code.stat(path);
        if (!st.exists || Math.abs(st.mtime - doc.mtime) <= 1) return;
        if (doc.model.getAlternativeVersionId() === doc.saved) await reload(path);
        else setConflict(path);
      } catch {}
    }, 2000);
    return () => clearInterval(id);
  }, [monaco, code, reload]);

  return (
    // nokey: the canvas leaves keys in here alone (it would take Space for panning: Monaco's input is no text field).
    <div className="code-tool nokey">
      <div className="code-bar">
        <span className="code-root" title={root}>
          {root.length > 72 ? `…${root.slice(-71)}` : root}
        </span>
        <span className="code-state muted small">
          {dirty.length ? t(`${dirty.length} unsaved · ${kbd("mod+s")} saves`, `저장 안 됨 ${dirty.length} · ${kbd("mod+s")}로 저장`) : t("Saved", "저장됨")}
        </span>
      </div>
      <div className="code-main">
        {!single && <FileTree code={code} active={active} onOpen={openFile} onNotice={onNotice} />}
        <div className="code-pane">
          {!single && (
            <div className="code-tabs" role="tablist">
              {open.map((p) => (
                <div key={p} role="tab" aria-selected={p === active} className={`code-tab${p === active ? " on" : ""}`} title={p}>
                  <button className="code-tab-name" onClick={() => setTabs(open, p)}>
                    {dirty.includes(p) ? "● " : ""}
                    {baseName(p)}
                  </button>
                  <button className="code-tab-x" aria-label={t(`Close ${p}`, `${p} 닫기`)} onClick={() => closeTab(p)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {conflict && (
            <div className="code-conflict">
              <span>{t(`${baseName(conflict) || baseName(root)} changed on disk.`, `${baseName(conflict) || baseName(root)}이(가) 디스크에서 바뀌었습니다.`)}</span>
              <button onClick={() => void reload(conflict)}>{t("Use the disk's", "디스크 것 쓰기")}</button>
              <button onClick={() => void save(true)}>{t("Keep mine (save)", "내 것 유지 (저장)")}</button>
            </div>
          )}
          {problem && <p className="code-problem small">{problem}</p>}
          {!open.length && !single && <p className="code-empty muted">{t("Pick a file on the left.", "왼쪽에서 파일을 고르세요.")}</p>}
          <div ref={host} className="code-editor nowheel" aria-busy={loading || !monaco} />
          {!monaco && <p className="code-empty muted">{t("Loading the editor…", "편집기를 불러오는 중…")}</p>}
        </div>
      </div>
    </div>
  );
}

/** The folder, one level at a time (big folders such as node_modules load only when opened). */
function FileTree({ code, active, onOpen, onNotice }: { code: ReturnType<ReturnType<typeof useApi>["code"]>; active: string; onOpen: (p: string) => void; onNotice: (m: string) => void }) {
  const t = useT();
  const [dirs, setDirs] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [adding, setAdding] = useState(false);
  const load = useCallback(
    async (dir: string) => {
      try {
        const r = await code.list(dir);
        setDirs((d) => ({ ...d, [dir]: r.entries }));
      } catch (err) {
        onNotice((err as Error).message);
      }
    },
    [code, onNotice],
  );
  useEffect(() => {
    void load("");
  }, [load]);
  const refresh = () => {
    for (const dir of expanded) void load(dir);
  };
  const toggle = (dir: string) => {
    const next = new Set(expanded);
    if (next.has(dir)) next.delete(dir);
    else {
      next.add(dir);
      if (!dirs[dir]) void load(dir);
    }
    setExpanded(next);
  };
  const rows = (dir: string, depth: number): React.ReactNode =>
    (dirs[dir] ?? []).map((e) => {
      const path = dir ? `${dir}/${e.name}` : e.name;
      return (
        <li key={path}>
          <button
            className={`tree-row${path === active ? " on" : ""}${e.name.startsWith(".") ? " dim" : ""}`}
            style={{ paddingLeft: 6 + depth * 12 }}
            onClick={() => (e.dir ? toggle(path) : onOpen(path))}
            title={path}
          >
            <span className="tree-twisty">{e.dir ? (expanded.has(path) ? "▾" : "▸") : ""}</span>
            {e.name}
          </button>
          {e.dir && expanded.has(path) && <ul>{rows(path, depth + 1)}</ul>}
        </li>
      );
    });
  return (
    <div className="code-tree nowheel">
      <div className="tree-bar">
        <button className="ghost icon" onClick={() => setAdding(true)} title={t("New file", "새 파일")} aria-label={t("New file", "새 파일")}>
          +
        </button>
        <button className="ghost icon" onClick={refresh} title={t("Refresh", "새로 고침")} aria-label={t("Refresh", "새로 고침")}>
          ↻
        </button>
      </div>
      {adding && (
        <input
          className="tree-new"
          autoFocus
          placeholder={t("path/to/new-file.ts", "경로/새파일.ts")}
          onKeyDown={async (e) => {
            if (e.key === "Escape") return setAdding(false);
            if (e.key !== "Enter") return;
            const name = e.currentTarget.value.trim();
            setAdding(false);
            if (!name) return;
            try {
              const r = await code.create(name);
              const parent = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : "";
              await load(parent);
              onOpen(r.path);
            } catch (err) {
              onNotice((err as Error).message);
            }
          }}
          onBlur={() => setAdding(false)}
        />
      )}
      <ul className="tree">{rows("", 0)}</ul>
    </div>
  );
}
