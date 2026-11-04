// Figma-like board canvas on React Flow (@xyflow/react, MIT): each tool is a frame node on an infinite canvas.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionLineType,
  ConnectionMode,
  Handle,
  MiniMap,
  NodeResizeControl,
  NodeResizer,
  Position,
  ReactFlow,
  ResizeControlVariant,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  useInternalNode,
  useReactFlow,
  useStore,
  type ControlPosition,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type InternalNode,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnSelectionChangeParams,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { BROWSER_WIDTH, fixedHeight, frameAnchor, heightRange, inSection, SECTION_MIN, sectionInside, type Layout, type Link, type LinkDirection, type Section, type SectionLayout, type Tool } from "../shared/catalog.ts";
import { useApi } from "./api.ts";
import { ToolBody } from "./tools.tsx";
import { kindLabel, useT } from "./i18n.tsx";
import { TEMPLATE_MIME } from "./Library.tsx";

interface FrameData extends Record<string, unknown> {
  tool: Tool;
  active: boolean;
  waiting: boolean;
  errors: number;
  onAppErrors: (toolId: string, n: number) => void;
  onLayout: (toolId: string, l: Partial<Layout>) => void;
  onNotice: (m: string) => void;
  /** The link tool is on: the whole frame is where a link starts or ends. */
  linking: boolean;
  /** The only selected frame: it shows its size, as Figma does. */
  solo: boolean;
  /** A move or resize the person finished: for undo. */
  onCommit: (changes: LayoutChange[]) => void;
  onRename: (toolId: string, title: string) => void;
}
/** One frame's layout before and after a move or resize. */
export interface LayoutChange {
  id: string;
  before: Partial<Layout>;
  after: Partial<Layout>;
}
type FrameNode = Node<FrameData, "frame">;
interface SectionData extends Record<string, unknown> {
  section: Section;
  selected: boolean;
  onRename: (sectionId: string, title: string) => void;
  onResized: (sectionId: string, before: SectionLayout, after: SectionLayout) => void;
}
type SectionNode = Node<SectionData, "section">;
type AnyNode = FrameNode | SectionNode;
type LinkEdge = Edge<{ direction: LinkDirection }, "link">;

/** select: drag on empty space draws a selection box. hand: drag anywhere pans. link: drag from a frame to another.
 *  section: drag to draw a section (Shift+S). */
export type CanvasTool = "select" | "hand" | "link" | "section";

const viewportKey = (boardId: string) => `wb.viewport.${boardId}`;
function savedViewport(boardId: string): Viewport | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(viewportKey(boardId)) ?? "null");
    if (v && [v.x, v.y, v.zoom].every(Number.isFinite)) return v;
  } catch {
    /* private mode or bad value */
  }
  return undefined;
}

interface BoardCanvasProps {
  boardId: string;
  tools: Tool[];
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  /** Right click: ids = the frames it applies to (empty = on the canvas itself); at = canvas position. */
  onContextMenu: (e: { x: number; y: number }, ids: string[], at: { x: number; y: number }) => void;
  onDropTemplate: (templateId: string, at: { x: number; y: number }) => void;
  showMinimap: boolean;
  /** select: drag on empty space draws a selection box. hand: drag anywhere pans; frames ignore the pointer. link: drag from one frame to another. */
  tool: CanvasTool;
  links: Link[];
  onSelectLinks: (ids: string[]) => void;
  /** Right click on a link. */
  onLinkMenu: (e: { x: number; y: number }, linkId: string) => void;
  activeIds: Set<string>;
  waitingIds: Set<string>;
  appErrors: Record<string, number>;
  onAppErrors: (toolId: string, n: number) => void;
  onInteract: () => void;
  onNotice: (m: string) => void;
  /** On screen: arrow keys move the selected frames. */
  active: boolean;
  /** The person moved or resized frames (drag, arrows, grips): for undo. */
  onCommit: (changes: LayoutChange[]) => void;
  /** The person renamed a frame on its label. */
  onRename: (toolId: string, title: string) => void;
  /** The pointer moved over the canvas (client coordinates): new frames from N / C / B and paste go there. */
  onPointer: (p: { x: number; y: number } | null) => void;
  /** Sections (biggest first) and the ones selected (sections are selected here, not by React Flow). */
  sections: Section[];
  selectedSectionIds: string[];
  onSelectSections: (ids: string[], additive: boolean) => void;
  onSectionMenu: (e: { x: number; y: number }, sectionId: string) => void;
  /** Files dropped from the computer (board coordinates of the drop). */
  onDropFiles: (files: File[], at: { x: number; y: number }) => void;
  /** Folders dropped on the board (each opens in a code editor). */
  onDropFolders: (folders: File[], at: { x: number; y: number }) => void;
  /** Drawn with the section tool (board coordinates). */
  onDrawSection: (layout: SectionLayout) => void;
  /** A section was dragged (its contents went along) or resized: save it and keep it for undo. */
  onSectionMoved: (sectionId: string, before: SectionLayout, after: SectionLayout, moveContents: boolean) => void;
  onSectionRename: (sectionId: string, title: string) => void;
  children?: React.ReactNode; // <Panel> overlays
}

