// Right-click menu (portal), kept inside the window, closes on outside click / Escape / scroll.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | { label: string; onSelect: () => void; hint?: string; danger?: boolean; disabled?: boolean; strong?: boolean }
  | { separator: true };

export function ContextMenu({ x, y, title, items, onClose }: { x: number; y: number; title?: string; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(y, innerHeight - r.height - 8)) });
    ref.current!.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  useEffect(() => {
    const outside = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const btns = [...ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      btns.at((i + (e.key === "ArrowDown" ? 1 : -1)) % btns.length)?.focus();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key);
    window.addEventListener("wheel", onClose, { passive: true });
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("wheel", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="ctx-menu" role="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {title && <div className="ctx-title">{title}</div>}
      {items.map((it, i) =>
        "separator" in it ? (
          <div key={i} className="ctx-sep" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={[it.danger && "danger", it.strong && "strong"].filter(Boolean).join(" ")}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            <span>{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
