// One work board: a Figma-like canvas of tool frames, an inspector on the right, the agent's asks floating on top.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { frameAnchor, inSection, SECTION_COLORS, type Link, type LinkDirection, type Section, type SectionColor, type SectionLayout, type Tool } from "../shared/catalog.ts";
import { desktop, useApi, ApiError, loginProblem, type AgentStatus } from "./api.ts";
import { ShellsideMark } from "./ShellsideMark.tsx";
import { AskCard } from "./Asks.tsx";
import { BoardCanvas, useCanvasActions, type CanvasTool, type LayoutChange } from "./Canvas.tsx";
import { ContextMenu, type MenuItem } from "./ContextMenu.tsx";
import { CodeOpenDialog, SaveToLibraryDialog, SendToClaudeDialog } from "./Dialogs.tsx";
import { Inspector } from "./Inspector.tsx";
import { LibraryPanel } from "./Library.tsx";
import { LiveProvider } from "./live.ts";
import { useBoard, useNow } from "./useBoard.ts";
import { useT } from "./i18n.tsx";
import { isMod, kbd } from "./keys.ts";
import { ShortcutsDialog } from "./Shortcuts.tsx";
import { builtins, type BuiltinKind } from "./builtins.ts";
import { codeCommand } from "./codeFocus.ts";

const isEditable = (el: Element | null) =>
  !!el &&
  (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable || !!el.closest(".monaco-editor"));
/** Keys belong to something else: a text field, the terminal, a browser page, an open menu or dialog. */
const keysTaken = () => {
  const el = document.activeElement;
  return isEditable(el) || !!el?.closest(".term-window, .browser-page") || !!document.querySelector('[role="menu"], .modal');
};

/** Frames copied with ⌘/Ctrl+C, for pasting on any board in this window. The clipboard gets their @names as text. */
let copied: { tools: Tool[]; text: string } | null = null;

interface BoardPanelProps {
  boardId: string;
  boardName: string;
  /** On screen. Background boards keep running (apps, sync) but take no keys and move no camera. */
  active: boolean;
  agentStatus: AgentStatus | null;
  /** The terminal button (lives in this header's top-right corner). */
  terminalButton: React.ReactNode;
  onNotice: (m: string) => void;
  onSentToClaude: (mode: "claude" | "started") => void;
  onOpenTerminal: () => void;
  onRefreshStatus: () => void;
}

export function BoardPanel(props: BoardPanelProps) {
  return (
    <ReactFlowProvider>
      <BoardView {...props} />
    </ReactFlowProvider>
  );
}

function usePersistent<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : (JSON.parse(s) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  }, [key, v]);
  return [v, setV] as const;
}

type Menu = { x: number; y: number; ids: string[]; at: { x: number; y: number } };

