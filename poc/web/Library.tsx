// Component library panel (like Figma's Assets): click to add at the center, or drag onto the canvas.
import { useState } from "react";
import { api, type Template } from "./api.ts";
import { actorLabel, kindLabel, useT } from "./i18n.tsx";

export const TEMPLATE_MIME = "application/x-workboard-template";

export function LibraryPanel({ items, onAdd, onClose, onNotice }: { items: Template[]; onAdd: (id: string) => void; onClose: () => void; onNotice: (m: string) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const shown = items.filter((tpl) => `${tpl.name} ${tpl.description} ${kindLabel(tpl.kind, t)}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="library nowheel" aria-label={t("Library", "라이브러리")}>
      <header>
        <h3>{t("Library", "라이브러리")}</h3>
        <span className="muted">{items.length}</span>
        <span className="spacer" />
        <button className="ghost icon" onClick={onClose} aria-label={t("Close library", "라이브러리 닫기")}>
          ×
        </button>
      </header>
      <input className="lib-search" placeholder={t("Search", "검색")} value={q} onChange={(e) => setQ(e.target.value)} />
      {items.length === 0 ? (
        <p className="muted pad">
          {t("No saved components yet. Right-click a component on the board and choose ", "저장된 컴포넌트가 없습니다. 보드의 컴포넌트를 우클릭하고 ")}
          <b>{t("Save to library", "라이브러리에 저장")}</b>
          {t(".", "을 누르세요.")}
        </p>
      ) : (
        <ul>
          {shown.map((tpl) => (
            <li
              key={tpl.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(TEMPLATE_MIME, tpl.id);
                e.dataTransfer.effectAllowed = "copy";
              }}
              title={t("Click, or drag onto the canvas", "클릭하거나 캔버스로 끌어다 놓으세요")}
            >
              <button className="lib-item" onClick={() => onAdd(tpl.id)}>
                <span className="layer-kind">{kindLabel(tpl.kind, t)}</span>
                <span className="lib-name">{tpl.name}</span>
                {tpl.description && <span className="lib-desc">{tpl.description}</span>}
                <span className="lib-meta">
                  {t(`Saved by ${actorLabel(tpl.createdBy, t)} · used ${tpl.uses}×`, `${actorLabel(tpl.createdBy, t)} 저장 · ${tpl.uses}회 사용`)}
                </span>
              </button>
              <button
                className="ghost icon lib-del"
                aria-label={t(`Delete ${tpl.name}`, `${tpl.name} 삭제`)}
                title={t("Remove from library", "라이브러리에서 삭제")}
                onClick={() =>
                  confirm(t(`Remove "${tpl.name}" from the library?`, `"${tpl.name}"을(를) 라이브러리에서 삭제할까요?`)) && api.deleteTemplate(tpl.id).catch((e) => onNotice(e.message))
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
