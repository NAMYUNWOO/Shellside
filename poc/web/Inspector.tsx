// Right panel, like Figma's design panel: the selected frame's properties, or layers + channels + history when nothing is selected.
import { useEffect, useState } from "react";
import { describeValue, type BoardEvent, type Channel, type Tool } from "../shared/catalog.ts";
import { useApi } from "./api.ts";
import { actorLabel, ago, eventText, kindLabel, useI18n, useT } from "./i18n.tsx";

interface InspectorProps {
  selected: Tool[];
  tools: Tool[];
  channels: Channel[];
  events: BoardEvent[];
  now: number;
  errors: number;
  onPick: (id: string) => void;
  onNotice: (m: string) => void;
  onSendToClaude: (ids: string[]) => void;
  onSave: (tool: Tool) => void;
  onFit: (ids: string[]) => void;
  onDelete: (ids: string[]) => void;
  onCollapse: () => void;
}

export function Inspector(props: InspectorProps) {
  const t = useT();
  const { selected } = props;
  const label = selected.length === 1 ? t("Properties", "속성") : selected.length > 1 ? t(`${selected.length} selected`, `${selected.length}개 선택`) : t("Board", "보드");
  return (
    <aside className="inspector nowheel">
      <div className="insp-head">
        <span>{label}</span>
        <button className="ghost icon" onClick={props.onCollapse} title={t("Collapse panel", "패널 접기")} aria-label={t("Collapse properties panel", "속성 패널 접기")}>
          »
        </button>
      </div>
      {selected.length === 1 ? (
        <ToolInspector key={selected[0].id} {...props} tool={selected[0]} />
      ) : selected.length > 1 ? (
        <MultiInspector {...props} />
      ) : (
        <Overview {...props} />
      )}
    </aside>
  );
}

function MultiInspector({ selected, onSendToClaude, onFit, onDelete }: InspectorProps) {
  const t = useT();
  const ids = selected.map((tl) => tl.id);
  return (
    <>
      <section className="insp-section">
        <div className="insp-kind">{t("Multiple selection", "여러 개 선택")}</div>
        <h3 className="insp-multi">{t(`${selected.length} components`, `${selected.length}개 컴포넌트`)}</h3>
        <ul className="sel-list">
          {selected.map((tl) => (
            <li key={tl.id}>
              <span className="layer-kind">{kindLabel(tl.kind, t)}</span> {tl.title}
            </li>
          ))}
        </ul>
      </section>
      <section className="insp-section insp-actions">
        <button className="primary wide" onClick={() => onSendToClaude(ids)}>
          {t("Send to Claude…", "Claude에게 보내기…")}
        </button>
        <button className="wide" onClick={() => onFit(ids)}>
          {t("Zoom to fit", "화면에 맞추기")}
        </button>
        <p className="muted small">{t("Drag to move them together. ⌘/Ctrl/Shift+click to add or remove.", "드래그해서 함께 옮길 수 있습니다. ⌘/Ctrl/Shift+클릭으로 더하거나 뺍니다.")}</p>
      </section>
      <section className="insp-section">
        <button className="danger wide" onClick={() => onDelete(ids)}>
          {t(`Delete ${selected.length}`, `${selected.length}개 삭제`)}
        </button>
      </section>
    </>
  );
}