function BoardView({ boardId, boardName, active, agentStatus, terminalButton, onNotice, onSentToClaude, onOpenTerminal, onRefreshStatus }: BoardPanelProps) {
  const api = useApi();
  const t = useT();
  const { tools, toolsById, asks, events, library, channels, links, sections, sectionsById, live, connected, ready } = useBoard(boardId);
  const now = useNow();
  const cam = useCanvasActions();
  const rf = useReactFlow();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [follow, setFollow] = usePersistent("wb.follow", true);
  const [libraryOpen, setLibraryOpen] = usePersistent("wb.libraryOpen", false);
  const [inspectorOpen, setInspectorOpen] = usePersistent("wb.inspectorOpen", true);
  const [minimap, setMinimap] = usePersistent("wb.minimap", false);
  const [tool, setTool] = usePersistent<CanvasTool>("wb.tool", "select");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [zoomMenu, setZoomMenu] = useState<{ x: number; y: number } | null>(null);
  const [insertMenu, setInsertMenu] = useState<{ x: number; y: number } | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const onPointer = useCallback((p: { x: number; y: number } | null) => (pointer.current = p), []);
  /** Where new frames go: under the pointer when it is on the canvas, else the middle of the view. */
  const dropPoint = useCallback(() => (pointer.current ? rf.screenToFlowPosition(pointer.current) : cam.center()), [rf, cam]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [linkMenu, setLinkMenu] = useState<{ x: number; y: number; linkId: string } | null>(null);
  const [selectedLinkIds, setSelectedLinkIds] = useState<string[]>([]);
  const onSelectLinks = useCallback((ids: string[]) => setSelectedLinkIds((prev) => (prev.length === ids.length && prev.every((id, i) => id === ids[i]) ? prev : ids)), []);
  const [sendIds, setSendIds] = useState<string[] | null>(null);
  const [sendSectionIds, setSendSectionIds] = useState<string[]>([]);
  const [selectedSectionIds, setSelectedSectionIds] = useState<string[]>([]);
  const [sectionMenu, setSectionMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  /** Files on their way onto the board (a big one streams for a while). */
  const [uploads, setUploads] = useState<{ key: string; name: string; size: number; loaded: number; state: "sending" | "done" | "failed"; error?: string }[]>([]);
  /** Shift (or ⌘/Ctrl) held: a click adds to the selection instead of replacing it. */
  const adding = useRef(false);
  const [saveTool, setSaveTool] = useState<Tool | null>(null);
  /** Where a code editor being opened goes (its top-left), while the open dialog shows. */
  const [codeAt, setCodeAt] = useState<{ x: number; y: number } | null>(null);
  const [appErrors, setAppErrors] = useState<Record<string, number>>({});
  const [activeUntil, setActiveUntil] = useState<Record<string, number>>({});
  const [tick, setTick] = useState(0);
  const lastInteract = useRef(0);
  const lastSeq = useRef<number | null>(null);

  const onInteract = useCallback(() => {
    lastInteract.current = Date.now();
  }, []);
  const onAppErrors = useCallback((id: string, n: number) => setAppErrors((e) => (e[id] === n ? e : { ...e, [id]: n })), []);
  const onSelect = useCallback((ids: string[]) => {
    setSelectedIds((prev) => (prev.length === ids.length && prev.every((id, i) => id === ids[i]) ? prev : ids));
    // Picking frames (not adding to a selection) leaves the sections.
    if (ids.length && !adding.current) setSelectedSectionIds((prev) => (prev.length ? [] : prev));
  }, []);
  const onSelectSections = useCallback((ids: string[], additive: boolean) => {
    if (additive) setSelectedSectionIds((prev) => (ids.every((id) => prev.includes(id)) ? prev.filter((id) => !ids.includes(id)) : [...new Set([...prev, ...ids])]));
    else {
      setSelectedSectionIds(ids);
      if (ids.length) setSelectedIds([]);
    }
  }, []);
  /** The tools in a section (by where their top part is, as the server counts them). */
  const toolsInSection = (sec: Section) => tools.filter((tl) => tl.layout && inSection(frameAnchor(tl.layout), sec.layout));
  const selectedSections = selectedSectionIds.map((id) => sectionsById[id]).filter(Boolean) as Section[];

  // Drop selections whose frames are gone.
  useEffect(() => {
    if (selectedIds.some((id) => !toolsById[id])) setSelectedIds((ids) => ids.filter((id) => toolsById[id]));
  }, [toolsById, selectedIds]);

  // Agent presence and "follow the agent", like following a collaborator in Figma.
  useEffect(() => {
    if (!ready) return;
    if (lastSeq.current === null) {
      lastSeq.current = events.at(-1)?.seq ?? 0; // history is not news
      return;
    }
    const fresh = events.filter((e) => e.seq > lastSeq.current!);
    if (!fresh.length) return;
    lastSeq.current = fresh.at(-1)!.seq;
    const touched = fresh.filter((e) => e.actor === "agent" && e.toolId && e.type !== "tool_deleted").map((e) => e.toolId!);
    if (!touched.length) return;
    const until = Date.now() + 3500;
    setActiveUntil((a) => ({ ...a, ...Object.fromEntries(touched.map((id) => [id, until])) }));
    const busy = Date.now() - lastInteract.current < 4000 || (isEditable(document.activeElement) && !!document.activeElement?.closest(".board-pane"));
    if (active && follow && !busy) window.setTimeout(() => cam.focusTool(touched.at(-1)!, { onlyIfHidden: true }), 80);
  }, [events, ready, follow, cam, active]);

  useEffect(() => {
    if (!Object.values(activeUntil).some((u) => u > Date.now())) return;
    const id = window.setTimeout(() => setTick((n) => n + 1), 500);
    return () => clearTimeout(id);
  }, [activeUntil, tick]);
  const activeKey = Object.entries(activeUntil)
    .filter(([, u]) => u > Date.now())
    .map(([id]) => id)
    .sort()
    .join(",");
  const activeIds = useMemo(() => new Set(activeKey.split(",").filter(Boolean)), [activeKey]);
  const waitingKey = asks
    .map((a) => a.toolId)
    .filter(Boolean)
    .sort()
    .join(",");
  const waitingIds = useMemo(() => new Set(waitingKey.split(",").filter(Boolean)), [waitingKey]);

  // A new ask pulls the camera to its frame (when following).
  const askCount = useRef(0);
  useEffect(() => {
    if (asks.length > askCount.current && follow && active) {
      const tid = asks.at(-1)?.toolId;
      if (tid) window.setTimeout(() => cam.focusTool(tid, { onlyIfHidden: true }), 80);
    }
    askCount.current = asks.length;
  }, [asks, follow, cam, active]);

  const pick = useCallback(
    (id: string) => {
      setSelectedIds([id]);
      cam.focusTool(id);
    },
    [cam],
  );
  const fitTo = useCallback((ids: string[]) => rf.fitView({ nodes: ids.map((id) => ({ id })), duration: 300, padding: 0.2, maxZoom: 1 }), [rf]);

  // ── Undo / redo (⌘/Ctrl+Z, ⇧⌘Z / Ctrl+Y), as in Figma: what the person does on the canvas (move, resize, add,
  // duplicate, paste, delete, rename). Not the agent's edits. A frame brought back gets a new id; `alias` maps the old
  // one to it, so older steps still find it.
  type Step = { label: string; undo: () => Promise<void>; redo: () => Promise<void> };
  const history = useRef<{ done: Step[]; undone: Step[]; alias: Map<string, string> }>({ done: [], undone: [], alias: new Map() });
  const toolsRef = useRef(toolsById);
  toolsRef.current = toolsById;
  const linksRef = useRef(links);
  linksRef.current = links;
  const sectionsRef = useRef(sectionsById);
  sectionsRef.current = sectionsById;
  const resolve = (id: string) => {
    const seen = new Set<string>();
    while (history.current.alias.has(id) && !seen.has(id)) seen.add(id), (id = history.current.alias.get(id)!);
    return id;
  };
  const record = (step: Step) => {
    const h = history.current;
    h.done.push(step);
    if (h.done.length > 100) h.done.shift();
    h.undone = [];
  };
  /** Copies of what is about to go, for bringing it back: the tools and the links that touch them. */
  const snapshot = (ids: string[]) => {
    const set = new Set(ids);
    return {
      tools: ids.map((id) => toolsRef.current[id]).filter(Boolean).map((tl) => structuredClone(tl)) as Tool[],
      links: linksRef.current.filter((l) => set.has(l.from) || set.has(l.to)).map((l) => ({ ...l })),
    };
  };
  /** Make deleted tools again, where they were, with their name, content and links. */
  const recreate = async (snap: { tools: Tool[]; links: Link[] }) => {
    for (const s of snap.tools) {
      const input = {
        kind: s.kind,
        title: s.title,
        description: s.description,
        props: s.props,
        state: s.state,
        ...(s.layout ? { width: s.layout.w, at: { x: s.layout.x + s.layout.w / 2, y: s.layout.y + 80 } } : {}),
      };
      // The same id when it is free (it is, once deleted): the agent's references stay good.
      const made = await api.createTool({ ...input, id: s.id, name: s.name } as Partial<Tool>).catch(() => api.createTool(input));
      history.current.alias.set(s.id, made.id);
      if (s.layout) await api.setLayout(made.id, { x: s.layout.x, y: s.layout.y, w: s.layout.w, ...(s.layout.h ? { h: s.layout.h } : {}) }).catch(() => {});
      if (s.agentAccess === "read") await api.updateTool(made.id, { agentAccess: "read" }).catch(() => {});
    }
    for (const l of snap.links) await api.createLink(resolve(l.from), resolve(l.to), l.direction).catch(() => {});
    return snap.tools.map((s) => resolve(s.id));
  };
  const removeNow = async (ids: string[]) => {
    for (const id of ids) await api.deleteTool(resolve(id)).catch(() => {});
  };
  /** The person made these tools (add, duplicate, paste, library): undo removes them. */
  const recordCreate = (ids: string[], label: string) => {
    let snap: { tools: Tool[]; links: Link[] } | null = null;
    record({
      label,
      undo: async () => {
        snap = snapshot(ids.map(resolve));
        await removeNow(ids);
      },
      redo: async () => {
        if (snap) await recreate(snap);
      },
    });
  };
  const runHistory = async (which: "undo" | "redo") => {
    const h = history.current;
    const step = (which === "undo" ? h.done : h.undone).pop();
    if (!step) return onNotice(which === "undo" ? t("Nothing to undo", "되돌릴 작업이 없습니다") : t("Nothing to redo", "다시 할 작업이 없습니다"));
    try {
      await step[which]();
      (which === "undo" ? h.undone : h.done).push(step);
      onNotice(which === "undo" ? t(`Undo: ${step.label}`, `되돌림: ${step.label}`) : t(`Redo: ${step.label}`, `다시 함: ${step.label}`));
    } catch (err) {
      onNotice((err as Error).message);
    }
  };
  const onCommit = useCallback((changes: LayoutChange[]) => {
    const set = (key: "before" | "after") => async () => {
      for (const c of changes) await api.setLayout(resolve(c.id), c[key]).catch(() => {});
    };
    record({ label: changes.some((c) => "w" in c.after) ? t("Resize", "크기 조절") : t("Move", "이동"), undo: set("before"), redo: set("after") });
  }, [api, t]); // eslint-disable-line react-hooks/exhaustive-deps
  const onRename = useCallback((id: string, title: string) => {
    const before = toolsRef.current[id]?.title ?? "";
    const apply = (to: string) => () => api.updateTool(resolve(id), { title: to }).then(() => {});
    void apply(title)().catch((err) => onNotice(err.message));
    record({ label: t("Rename", "이름 바꾸기"), undo: apply(before), redo: apply(title) });
  }, [api, t, onNotice]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── sections ──
  /** Bring a removed section back, with its id, name, colour and place. */
  const reviveSection = (sec: Section) =>
    api.createSection({ id: sec.id, title: sec.title, name: sec.name, color: sec.color, layout: sec.layout }).catch(() =>
      api.createSection({ title: sec.title, color: sec.color, layout: sec.layout }),
    );
  const recordSectionMade = (sec: Section, label: string) => {
    let kept = sec;
    record({
      label,
      undo: async () => {
        kept = sectionsRef.current[sec.id] ?? kept;
        await api.deleteSection(sec.id);
      },
      redo: async () => void (await reviveSection(kept)),
    });
  };
  const drawSection = async (layout: SectionLayout) => {
    setTool("select");
    try {
      const sec = await api.createSection({ layout });
      setSelectedSectionIds([sec.id]);
      setSelectedIds([]);
      recordSectionMade(sec, t("Add section", "섹션 추가"));
    } catch (err) {
      onNotice((err as Error).message);
    }
  };
  /** Shift+S or ⌘/Ctrl+Alt+S with frames selected: a section around them. */
  const wrapInSection = async (ids: string[]) => {
    try {
      const sec = await api.createSection({ around: ids });
      setSelectedSectionIds([sec.id]);
      setSelectedIds([]);
      recordSectionMade(sec, t("Add section", "섹션 추가"));
    } catch (err) {
      onNotice((err as Error).message);
    }
  };
  const onSectionMoved = useCallback((id: string, before: SectionLayout, after: SectionLayout, moveContents: boolean) => {
    const put = (l: SectionLayout) => () => api.setSectionLayout(id, l, moveContents).then(() => {});
    put(after)().catch((err) => onNotice(err.message));
    record({ label: moveContents ? t("Move section", "섹션 이동") : t("Resize section", "섹션 크기 조절"), undo: put(before), redo: put(after) });
  }, [api, t, onNotice]); // eslint-disable-line react-hooks/exhaustive-deps
  const updateSection = (id: string, patch: { title?: string; color?: SectionColor }, label: string) => {
    const cur = sectionsRef.current[id];
    if (!cur) return;
    const back = { ...(patch.title !== undefined ? { title: cur.title } : {}), ...(patch.color !== undefined ? { color: cur.color } : {}) };
    api.updateSection(id, patch).catch((err) => onNotice(err.message));
    record({ label, undo: () => api.updateSection(id, back).then(() => {}), redo: () => api.updateSection(id, patch).then(() => {}) });
  };
  const onSectionRename = useCallback((id: string, title: string) => updateSection(id, { title }, t("Rename section", "섹션 이름 바꾸기")), [api, t]); // eslint-disable-line react-hooks/exhaustive-deps
  /** ⇧⌘G / Ctrl+Shift+G: remove the sections, keep what is in them. */
  const ungroupSections = async (ids: string[]) => {
    const gone = ids.map((id) => sectionsRef.current[id]).filter(Boolean) as Section[];
    for (const sec of gone) await api.deleteSection(sec.id).catch((err) => onNotice(err.message));
    setSelectedSectionIds([]);
    if (gone.length)
      record({
        label: t("Remove section", "섹션 없애기"),
        undo: async () => {
          for (const sec of gone) await reviveSection(sec);
        },
        redo: async () => {
          for (const sec of gone) await api.deleteSection(sec.id).catch(() => {});
        },
      });
  };
  /** Delete: the sections and what is in them, as in Figma; undo brings all of it back. */
  const deleteSections = async (ids: string[]) => {
    const gone = ids.map((id) => sectionsRef.current[id]).filter(Boolean) as Section[];
    if (!gone.length) return;
    const inner = Object.values(sectionsRef.current).filter((x) => !ids.includes(x.id) && gone.some((g) => x.layout.x >= g.layout.x && x.layout.y >= g.layout.y && x.layout.x + x.layout.w <= g.layout.x + g.layout.w && x.layout.y + x.layout.h <= g.layout.y + g.layout.h));
    const toolIds = [...new Set(gone.flatMap((sec) => toolsInSection(sec).map((tl) => tl.id)))];
    const snap = snapshot(toolIds);
    for (const sec of gone) await api.deleteSection(sec.id, true).catch((err) => onNotice(err.message));
    setSelectedSectionIds([]);
    record({
      label: t("Delete section", "섹션 삭제"),
      undo: async () => {
        for (const sec of [...gone, ...inner].sort((a, b) => b.layout.w * b.layout.h - a.layout.w * a.layout.h)) await reviveSection(sec);
        await recreate(snap);
      },
      redo: async () => {
        for (const sec of gone) await api.deleteSection(sec.id, true).catch(() => {});
      },
    });
    onNotice(t(`Deleted ${gone.length === 1 ? `"${gone[0].title}"` : `${gone.length} sections`} and ${toolIds.length} frame(s) in it · ${kbd("mod+z")} to undo`, `${gone.length === 1 ? `"${gone[0].title}"` : `섹션 ${gone.length}개`}와 안의 프레임 ${toolIds.length}개 삭제함 · ${kbd("mod+z")}로 되돌리기`));
  };
  /** ⌘/Ctrl+D on a section: a copy beside it, with copies of what is in it. */
  const duplicateSection = async (id: string) => {
    const sec = sectionsRef.current[id];
    if (!sec) return;
    // The first free place to its right: the copy and the frames in it must not land in another section.
    const taken = [
      ...Object.values(sectionsRef.current).map((x) => x.layout),
      ...tools.filter((tl) => tl.layout).map((tl) => ({ ...tl.layout!, h: rf.getNode(tl.id)?.measured?.height ?? tl.layout!.h ?? 200 })),
    ];
    const overlaps = (x: number) => taken.filter((r) => x < r.x + r.w + 40 && r.x - 40 < x + sec.layout.w && sec.layout.y < r.y + r.h + 40 && r.y - 40 < sec.layout.y + sec.layout.h);
    let x = sec.layout.x + sec.layout.w + 80;
    for (let i = 0, hit = overlaps(x); hit.length && i < 50; i++, hit = overlaps(x)) x = Math.max(...hit.map((r) => r.x + r.w)) + 80;
    const dx = x - sec.layout.x;
    try {
      const copy = await api.createSection({ title: `${sec.title}${t(" copy", " 사본")}`, color: sec.color, layout: { ...sec.layout, x } });
      recordSectionMade(copy, t("Duplicate section", "섹션 복제"));
      const inside = toolsInSection(sec).filter((tl) => tl.layout);
      if (inside.length) {
        const minX = Math.min(...inside.map((tl) => tl.layout!.x));
        const minY = Math.min(...inside.map((tl) => tl.layout!.y));
        await copyTools(inside, { x: minX + dx, y: minY });
      }
      setSelectedSectionIds([copy.id]);
      setSelectedIds([]);
    } catch (err) {
      onNotice((err as Error).message);
    }
  };
  /** Files dropped on the board: one file tool each, in a grid from the drop point, one at a time. */
  const dropFiles = async (files: File[], at: { x: number; y: number }) => {
    const batch = files.map((f, i) => ({ file: f, key: `${Date.now()}-${i}-${f.name}`, at: { x: at.x + (i % 4) * 380, y: at.y + Math.floor(i / 4) * 280 } }));
    setUploads((u) => [...u, ...batch.map((b) => ({ key: b.key, name: b.file.name, size: b.file.size, loaded: 0, state: "sending" as const }))]);
    const set = (key: string, patch: Partial<(typeof uploads)[number]>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...patch } : x)));
    const made: string[] = [];
    for (const b of batch) {
      try {
        const tool = await api.dropFile(b.file, b.at, (loaded) => set(b.key, { loaded }));
        made.push(tool.id);
        set(b.key, { state: "done", loaded: b.file.size });
      } catch (err) {
        set(b.key, { state: "failed", error: (err as Error).message });
        onNotice(`${b.file.name}: ${(err as Error).message}`);
      }
    }
    if (made.length) {
      setSelectedIds(made);
      setSelectedSectionIds([]);
      recordCreate(made, t("Add files", "파일 추가"));
    }
    window.setTimeout(() => setUploads((u) => u.filter((x) => !batch.some((b) => b.key === x.key) || x.state === "sending")), 2500);
  };

  /** Folders dropped on the board open in code editors. Only the desktop app knows where a dropped folder is. */
  const dropFolders = async (folders: File[], at: { x: number; y: number }) => {
    const paths = folders.map((f) => desktop?.pathForFile(f) ?? "").filter(Boolean);
    if (!paths.length)
      return onNotice(
        t(
          "A folder opens in a code editor from the desktop app. Here, use + → Code editor and type its path.",
          "폴더는 데스크톱 앱에서 코드 편집기로 열립니다. 여기서는 + → 코드 편집기에서 경로를 입력하세요.",
        ),
      );
    const made: string[] = [];
    for (const [i, path] of paths.entries()) {
      try {
        made.push((await api.openCode(path, { x: at.x + i * 940, y: at.y })).id);
      } catch (err) {
        onNotice((err as Error).message);
      }
    }
    if (made.length) {
      setSelectedIds(made);
      setSelectedSectionIds([]);
      recordCreate(made, t("Open folder", "폴더 열기"));
    }
  };

  const sendSections = (ids: string[]) => {
    setSendSectionIds(ids);
    setSendIds([]);
  };
  const fitSections = (ids: string[]) => {
    const ls = ids.map((id) => sectionsRef.current[id]?.layout).filter(Boolean) as SectionLayout[];
    if (!ls.length) return;
    const x = Math.min(...ls.map((l) => l.x));
    const y = Math.min(...ls.map((l) => l.y));
    rf.fitBounds({ x, y, width: Math.max(...ls.map((l) => l.x + l.w)) - x, height: Math.max(...ls.map((l) => l.y + l.h)) - y }, { padding: 0.12, duration: 300 });
  };

  /** Delete at once, as Figma does; ⌘/Ctrl+Z brings the frames back (with their links). */
  const removeTools = useCallback(
    async (ids: string[]) => {
      const snap = snapshot(ids);
      if (!snap.tools.length) return;
      await removeNow(ids);
      record({ label: t("Delete", "삭제"), undo: async () => void (await recreate(snap)), redo: () => removeNow(snap.tools.map((tl) => tl.id)) });
      onNotice(
        snap.tools.length === 1
          ? t(`Deleted "${snap.tools[0].title}" · ${kbd("mod+z")} to undo`, `"${snap.tools[0].title}" 삭제함 · ${kbd("mod+z")}로 되돌리기`)
          : t(`Deleted ${snap.tools.length} frames · ${kbd("mod+z")} to undo`, `프레임 ${snap.tools.length}개 삭제함 · ${kbd("mod+z")}로 되돌리기`),
      );
    },
    [onNotice, api, t], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /** New copies of these tools. at: where the group's top-left goes (default: 48 down and right of the originals). */
  const copyTools = async (sources: Tool[], at?: { x: number; y: number }) => {
    const placed = sources.filter((s) => s.layout);
    if (!placed.length) return;
    const minX = Math.min(...placed.map((s) => s.layout!.x));
    const minY = Math.min(...placed.map((s) => s.layout!.y));
    const dx = at ? at.x - minX : 48;
    const dy = at ? at.y - minY : 48;
    const made: string[] = [];
    for (const src of placed) {
      const { sourcePath: _keep, ...props } = src.props ?? {};
      try {
        const copy = await api.createTool({
          kind: src.kind,
          title: `${src.title}${t(" copy", " 사본")}`,
          description: src.description,
          props: src.kind === "app" ? { ...props, sourcePath: src.props.sourcePath } : src.props,
          state: src.state,
          width: src.layout!.w,
          at: { x: src.layout!.x + dx + src.layout!.w / 2, y: src.layout!.y + dy + 80 },
        });
        made.push(copy.id);
      } catch (err) {
        onNotice((err as Error).message);
      }
    }
    if (made.length) {
      setSelectedIds(made);
      recordCreate(made, at ? t("Paste", "붙여넣기") : t("Duplicate", "복제"));
    }
  };
  const duplicate = (ids: string[]) => copyTools(ids.map((id) => toolsById[id]).filter(Boolean) as Tool[]);

  type AddKind = "note" | "checklist" | "browser" | "table" | "form";
  const addTool = async (kind: AddKind, at = cam.center()) => {
    const input: Record<AddKind, Partial<Tool> & { at?: { x: number; y: number } }> = {
      note: { kind, title: t("Note", "메모"), state: { text: "" }, at },
      checklist: { kind, title: t("Checklist", "체크리스트"), state: { items: [] }, at },
      browser: { kind, title: t("Browser", "브라우저"), state: { url: "about:blank" } }, // big: goes to a free spot, the camera follows
      table: {
        kind,
        title: t("Table", "표"),
        props: {
          columns: [
            { key: "item", label: t("Item", "항목"), type: "text" },
            { key: "status", label: t("Status", "상태"), type: "select", options: [t("To do", "할 일"), t("Doing", "진행 중"), t("Done", "완료")] },
            { key: "note", label: t("Note", "메모"), type: "text" },
          ],
        },
        state: { rows: [] },
        at,
      },
      form: {
        kind,
        title: t("Form", "폼"),
        props: {
          fields: [
            { name: "title", label: t("Title", "제목"), type: "text" },
            { name: "details", label: t("Details", "내용"), type: "textarea" },
          ],
        },
        at,
      },
    };
    try {
      const created = await api.createTool(input[kind]);
      setSelectedIds([created.id]);
      recordCreate([created.id], t("Add", "추가"));
      if (kind === "browser") window.setTimeout(() => cam.focusTool(created.id), 80);
    } catch (err) {
      onNotice((err as Error).message);
    }
  };
  // ── built-in components (library and the + menu) ──
  const filePicker = useRef<HTMLInputElement>(null);
  const pickAt = useRef<{ x: number; y: number } | null>(null);
  const addBuiltin = (kind: BuiltinKind, at = cam.center()) => {
    if (kind === "file") {
      pickAt.current = at;
      return filePicker.current?.click();
    }
    if (kind === "section") return drawSection({ x: Math.round(at.x - 320), y: Math.round(at.y - 120), w: 640, h: 420 });
    if (kind === "code") return setCodeAt({ x: Math.round(at.x - 450), y: Math.round(at.y - 80) });
    return addTool(kind, at);
  };
  const codeOpened = (tool: Tool) => {
    setSelectedIds([tool.id]);
    recordCreate([tool.id], t("Add", "추가"));
    window.setTimeout(() => cam.focusTool(tool.id, { onlyIfHidden: true }), 80);
  };
  const addTemplate = async (id: string, at = cam.center()) => {
    if (id.startsWith("builtin:")) return addBuiltin(id.slice(8) as BuiltinKind, at);
    try {
      const created = await api.useTemplate(id, at);
      setSelectedIds([created.id]);
      recordCreate([created.id], t("Add from library", "라이브러리에서 추가"));
    } catch (err) {
      onNotice((err as Error).message);
    }
  };

  // Figma's shortcuts (see Shortcuts.tsx for the list). Only on the board on screen, and never while a text field, the
  // terminal, a browser page, a menu or a dialog has the keys. Letters match the physical key (e.code), so they work
  // with a Korean input method on too.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      adding.current = e.shiftKey || e.metaKey || e.ctrlKey;
      const el = document.activeElement;
      // Esc while editing inside a frame: stop editing and select that frame (as leaving a text in Figma).
      if (e.key === "Escape" && isEditable(el) && el?.closest(".react-flow__node") && !el.closest(".monaco-editor") && !document.querySelector('[role="menu"], .modal')) {
        const id = el.closest(".react-flow__node")?.getAttribute("data-id");
        (el as HTMLElement).blur();
        if (id) setSelectedIds([id]);
        return;
      }
      if (keysTaken() || e.isComposing) return;
      const mod = isMod(e);
      const plain = !mod && !e.altKey && !e.ctrlKey && !e.metaKey;
      const code = e.code;
      const take = () => e.preventDefault();
      if (code === "Space" && plain) {
        take(); // no page scroll or button press; React Flow pans while it is held
        if (!e.repeat) setSpaceHeld(true);
      } else if (plain && !e.shiftKey && code === "KeyV") setTool("select");
      else if (plain && !e.shiftKey && code === "KeyH") setTool("hand");
      else if (plain && !e.shiftKey && code === "KeyL") setTool("link");
      else if (plain && !e.shiftKey && code === "KeyN") (take(), addTool("note", dropPoint()));
      else if (plain && !e.shiftKey && code === "KeyC") (take(), addTool("checklist", dropPoint()));
      else if (plain && !e.shiftKey && code === "KeyB") (take(), addTool("browser"));
      else if (plain && !e.shiftKey && code === "KeyE") (take(), addBuiltin("code", dropPoint()));
      else if (plain && e.shiftKey && code === "Digit0") (take(), cam.zoomTo(1));
      else if (plain && e.shiftKey && code === "Digit1") (take(), cam.fitAll());
      else if (plain && e.shiftKey && code === "Digit2") (take(), selectedIds.length ? fitTo(selectedIds) : selectedSectionIds.length ? fitSections(selectedSectionIds) : cam.fitAll());
      else if (plain && e.shiftKey && code === "KeyS") (take(), selectedIds.length ? wrapInSection(selectedIds) : setTool("section"));
      else if (mod && e.altKey && code === "KeyS" && selectedIds.length) (take(), wrapInSection(selectedIds));
      else if (mod && e.shiftKey && code === "KeyG" && selectedSectionIds.length) (take(), ungroupSections(selectedSectionIds));
      else if (mod && (code === "Equal" || code === "NumpadAdd")) (take(), cam.zoomIn());
      else if (mod && (code === "Minus" || code === "NumpadSubtract")) (take(), cam.zoomOut());
      else if (mod && code === "Digit0") (take(), cam.zoomTo(1));
      else if (mod && !e.shiftKey && code === "KeyZ") (take(), runHistory("undo"));
      else if ((mod && e.shiftKey && code === "KeyZ") || (e.ctrlKey && !e.metaKey && code === "KeyY")) (take(), runHistory("redo"));
      else if (mod && !e.shiftKey && code === "KeyA") (take(), setSelectedIds(tools.map((tl) => tl.id)));
      else if (mod && !e.shiftKey && code === "KeyD" && (selectedIds.length || selectedSectionIds.length)) {
        take();
        if (selectedIds.length) duplicate(selectedIds);
        for (const id of selectedSectionIds) duplicateSection(id);
      }
      else if (mod && code === "Backslash") (take(), setInspectorOpen(!inspectorOpen));
      else if (mod && code === "Enter" && (selectedIds.length || selectedSectionIds.length)) (take(), setSendSectionIds(selectedSectionIds), setSendIds(selectedIds));
      else if ((plain && e.shiftKey && code === "Slash") || (mod && code === "Slash")) (take(), setShortcutsOpen(true));
      else if (plain && !e.shiftKey && code === "Slash") (take(), document.getElementById("cmd-input")?.focus());
      else if (plain && code === "Enter" && selectedIds.length === 1) {
        // Enter: start using the selected frame (its first field), as Enter goes into a selection in Figma.
        const field = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(selectedIds[0])}"] .frame-body :is(textarea, input, select, [contenteditable="true"])`);
        if (field) (take(), field.focus());
      } else if (e.key === "Escape") {
        if (tool !== "select") setTool("select");
        setSelectedIds([]);
        setSelectedSectionIds([]);
      } else if ((e.key === "Delete" || e.key === "Backspace") && (selectedIds.length || selectedLinkIds.length || selectedSectionIds.length)) {
        take();
        for (const id of selectedLinkIds) api.deleteLink(id).catch((err) => onNotice(err.message));
        if (selectedSectionIds.length) deleteSections(selectedSectionIds);
        else if (selectedIds.length) removeTools(selectedIds);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
      adding.current = e.shiftKey || e.metaKey || e.ctrlKey;
    };
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  });

  // The desktop app's Edit → Select All asks the board first (its menu may take ⌘/Ctrl+A before the page sees it).
  useEffect(() => {
    if (!active) return;
    const w = window as unknown as { __wbSelectAll?: () => boolean; __wbUndo?: () => boolean; __wbRedo?: () => boolean };
    w.__wbSelectAll = () => {
      if (codeCommand("editor.action.selectAll")) return true;
      if (keysTaken()) return false;
      setSelectedIds(tools.map((tl) => tl.id));
      return true;
    };
    w.__wbUndo = () => codeCommand("undo") || (keysTaken() ? false : (void runHistory("undo"), true));
    w.__wbRedo = () => codeCommand("redo") || (keysTaken() ? false : (void runHistory("redo"), true));
    return () => {
      delete w.__wbSelectAll;
      delete w.__wbUndo;
      delete w.__wbRedo;
    };
  });

  // ⌘/Ctrl+C, X and V copy, cut and paste frames. Through the clipboard events, so the desktop app's Edit menu works too.
  useEffect(() => {
    if (!active) return;
    const onCopy = (e: ClipboardEvent) => {
      if (keysTaken() || !selectedIds.length) return;
      const picked = selectedIds.map((id) => toolsById[id]).filter(Boolean) as Tool[];
      const text = picked.map((tl) => (tl.name ? `@${tl.name}` : tl.title)).join(" ");
      copied = { tools: picked, text };
      e.clipboardData?.setData("text/plain", text);
      e.preventDefault();
      if (e.type === "cut") removeTools(selectedIds);
      else onNotice(picked.length === 1 ? t("Copied 1 frame", "프레임 1개 복사함") : t(`Copied ${picked.length} frames`, `프레임 ${picked.length}개 복사함`));
    };
    const onPaste = (e: ClipboardEvent) => {
      if (keysTaken() || !copied) return;
      // Only our own last copy: text copied elsewhere since then is not frames.
      if ((e.clipboardData?.getData("text/plain") ?? "") !== copied.text) return;
      e.preventDefault();
      copyTools(copied.tools, dropPoint());
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  });

  // Right click on a link: which way it points, or remove it.
  const linkMenuItems = (l: Link): MenuItem[] => {
    const a = `@${toolsById[l.from]?.name ?? "?"}`;
    const b = `@${toolsById[l.to]?.name ?? "?"}`;
    const set = (input: { direction: LinkDirection; from?: string; to?: string }) => api.updateLink(l.id, input).catch((err) => onNotice(err.message));
    const mark = (on: boolean, label: string) => `${on ? "✓ " : "\u2003"}${label}`;
    return [
      { label: mark(l.direction === "none", t(`No direction  ${a} — ${b}`, `방향 없음  ${a} — ${b}`)), onSelect: () => set({ direction: "none" }) },
      { label: mark(l.direction === "forward", `${a} → ${b}`), onSelect: () => set({ direction: "forward" }) },
      { label: mark(false, `${b} → ${a}`), onSelect: () => set({ direction: "forward", from: l.to, to: l.from }) },
      { label: mark(l.direction === "both", t(`Both ways  ${a} ↔ ${b}`, `양방향  ${a} ↔ ${b}`)), onSelect: () => set({ direction: "both" }) },
      { separator: true },
      { label: t("Delete link", "연결 삭제"), hint: kbd("delete"), danger: true, onSelect: () => api.deleteLink(l.id).catch((err) => onNotice(err.message)) },
    ];
  };

  const COLOR_NAMES: Record<SectionColor, [string, string]> = {
    gray: ["Gray", "회색"],
    red: ["Red", "빨강"],
    orange: ["Orange", "주황"],
    yellow: ["Yellow", "노랑"],
    green: ["Green", "초록"],
    blue: ["Blue", "파랑"],
    violet: ["Violet", "보라"],
    pink: ["Pink", "분홍"],
  };
  const sectionMenuItems = (sec: Section): MenuItem[] => {
    const inside = toolsInSection(sec);
    return [
      { label: t("Send section to Claude…", "섹션을 Claude에게 보내기…"), hint: kbd("mod+enter"), strong: true, onSelect: () => sendSections([sec.id]) },
      { separator: true },
      { label: t("Zoom to section", "섹션에 맞추기"), hint: kbd("shift+2"), onSelect: () => fitSections([sec.id]) },
      { label: t(`Select the ${inside.length} frame(s) in it`, `안의 프레임 ${inside.length}개 선택`), disabled: !inside.length, onSelect: () => (setSelectedSectionIds([]), setSelectedIds(inside.map((tl) => tl.id))) },
      { label: t("Rename (double-click the name)", "이름 바꾸기 (이름 더블클릭)"), onSelect: () => (setSelectedSectionIds([sec.id]), setInspectorOpen(true), window.setTimeout(() => (document.getElementById("insp-section-title") as HTMLInputElement | null)?.select(), 50)) },
      { separator: true },
      ...SECTION_COLORS.map((c) => ({ label: `${sec.color === c ? "✓ " : "\u2003"}${t(COLOR_NAMES[c][0], COLOR_NAMES[c][1])}`, onSelect: () => updateSection(sec.id, { color: c }, t("Section color", "섹션 색")) })),
      { separator: true },
      { label: t("Duplicate", "복제"), hint: kbd("mod+d"), onSelect: () => duplicateSection(sec.id) },
      { label: t("Remove section (keep what is in it)", "섹션만 없애기 (안의 것은 남김)"), hint: kbd("mod+shift+g"), onSelect: () => ungroupSections([sec.id]) },
      { label: t("Delete section and what is in it", "섹션과 안의 것 삭제"), hint: kbd("delete"), danger: true, onSelect: () => deleteSections([sec.id]) },
    ];
  };

  const menuItems = (m: Menu): MenuItem[] => {
    const targets = m.ids.map((id) => toolsById[id]).filter(Boolean) as Tool[];
    if (!targets.length) {
      return [
        { label: t("+ Note here", "+ 메모 여기에"), hint: "N", onSelect: () => addTool("note", m.at) },
        { label: t("+ Checklist here", "+ 체크리스트 여기에"), hint: "C", onSelect: () => addTool("checklist", m.at) },
        { label: t("+ Browser here", "+ 브라우저 여기에"), hint: "B", onSelect: () => addTool("browser", m.at) },
        { label: t("+ Code editor here…", "+ 코드 편집기 여기에…"), hint: "E", onSelect: () => addBuiltin("code", m.at) },
        { label: t("+ Section here", "+ 섹션 여기에"), hint: kbd("shift+s"), onSelect: () => drawSection({ x: Math.round(m.at.x), y: Math.round(m.at.y), w: 640, h: 420 }) },
        ...(copied ? [{ label: t("Paste here", "여기에 붙여넣기"), hint: kbd("mod+v"), onSelect: () => copyTools(copied!.tools, m.at) }] : []),
        { label: libraryOpen ? t("Close library", "라이브러리 닫기") : t("Open library", "라이브러리 열기"), onSelect: () => setLibraryOpen(!libraryOpen) },
        { separator: true },
        { label: t("Send to Claude…", "Claude에게 보내기…"), onSelect: () => setSendIds([]) },
        { label: t("Select all", "모두 선택"), hint: kbd("mod+a"), onSelect: () => setSelectedIds(tools.map((tl) => tl.id)) },
        { label: t("Zoom to fit all", "전체 보기"), hint: kbd("shift+1"), onSelect: cam.fitAll },
        { label: t("Keyboard shortcuts", "단축키"), hint: "?", onSelect: () => setShortcutsOpen(true) },
      ];
    }
    const one = targets.length === 1 ? targets[0] : null;
    const ids = targets.map((tl) => tl.id);
    const allRead = targets.every((tl) => tl.agentAccess === "read");
    return [
      {
        label: targets.length > 1 ? t(`Send ${targets.length} to Claude…`, `Claude에게 보내기 (${targets.length}개)…`) : t("Send to Claude…", "Claude에게 보내기…"),
        hint: kbd("mod+enter"),
        strong: true,
        onSelect: () => setSendIds(ids),
      },
      { separator: true },
      { label: t("Zoom to selection", "선택 영역에 맞추기"), hint: kbd("shift+2"), onSelect: () => fitTo(ids) },
      ...(one
        ? ([
            {
              label: t("Rename", "이름 바꾸기"),
              onSelect: () => {
                setSelectedIds([one.id]);
                setInspectorOpen(true); // renaming happens in the inspector
                window.setTimeout(() => (document.getElementById("insp-title") as HTMLInputElement | null)?.select(), 50);
              },
            },
            // A saved component is remade without its file, so files stay out of the library.
            ...(one.kind === "file" || one.kind === "code" ? [] : [{ label: t("Save to library…", "라이브러리에 저장…"), onSelect: () => setSaveTool(one) }]),
            ...(one.name
              ? [{ label: t("Copy name", "이름 복사"), hint: `@${one.name}`, onSelect: () => navigator.clipboard?.writeText(`@${one.name}`).then(() => onNotice(t(`Copied @${one.name}`, `@${one.name} 복사됨`))) }]
              : []),
            { label: t("Copy ID", "ID 복사"), hint: one.id, onSelect: () => navigator.clipboard?.writeText(one.id).then(() => onNotice(t(`Copied ${one.id}`, `${one.id} 복사됨`))) },
          ] as MenuItem[])
        : []),
      {
        label: t("Copy", "복사"),
        hint: kbd("mod+c"),
        onSelect: () => {
          copied = { tools: targets, text: targets.map((tl) => (tl.name ? `@${tl.name}` : tl.title)).join(" ") };
          navigator.clipboard?.writeText(copied.text).catch(() => {});
        },
      },
      { label: targets.length > 1 ? t(`Duplicate ${targets.length}`, `복제 (${targets.length}개)`) : t("Duplicate", "복제"), hint: kbd("mod+d"), onSelect: () => duplicate(ids) },
      { label: t("Put in a new section", "새 섹션으로 묶기"), hint: kbd("shift+s"), onSelect: () => wrapInSection(ids) },
      {
        label: allRead ? t("Let the agent edit", "agent가 수정할 수 있게") : t("Agent can only read", "agent는 읽기만"),
        onSelect: () => ids.forEach((id) => api.updateTool(id, { agentAccess: allRead ? "write" : "read" }).catch((err) => onNotice(err.message))),
      },
      { separator: true },
      { label: targets.length > 1 ? t(`Delete ${targets.length}`, `${targets.length}개 삭제`) : t("Delete", "삭제"), hint: kbd("delete"), danger: true, onSelect: () => removeTools(ids) },
    ];
  };

  const selected = selectedIds.map((id) => toolsById[id]).filter(Boolean) as Tool[];
  return (
    <LiveProvider value={live}>
    <section className="pane board-pane" aria-label={t(`Board ${boardName}`, `보드 ${boardName}`)}>
      <header className="pane-head board-head">
        <h2 className="board-name">{boardName}</h2>
        <span className={`status ${connected ? "status-open" : "status-closed"}`}>{connected ? t("Live", "실시간") : t("Reconnecting", "재연결 중")}</span>
        <button className={libraryOpen ? "toggle on lib" : "toggle lib"} aria-pressed={libraryOpen} onClick={() => setLibraryOpen(!libraryOpen)} title={t("Components: built in and saved", "컴포넌트: 기본 제공과 저장한 것")}>
          {t("Library", "라이브러리")} <span className="count">{library.length}</span>
        </button>
        <div className="spacer" />
        <button className={`toggle${follow ? " on" : ""}`} aria-pressed={follow} onClick={() => setFollow(!follow)} title={t("Move the view to whatever the agent is working on", "agent가 작업하는 도구로 화면을 옮깁니다")}>
          <span className="dot" /> {t("Follow", "따라가기")}
        </button>
        <button
          className="ghost zoom-pct"
          aria-haspopup="menu"
          aria-label={t("Zoom", "확대/축소")}
          data-tip={t("Zoom and view", "확대/축소 · 보기")}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setZoomMenu({ x: r.left, y: r.bottom + 4 });
          }}
        >
          {Math.round(cam.zoom * 100)}% <span className="caret">▾</span>
        </button>
        <button
          className="danger"
          title={t("Send the agent a stop event. It stops the next time it checks the board.", "agent에게 중단 이벤트를 보냅니다. agent가 보드를 확인할 때 멈춥니다.")}
          onClick={() => api.stop().then(() => onNotice(t("Stop request sent.", "중단 요청을 보냈습니다.")), (e) => onNotice(e.message))}
        >
          {t("Stop", "중단")}
        </button>
        {terminalButton}
      </header>

      <div className="board-main">
        <div className={`canvas-wrap tool-${tool}${minimap ? " minimap-on" : ""}${tool === "hand" ? " hand-mode" : ""}${tool === "link" ? " link-mode" : ""}${spaceHeld ? " space-pan" : ""}`}>
          <BoardCanvas
            active={active}
            onPointer={onPointer}
            onCommit={onCommit}
            onRename={onRename}
            sections={sections}
            selectedSectionIds={selectedSectionIds}
            onSelectSections={onSelectSections}
            onSectionMenu={(pos, id) => setSectionMenu({ ...pos, id })}
            onDrawSection={drawSection}
            onDropFiles={dropFiles}
            onDropFolders={dropFolders}
            onSectionMoved={onSectionMoved}
            onSectionRename={onSectionRename}
            showMinimap={minimap}
            tool={tool}
            links={links}
            onSelectLinks={onSelectLinks}
            onLinkMenu={(pos, linkId) => setLinkMenu({ ...pos, linkId })}
            boardId={boardId}
            tools={tools}
            selectedIds={selectedIds}
            onSelect={onSelect}
            onContextMenu={(pos, ids, at) => setMenu({ ...pos, ids, at })}
            onDropTemplate={(id, at) => addTemplate(id, at)}
            activeIds={activeIds}
            waitingIds={waitingIds}
            appErrors={appErrors}
            onAppErrors={onAppErrors}
            onInteract={onInteract}
            onNotice={onNotice}
          >
            {uploads.length > 0 && (
              <Panel position="bottom-left" className="uploads" aria-live="polite">
                {uploads.map((u) => (
                  <div key={u.key} className={`upload ${u.state}`} title={u.error}>
                    <span className="upload-name">{u.name}</span>
                    <span className="upload-size">
                      {u.state === "failed" ? t("failed", "실패") : u.state === "done" ? "✓" : u.size ? `${Math.floor((u.loaded / u.size) * 100)}%` : "…"}
                    </span>
                    <span className="upload-bar" style={{ ["--p" as string]: u.size ? u.loaded / u.size : 0 }} />
                  </div>
                ))}
              </Panel>
            )}
            {libraryOpen && (
              <Panel position="top-left">
                <LibraryPanel items={library} onAdd={(id) => addTemplate(id)} onClose={() => setLibraryOpen(false)} onNotice={onNotice} />
              </Panel>
            )}
            {asks.length > 0 && (
              <Panel position="top-right" className="asks-panel nowheel" aria-live="polite">
                {asks.map((a) => (
                  <AskCard key={a.id} ask={a} tool={a.toolId ? toolsById[a.toolId] : undefined} now={now} onNotice={onNotice} onLocate={a.toolId ? () => pick(a.toolId!) : undefined} />
                ))}
              </Panel>
            )}
            <Panel position="top-center" className="top-stack">
              <LoginBanner status={agentStatus} onOpenTerminal={onOpenTerminal} onRefresh={onRefreshStatus} onNotice={onNotice} />
              {ready && tools.length === 0 && (
                <div className="canvas-empty">
                  <p>
                    <b>{t("This board is empty.", "빈 보드입니다.")}</b>{" "}
                    {t(
                      "Open the terminal (top right) and ask Claude to build a tool, or type a request in the box below.",
                      "오른쪽 위 터미널 버튼을 눌러 Claude에게 도구를 만들어 달라고 하거나, 아래 입력창에 바로 적어 보세요.",
                    )}
                  </p>
                  <code>
                    {t(
                      "Make a v2.3 release checklist on the board. Get my approval before the prod deploy.",
                      "v2.3 릴리스 체크리스트 보드에 만들어줘. prod 배포 전엔 내 승인 받아.",
                    )}
                  </code>
                </div>
              )}
            </Panel>
            <Panel position="bottom-center" className="cmd-panel">
              <CommandBar
                tool={tool}
                onTool={setTool}
                tools={tools}
                selected={selected}
                selectedSections={selectedSections}
                onInsert={(r) => setInsertMenu({ x: r.left, y: r.top - 8 })}
                onShortcuts={() => setShortcutsOpen(true)}
                onSend={async (prompt) => {
                  try {
                    const r = await api.sendToAgent(prompt, selectedIds, selectedSectionIds);
                    onNotice(r.mode === "claude" ? t("Sent to Claude.", "Claude에게 보냈습니다.") : t("Started Claude in the terminal with your request.", "터미널에서 Claude를 시작해 요청을 보냈습니다."));
                    onSentToClaude(r.mode);
                  } catch (err) {
                    if (err instanceof ApiError && err.data?.reason) onOpenTerminal();
                    throw err;
                  }
                }}
                onNotice={onNotice}
              />
            </Panel>
          </BoardCanvas>
        </div>
        {inspectorOpen ? (
        <Inspector
          onCollapse={() => setInspectorOpen(false)}
          selected={selected}
          selectedSections={selectedSections}
          sections={sections}
          sectionTools={toolsInSection}
          onSectionRename={onSectionRename}
          onSectionColor={(id, color) => updateSection(id, { color }, t("Section color", "섹션 색"))}
          onSectionSend={sendSections}
          onSectionFit={fitSections}
          onSectionUngroup={ungroupSections}
          onSectionDelete={deleteSections}
          onPickSection={(id) => (setSelectedSectionIds([id]), setSelectedIds([]), fitSections([id]))}
          tools={tools}
          channels={channels}
          events={events}
          now={now}
          errors={selected.length === 1 ? (appErrors[selected[0].id] ?? 0) : 0}
          onPick={pick}
          onNotice={onNotice}
          onSendToClaude={setSendIds}
          onSave={setSaveTool}
          onFit={fitTo}
          onDelete={removeTools}
        />
        ) : (
          <button
            className="inspector-rail"
            onClick={() => setInspectorOpen(true)}
            title={t("Open properties panel", "속성 패널 열기")}
            aria-label={t("Open properties panel", "속성 패널 열기")}
          >
            <span className="rail-arrow">«</span>
            {selected.length > 0 && <span className="rail-count">{selected.length}</span>}
            <span className="rail-label">{selected.length ? t("Properties", "속성") : t("Layers · History", "레이어 · 이력")}</span>
          </button>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={menu.ids.length > 1 ? t(`${menu.ids.length} selected`, `${menu.ids.length}개 선택`) : menu.ids.length === 1 ? toolsById[menu.ids[0]]?.title : undefined}
          items={menuItems(menu)}
          onClose={() => setMenu(null)}
        />
      )}
      {linkMenu && links.some((l) => l.id === linkMenu.linkId) && (
        <ContextMenu
          x={linkMenu.x}
          y={linkMenu.y}
          title={t("Link", "연결")}
          items={linkMenuItems(links.find((l) => l.id === linkMenu.linkId)!)}
          onClose={() => setLinkMenu(null)}
        />
      )}
      {sectionMenu && sectionsById[sectionMenu.id] && (
        <ContextMenu
          x={sectionMenu.x}
          y={sectionMenu.y}
          title={sectionsById[sectionMenu.id].title}
          items={sectionMenuItems(sectionsById[sectionMenu.id])}
          onClose={() => setSectionMenu(null)}
        />
      )}
      {sendIds && (
        <SendToClaudeDialog
          tools={sendIds.map((id) => toolsById[id]).filter(Boolean) as Tool[]}
          sections={sendSectionIds.map((id) => sectionsById[id]).filter(Boolean) as Section[]}
          status={agentStatus}
          onClose={() => (setSendIds(null), setSendSectionIds([]))}
          onNotice={onNotice}
          onSent={onSentToClaude}
          onOpenTerminal={onOpenTerminal}
        />
      )}
      {saveTool && <SaveToLibraryDialog tool={saveTool} onClose={() => setSaveTool(null)} onNotice={onNotice} />}
      {codeAt && <CodeOpenDialog boardId={boardId} at={codeAt} onClose={() => setCodeAt(null)} onOpened={codeOpened} onNotice={onNotice} />}
      {zoomMenu && (
        <ContextMenu
          x={zoomMenu.x}
          y={zoomMenu.y}
          items={[
            { label: t("Zoom in", "확대"), hint: kbd("mod+plus"), onSelect: cam.zoomIn },
            { label: t("Zoom out", "축소"), hint: kbd("mod+minus"), onSelect: cam.zoomOut },
            { label: t("Zoom to fit", "전체 보기"), hint: kbd("shift+1"), onSelect: cam.fitAll },
            { label: t("Zoom to selection", "선택 영역에 맞추기"), hint: kbd("shift+2"), disabled: !selectedIds.length, onSelect: () => fitTo(selectedIds) },
            { separator: true },
            { label: "50%", onSelect: () => cam.zoomTo(0.5) },
            { label: "100%", hint: kbd("shift+0"), onSelect: () => cam.zoomTo(1) },
            { label: "200%", onSelect: () => cam.zoomTo(2) },
            { separator: true },
            { label: `${minimap ? "✓ " : "\u2003"}${t("Minimap", "미니맵")}`, onSelect: () => setMinimap(!minimap) },
            { label: `${inspectorOpen ? "✓ " : "\u2003"}${t("Properties panel", "속성 패널")}`, hint: kbd("mod+\\"), onSelect: () => setInspectorOpen(!inspectorOpen) },
            { label: t("Keyboard shortcuts", "단축키"), hint: "?", onSelect: () => setShortcutsOpen(true) },
          ]}
          onClose={() => setZoomMenu(null)}
        />
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {insertMenu && (
        <ContextMenu
          x={insertMenu.x}
          y={insertMenu.y}
          above
          title={t("Add", "추가")}
          items={builtins(t).map((b) => ({ label: b.name, hint: b.key, onSelect: () => addBuiltin(b.kind) }))}
          onClose={() => setInsertMenu(null)}
        />
      )}
      <input
        ref={filePicker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = "";
          if (files.length) dropFiles(files, pickAt.current ?? cam.center());
        }}
      />
    </section>
    </LiveProvider>
  );
}

