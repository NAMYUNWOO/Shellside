// Catalog renderers. Each draws a tool from its JSON and turns the person's edits into JSON Patches.
// The canvas frame (Canvas.tsx) and the inspector (Inspector.tsx) wrap these.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChecklistItem, FormField, TableColumn, Tool } from "../shared/catalog.ts";
import { desktop, useApi } from "./api.ts";
import { IS_MAC } from "./keys.ts";
import { AppFrame } from "./AppFrame.tsx";
import { BrowserView } from "./BrowserView.tsx";
import { useT } from "./i18n.tsx";

type Patch = (ops: unknown[]) => Promise<void>;
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** The working surface of a tool, drawn inside its canvas frame. */
export function ToolBody({ tool, onNotice, onAppErrors }: { tool: Tool; onNotice: (m: string) => void; onAppErrors: (n: number) => void }) {
  const api = useApi();
  const t = useT();
  const patch: Patch = async (ops) => {
    try {
      await api.patchState(tool.id, ops, tool.version);
    } catch (err) {
      onNotice((err as Error).message);
    }
  };
  switch (tool.kind) {
    case "checklist":
      return <Checklist tool={tool} patch={patch} />;
    case "form":
      return <FormTool tool={tool} patch={patch} />;
    case "table":
      return <TableTool tool={tool} patch={patch} />;
    case "note":
      return <NoteTool tool={tool} onNotice={onNotice} />;
    case "app":
      return <AppFrame tool={tool} onNotice={onNotice} onErrors={onAppErrors} />;
    case "browser":
      return <BrowserView tool={tool} onNotice={onNotice} />;
    case "file":
      return <FileTool tool={tool} patch={patch} onNotice={onNotice} />;
    default:
      return <p className="muted">{t(`Unknown tool kind: ${tool.kind}`, `알 수 없는 도구 형식: ${tool.kind}`)}</p>;
  }
}

// ── checklist ────────────────────────────────────────────────────────────────
function Checklist({ tool, patch }: { tool: Tool; patch: Patch }) {
  const t = useT();
  const items: ChecklistItem[] = tool.state.items;
  const done = items.filter((i) => i.done).length;
  const [label, setLabel] = useState("");
  const add = () => {
    if (!label.trim()) return;
    patch([{ op: "add", path: "/items/-", value: { id: newId("i"), label: label.trim(), done: false, gate: "none" } }]);
    setLabel("");
  };
  return (
    <div className="checklist">
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done}>
        <div className="bar" style={{ width: items.length ? `${(done / items.length) * 100}%` : 0 }} />
        <span>{t(`${done}/${items.length} done`, `${done}/${items.length} 완료`)}</span>
      </div>
      <ul>
        {items.map((it, i) => (
          <li key={it.id} className={it.done ? "done" : ""}>
            <label>
              <input type="checkbox" checked={it.done} onChange={() => patch([{ op: "replace", path: `/items/${i}/done`, value: !it.done }])} />
              <span className="label">{it.label}</span>
            </label>
            {it.gate === "human" && <span className="badge gate">{it.done ? t("Approved", "승인됨") : t("Needs approval", "사람 승인 필요")}</span>}
            {it.note && <div className="item-note">{it.note}</div>}
          </li>
        ))}
      </ul>
      <div className="add-row">
        <input value={label} placeholder={t("Add item", "항목 추가")} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()} />
      </div>
    </div>
  );
}

