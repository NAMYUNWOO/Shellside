// Right panel, like Figma's design panel: the selected frame's properties, or layers + channels + history when nothing is selected.
import { useEffect, useState } from "react";
import { describeValue, SECTION_COLORS, type BoardEvent, type Channel, type Section, type SectionColor, type Tool } from "../shared/catalog.ts";
import { useApi } from "./api.ts";
import { actorLabel, ago, eventText, kindLabel, useI18n, useT } from "./i18n.tsx";

interface InspectorProps {
  selected: Tool[];
  selectedSections: Section[];
  sections: Section[];
  /** The tools in a section (by where their top part is). */
  sectionTools: (sec: Section) => Tool[];
  onSectionRename: (id: string, title: string) => void;
  onSectionColor: (id: string, color: SectionColor) => void;
  onSectionSend: (ids: string[]) => void;
  onSectionFit: (ids: string[]) => void;
  onSectionUngroup: (ids: string[]) => void;
  onSectionDelete: (ids: string[]) => void;
  onPickSection: (id: string) => void;
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
  const { selected, selectedSections } = props;
  const label =
    selectedSections.length && !selected.length
      ? t("Section", "섹션")
      : selected.length === 1
        ? t("Properties", "속성")
        : selected.length > 1
          ? t(`${selected.length} selected`, `${selected.length}개 선택`)
          : t("Board", "보드");
  return (
    <aside className="inspector nowheel">
      <div className="insp-head">
        <span>{label}</span>
        <button className="ghost icon" onClick={props.onCollapse} title={t("Collapse panel", "패널 접기")} aria-label={t("Collapse properties panel", "속성 패널 접기")}>
          »
        </button>
      </div>
      {selectedSections.length && !selected.length ? (
        <SectionInspector key={selectedSections.map((x) => x.id).join()} {...props} />
      ) : selected.length === 1 ? (
        <ToolInspector key={selected[0].id} {...props} tool={selected[0]} />
      ) : selected.length > 1 ? (
        <MultiInspector {...props} />
      ) : (
        <Overview {...props} />
      )}
    </aside>
  );
}

const SECTION_COLOR_NAMES: Record<SectionColor, [string, string]> = {
  gray: ["Gray", "회색"],
  red: ["Red", "빨강"],
  orange: ["Orange", "주황"],
  yellow: ["Yellow", "노랑"],
  green: ["Green", "초록"],
  blue: ["Blue", "파랑"],
  violet: ["Violet", "보라"],
  pink: ["Pink", "분홍"],
};