/** Shown on the board while Claude cannot be used: not installed, not signed in, or the terminal's Claude asks to sign in. */
function LoginBanner({ status, onOpenTerminal, onRefresh, onNotice }: { status: AgentStatus | null; onOpenTerminal: () => void; onRefresh: () => void; onNotice: (m: string) => void }) {
  const api = useApi();
  const t = useT();
  const problem = loginProblem(status);
  const key = problem ? `${problem.kind}:${problem.detail ?? ""}` : "";
  const [dismissed, setDismissed] = useState("");
  const [busy, setBusy] = useState(false);
  if (!problem || dismissed === key) return null;

  const signIn = async () => {
    setBusy(true);
    try {
      const r = await api.startLogin();
      onOpenTerminal();
      onNotice(
        r.mode === "started"
          ? t("Sign-in started in the terminal. Open the link it shows in your browser to sign in.", "터미널에서 로그인을 시작했습니다. 나오는 링크를 브라우저에서 열어 로그인하세요.")
          : t("Sign in on Claude's screen in the terminal. If you don't see it, type /login.", "터미널의 Claude 화면에서 로그인하세요. 로그인 화면이 안 보이면 /login 을 입력하세요."),
      );
    } catch (err) {
      onNotice((err as Error).message);
      onOpenTerminal();
    } finally {
      setBusy(false);
    }
  };

  const text =
    problem.kind === "install"
      ? {
          title: t("Claude Code is not installed", "Claude Code가 설치되어 있지 않습니다"),
          body: t("Install Claude Code on this machine to use Claude on the board.", "이 PC에 Claude Code를 설치해야 보드에서 Claude를 쓸 수 있습니다."),
        }
      : problem.kind === "account"
        ? {
            title: t("Sign in to Claude", "Claude 로그인이 필요합니다"),
            body: t(
              "No Claude account is signed in on this machine. Once you sign in, Claude can build and edit tools on every board. All boards share the sign-in.",
              "이 PC에 Claude 계정이 로그인되어 있지 않습니다. 로그인하면 보드마다 Claude가 도구를 만들고 고칠 수 있습니다. 로그인은 모든 보드가 함께 씁니다.",
            ),
          }
        : {
            title: t("Sign in to Claude", "Claude 로그인이 필요합니다"),
            body: t(
              `Claude in this board's terminal asked you to sign in${problem.detail ? ` (${problem.detail})` : ""}. The saved sign-in may have expired.`,
              `이 보드의 터미널에서 Claude가 로그인을 요구했습니다${problem.detail ? ` (${problem.detail})` : ""}. 저장된 로그인이 만료되었을 수 있습니다.`,
            ),
          };

  return (
    <div className="login-banner" role="alert">
      <ShellsideMark size={22} />
      <div className="login-text">
        <b>{text.title}</b>
        <span>{text.body}</span>
      </div>
      <div className="login-actions">
        {problem.kind !== "install" && (
          <button className="primary" disabled={busy} onClick={signIn}>
            {t("Sign in from terminal", "터미널에서 로그인")}
          </button>
        )}
        <button className="ghost" onClick={onRefresh} title={t("Check the sign-in status again", "로그인 상태를 다시 확인합니다")}>
          {t("Check again", "다시 확인")}
        </button>
        <button className="ghost icon" onClick={() => setDismissed(key)} aria-label={t("Dismiss", "안내 닫기")} title={t("Dismiss", "닫기")}>
          ×
        </button>
      </div>
    </div>
  );
}