function ToolInspector({ tool, now, errors, onNotice, onSendToClaude, onSave, onDelete }: InspectorProps & { tool: Tool }) {
  const api = useApi();
  const t = useT();
  const [title, setTitle] = useState(tool.title);
  const [desc, setDesc] = useState(tool.description);
  const [logs, setLogs] = useState<{ at: string; level: string; message: string }[] | null>(null);
  useEffect(() => setTitle(tool.title), [tool.title]);
  const [name, setName] = useState(tool.name ?? "");
  useEffect(() => setName(tool.name ?? ""), [tool.name]);
  useEffect(() => setDesc(tool.description), [tool.description]);

  const fail = (err: Error) => onNotice(err.message);
  const saveMeta = (patch: Partial<Tool>) => api.updateTool(tool.id, patch).catch(fail);
  const L = tool.layout;
  const loadLogs = () =>
    api
      .appLogs(tool.id)
      .then((d) => setLogs(d.logs ?? []))
      .catch(fail);

  return (
    <>
      <section className="insp-section">
        <div className="insp-kind">
          {kindLabel(tool.kind, t)}
          <button
            className="ghost id"
            title={t("Copy ID (to point the agent at this tool)", "ID 복사 (agent에게 이 도구를 가리킬 때)")}
            onClick={() => navigator.clipboard?.writeText(tool.id).then(() => onNotice(t(`Copied ${tool.id}`, `${tool.id} 복사됨`)))}
          >
            {tool.id}
          </button>
        </div>
        <input
          id="insp-title"
          className="insp-title"
          aria-label={t("Title", "제목")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== tool.title && saveMeta({ title })}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && (e.target as HTMLInputElement).blur()}
        />
        <label className="insp-name" title={t("The name you use for it in requests to Claude, e.g. \"summarize @notes\"", "Claude에게 요청할 때 부르는 이름입니다. 예: \"@notes 요약해줘\"")}>
          <span aria-hidden>@</span>
          <input
            id="insp-name"
            aria-label={t("Name (for requests to Claude)", "이름 (Claude에게 요청할 때)")}
            value={name}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setName(e.target.value.replace(/\s/g, ""))}
            onBlur={() => {
              const n = name.trim().replace(/^@/, "");
              if (!n || n === tool.name) return setName(tool.name ?? "");
              api.updateTool(tool.id, { name: n }).catch((err: Error) => {
                setName(tool.name ?? "");
                fail(err);
              });
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              else if (e.key === "Escape") {
                setName(tool.name ?? "");
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </label>
        <textarea
          className="insp-desc"
          aria-label={t("Description", "설명")}
          rows={2}
          placeholder={t("Description (the agent reads it too)", "설명 (agent도 읽습니다)")}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onBlur={() => desc !== tool.description && saveMeta({ description: desc })}
        />
      </section>

      {L && (
        <section className="insp-section insp-xyw">
          {(tool.kind === "browser" ? (["x", "y", "w", "h"] as const) : (["x", "y", "w"] as const)).map((k) => (
            <label key={k}>
              <span>{k.toUpperCase()}</span>
              <NumberField value={L[k] ?? 0} onCommit={(v) => api.setLayout(tool.id, { [k]: v }).catch(fail)} />
            </label>
          ))}
        </section>
      )}

      <section className="insp-section insp-meta">
        <div>
          <span>{t("Created by", "만든 이")}</span>
          <b className={tool.createdBy}>{actorLabel(tool.createdBy, t)}</b>
        </div>
        <div>
          <span>{t("Last change", "최근 변경")}</span>
          <b className={tool.updatedBy}>
            {actorLabel(tool.updatedBy, t)} · {ago(tool.updatedAt, now, t)}
          </b>
        </div>
        <div>
          <span>{t("Version", "버전")}</span>
          <b>v{tool.version}</b>
        </div>
      </section>

      <section className="insp-section">
        <h4>{t("Agent access", "agent 권한")}</h4>
        <div className="segmented" role="group" aria-label={t("Agent access", "agent 권한")}>
          <button aria-pressed={tool.agentAccess === "read"} onClick={() => saveMeta({ agentAccess: "read" })}>
            {t("Read only", "읽기만")}
          </button>
          <button aria-pressed={tool.agentAccess === "write"} onClick={() => saveMeta({ agentAccess: "write" })}>
            {t("Read & write", "읽기·쓰기")}
          </button>
        </div>
      </section>

      <section className="insp-section insp-actions">
        <button className="primary wide" onClick={() => onSendToClaude([tool.id])}>
          {t("Send to Claude…", "Claude에게 보내기…")}
        </button>
        <button className="wide" onClick={() => onSave(tool)}>
          {t("Save to library…", "라이브러리에 저장…")}
        </button>
      </section>

      {tool.kind === "app" && (
        <>
          <details className="insp-section" onToggle={(e) => (e.target as HTMLDetailsElement).open && loadLogs()}>
            <summary>
              {t("Logs", "로그")} {errors > 0 && <span className="pill error">{t(`${errors} error${errors > 1 ? "s" : ""}`, `오류 ${errors}`)}</span>}
            </summary>
            <div className="row-end">
              <button className="ghost" onClick={loadLogs}>
                {t("Refresh", "새로고침")}
              </button>
            </div>
            <ol className="logs">
              {logs?.length === 0 && <li className="muted">{t("(no logs)", "(로그 없음)")}</li>}
              {logs?.map((l, i) => (
                <li key={i} className={`log-${l.level}`}>
                  <span>{l.level}</span> {l.message}
                </li>
              ))}
            </ol>
          </details>
          <details className="insp-section">
            <summary>{t("Code", "코드")}</summary>
            {tool.props.sourcePath && <div className="muted">workspace/{tool.props.sourcePath}</div>}
            <pre className="code">{tool.props.source}</pre>
          </details>
        </>
      )}

      <section className="insp-section">
        <button className="danger wide" onClick={() => onDelete([tool.id])}>
          {t("Delete tool", "도구 삭제")}
        </button>
      </section>
    </>
  );
}

function NumberField({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => {
    const n = Number(v);
    if (Number.isFinite(n) && n !== value) onCommit(n);
    else setV(String(value));
  };
  return <input inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />;
}

function Overview({ tools, channels, events, now, onPick }: InspectorProps) {
  const { t, lang } = useI18n();
  const [tab, setTab] = useState<"layers" | "channels" | "history">("layers");
  const layers = [...tools].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "layers"} onClick={() => setTab("layers")}>
          {t(`Layers ${tools.length}`, `레이어 ${tools.length}`)}
        </button>
        <button role="tab" aria-selected={tab === "channels"} onClick={() => setTab("channels")} title={t("Data the apps on this board share", "이 보드의 앱들이 함께 쓰는 데이터")}>
          {t(`Channels ${channels.length}`, `채널 ${channels.length}`)}
        </button>
        <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>
          {t("History", "이력")}
        </button>
      </div>
      {tab === "channels" ? (
        <Channels channels={channels} tools={tools} now={now} onPick={onPick} />
      ) : tab === "layers" ? (
        <ul className="layers">
          {layers.length === 0 && <li className="muted pad">{t("No tools yet.", "도구가 없습니다.")}</li>}
          {layers.map((tl) => (
            <li key={tl.id}>
              <button onClick={() => onPick(tl.id)}>
                <span className="layer-kind">{kindLabel(tl.kind, t)}</span>
                <span className="layer-title">{tl.title}</span>
                <span className={`layer-who ${tl.updatedBy}`}>
                  {actorLabel(tl.updatedBy, t)} · {ago(tl.updatedAt, now, t)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ol className="history">
          {events.length === 0 && <li className="muted pad">{t("No history yet.", "아직 이력이 없습니다.")}</li>}
          {[...events]
            .reverse()
            .slice(0, 80)
            .map((e) => (
              <li key={e.seq}>
                <span className={`who ${e.actor}`}>{actorLabel(e.actor, t)}</span>
                <span className="what">{eventText(e, lang)}</span>
                <time className="muted">{ago(e.at, now, t)}</time>
              </li>
            ))}
        </ol>
      )}
    </>
  );
}

/** The board's channels: what flows between its apps, who wrote it last, and the value itself. */
function Channels({ channels, tools, now, onPick }: { channels: Channel[]; tools: Tool[]; now: number; onPick: (id: string) => void }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  if (!channels.length)
    return (
      <p className="muted pad">
        {t(
          "No channels yet. Apps share data through channels (useChannel), so one app's edits show up in the others at once.",
          "아직 채널이 없습니다. 앱들은 채널(useChannel)로 데이터를 주고받고, 한 앱에서 고치면 다른 앱에 바로 반영됩니다.",
        )}
      </p>
    );
  return (
    <ul className="layers channels">
      {channels.map((c) => {
        const app = c.toolId ? tools.find((x) => x.id === c.toolId) : undefined;
        const text = open === c.name ? JSON.stringify(c.value, null, 2) : "";
        return (
          <li key={c.name}>
            <button onClick={() => setOpen(open === c.name ? null : c.name)} aria-expanded={open === c.name}>
              <span className="layer-kind">v{c.version}</span>
              <span className="layer-title">{c.name}</span>
              <span className={`layer-who ${c.updatedBy}`}>
                {app ? app.title : actorLabel(c.updatedBy, t)} · {ago(c.updatedAt, now, t)}
              </span>
            </button>
            <div className="channel-shape muted">{describeValue(c.value, lang)}</div>
            {open === c.name && (
              <>
                {app && (
                  <button className="ghost channel-from" onClick={() => onPick(app.id)}>
                    {t(`Last written by "${app.title}"`, `마지막으로 쓴 앱: "${app.title}"`)}
                  </button>
                )}
                <pre className="channel-value">{text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text}</pre>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