const nodeTypes = { frame: FrameView, section: SectionView };
const edgeTypes = { link: LinkLine };

export function BoardCanvas(props: BoardCanvasProps) {
  const api = useApi();
  const t = useT();
  const { boardId, tools, selectedIds, onSelect, activeIds, waitingIds, appErrors, onAppErrors, onInteract, onNotice, onCommit, onRename } = props;
  const linking = props.tool === "link";
  const rf = useReactFlow<AnyNode>();
  const [nodes, setNodes] = useState<AnyNode[]>([]);
  const { sections, selectedSectionIds, onSectionMoved, onSectionRename } = props;
  // Sections we moved or resized but the server has not echoed yet; and what a section drag carries along.
  const pendingSections = useRef(new Map<string, { layout: SectionLayout; until: number }>());
  const sectionDrag = useRef<{ id: string; from: SectionLayout; members: Map<string, { x: number; y: number }> } | null>(null);
  const onSectionResized = useCallback(
    (id: string, before: SectionLayout, after: SectionLayout) => {
      pendingSections.current.set(id, { layout: after, until: Date.now() + 2000 });
      onSectionMoved(id, before, after, false);
    },
    [onSectionMoved],
  );
  const initialViewport = useRef(savedViewport(boardId));
  const selectedSet = useRef(new Set<string>());
  selectedSet.current = new Set(selectedIds);
  // Positions we sent but the server has not echoed yet: keeps a dropped frame from snapping back.
  const pending = useRef(new Map<string, { layout: Partial<Layout>; until: number }>());

  const onLayout = useCallback(
    (toolId: string, l: Partial<Layout>) => {
      const rounded = Object.fromEntries(Object.entries(l).map(([k, v]) => [k, Math.round(v as number)])) as Partial<Layout>;
      pending.current.set(toolId, { layout: { ...pending.current.get(toolId)?.layout, ...rounded }, until: Date.now() + 2000 });
      api.setLayout(toolId, rounded).catch((err) => {
        pending.current.delete(toolId);
        onNotice(t(`Could not save position: ${err.message}`, `위치 저장 실패: ${err.message}`));
      });
    },
    [onNotice, api, t],
  );

  // Server tools and sections → React Flow nodes, keeping React Flow's own bookkeeping (measured size, dragging,
  // resizing). Sections come first and sit behind the frames; only their label takes the pointer (see the CSS), so a
  // drag on a section's empty space draws a selection box, as in Figma.
  useEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      const carried = sectionDrag.current?.members;
      const secNodes = sections.map((sec) => {
        const p = byId.get(sec.id) as SectionNode | undefined;
        let L = sec.layout;
        const pend = pendingSections.current.get(sec.id);
        if (pend) {
          const echoed = (["x", "y", "w", "h"] as const).every((k) => L[k] === pend.layout[k]);
          if (echoed || Date.now() > pend.until) pendingSections.current.delete(sec.id);
          else L = pend.layout;
        }
        return {
          ...p,
          id: sec.id,
          type: "section",
          position: p?.dragging || carried?.has(sec.id) ? p!.position : { x: L.x, y: L.y },
          width: p?.resizing ? p.width : L.w,
          height: p?.resizing ? p.height : L.h,
          zIndex: -1,
          selectable: false,
          connectable: false,
          focusable: false,
          draggable: props.tool === "select",
          dragHandle: ".section-label",
          data: { section: sec, selected: selectedSectionIds.includes(sec.id), onRename: onSectionRename, onResized: onSectionResized },
        } as SectionNode;
      });
      const frameNodes = tools
        .filter((t) => t.layout)
        .map((t) => {
          const p = byId.get(t.id);
          let L: Layout = t.layout!;
          const pend = pending.current.get(t.id);
          if (pend) {
            const echoed = Object.entries(pend.layout).every(([k, v]) => (L as any)[k] === v);
            if (echoed || Date.now() > pend.until) pending.current.delete(t.id);
            else L = { ...L, ...pend.layout };
          }
          return {
            ...p,
            id: t.id,
            type: "frame",
            position: p?.dragging || carried?.has(t.id) ? p!.position : { x: L.x, y: L.y },
            width: p?.resizing ? p.width : L.w,
            // Height follows the content, except browsers and code editors: they keep a set height and scroll inside.
            height: p?.resizing ? p.height : fixedHeight(t.kind) ? (L.h ?? heightRange(t.kind).default) : undefined,
            selected: selectedSet.current.has(t.id),
            data: {
              tool: t,
              active: activeIds.has(t.id),
              waiting: waitingIds.has(t.id),
              errors: appErrors[t.id] ?? 0,
              onAppErrors,
              onLayout,
              onNotice,
              linking,
              solo: selectedIds.length === 1 && selectedIds[0] === t.id,
              onCommit,
              onRename,
            },
          } as FrameNode;
        });
      return [...secNodes, ...frameNodes];
    });
  }, [tools, selectedIds, activeIds, waitingIds, appErrors, onAppErrors, onLayout, onNotice, linking, onCommit, onRename, sections, selectedSectionIds, onSectionRename, onSectionResized, props.tool]);

  // Board links → React Flow edges. Selection stays React Flow's; LinkLine draws the direction.
  const [edges, setEdges] = useState<LinkEdge[]>([]);
  useEffect(() => {
    setEdges((prev) => {
      const was = new Map(prev.map((e) => [e.id, e.selected]));
      return props.links
        .filter((l) => tools.some((t) => t.id === l.from) && tools.some((t) => t.id === l.to))
        .map((l) => ({ id: l.id, source: l.from, target: l.to, type: "link", selected: !!was.get(l.id), data: { direction: l.direction } }) as LinkEdge);
    });
  }, [props.links, tools]);
  const onEdgesChange = useCallback((changes: EdgeChange<LinkEdge>[]) => {
    // Links are removed from their menu or with Delete (BoardPanel), never by React Flow itself.
    setEdges((eds) => applyEdgeChanges(changes.filter((c) => c.type === "select"), eds));
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<AnyNode>[]) => {
    // Frames are deleted by BoardPanel (Delete key, menus, inspector), which can undo it; never by React Flow itself.
    setNodes((nds) => applyNodeChanges(changes.filter((c) => c.type !== "remove"), nds));
  }, []);

  // As in Figma: the wheel and two-finger scroll pan (React Flow), ⌘/Ctrl+wheel and pinch zoom. Shift+wheel pans
  // sideways (here, for mice that only scroll vertically). Scrollable parts inside a frame are marked .nowheel and keep
  // their own scrolling. A browser page takes a scroll that starts over it before this runs (see routeWheel in BrowserView).
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const t = e.target as Element | null;
      if (!e.shiftKey || e.ctrlKey || e.metaKey || t?.closest(".nowheel")) return;
      e.preventDefault();
      e.stopPropagation();
      const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? el.clientHeight : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0];
      const v = rf.getViewport();
      rf.setViewport({ x: v.x - dx, y: v.y - dy, zoom: v.zoom });
      onInteract();
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [rf, onInteract]);

  const { onSelectLinks } = props;
  const onSelectionChange = useCallback(
    ({ nodes: sel, edges: selEdges }: OnSelectionChangeParams) => {
      onSelect(sel.map((n) => n.id));
      onSelectLinks(selEdges.map((e) => e.id));
    },
    [onSelect, onSelectLinks],
  );
  const flowPos = (e: { clientX: number; clientY: number }) => rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });

  // Arrow keys move the selected frames 1 board unit (Shift: 10), as in Figma. Saved once the keys rest.
  const { active } = props;
  const nudgeSave = useRef<number>(0);
  const nudgeFrom = useRef<Map<string, { x: number; y: number }> | null>(null);
  const dragFrom = useRef(new Map<string, { x: number; y: number }>());
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      const el = document.activeElement;
      const typing = !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable || !!el.closest(".term-window, .browser-page"));
      if (document.querySelector('[role="menu"], .modal')) return; // a menu or dialog takes the arrows
      if (!dir || typing || e.metaKey || e.ctrlKey || e.altKey || !selectedSet.current.size || props.tool !== "select") return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      if (!nudgeFrom.current) nudgeFrom.current = new Map(rf.getNodes().filter((n) => selectedSet.current.has(n.id)).map((n) => [n.id, { ...n.position }]));
      setNodes((nds) => nds.map((n) => (selectedSet.current.has(n.id) ? { ...n, position: { x: n.position.x + dir[0] * step, y: n.position.y + dir[1] * step } } : n)));
      onInteract();
      window.clearTimeout(nudgeSave.current);
      nudgeSave.current = window.setTimeout(() => {
        const from = nudgeFrom.current ?? new Map();
        nudgeFrom.current = null;
        const changes: LayoutChange[] = [];
        for (const n of rf.getNodes()) {
          const b = from.get(n.id);
          if (!b) continue;
          onLayout(n.id, { x: n.position.x, y: n.position.y });
          changes.push({ id: n.id, before: { x: Math.round(b.x), y: Math.round(b.y) }, after: { x: Math.round(n.position.x), y: Math.round(n.position.y) } });
        }
        if (changes.length) onCommit(changes);
      }, 300);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, props.tool, rf, onLayout, onInteract, onCommit]);

  const { onPointer } = props;
  return (
    <div
      ref={wrapRef}
      className="flow-wrap"
      onPointerMove={(e) => onPointer({ x: e.clientX, y: e.clientY })}
      onPointerLeave={() => onPointer(null)}
    >
    {props.tool === "section" && <SectionDraw onDraw={props.onDrawSection} />}
    <ReactFlow<AnyNode, LinkEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      // Links: in link mode, press on a frame and let go on another (or click one, then the other).
      connectionMode={ConnectionMode.Loose}
      connectionLineType={ConnectionLineType.Straight}
      connectionLineStyle={{ stroke: "var(--accent)", strokeWidth: 2 }}
      isValidConnection={(c) => c.source !== c.target}
      onConnect={(c) => {
        if (!c.source || !c.target || c.source === c.target) return;
        api.createLink(c.source, c.target).catch((err: Error) => onNotice(err.message));
      }}
      onEdgeContextMenu={(e, edge) => {
        e.preventDefault();
        setEdges((eds) => eds.map((x) => ({ ...x, selected: x.id === edge.id })));
        props.onLinkMenu({ x: e.clientX, y: e.clientY }, edge.id);
      }}
      onNodeDragStart={(_e, node, dragged) => {
        onInteract();
        dragFrom.current = new Map(dragged.map((n) => [n.id, { ...n.position }]));
        if (node.type !== "section") return;
        // Dragging a section takes along the frames in it and the sections inside it, by where they are now.
        const sec = (node as SectionNode).data.section;
        const from = { ...sec.layout, x: node.position.x, y: node.position.y };
        const members = new Map<string, { x: number; y: number }>();
        for (const n of rf.getNodes()) {
          if (n.id === node.id) continue;
          if (n.type === "frame" && inSection(frameAnchor({ ...n.position, w: n.measured?.width ?? n.width ?? 0 }), from)) members.set(n.id, { ...n.position });
          if (n.type === "section" && sectionInside({ ...n.position, w: n.width ?? 0, h: n.height ?? 0 }, from)) members.set(n.id, { ...n.position });
        }
        sectionDrag.current = { id: node.id, from, members };
      }}
      onNodeDrag={(_e, node) => {
        const d = sectionDrag.current;
        if (!d || d.id !== node.id) return;
        const dx = node.position.x - d.from.x;
        const dy = node.position.y - d.from.y;
        setNodes((nds) => nds.map((n) => (d.members.has(n.id) ? { ...n, position: { x: d.members.get(n.id)!.x + dx, y: d.members.get(n.id)!.y + dy } } : n)));
      }}
      onNodeDragStop={(_e, node, dragged) => {
        const d = sectionDrag.current;
        if (d && d.id === node.id) {
          const after = { ...d.from, x: Math.round(node.position.x), y: Math.round(node.position.y) };
          const dx = after.x - Math.round(d.from.x);
          const dy = after.y - Math.round(d.from.y);
          // Keep the carried frames where they were dropped until the server's move comes back.
          for (const [id, p] of d.members) {
            const n = rf.getNode(id);
            if (n?.type === "frame") pending.current.set(id, { layout: { x: Math.round(p.x) + dx, y: Math.round(p.y) + dy }, until: Date.now() + 2000 });
            else if (n?.type === "section") pendingSections.current.set(id, { layout: { ...(n as SectionNode).data.section.layout, x: Math.round(p.x) + dx, y: Math.round(p.y) + dy }, until: Date.now() + 2000 });
          }
          pendingSections.current.set(d.id, { layout: after, until: Date.now() + 2000 });
          sectionDrag.current = null;
          if (dx || dy) onSectionMoved(d.id, { ...d.from, x: Math.round(d.from.x), y: Math.round(d.from.y) }, after, true);
          return;
        }
        const changes: LayoutChange[] = [];
        for (const n of dragged) {
          onLayout(n.id, { x: n.position.x, y: n.position.y });
          const b = dragFrom.current.get(n.id);
          if (b && (Math.round(b.x) !== Math.round(n.position.x) || Math.round(b.y) !== Math.round(n.position.y)))
            changes.push({ id: n.id, before: { x: Math.round(b.x), y: Math.round(b.y) }, after: { x: Math.round(n.position.x), y: Math.round(n.position.y) } });
        }
        if (changes.length) onCommit(changes);
      }}
      onSelectionChange={onSelectionChange}
      onPaneClick={() => {
        onSelect([]);
        props.onSelectSections([], false);
      }}
      onNodeClick={(e, node) => {
        if (node.type === "section") props.onSelectSections([node.id], e.shiftKey || e.metaKey || e.ctrlKey);
      }}
      onNodeContextMenu={(e, node) => {
        e.preventDefault();
        if (node.type === "section") {
          if (!selectedSectionIds.includes(node.id)) props.onSelectSections([node.id], false);
          return props.onSectionMenu({ x: e.clientX, y: e.clientY }, node.id);
        }
        // Right-clicking outside the current selection targets just that frame, like a file manager.
        const ids = selectedSet.current.has(node.id) ? [...selectedSet.current] : [node.id];
        if (!selectedSet.current.has(node.id)) onSelect([node.id]);
        props.onContextMenu({ x: e.clientX, y: e.clientY }, ids, flowPos(e));
      }}
      onSelectionContextMenu={(e, sel) => {
        e.preventDefault();
        props.onContextMenu({ x: e.clientX, y: e.clientY }, sel.map((n) => n.id), flowPos(e));
      }}
      onPaneContextMenu={(e) => {
        e.preventDefault();
        props.onContextMenu({ x: e.clientX, y: e.clientY }, [], flowPos(e));
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TEMPLATE_MIME) && !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(TEMPLATE_MIME);
        if (id) {
          e.preventDefault();
          return props.onDropTemplate(id, flowPos(e));
        }
        // Files from the computer become file tools where they land; folders open in code editors (BoardPanel).
        const items = [...e.dataTransfer.items].filter((it) => it.kind === "file");
        if (!items.length) return;
        e.preventDefault();
        const isDir = (it: DataTransferItem) => !!it.webkitGetAsEntry?.()?.isDirectory;
        const asFiles = (list: DataTransferItem[]) => list.map((it) => it.getAsFile()).filter((f): f is File => !!f);
        const folders = asFiles(items.filter(isDir));
        const files = asFiles(items.filter((it) => !isDir(it)));
        if (folders.length) props.onDropFolders(folders, flowPos(e));
        if (files.length) props.onDropFiles(files, flowPos(e));
      }}
      onMoveStart={(e) => e && onInteract()}
      onMoveEnd={(_e, vp) => {
        try {
          localStorage.setItem(viewportKey(boardId), JSON.stringify(vp));
        } catch {
          /* ignore */
        }
      }}
      defaultViewport={initialViewport.current ?? { x: 80, y: 80, zoom: 1 }}
      fitView={!initialViewport.current}
      fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      minZoom={0.2}
      maxZoom={2}
      // Figma's controls: drag on empty space draws a selection box (touching frames are selected); the wheel and
      // two-finger scroll pan; ⌘/Ctrl+wheel and pinch zoom at the pointer; Space+drag, middle-button drag and the hand
      // tool pan; Shift (or ⌘/Ctrl) + click adds to the selection.
      selectionOnDrag={props.tool === "select"}
      selectionMode={SelectionMode.Partial}
      panOnDrag={props.tool === "select" || props.tool === "section" ? [1] : true}
      nodesDraggable={props.tool === "select"}
      elementsSelectable={props.tool === "select" || props.tool === "link"}
      panActivationKeyCode="Space"
      multiSelectionKeyCode={["Meta", "Control", "Shift"]}
      panOnScroll
      panOnScrollSpeed={1}
      zoomOnScroll={false}
      zoomActivationKeyCode={["Meta", "Control"]}
      zoomOnPinch
      zoomOnDoubleClick={false}
      deleteKeyCode={null}
      // Its own arrow-key moves (5 px, on a focused frame) would add to ours (1, Shift 10, on the whole selection).
      disableKeyboardA11y
      nodesConnectable={linking}
      colorMode="system"
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.3} />
      {props.showMinimap && (
        // Overview of the whole board: frames are blocks, the clear window is what is on screen. Drag or scroll it to move.
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          ariaLabel={t("Minimap: the visible area of the whole board", "미니맵: 보드 전체에서 지금 보이는 영역")}
          nodeColor={(n) => (n.type === "section" ? "rgba(120, 120, 120, 0.12)" : (n.data as FrameData).tool.createdBy === "agent" ? "#cdbcf3" : "#c9d7e8")}
          nodeBorderRadius={6}
          maskColor="rgba(20, 20, 20, 0.12)"
          maskStrokeColor="#0d99ff"
          maskStrokeWidth={2}
          style={{ width: 168, height: 108 }}
        />
      )}
      {props.children}
    </ReactFlow>
    </div>
  );
}

