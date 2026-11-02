// The board opens only in a browser paired with the server (server/auth.ts): only a paired browser counts as the
// person, so nothing else on this computer (Claude in a board's terminal included) can approve, type into a terminal
// or send requests as them. The first browser on a fresh server pairs by itself; later ones enter a code that the
// server prints in its own console.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { authApi, UNPAIRED_EVENT } from "./api.ts";
import { useI18n } from "./i18n.tsx";
import { ShellsideMark } from "./ShellsideMark.tsx";

type Gate = "checking" | "offline" | "paired" | "unpaired";

export function PairGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>("checking");
  const timer = useRef(0);

  const check = useCallback(async (tryFirst = true): Promise<void> => {
    clearTimeout(timer.current);
    try {
      const s = await authApi.status();
      if (s.paired) return setGate("paired");
      if (s.firstRun && tryFirst) {
        await authApi.pairFirst().catch(() => {});
        return check(false);
      }
      setGate("unpaired");
    } catch {
      // The server is not up (yet): keep trying, and keep a board that is already open as it is.
      setGate((g) => (g === "checking" ? "offline" : g));
      timer.current = window.setTimeout(() => void check(tryFirst), 1500);
    }
  }, []);

  useEffect(() => {
    void check();
    const onUnpaired = () => void check();
    window.addEventListener(UNPAIRED_EVENT, onUnpaired);
    return () => {
      window.removeEventListener(UNPAIRED_EVENT, onUnpaired);
      clearTimeout(timer.current);
    };
  }, [check]);

  if (gate === "paired") return <>{children}</>;
  if (gate === "unpaired") return <PairScreen onPaired={() => setGate("paired")} />;
  return <Connecting offline={gate === "offline"} />;
}

function Connecting({ offline }: { offline: boolean }) {
  const { t } = useI18n();
  return <div className="pair-screen">{offline && <p className="pair-wait">{t("Connecting to the Shellside server…", "Shellside 서버에 연결하는 중…")}</p>}</div>;
}

function PairScreen({ onPaired }: { onPaired: () => void }) {
  const { t, lang, setLang } = useI18n();
  const [code, setCode] = useState("");
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const digits = code.replace(/\D/g, "");

  const ask = async () => {
    setError("");
    try {
      await authApi.requestCode();
      setAsked(true);
      input.current?.focus();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (digits.length !== 8 || busy) return;
    setBusy(true);
    setError("");
    try {
      await authApi.pair(digits);
      onPaired();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="pair-screen">
      <form className="pair-card" onSubmit={submit}>
        <header className="pair-head">
          <ShellsideMark size={26} />
          <h1>{t("Connect this browser", "이 브라우저 연결")}</h1>
          <button type="button" className="ghost small" onClick={() => setLang(lang === "ko" ? "en" : "ko")}>
            {lang === "ko" ? "English" : "한국어"}
          </button>
        </header>
        <p className="pair-lead">
          {t("This browser isn't connected to the Shellside server yet. Each browser only needs to connect once.", "이 브라우저는 아직 Shellside 서버에 연결되지 않았습니다. 브라우저마다 처음 한 번만 연결하면 됩니다.")}
        </p>
        <ol className="pair-steps">
          <li>
            <p>
              {asked ? (
                t("The code is now in the terminal.", "터미널에 연결 코드를 띄웠습니다.")
              ) : lang === "ko" ? (
                <>
                  <code>npm run dev</code>를 실행한 터미널에 연결 코드를 띄우세요.
                </>
              ) : (
                <>
                  Show a pairing code in the terminal running <code>npm run dev</code>.
                </>
              )}
            </p>
            <div className="pair-row">
              <button type="button" onClick={ask}>
                {asked ? t("Show again", "다시 띄우기") : t("Show code", "코드 띄우기")}
              </button>
            </div>
          </li>
          <li>
            <p>{t("Enter the 8-digit code from the terminal.", "터미널에 표시된 8자리 숫자를 입력하세요.")}</p>
            <div className="pair-row">
              <input
                ref={input}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^\d\s-]/g, "").slice(0, 10))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="1234-5678"
                aria-label={t("Pairing code", "연결 코드")}
              />
              <button className="primary" disabled={digits.length !== 8 || busy}>
                {t("Connect", "연결")}
              </button>
            </div>
          </li>
        </ol>
        {error && (
          <p className="pair-error" role="alert">
            {error}
          </p>
        )}
        <p className="pair-note">
          {t("A code is valid for 10 minutes and works once.", "코드는 10분 동안 유효하고 한 번만 쓸 수 있습니다.")}{" "}
          {t(
            "Approvals, terminal input and requests to Claude are accepted only from connected browsers, so no other program on this computer, Claude in a board terminal included, can approve or type for you.",
            "승인, 터미널 입력, Claude 요청은 연결된 브라우저에서만 받습니다. 보드 터미널 속 Claude를 포함해 이 컴퓨터의 다른 프로그램이 사용자 대신 승인하거나 입력하지 못하게 하려는 장치입니다.",
          )}
        </p>
      </form>
    </div>
  );
}
