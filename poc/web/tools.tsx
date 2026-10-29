// Catalog renderers. Each draws a tool from its JSON and turns the person's edits into JSON Patches.
// The canvas frame (Canvas.tsx) and the inspector (Inspector.tsx) wrap these.
import { useEffect, useState } from "react";
import type { ChecklistItem, FormField, TableColumn, Tool } from "../shared/catalog.ts";
import { useApi } from "./api.ts";
import { AppFrame } from "./AppFrame.tsx";
import { BrowserView } from "./BrowserView.tsx";
import { useT } from "./i18n.tsx";

type Patch = (ops: unknown[]) => Promise<void>;
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** The working surface of a tool, drawn inside its canvas frame. */
export function ToolBody({ tool, selected = false, onNotice, onAppErrors }: { tool: Tool; selected?: boolean; onNotice: (m: string) => void; onAppErrors: (n: number) => void }) {
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
      return <NoteTool tool={tool} patch={patch} />;
    case "app":
      return <AppFrame tool={tool} onNotice={onNotice} onErrors={onAppErrors} />;
    case "browser":
      return <BrowserView tool={tool} selected={selected} onNotice={onNotice} />;
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
function NoteTool({ tool, patch }: { tool: Tool; patch: Patch }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(tool.state.text);
  useEffect(() => {
    if (!editing) setText(tool.state.text);
  }, [tool.version, editing]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!editing) {
    return (
      <div className="note-tool">
        <pre>{tool.state.text || <span className="muted">{t("(empty)", "(비어 있음)")}</span>}</pre>
        <button className="ghost" onClick={() => setEditing(true)}>
          {t("Edit", "편집")}
        </button>
      </div>
    );
  }
  return (
    <div className="note-tool">
      <textarea className="nowheel" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="form-foot">
        <button className="ghost" onClick={() => setEditing(false)}>
          {t("Cancel", "취소")}
        </button>
        <button
          onClick={async () => {
            await patch([{ op: "replace", path: "/text", value: text }]);
            setEditing(false);
          }}
        >
          {t("Save", "저장")}
        </button>
      </div>
    </div>
  );
}
