// Localization: English by default, Korean on request. Strings live next to their use as t("English", "한국어").
// Switching re-renders every component that calls useT()/useI18n() (context updates reach React Flow nodes too).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { BoardEvent } from "../shared/catalog.ts";

export type Lang = "en" | "ko";
export type T = (en: string, ko: string) => string;

const KEY = "wb.lang";
function initialLang(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "en" || v === "ko") return v;
  } catch {
    /* private mode */
  }
  return "en";
}

let current: Lang = initialLang();
/** The language in use, for code outside React (API request headers). */
export const currentLang = () => current;

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: T;
}
const Ctx = createContext<I18n>({ lang: current, setLang: () => {}, t: (en) => en });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current);
  const setLang = useCallback((l: Lang) => {
    current = l;
    try {
      localStorage.setItem(KEY, l);
    } catch {
      /* ignore */
    }
    setLangState(l);
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo<I18n>(() => ({ lang, setLang, t: (en, ko) => (lang === "ko" ? ko : en) }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
export const useT = () => useContext(Ctx).t;

// ── shared labels ────────────────────────────────────────────────────────────
export function kindLabel(kind: string, t: T): string {
  const labels: Record<string, string> = {
    checklist: t("Checklist", "체크리스트"),
    form: t("Form", "폼"),
    table: t("Table", "표"),
    note: t("Note", "메모"),
    app: t("App", "앱"),
    browser: t("Browser", "브라우저"),
  };
  return labels[kind] ?? kind;
}

export const actorLabel = (actor: string, t: T) => (actor === "agent" ? "agent" : t("person", "사람"));

/** none = Claude not running; starting = running but not ready (trust prompt…); permission = waiting for the person. */
export function agentStateLabel(state: string, t: T): string {
  const labels: Record<string, string> = {
    none: t("off", "꺼짐"),
    starting: t("starting", "준비 중"),
    idle: t("idle", "대기"),
    busy: t("working", "작업 중"),
    permission: t("needs permission", "권한 확인 대기"),
  };
  return labels[state] ?? state;
}

export function ago(iso: string, now: number, t: T): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return t("just now", "방금");
  if (s < 60) return t(`${s}s ago`, `${s}초 전`);
  const m = Math.round(s / 60);
  if (m < 60) return t(`${m}m ago`, `${m}분 전`);
  const h = Math.round(m / 60);
  return t(`${h}h ago`, `${h}시간 전`);
}

/** History lines are written in both languages on the server; the agent always reads the English one. */
export const eventText = (e: BoardEvent, lang: Lang) => (lang === "ko" ? (e.summaryKo ?? e.summary) : e.summary);

/** Language switch: EN / 한국어. */
export function LangSwitch({ compact = false }: { compact?: boolean }) {
  const { lang, setLang } = useI18n();
  return (
    <div className={`lang-switch${compact ? " compact" : ""}`} role="group" aria-label="Language / 언어">
      <button aria-pressed={lang === "en"} onClick={() => setLang("en")} title="English">
        EN
      </button>
      <button aria-pressed={lang === "ko"} onClick={() => setLang("ko")} title="한국어">
        {compact ? "KO" : "한국어"}
      </button>
    </div>
  );
}
