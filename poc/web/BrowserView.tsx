// A board browser: a live view of a real Chrome tab on the server. The page is drawn from screencast frames;
// the person's mouse, keys and typing (IME included) go back to the page. The agent drives the same tab.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Tool } from "../shared/catalog.ts";
import { useApi, wsUrl } from "./api.ts";
import { useT } from "./i18n.tsx";

interface ViewState {
  ready: boolean;
  url: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  tabs: { title: string; url: string }[];
  active: number;
  control: "shared" | "person";
  agent: boolean;
  dialog: { type: string; message: string; defaultPrompt?: string } | null;
  viewport: { w: number; h: number };
}

interface SelectPopup {
  ref: string;
  rect: { x: number; y: number; w: number; h: number };
  selected: number;
  options: { label: string; disabled: boolean; group?: string }[];
}

interface Marker {
  label: string;
  x?: number;
  y?: number;
  at: number;
}

const modsOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** On screen: not scrolled away, not in a board running in the background, not in a hidden browser tab. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let inView = true;
    const slot = el.closest(".board-slot");
    const update = () => setOn(inView && document.visibilityState === "visible" && !slot?.classList.contains("background"));
    const io = new IntersectionObserver((entries) => {
      inView = entries.some((e) => e.isIntersecting);
      update();
    });
    io.observe(el);
    const mo = slot ? new MutationObserver(update) : null;
    if (slot) mo!.observe(slot, { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("visibilitychange", update);
    return () => {
      io.disconnect();
      mo?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [ref]);
  return on;
}

/** Input the person makes while the connection is down is kept and sent once it is back (moves are dropped). */
const KEEP_WHILE_OFFLINE = new Set(["key", "text", "ime", "nav", "tab", "dialog", "choose", "files", "copy"]);

// ── the wheel over a page ──
// A scroll that starts over a page scrolls the page, and the rest of that gesture (momentum included) stays with it even
// if the pointer slides off. A scroll that starts on the board stays with the board when it passes over a page. A pinch
// (or ⌘/Ctrl+wheel) always zooms the board.
const GESTURE_GAP_MS = 250; // a pause this long ends a gesture
const wheelSinks = new WeakMap<Element, (e: WheelEvent) => void>();
const gesture: { page: Element | null; at: number } = { page: null, at: -Infinity };
function routeWheel(e: WheelEvent) {
  if (e.ctrlKey || e.metaKey) return;
  if (e.timeStamp - gesture.at > GESTURE_GAP_MS) {
    const target = e.target instanceof Element ? e.target : null;
    const page = target?.closest(".browser-page") ?? null;
    gesture.page = page && !target!.closest(".nowheel, .browser-overlay") ? page : null;
  }
  gesture.at = e.timeStamp;
  const sink = gesture.page && wheelSinks.get(gesture.page);
  if (!sink) return;
  e.preventDefault();
  e.stopPropagation(); // before the board's own wheel handling (zoom, Shift+wheel pan)
  sink(e);
}
if (typeof window !== "undefined") {
  const w = window as unknown as { __browserWheel?: (e: WheelEvent) => void };
  if (w.__browserWheel) window.removeEventListener("wheel", w.__browserWheel, { capture: true }); // hot reload
  w.__browserWheel = routeWheel;
  window.addEventListener("wheel", routeWheel, { capture: true, passive: false });
}

export function BrowserView({ tool, onNotice }: { tool: Tool; onNotice: (m: string) => void }) {
  const api = useApi();
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const outbox = useRef<object[]>([]);
  const onScreenRef = useRef(true);
  const sizeRef = useRef({ w: 0, h: 0 });
  const onScreen = useOnScreen(rootRef);

  const [view, setView] = useState<ViewState | null>(null);
  const [connected, setConnected] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [error, setError] = useState<{ message: string; fatal?: boolean } | null>(null);
  const [address, setAddress] = useState(tool.state.url === "about:blank" ? "" : tool.state.url);
  const [editingAddress, setEditingAddress] = useState(false);
  const [select, setSelect] = useState<SelectPopup | null>(null);
  const [marker, setMarker] = useState<Marker | null>(null);
  const [fileChooser, setFileChooser] = useState<{ multiple: boolean } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [tabsOpen, setTabsOpen] = useState(false);
  const composing = useRef(false);
  const [caret, setCaret] = useState({ x: 0, y: 0 });
  const [promptText, setPromptText] = useState("");

  const send = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else if (KEEP_WHILE_OFFLINE.has((msg as { t: string }).t) && outbox.current.length < 500) outbox.current.push(msg);
  }, []);

  // Off screen (scrolled away, a background board, a hidden tab): stay connected, but stop the frames.
  useEffect(() => {
    onScreenRef.current = onScreen;
    send({ t: onScreen ? "resume" : "pause" });
  }, [onScreen, send]);

  // ── connection: frames in, input out ──
  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: number | undefined;
    let decoding = false;
    let pending: { ws: WebSocket; blob: Blob } | null = null;
    let shown = false;
    // Each frame is acknowledged once drawn or dropped: the server sends more only then, so frames never pile up here.
    const ack = (ws: WebSocket) => ws.readyState === WebSocket.OPEN && ws.send('{"t":"ack"}');
    const draw = async (ws: WebSocket, blob: Blob) => {
      if (decoding) {
        if (pending) ack(pending.ws); // only the newest frame matters
        pending = { ws, blob };
        return;
      }
      decoding = true;
      try {
        const bmp = await createImageBitmap(blob);
        const c = canvasRef.current;
        if (c) {
          if (c.width !== bmp.width || c.height !== bmp.height) {
            c.width = bmp.width;
            c.height = bmp.height;
          }
          c.getContext("2d")?.drawImage(bmp, 0, 0);
          if (!shown) setHasFrame((shown = true));
        }
        bmp.close();
      } catch {
        /* a broken frame: skip it */
      } finally {
        ack(ws);
        decoding = false;
        if (pending) {
          const next = pending;
          pending = null;
          void draw(next.ws, next.blob);
        }
      }
    };
    const connect = () => {
      const ws = new WebSocket(wsUrl(`/ws/browser?board=${encodeURIComponent(api.boardId)}&tool=${encodeURIComponent(tool.id)}`));
      ws.binaryType = "blob";
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
        const { w, h } = sizeRef.current;
        if (w && h) ws.send(JSON.stringify({ t: "viewport", w, h }));
        if (!onScreenRef.current) ws.send(JSON.stringify({ t: "pause" }));
        for (const m of outbox.current.splice(0)) ws.send(JSON.stringify(m));
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return void draw(ws, e.data as Blob);
        const msg = JSON.parse(e.data);
        switch (msg.t) {
          case "state":
            setView(msg);
            if (msg.ready) setError((er) => (er?.fatal ? null : er));
            return;
          case "agent":
            setView((cur) => (cur ? { ...cur, agent: msg.on !== false } : cur));
            if (msg.on === false) return setMarker((m) => (m && Date.now() - m.at < 900 ? m : null));
            if (msg.label) setMarker({ label: msg.label, x: msg.x, y: msg.y, at: Date.now() });
            return;
          case "select":
            return setSelect(msg);
          case "cursor":
            if (canvasRef.current) canvasRef.current.style.cursor = msg.value;
            return;
          case "clipboard":
            if (msg.text) navigator.clipboard?.writeText(msg.text).catch(() => {});
            return;
          case "filechooser":
            return setFileChooser({ multiple: !!msg.multiple });
          case "download":
            return setToast(t(`Downloaded ${msg.name} → the board folder's downloads/`, `${msg.name} 다운로드 → 보드 폴더의 downloads/`));
          case "error":
            return setError({ message: msg.message, fatal: msg.fatal });
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (wsRef.current === ws) wsRef.current = null;
        if (!closed) timer = window.setTimeout(connect, Math.min(500 * 2 ** retry++, 8000));
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [api.boardId, tool.id, t]);

  // The page area's size (untransformed CSS px) is the page's viewport.
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (!w || !h || (w === sizeRef.current.w && h === sizeRef.current.h)) return;
      sizeRef.current = { w, h };
      send({ t: "viewport", w, h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [send]);

  useEffect(() => {
    if (!editingAddress && view) setAddress(view.url === "about:blank" ? "" : view.url);
  }, [view?.url, editingAddress]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!marker) return;
    const id = window.setTimeout(() => setMarker(null), 1800);
    return () => clearTimeout(id);
  }, [marker]);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => setPromptText(view?.dialog?.defaultPrompt ?? ""), [view?.dialog]);
  // A browser the person just added is empty: start in the address bar.
  useEffect(() => {
    if (tool.createdBy === "human" && tool.state.url === "about:blank" && Date.now() - Date.parse(tool.createdAt) < 5000) addressRef.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── pointer ──
  const toPage = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const { w, h } = sizeRef.current;
    return { x: Math.round(((e.clientX - r.left) / r.width) * w), y: Math.round(((e.clientY - r.top) / r.height) * h) };
  };
  const focusKeys = (p?: { x: number; y: number }) => {
    const k = keysRef.current;
    if (!k) return;
    if (composing.current) k.blur(); // commits the IME text before the click lands
    if (p) setCaret(p);
    k.focus({ preventScroll: true });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setTabsOpen(false);
    const p = toPage(e);
    focusKeys(p);
    send({ t: "mouse", type: "down", ...p, button: e.button, buttons: e.buttons, clickCount: e.detail || 1, mods: modsOf(e) });
    const move = (ev: MouseEvent) => send({ t: "mouse", type: "move", ...toPage(ev), buttons: ev.buttons, mods: modsOf(ev) });
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      send({ t: "mouse", type: "up", ...toPage(ev), button: ev.button, buttons: ev.buttons, clickCount: e.detail || 1, mods: modsOf(ev) });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const lastMove = useRef(0);
  const onMouseMove = (e: React.MouseEvent) => {
    if (e.buttons) return; // drags are sent by the window listener
    const now = performance.now();
    if (now - lastMove.current < 16) return;
    lastMove.current = now;
    send({ t: "mouse", type: "move", ...toPage(e), buttons: 0, mods: modsOf(e) });
  };

  // This page's share of the wheel (see routeWheel). The page moves as far as the fingers do on screen, at any board zoom.
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    wheelSinks.set(el, (e) => {
      const r = canvasRef.current?.getBoundingClientRect();
      const { w, h } = sizeRef.current;
      if (!r?.width || !r.height || !w || !h) return;
      const k = w / r.width; // page px per screen px
      const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? r.height : 1;
      let dx = e.deltaX * unit * k;
      let dy = e.deltaY * unit * k;
      let mods = modsOf(e);
      if (e.shiftKey && !dx) {
        [dx, dy] = [dy, 0]; // Shift+wheel scrolls sideways
        mods &= ~8;
      }
      // Under the pointer, kept inside the page (a gesture may slide off it).
      const x = Math.round(Math.min(w - 1, Math.max(0, ((e.clientX - r.left) / r.width) * w)));
      const y = Math.round(Math.min(h - 1, Math.max(0, ((e.clientY - r.top) / r.height) * h)));
      send({ t: "wheel", x, y, dx, dy, mods });
    });
    return () => void wheelSinks.delete(el);
  }, [send]);

  // ── keyboard: a hidden textarea takes the keys. IME composition (Korean, Japanese…) is mirrored into the page,
  // so the page composes in place as in a normal browser. The textarea is never changed while composing. ──
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation(); // keep the canvas from moving the frame or panning
    const ne = e.nativeEvent;
    if (ne.isComposing || composing.current || ne.keyCode === 229 || e.key === "Dead" || e.key === "Process") return; // the IME has it
    e.currentTarget.value = ""; // between compositions: safe to empty
    const cmd = IS_MAC ? e.metaKey : e.ctrlKey;
    const k = e.key.toLowerCase();
    if (cmd && (k === "v" || k === "c" || k === "x")) {
      if (k !== "v") {
        e.preventDefault();
        send({ t: "copy", cut: k === "x" });
      }
      return; // ⌘V: the paste event below sends the text
    }
    if (cmd && k === "l") {
      e.preventDefault();
      addressRef.current?.focus();
      addressRef.current?.select();
      return;
    }
    if (cmd && k === "r") {
      e.preventDefault();
      send({ t: "nav", action: "reload" });
      return;
    }
    if (cmd && (e.key === "[" || e.key === "]")) {
      e.preventDefault();
      send({ t: "nav", action: e.key === "[" ? "back" : "forward" });
      return;
    }
    e.preventDefault();
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    const text = printable ? e.key : e.key === "Enter" ? "\r" : undefined;
    send({ t: "key", type: "down", key: e.key, code: e.code, keyCode: e.keyCode, mods: modsOf(e), text, repeat: e.repeat });
  };
  const onKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    const ne = e.nativeEvent;
    if (ne.isComposing || composing.current || ne.keyCode === 229 || e.key === "Dead" || e.key === "Process") return;
    e.preventDefault();
    send({ t: "key", type: "up", key: e.key, code: e.code, keyCode: e.keyCode, mods: modsOf(e) });
  };

  // ── toolbar actions ──
  const go = () => {
    const url = address.trim();
    setEditingAddress(false);
    addressRef.current?.blur();
    if (url) send({ t: "nav", action: "go", url });
  };
  const setControl = async (control: "shared" | "person") => {
    try {
      await api.patchState(tool.id, [{ op: "replace", path: "/control", value: control }]);
    } catch (err) {
      onNotice((err as Error).message);
    }
  };
  const pickFiles = async (files: FileList | null) => {
    setFileChooser(null);
    if (!files?.length) return send({ t: "files", cancel: true });
    try {
      const paths: string[] = [];
      for (const f of [...files]) paths.push((await api.upload(tool.id, f)).path);
      send({ t: "files", paths });
    } catch (err) {
      onNotice((err as Error).message);
      send({ t: "files", cancel: true });
    }
  };

  const v = view;
  const person = (v?.control ?? tool.state.control) === "person";
  const vw = sizeRef.current.w || v?.viewport.w || 1;
  const vh = sizeRef.current.h || v?.viewport.h || 1;
  const pct = (x: number, total: number) => `${(x / total) * 100}%`;

  return (
    <div ref={rootRef} className={`browser${person ? " person" : ""}${v?.agent ? " agent" : ""}`}>
      <div className="browser-bar">
        <button className="ghost icon" disabled={!v?.canBack} onClick={() => send({ t: "nav", action: "back" })} title={t("Back", "뒤로")} aria-label={t("Back", "뒤로")}>
          ‹
        </button>
        <button className="ghost icon" disabled={!v?.canForward} onClick={() => send({ t: "nav", action: "forward" })} title={t("Forward", "앞으로")} aria-label={t("Forward", "앞으로")}>
          ›
        </button>
        <button
          className="ghost icon"
          onClick={() => send({ t: "nav", action: v?.loading ? "stop" : "reload" })}
          title={v?.loading ? t("Stop", "중지") : t("Reload", "새로고침")}
          aria-label={v?.loading ? t("Stop", "중지") : t("Reload", "새로고침")}
        >
          {v?.loading ? "×" : "↻"}
        </button>
        <input
          ref={addressRef}
          className="browser-address"
          value={address}
          spellCheck={false}
          placeholder={t("Search or type an address", "검색어 또는 주소 입력")}
          onFocus={(e) => {
            setEditingAddress(true);
            e.target.select();
          }}
          onBlur={() => setEditingAddress(false)}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.nativeEvent.isComposing) go();
            else if (e.key === "Escape") {
              setAddress(v?.url ?? "");
              keysRef.current?.focus();
            }
          }}
          aria-label={t("Address", "주소")}
        />
        {(v?.tabs.length ?? 0) > 1 && (
          <div className="browser-tabs">
            <button className="ghost" onClick={() => setTabsOpen((o) => !o)} aria-expanded={tabsOpen} title={t("Tabs", "탭")}>
              {t(`${v!.tabs.length} tabs`, `탭 ${v!.tabs.length}개`)} ▾
            </button>
            {tabsOpen && (
              <div className="browser-menu" role="menu">
                {v!.tabs.map((tb, i) => (
                  <div key={i} className={`browser-menu-row${i === v!.active ? " on" : ""}`}>
                    <button className="ghost" role="menuitem" onClick={() => (send({ t: "tab", action: "select", index: i }), setTabsOpen(false))} title={tb.url}>
                      {tb.title || tb.url}
                    </button>
                    <button className="ghost icon" onClick={() => send({ t: "tab", action: "close", index: i })} aria-label={t("Close tab", "탭 닫기")}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {person ? (
          <button className="primary" onClick={() => setControl("shared")} title={t("Let Claude use the browser again", "Claude가 다시 브라우저를 쓰게 합니다")}>
            {t("Hand back to Claude", "Claude에게 돌려주기")}
          </button>
        ) : (
          <button className="ghost" onClick={() => setControl("person")} title={t("Use the browser yourself; Claude waits until you hand it back", "직접 조작합니다. 돌려줄 때까지 Claude는 기다립니다")}>
            {t("Take over", "직접 조작")}
          </button>
        )}
      </div>
      {v?.loading && <div className="browser-progress" />}
      <div ref={pageRef} className="browser-page nodrag nopan">
        <canvas ref={canvasRef} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onContextMenu={(e) => (e.preventDefault(), e.stopPropagation())} />
        <textarea
          ref={keysRef}
          className="browser-keys"
          style={{ left: pct(caret.x, vw), top: pct(caret.y, vh) }}
          aria-label={t("Type into the page", "페이지에 입력")}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onCompositionStart={() => (composing.current = true)}
          onCompositionUpdate={(e) => send({ t: "ime", text: e.data })}
          onCompositionEnd={(e) => {
            composing.current = false;
            // Commit what was composed (an empty commit just clears the page's composition).
            send(e.data ? { t: "text", text: e.data } : { t: "ime", text: "" });
          }}
          onInput={(e) => {
            const ne = e.nativeEvent as InputEvent;
            // Text that arrives without a key we forwarded (emoji picker, dictation, a key right after an IME commit).
            if (!ne.isComposing && !composing.current && ne.inputType === "insertText" && ne.data) send({ t: "text", text: ne.data });
          }}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain");
            if (text) send({ t: "text", text });
          }}
        />
        {!hasFrame && (
          <div className="browser-empty">
            {error?.fatal ? null : connected ? t("Opening the page…", "페이지를 여는 중…") : t("Starting the browser…", "브라우저를 시작하는 중…")}
          </div>
        )}
        {marker && (
          <div className="browser-marker" style={marker.x !== undefined && marker.y !== undefined ? { left: pct(marker.x, vw), top: pct(marker.y, vh) } : { left: "50%", top: "50%", opacity: 0 }}>
            <span className="dot" />
            <span className="label">Claude · {marker.label}</span>
          </div>
        )}
        {v?.agent && <div className="browser-banner agent">{t("Claude is using this browser", "Claude가 이 브라우저를 사용 중")}</div>}
        {person && <div className="browser-banner person">{t("You have the browser. Claude waits until you hand it back.", "직접 조작 중입니다. 돌려줄 때까지 Claude는 기다립니다.")}</div>}
        {error && (
          <div className="browser-error" role="alert">
            <span>{error.message}</span>
            {error.fatal ? (
              <button className="ghost" onClick={() => (setError(null), send({ t: "reopen" }))}>
                {t("Try again", "다시 시도")}
              </button>
            ) : (
              <button className="ghost icon" onClick={() => setError(null)} aria-label={t("Dismiss", "닫기")}>
                ×
              </button>
            )}
          </div>
        )}
        {select && (
          <div className="browser-overlay" onMouseDown={(e) => (e.stopPropagation(), setSelect(null))}>
            <div
              className="browser-select nowheel"
              role="listbox"
              style={{ left: pct(select.rect.x, vw), top: pct(select.rect.y + select.rect.h, vh), minWidth: pct(select.rect.w, vw) }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {select.options.map((o, i) => (
                <button
                  key={i}
                  role="option"
                  aria-selected={i === select.selected}
                  disabled={o.disabled}
                  className={i === select.selected ? "on" : ""}
                  onClick={() => {
                    send({ t: "choose", ref: select.ref, index: i });
                    setSelect(null);
                    keysRef.current?.focus({ preventScroll: true });
                  }}
                >
                  {o.group ? <span className="muted">{o.group} · </span> : null}
                  {o.label || " "}
                </button>
              ))}
            </div>
          </div>
        )}
        {v?.dialog && (
          <div className="browser-overlay dim">
            <div className="browser-dialog" role="alertdialog" aria-label={t("Message from the page", "페이지 메시지")}>
              <p className="muted small">{t("The page says", "페이지 메시지")}</p>
              <p className="msg">{v.dialog.message}</p>
              {v.dialog.type === "prompt" && <input value={promptText} onChange={(e) => setPromptText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} autoFocus />}
              <div className="form-foot">
                {v.dialog.type !== "alert" && (
                  <button className="ghost" onClick={() => send({ t: "dialog", accept: false })}>
                    {t("Cancel", "취소")}
                  </button>
                )}
                <button className="primary" onClick={() => send({ t: "dialog", accept: true, text: promptText })}>
                  OK
                </button>
              </div>
            </div>
          </div>
        )}
        {fileChooser && (
          <div className="browser-overlay dim">
            <div className="browser-dialog">
              <p className="msg">{t("The page asks for a file.", "페이지가 파일을 요청합니다.")}</p>
              <input ref={fileRef} type="file" multiple={fileChooser.multiple} hidden onChange={(e) => pickFiles(e.target.files)} />
              <div className="form-foot">
                <button className="ghost" onClick={() => (setFileChooser(null), send({ t: "files", cancel: true }))}>
                  {t("Cancel", "취소")}
                </button>
                <button className="primary" onClick={() => fileRef.current?.click()}>
                  {t("Choose file…", "파일 선택…")}
                </button>
              </div>
            </div>
          </div>
        )}
        {toast && <div className="browser-toast">{toast}</div>}
      </div>
    </div>
  );
}