// ── links ──
/** A frame's box on the board, with its label above it (the label keeps its size on screen: `top` is its height). */
function frameBox(n: InternalNode, top: number) {
  const { x, y } = n.internals.positionAbsolute;
  return { x, y: y - top, w: n.measured.width ?? 0, h: (n.measured.height ?? 0) + top };
}
/** Where the line from a box's centre towards a point leaves the box, `gap` outside it. */
function borderPoint(r: { x: number; y: number; w: number; h: number }, toward: { x: number; y: number }, gap: number) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const s = Math.min(dx ? (r.w / 2 + gap) / Math.abs(dx) : Infinity, dy ? (r.h / 2 + gap) / Math.abs(dy) : Infinity);
  return { x: cx + dx * s, y: cy + dy * s };
}
const centre = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Arrowhead size, the gap to a frame and the frame label's height, in screen pixels (they look the same at any zoom). */
const ARROW = { length: 13, halfWidth: 5.5, gap: 4, label: 23 };

/** A straight line between two frames' edges, aimed centre to centre (it follows the frames as they move).
 *  An arrowhead at an end shows the link points that way. */
function LinkLine({ id, source, target, data, selected }: EdgeProps<LinkEdge>) {
  const a = useInternalNode(source);
  const b = useInternalNode(target);
  const zoom = useStore((s) => s.transform[2]);
  if (!a || !b) return null;
  const px = 1 / zoom; // one screen pixel in board units
  const ra = frameBox(a, ARROW.label * px);
  const rb = frameBox(b, ARROW.label * px);
  const p = borderPoint(ra, centre(rb), ARROW.gap * px);
  const q = borderPoint(rb, centre(ra), ARROW.gap * px);
  const dir = data?.direction ?? "none";
  const atTo = dir !== "none";
  const atFrom = dir === "both";
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const dist = Math.hypot(dx, dy) || 1;
  const u = { x: dx / dist, y: dy / dist };
  // Short lines (frames close together) get smaller heads, so two never overlap.
  const len = Math.min(ARROW.length * px, dist / (atFrom ? 2.2 : 1.1));
  const half = (len / (ARROW.length * px)) * ARROW.halfWidth * px;
  const head = (tip: { x: number; y: number }, s: number) => {
    const bx = tip.x - u.x * len * s;
    const by = tip.y - u.y * len * s;
    return `M ${tip.x},${tip.y} L ${bx - u.y * half},${by + u.x * half} L ${bx + u.y * half},${by - u.x * half} Z`;
  };
  // The line stops inside each head, so its end doesn't blunt the tip.
  const from = atFrom ? { x: p.x + u.x * len * 0.6, y: p.y + u.y * len * 0.6 } : p;
  const to = atTo ? { x: q.x - u.x * len * 0.6, y: q.y - u.y * len * 0.6 } : q;
  const cls = selected ? " selected" : "";
  return (
    <>
      <BaseEdge id={id} path={`M ${from.x},${from.y} L ${to.x},${to.y}`} interactionWidth={24} className={"link-line" + cls} />
      {atTo && <path className={"link-arrow" + cls} d={head(q, 1)} />}
      {atFrom && <path className={"link-arrow" + cls} d={head(p, -1)} />}
    </>
  );
}