function CommandBar({
  tool,
  onTool,
  tools,
  selected,
  onInsert,
  onShortcuts,
  onSend,
  onNotice,
  selectedSections,
}: {
  tool: CanvasTool;
  onTool: (t: CanvasTool) => void;
  tools: Tool[];
  selected: Tool[];
  selectedSections: Section[];
  /** The + button: the menu of built-in components (opens above it). */
  onInsert: (anchor: DOMRect) => void;
  onShortcuts: () => void;
  onSend: (prompt: string) => Promise<void>;
  onNotice: (m: string) => void;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const clean = text.trim();
  const inputRef = useRef<HTMLInputElement>(null);
  // "@na…" before the caret: offer the tools whose name fits, and put the chosen name in.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [pick, setPick] = useState(0);
  const matches = mention
    ? tools
        .filter((tl) => tl.name && (tl.name.toLowerCase().startsWith(mention.query) || tl.title.toLowerCase().includes(mention.query)))
        .sort((a, b) => Number(!a.name!.toLowerCase().startsWith(mention.query)) - Number(!b.name!.toLowerCase().startsWith(mention.query)))
        .slice(0, 6)
    : [];
  const findMention = (value: string, caret: number) => {
    const m = /(^|\s)@([\p{L}\p{N}_.-]*)$/u.exec(value.slice(0, caret));
    setMention(m ? { start: caret - m[2].length - 1, query: m[2].toLowerCase() } : null);
    setPick(0);
  };
  const insert = (tl: Tool) => {
    if (!mention) return;
    const el = inputRef.current;
    const caret = el?.selectionStart ?? text.length;
    const word = `@${tl.name} `;
    const next = text.slice(0, mention.start) + word + text.slice(caret).replace(/^\S*\s?/, "");
    setText(next);
    setMention(null);
    window.requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(mention.start + word.length, mention.start + word.length);
    });
  };
  const send = async () => {
    if (!clean || busy) return;
    setBusy(true);
    try {
      await onSend(clean);
      setText("");
    } catch (err) {
      onNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="commandbar">
      <div className="tools" role="group" aria-label={t("Tools", "도구")}>
        <button
          className={tool === "select" ? "tool on" : "tool"}
          aria-pressed={tool === "select"}
          onClick={() => onTool("select")}
          aria-label={t("Move", "이동")}
          data-tip={`${t("Move", "이동")}   V`}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path d="M3 2l9 5.2-4 .9-1.7 3.9z" fill="currentColor" />
          </svg>
        </button>
        <button
          className={tool === "hand" ? "tool on" : "tool"}
          aria-pressed={tool === "hand"}
          onClick={() => onTool("hand")}
          aria-label={t("Hand tool", "손 도구")}
          data-tip={`${t("Hand tool", "손 도구")}   H · ${t("or hold Space", "또는 Space")}`}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path
              d="M5.5 8V3.6a1 1 0 0 1 2 0V7m0-3.9V2.6a1 1 0 0 1 2 0V7m0-3.4a1 1 0 0 1 2 0V8m0-2.6a1 1 0 0 1 2 0v4.3A4.3 4.3 0 0 1 9.2 14H8.4a4 4 0 0 1-3.2-1.6L2.9 9.3a1 1 0 0 1 1.5-1.3L5.5 9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          className={tool === "link" ? "tool on" : "tool"}
          aria-pressed={tool === "link"}
          onClick={() => onTool("link")}
          aria-label={t("Link", "연결")}
          data-tip={`${t("Link frames", "프레임 연결")}   L`}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <circle cx="3.5" cy="12.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M5 11l6.5-6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M8.5 3.5h4v4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          className={tool === "section" ? "tool on" : "tool"}
          aria-pressed={tool === "section"}
          onClick={() => onTool("section")}
          aria-label={t("Section", "섹션")}
          data-tip={`${t("Section", "섹션")}   ${kbd("shift+s")}`}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <rect x="2" y="3.5" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <rect x="3.6" y="1.6" width="5" height="3.2" rx="1" fill="currentColor" />
          </svg>
        </button>
        <button
          className="tool insert"
          aria-haspopup="menu"
          aria-label={t("Add a component", "컴포넌트 추가")}
          data-tip={t("Add: note, checklist, table, form, browser, code editor, file, section", "추가: 메모, 체크리스트, 표, 폼, 브라우저, 코드 편집기, 파일, 섹션")}
          onClick={(e) => onInsert(e.currentTarget.getBoundingClientRect())}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <span className="sep" />
      {selected.length + selectedSections.length > 0 && (
        <span className="ctx-chip" title={[...selectedSections.map((x) => x.title), ...selected.map((tl) => tl.title)].join(", ")}>
          {selectedSections.length
            ? t(`${selectedSections.length} section(s) attached`, `섹션 ${selectedSections.length}개 포함`)
            : t(`${selected.length} selected attached`, `선택 ${selected.length}개 포함`)}
        </span>
      )}
      <div className="cmd-input">
        {mention && matches.length > 0 && (
          <div className="mention-menu" role="listbox" aria-label={t("Tools by name", "이름으로 찾은 컴포넌트")}>
            {matches.map((tl, i) => (
              <button
                key={tl.id}
                role="option"
                aria-selected={i === pick}
                className={i === pick ? "on" : undefined}
                onMouseDown={(e) => (e.preventDefault(), insert(tl))}
                onMouseEnter={() => setPick(i)}
              >
                <span className="frame-name">@{tl.name}</span>
                <span className="mention-title">{tl.title}</span>
                <span className="muted">{tl.kind}</span>
              </button>
            ))}
          </div>
        )}
        <input
          id="cmd-input"
          ref={inputRef}
          value={text}
          placeholder={
            selected.length
              ? t("What should Claude do with the selection?", "선택한 컴포넌트로 Claude에게 시킬 일")
              : t("Ask Claude (@name points at a tool)", "Claude에게 말하기 (@이름으로 컴포넌트 지정)")
          }
          onChange={(e) => {
            setText(e.target.value);
            findMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => findMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
          onBlur={() => setMention(null)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (mention && matches.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setPick((p) => (p + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                insert(matches[Math.min(pick, matches.length - 1)]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMention(null);
                return;
              }
            }
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            } else if (e.key === "Escape") {
              e.currentTarget.blur(); // back to the canvas's shortcuts
            }
          }}
        />
      </div>
      <button className="primary" disabled={!clean || busy} onClick={send}>
        {t("Send ↵", "보내기 ↵")}
      </button>
      <button className="ghost icon help-btn" onClick={onShortcuts} aria-label={t("Keyboard shortcuts", "단축키")} data-tip={`${t("Keyboard shortcuts", "단축키")}   ?`}>
        ?
      </button>
    </div>
  );
}