// ── form ─────────────────────────────────────────────────────────────────────
export function FieldInput({ field, value, onChange }: { field: FormField; value: unknown; onChange: (v: unknown) => void }) {
  const t = useT();
  const id = `f-${field.name}`;
  const common = { id, name: field.name, required: field.required, placeholder: field.placeholder };
  let control: React.ReactNode;
  switch (field.type) {
    case "textarea":
      control = <textarea {...common} className="nowheel" rows={3} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "number":
      control = <input {...common} type="number" value={(value as number | string) ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />;
      break;
    case "select":
      control = (
        <select {...common} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("Choose…", "선택…")}</option>
          {field.options?.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      );
      break;
    case "checkbox":
      control = <input {...common} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />;
      break;
    default:
      control = <input {...common} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className={`field field-${field.type}`}>
      <label htmlFor={id}>
        {field.label}
        {field.required && <span className="req"> *</span>}
      </label>
      {control}
    </div>
  );
}

function FormTool({ tool, patch }: { tool: Tool; patch: Patch }) {
  const t = useT();
  const fields: FormField[] = tool.props.fields;
  const [draft, setDraft] = useState<Record<string, unknown>>(tool.state.values);
  useEffect(() => setDraft(tool.state.values), [tool.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    patch([
      { op: "add", path: "/values", value: draft },
      { op: "add", path: "/submitted", value: true },
      { op: "add", path: "/submittedAt", value: new Date().toISOString() },
    ]);
  };
  return (
    <form className="form-tool" onSubmit={submit}>
      {fields.map((f) => (
        <FieldInput key={f.name} field={f} value={draft[f.name]} onChange={(v) => setDraft((d) => ({ ...d, [f.name]: v }))} />
      ))}
      <div className="form-foot">
        {tool.state.submitted && <span className="muted">{t("Submitted", "제출됨")}</span>}
        <button type="submit">{tool.props.submitLabel ?? (tool.state.submitted ? t("Submit again", "다시 제출") : t("Submit", "제출"))}</button>
      </div>
    </form>
  );
}

// ── table ────────────────────────────────────────────────────────────────────
function TableTool({ tool, patch }: { tool: Tool; patch: Patch }) {
  const t = useT();
  const columns: TableColumn[] = tool.props.columns;
  const rows: Record<string, any>[] = tool.state.rows;
  const commit = (i: number, key: string, value: unknown) => {
    if (rows[i][key] === value) return;
    patch([{ op: "add", path: `/rows/${i}/${key}`, value }]);
  };
  return (
    <div className="table-tool">
      <div className="table-scroll nowheel">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
              <th aria-label={t("Delete row", "행 삭제")} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.id}>
                {columns.map((c) => (
                  <td key={c.key} className={`col-${c.type}`}>
                    <Cell column={c} value={row[c.key]} version={tool.version} onCommit={(v) => commit(i, c.key, v)} />
                  </td>
                ))}
                <td className="row-del">
                  <button className="ghost icon" aria-label={t("Delete row", "행 삭제")} onClick={() => patch([{ op: "remove", path: `/rows/${i}` }])}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="ghost" onClick={() => patch([{ op: "add", path: "/rows/-", value: { id: newId("r") } }])}>
        {t("+ Add row", "+ 행 추가")}
      </button>
    </div>
  );
}

function Cell({ column, value, version, onCommit }: { column: TableColumn; value: unknown; version: number; onCommit: (v: unknown) => void }) {
  if (column.type === "select") {
    return (
      <select value={(value as string) ?? ""} onChange={(e) => onCommit(e.target.value)}>
        <option value="">—</option>
        {column.options?.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  }
  if (column.type === "checkbox") return <input type="checkbox" checked={Boolean(value)} onChange={(e) => onCommit(e.target.checked)} />;
  const isNum = column.type === "number";
  return (
    <input
      key={`${version}`}
      type={isNum ? "number" : "text"}
      defaultValue={(value as string | number) ?? ""}
      onBlur={(e) => onCommit(isNum ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && (e.target as HTMLInputElement).blur()}
    />
  );
}

// ── note ─────────────────────────────────────────────────────────────────────
// Always editable, and what is typed is the note: it is saved a moment after typing stops (and when the note loses
// focus), so the agent always reads what is on screen. Text from elsewhere (the agent) shows unless the person has
// typing that is not saved yet.
const NOTE_SAVE_MS = 400;
function NoteTool({ tool, onNotice }: { tool: Tool; onNotice: (m: string) => void }) {
  const api = useApi();
  const t = useT();
  const [text, setText] = useState<string>(tool.state.text ?? "");
  const unsaved = useRef<string | null>(null); // typed but not sent yet
  const inflight = useRef(0); // saves on their way: their echoes may be older than what is on screen
  const serverText = useRef<string>(tool.state.text ?? "");
  const timer = useRef<number | undefined>(undefined);
  const area = useRef<HTMLTextAreaElement>(null);
  const notice = useRef(onNotice);
  notice.current = onNotice;

  const save = useCallback(() => {
    window.clearTimeout(timer.current);
    const value = unsaved.current;
    if (value === null) return;
    unsaved.current = null;
    inflight.current++;
    // No baseVersion: the newest text wins (this is the person typing right now).
    api
      .patchState(tool.id, [{ op: "replace", path: "/text", value }])
      .catch((err: Error) => {
        if (unsaved.current === null) unsaved.current = value; // try again with the next keystroke or blur
        notice.current(err.message);
      })
      .finally(() => {
        // Once every save has landed, show what the board has (the same text, unless someone else wrote since).
        if (--inflight.current === 0 && unsaved.current === null) setText(serverText.current);
      });
  }, [api, tool.id]);

  useEffect(() => {
    serverText.current = tool.state.text ?? "";
    if (unsaved.current === null && inflight.current === 0) setText(serverText.current);
  }, [tool.state.text]);
  useEffect(() => save, [save]); // leaving the board (or deleting the note) still saves the last keystrokes
  useEffect(() => {
    const flush = () => save();
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [save]);
  // The note grows with its text (the board frame follows), so it never scrolls inside.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  return (
    <div className="note-tool">
      <textarea
        ref={area}
        value={text}
        rows={4}
        placeholder={t("Write a note…", "메모를 적으세요…")}
        aria-label={t("Note", "메모")}
        onChange={(e) => {
          setText(e.target.value);
          unsaved.current = e.target.value;
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(save, NOTE_SAVE_MS);
        }}
        onBlur={save}
      />
    </div>
  );
}

// ── file: a file on the board (kept in the board's workspace) ────────────────
const humanSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
/** Opening these would run a program: show them in their folder instead. */
const RUNS = /\.(exe|bat|cmd|com|msi|ps1|vbs|vbe|js|jse|wsf|wsh|scr|lnk|reg|hta|cpl|jar|app|command|sh|bash|zsh|pkg|scpt|workflow)$/i;

function FileTool({ tool, patch, onNotice }: { tool: Tool; patch: Patch; onNotice: (m: string) => void }) {
  const api = useApi();
  const t = useT();
  const { fileName, path, relPath, size, mime } = tool.props as { fileName: string; path: string; relPath?: string; size: number; mime: string };
  const image = /^image\/(png|jpeg|gif|webp|bmp|avif|x-icon)$/.test(mime);
  const text = (/^text\//.test(mime) && mime !== "text/html") || /json|xml|ndjson|yaml/.test(mime);
  const ext = (fileName.match(/\.([^.]{1,5})$/)?.[1] ?? "").toUpperCase();
  const [head, setHead] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [note, setNote] = useState<string>(tool.state.note ?? "");
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setNote(tool.state.note ?? "");
  }, [tool.state.note]);
  useEffect(() => {
    if (!text) return;
    fetch(api.fileUrl(tool.id, 2048))
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then(setHead, () => setMissing(true));
  }, [api, tool.id, path, text]);
  const copy = () => navigator.clipboard?.writeText(path).then(() => onNotice(t("Copied the path", "경로를 복사했습니다")));
  const open = async () => {
    if (RUNS.test(fileName)) return onNotice(t("This file runs a program, so it isn't opened from the board. Show it in its folder instead.", "프로그램을 실행하는 파일이라 보드에서 열지 않습니다. 폴더에서 보기를 쓰세요."));
    if (desktop) {
      const err = await desktop.openPath(path);
      if (err) onNotice(err);
    } else window.open(api.fileUrl(tool.id), "_blank", "noopener");
  };
  return (
    <div className="file-tool">
      <div className="file-head">
        <span className={`file-icon${image ? " image" : text ? " text" : ""}`} aria-hidden>
          {ext || "FILE"}
        </span>
        <div className="file-meta">
          <b className="file-name" title={fileName}>
            {fileName}
          </b>
          <span className="muted small">
            {humanSize(size)}
            {mime && mime !== "application/octet-stream" ? ` · ${mime}` : ""}
          </span>
        </div>
      </div>
      {image && !missing && <img className="file-preview" src={api.fileUrl(tool.id)} alt={fileName} loading="lazy" draggable={false} onError={() => setMissing(true)} />}
      {text && head !== null && (
        <pre className="file-text nowheel">
          {head}
          {size > 2048 ? "\n…" : ""}
        </pre>
      )}
      {missing && <p className="file-missing small">{t("The file is no longer where it was.", "파일이 원래 자리에 없습니다.")}</p>}
      <button className="file-path" onClick={copy} title={t("Copy the path (Claude reads the file there)", "경로 복사 (Claude는 이 경로에서 파일을 읽습니다)")}>
        {relPath ?? path}
      </button>
      <div className="file-actions">
        <button onClick={open}>{t("Open", "열기")}</button>
        {desktop && <button onClick={() => void desktop!.showInFolder(path)}>{IS_MAC ? t("Show in Finder", "Finder에서 보기") : t("Show in folder", "폴더에서 보기")}</button>}
        <button onClick={copy}>{t("Copy path", "경로 복사")}</button>
      </div>
      <textarea
        className="file-note nowheel"
        rows={2}
        value={note}
        placeholder={t("A note about this file (Claude reads it too)", "이 파일에 대한 메모 (Claude도 읽습니다)")}
        onFocus={() => (editing.current = true)}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          editing.current = false;
          if (note !== (tool.state.note ?? "")) void patch([{ op: "replace", path: "/note", value: note }]);
        }}
      />
    </div>
  );
}