// ── sections ──
/** A section: a tinted area with its name at the top left. Only the label (select, move, rename) and, when selected,
 *  the resize grips take the pointer; the rest lets clicks and drags through to the canvas. */
function SectionView({ data, width, height }: NodeProps<SectionNode>) {
  const t = useT();
  const zoom = useStore((s) => s.transform[2]);
  const { section, selected } = data;
  const [renaming, setRenaming] = useState(false);
  const from = useRef<SectionLayout>(section.layout);
  return (
    <div className={`section-box sec-${section.color}${selected ? " selected" : ""}`} style={{ width, height, ["--z" as string]: zoom }}>
      <div className="section-label" style={{ transform: `scale(${1 / zoom})` }} title={t(`@${section.name} · drag to move what is in it`, `@${section.name} · 끌면 안의 것들이 함께 움직입니다`)}>
        {renaming ? (
          <input
            className="frame-rename nodrag"
            defaultValue={section.title}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") {
                e.currentTarget.value = section.title;
                e.currentTarget.blur();
              }
              e.stopPropagation();
            }}
            onBlur={(e) => {
              const next = e.currentTarget.value.trim();
              setRenaming(false);
              if (next && next !== section.title) data.onRename(section.id, next);
            }}
          />
        ) : (
          <span onDoubleClick={() => setRenaming(true)}>{section.title}</span>
        )}
      </div>
      <NodeResizer
        isVisible={selected}
        minWidth={SECTION_MIN.w}
        minHeight={SECTION_MIN.h}
        color="var(--accent)"
        onResizeStart={(_e, p) => (from.current = { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) })}
        onResizeEnd={(_e, p) => data.onResized(section.id, from.current, { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) })}
      />
    </div>
  );
}