/** A selected section: its name and colour, what is in it, and what to do with it. */
function SectionInspector({ selectedSections, sectionTools, onSectionRename, onSectionColor, onSectionSend, onSectionFit, onSectionUngroup, onSectionDelete, onPick }: InspectorProps) {
  const t = useT();
  const sec = selectedSections[0];
  const ids = selectedSections.map((x) => x.id);
  const [title, setTitle] = useState(sec.title);
  useEffect(() => setTitle(sec.title), [sec.title]);
  const inside = sectionTools(sec);
  return (
    <>
      <section className="insp-section">
        <div className="insp-kind">
          {t("Section", "섹션")} <span className="frame-name">@{sec.name}</span>
        </div>
        {selectedSections.length === 1 ? (
          <input
            id="insp-section-title"
            className="insp-title"
            aria-label={t("Section name", "섹션 이름")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== sec.title && onSectionRename(sec.id, title.trim())}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <h3 className="insp-multi">{t(`${selectedSections.length} sections`, `섹션 ${selectedSections.length}개`)}</h3>
        )}
        <div className="swatches" role="radiogroup" aria-label={t("Color", "색")}>
          {SECTION_COLORS.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={sec.color === c}
              className={`swatch sec-${c}${sec.color === c ? " on" : ""}`}
              title={t(SECTION_COLOR_NAMES[c][0], SECTION_COLOR_NAMES[c][1])}
              aria-label={t(SECTION_COLOR_NAMES[c][0], SECTION_COLOR_NAMES[c][1])}
              onClick={() => ids.forEach((id) => onSectionColor(id, c))}
            />
          ))}
        </div>
      </section>
      {selectedSections.length === 1 && (
        <section className="insp-section">
          <div className="insp-kind">{t(`In it: ${inside.length}`, `안에 있는 것: ${inside.length}`)}</div>
          <ul className="sel-list">
            {inside.map((tl) => (
              <li key={tl.id}>
                <button className="ghost" onClick={() => onPick(tl.id)}>
                  <span className="layer-kind">{kindLabel(tl.kind, t)}</span> {tl.title}
                </button>
              </li>
            ))}
            {!inside.length && <li className="muted">{t("Drag frames into it, or add one inside.", "프레임을 끌어 넣거나 안에 새로 추가하세요.")}</li>}
          </ul>
        </section>
      )}
      <section className="insp-section insp-actions">
        <button className="primary wide" onClick={() => onSectionSend(ids)}>
          {t("Send section to Claude…", "섹션을 Claude에게 보내기…")}
        </button>
        <button className="wide" onClick={() => onSectionFit(ids)}>
          {t("Zoom to section", "섹션에 맞추기")}
        </button>
        <button className="wide" onClick={() => onSectionUngroup(ids)}>
          {t("Remove section, keep what is in it", "섹션만 없애기 (안의 것은 남김)")}
        </button>
        <p className="muted small">
          {t(
            "Drag the name to move the section and what is in it. Frames you drag in or out join or leave it. Claude can use @" + sec.name + ".",
            "이름을 끌면 섹션과 안의 것이 함께 움직입니다. 프레임을 끌어 넣거나 빼면 섹션에 들어오고 나갑니다. Claude에게는 @" + sec.name + "로 가리킬 수 있습니다.",
          )}
        </p>
      </section>
      <section className="insp-section">
        <button className="danger wide" onClick={() => onSectionDelete(ids)}>
          {t("Delete section and what is in it", "섹션과 안의 것 삭제")}
        </button>
      </section>
    </>
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

function Overview({ tools, channels, events, now, onPick, sections, sectionTools, onPickSection }: InspectorProps) {
  const { t, lang } = useI18n();
  const [tab, setTab] = useState<"layers" | "channels" | "history">("layers");
  const layers = [...tools].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Each tool under the smallest section it is in, as layers sit under their section in Figma.
  const home = new Map<string, string>();
  for (const sec of [...sections].sort((a, b) => b.layout.w * b.layout.h - a.layout.w * a.layout.h)) for (const tl of sectionTools(sec)) home.set(tl.id, sec.id);
  const layerRow = (tl: Tool, nested = false) => (
    <li key={tl.id} className={nested ? "nested" : undefined}>
      <button onClick={() => onPick(tl.id)}>
        <span className="layer-kind">{kindLabel(tl.kind, t)}</span>
        <span className="layer-title">{tl.title}</span>
        <span className={`layer-who ${tl.updatedBy}`}>
          {actorLabel(tl.updatedBy, t)} · {ago(tl.updatedAt, now, t)}
        </span>
      </button>
    </li>
  );
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
          {layers.length === 0 && !sections.length && <li className="muted pad">{t("No tools yet.", "도구가 없습니다.")}</li>}
          {sections.map((sec) => (
            <li key={sec.id} className="layer-section">
              <button onClick={() => onPickSection(sec.id)}>
                <span className={`layer-kind swatch-dot sec-${sec.color}`} aria-hidden />
                <span className="layer-title">{sec.title}</span>
                <span className="layer-who">@{sec.name}</span>
              </button>
              <ul>{layers.filter((tl) => home.get(tl.id) === sec.id).map((tl) => layerRow(tl, true))}</ul>
            </li>
          ))}
          {layers.filter((tl) => !home.has(tl.id)).map((tl) => layerRow(tl))}
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