/** The section tool (Shift+S): drag to draw a section; a click makes one of the default size there. */
function SectionDraw({ onDraw }: { onDraw: (layout: SectionLayout) => void }) {
  const rf = useReactFlow();
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const local = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  return (
    <div
      ref={ref}
      className="section-draw"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = local(e);
        setBox({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(e) => box && setBox({ ...box, ...((p) => ({ x1: p.x, y1: p.y }))(local(e)) })}
      onPointerUp={(e) => {
        if (!box) return;
        const r = ref.current!.getBoundingClientRect();
        const a = rf.screenToFlowPosition({ x: r.left + Math.min(box.x0, box.x1), y: r.top + Math.min(box.y0, box.y1) });
        const b = rf.screenToFlowPosition({ x: r.left + Math.max(box.x0, box.x1), y: r.top + Math.max(box.y0, box.y1) });
        setBox(null);
        const small = Math.abs(box.x1 - box.x0) < 8 && Math.abs(box.y1 - box.y0) < 8;
        onDraw(small ? { x: Math.round(a.x), y: Math.round(a.y), w: 640, h: 420 } : { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(b.x - a.x), h: Math.round(b.y - a.y) });
        e.stopPropagation();
      }}
    >
      {box && (
        <div
          className="section-draw-box"
          style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }}
        />
      )}
    </div>
  );
}

// The top edge stays free for the frame's label (dragging it moves the frame).
const BROWSER_GRIPS: [ControlPosition, ResizeControlVariant][] = [
  ["left", ResizeControlVariant.Line],
  ["right", ResizeControlVariant.Line],
  ["bottom", ResizeControlVariant.Line],
  ["bottom-left", ResizeControlVariant.Handle],
  ["bottom-right", ResizeControlVariant.Handle],
];

function FrameView({ data, selected, width, height }: NodeProps<FrameNode>) {
  const t = useT();
  const zoom = useStore((s) => s.transform[2]);
  const { tool, active, waiting, errors } = data;
  const [renaming, setRenaming] = useState(false);
  const resizeFrom = useRef<Partial<Layout>>({});
  const resizeStart = (_e: unknown, p: { x: number; y: number; width: number; height: number }) => {
    resizeFrom.current = { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), ...(fixedHeight(tool.kind) ? { h: Math.round(p.height) } : {}) };
  };
  const resizeEnd = (l: Partial<Layout>) => {
    data.onLayout(tool.id, l);
    const after = Object.fromEntries(Object.entries(l).map(([k, v]) => [k, Math.round(v as number)])) as Partial<Layout>;
    data.onCommit([{ id: tool.id, before: resizeFrom.current, after }]);
  };
  const browser = tool.kind === "browser";
  const sized = fixedHeight(tool.kind);
  const cls = ["frame", browser && "browser-frame", tool.kind === "code" && "code-frame", selected && "selected", active && "active", waiting && "waiting", data.linking && "linking"].filter(Boolean).join(" ");
  return (
    <div className={cls} style={{ ["--z" as string]: zoom }}>
      {/* Where links attach. With the link tool it covers the frame, so a link starts or ends anywhere on it. */}
      <Handle type="source" position={Position.Top} className="link-handle" isConnectable={data.linking} />
      <div className="frame-label" style={{ transform: `scale(${1 / zoom})` }} title={tool.description || tool.title}>
        {renaming ? (
          <input
            className="frame-rename nodrag"
            defaultValue={tool.title}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") {
                e.currentTarget.value = tool.title;
                e.currentTarget.blur();
              }
              e.stopPropagation();
            }}
            onBlur={(e) => {
              const next = e.currentTarget.value.trim();
              setRenaming(false);
              if (next && next !== tool.title) data.onRename(tool.id, next);
            }}
          />
        ) : (
          // Double-click the name to rename it, as a layer in Figma.
          <span className="frame-title" onDoubleClick={() => setRenaming(true)}>
            {tool.title}
          </span>
        )}
        {tool.name && <span className="frame-name">@{tool.name}</span>}
        <span className="frame-kind">{kindLabel(tool.kind, t)}</span>
        {active && <span className="pill agent">{t("agent working", "agent 작업 중")}</span>}
        {waiting && <span className="pill wait">{t("awaiting reply", "응답 대기")}</span>}
        {errors > 0 && <span className="pill error">{t(`${errors} error${errors > 1 ? "s" : ""}`, `오류 ${errors}`)}</span>}
      </div>
      {/* The label and the frame's edge move it (as a frame's name does in Figma); its content is for using the tool. */}
      <div className="frame-body nodrag">
        <ToolBody tool={tool} onNotice={data.onNotice} onAppErrors={(n) => data.onAppErrors(tool.id, n)} />
        {tool.kind === "app" && !selected && (
          // First click selects the app; only then does its iframe get the pointer, so scroll/drag keep panning the canvas.
          // (A browser needs no shield: clicks reach the page at once, and a scroll that starts on the board keeps zooming it.)
          <div className="frame-shield" title={t("Click to use the app", "클릭해서 앱 사용")} />
        )}
      </div>
      {data.solo && width ? (
        <div className="frame-size" style={{ transform: `translateX(-50%) scale(${1 / zoom})` }} aria-hidden>
          {Math.round(width)} × {Math.round(height ?? 0)}
        </div>
      ) : null}
      {selected && !sized && (
        <NodeResizeControl
          variant={ResizeControlVariant.Line}
          position="right"
          minWidth={240}
          maxWidth={1600}
          onResizeStart={resizeStart}
          onResizeEnd={(_e, p) => resizeEnd({ x: p.x, y: p.y, w: p.width })}
        />
      )}
      {/* A browser or code editor frame resizes from its sides and bottom corners, selected or not (selecting a browser
          by clicking the page would also click the website). The content takes the frame's new size. */}
      {sized &&
        BROWSER_GRIPS.map(([position, variant]) => (
          <NodeResizeControl
            key={position}
            position={position}
            variant={variant}
            autoScale={false} // the CSS keeps grips the same size on screen at any zoom
            minWidth={BROWSER_WIDTH.min}
            maxWidth={BROWSER_WIDTH.max}
            minHeight={heightRange(tool.kind).min}
            maxHeight={heightRange(tool.kind).max}
            onResizeStart={resizeStart}
            onResizeEnd={(_e, p) => resizeEnd({ x: p.x, y: p.y, w: p.width, h: p.height })}
          />
        ))}
    </div>
  );
}

/** Camera moves the board needs: follow the agent, fit everything, drop new tools where the person looks. */
export function useCanvasActions() {
  const rf = useReactFlow<AnyNode>();
  const zoom = useStore((s) => s.transform[2]);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);

  const focusTool = useCallback(
    (id: string, opts: { onlyIfHidden?: boolean } = {}) => {
      const n = rf.getNode(id);
      if (!n) return false;
      const w = n.measured?.width ?? n.width ?? 400;
      const h = n.measured?.height ?? 300;
      if (opts.onlyIfHidden) {
        const v = rf.getViewport();
        const sx = n.position.x * v.zoom + v.x;
        const sy = n.position.y * v.zoom + v.y;
        // "Visible" = the frame's top part is on screen; tall frames need not fit whole.
        if (sx >= 0 && sy >= 24 && sx + w * v.zoom <= width && sy + Math.min(h, 360) * v.zoom <= height) return false;
      }
      rf.fitView({ nodes: [{ id }], duration: 350, padding: 0.25, maxZoom: Math.max(rf.getZoom(), 0.6), minZoom: 0.3 });
      return true;
    },
    [rf, width, height],
  );

  return useMemo(
    () => ({
      zoom,
      focusTool,
      fitAll: () => rf.fitView({ padding: 0.15, duration: 300, maxZoom: 1 }),
      zoomTo: (z: number) => rf.zoomTo(z, { duration: 200 }),
      zoomIn: () => rf.zoomIn({ duration: 150 }),
      zoomOut: () => rf.zoomOut({ duration: 150 }),
      /** World position at the middle of the visible canvas. */
      center: () => {
        const r = document.querySelector(".board-pane .react-flow")?.getBoundingClientRect();
        return rf.screenToFlowPosition({ x: r ? r.left + r.width / 2 : innerWidth / 2, y: r ? r.top + r.height / 2 : innerHeight / 2 });
      },
    }),
    [rf, zoom, focusTool],
  );
}
