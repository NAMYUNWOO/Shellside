// Figma-like board canvas on React Flow (@xyflow/react, MIT): each tool is a frame node on an infinite canvas.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionLineType,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizeControl,
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
import { BROWSER_HEIGHT, BROWSER_WIDTH, type Layout, type Link, type LinkDirection, type Tool } from "../shared/catalog.ts";
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
}
type FrameNode = Node<FrameData, "frame">;
type LinkEdge = Edge<{ direction: LinkDirection }, "link">;

/** select: drag on empty space draws a selection box. hand: drag anywhere pans. link: drag from a frame to another. */
export type CanvasTool = "select" | "hand" | "link";

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
  children?: React.ReactNode; // <Panel> overlays
}

const nodeTypes = { frame: FrameView };
const edgeTypes = { link: LinkLine };

export function BoardCanvas(props: BoardCanvasProps) {
  const api = useApi();
  const t = useT();
  const { boardId, tools, selectedIds, onSelect, activeIds, waitingIds, appErrors, onAppErrors, onInteract, onNotice } = props;
  const linking = props.tool === "link";
  const rf = useReactFlow<FrameNode>();
  const [nodes, setNodes] = useState<FrameNode[]>([]);
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

  // Server tools → React Flow nodes, keeping React Flow's own bookkeeping (measured size, dragging, resizing).
  useEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return tools
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
            position: p?.dragging ? p.position : { x: L.x, y: L.y },
            width: p?.resizing ? p.width : L.w,
            // Height follows the content, except browsers: they keep a set height and the page scrolls inside.
            height: p?.resizing ? p.height : t.kind === "browser" ? (L.h ?? BROWSER_HEIGHT.default) : undefined,
            dragHandle: ".frame-label",
            selected: selectedSet.current.has(t.id),
            data: { tool: t, active: activeIds.has(t.id), waiting: waitingIds.has(t.id), errors: appErrors[t.id] ?? 0, onAppErrors, onLayout, onNotice, linking },
          } as FrameNode;
        });
    });
  }, [tools, selectedIds, activeIds, waitingIds, appErrors, onAppErrors, onLayout, onNotice, linking]);

  // Board links → React Flow edges. Selection stays React Flow's; the arrowheads (direction) follow each link's colour.
  const [edges, setEdges] = useState<LinkEdge[]>([]);
  useEffect(() => {
    setEdges((prev) => {
      const was = new Map(prev.map((e) => [e.id, e.selected]));
      return props.links
        .filter((l) => tools.some((t) => t.id === l.from) && tools.some((t) => t.id === l.to))
        .map((l) => ({ id: l.id, source: l.from, target: l.to, type: "link", selected: !!was.get(l.id), data: { direction: l.direction } }) as LinkEdge);
    });
  }, [props.links, tools]);
  const shownEdges = useMemo(
    () =>
      edges.map((e) => {
        const d = e.data?.direction ?? "none";
        const arrow = { type: MarkerType.ArrowClosed, width: 16, height: 16, color: e.selected ? "var(--accent)" : "var(--link)" };
        return { ...e, markerEnd: d !== "none" ? arrow : undefined, markerStart: d === "both" ? arrow : undefined };
      }),
    [edges],
  );
  const onEdgesChange = useCallback((changes: EdgeChange<LinkEdge>[]) => {
    // Links are removed from their menu or with Delete (BoardPanel), never by React Flow itself.
    setEdges((eds) => applyEdgeChanges(changes.filter((c) => c.type === "select"), eds));
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<FrameNode>[]) => {
    // Frames are deleted from the inspector (with a confirm), never by a stray key press.
    setNodes((nds) => applyNodeChanges(changes.filter((c) => c.type !== "remove"), nds));
  }, []);

  // The wheel zooms (React Flow, everywhere incl. over frames). Shift+wheel pans instead.
  // Scrollable parts inside a frame are marked .nowheel and keep their own scrolling. A browser page takes a scroll
  // that starts over it before this runs (see routeWheel in BrowserView).
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

  return (
    <div ref={wrapRef} className="flow-wrap">
    <ReactFlow<FrameNode, LinkEdge>
      nodes={nodes}
      edges={shownEdges}
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
      onNodeDragStart={onInteract}
      onNodeDragStop={(_e, _node, dragged) => dragged.forEach((n) => onLayout(n.id, { x: n.position.x, y: n.position.y }))}
      onSelectionChange={onSelectionChange}
      onPaneClick={() => onSelect([])}
      onNodeContextMenu={(e, node) => {
        e.preventDefault();
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
        if (!e.dataTransfer.types.includes(TEMPLATE_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(TEMPLATE_MIME);
        if (!id) return;
        e.preventDefault();
        props.onDropTemplate(id, flowPos(e));
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
      // Drag on empty space draws a selection box (touching frames are selected); the wheel and pinch zoom;
      // Space+drag, middle-button drag, the hand tool or Shift+wheel pan; ⌘/Ctrl/Shift+click adds to the selection.
      selectionOnDrag={props.tool === "select"}
      selectionMode={SelectionMode.Partial}
      panOnDrag={props.tool === "select" ? [1] : true}
      nodesDraggable={props.tool === "select"}
      elementsSelectable={props.tool !== "hand"}
      panActivationKeyCode="Space"
      multiSelectionKeyCode={["Meta", "Control", "Shift"]}
      zoomOnScroll
      zoomOnPinch
      zoomOnDoubleClick={false}
      deleteKeyCode={null}
      nodesConnectable={linking}
      colorMode="system"
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.3} />
      <Controls position="bottom-left" showInteractive={false} />
      {props.showMinimap && (
        // Overview of the whole board: frames are blocks, the clear window is what is on screen. Drag or scroll it to move.
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          ariaLabel={t("Minimap: the visible area of the whole board", "미니맵: 보드 전체에서 지금 보이는 영역")}
          nodeColor={(n) => ((n.data as FrameData).tool.createdBy === "agent" ? "#cdbcf3" : "#c9d7e8")}
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
/** Where the line from a frame's centre towards a point leaves the frame. */
function borderPoint(n: InternalNode, toward: { x: number; y: number }, gap: number) {
  const w = n.measured.width ?? 0;
  const h = n.measured.height ?? 0;
  const cx = n.internals.positionAbsolute.x + w / 2;
  const cy = n.internals.positionAbsolute.y + h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const s = Math.min(dx ? (w / 2 + gap) / Math.abs(dx) : Infinity, dy ? (h / 2 + gap) / Math.abs(dy) : Infinity);
  return { x: cx + dx * s, y: cy + dy * s };
}
const centre = (n: InternalNode) => ({ x: n.internals.positionAbsolute.x + (n.measured.width ?? 0) / 2, y: n.internals.positionAbsolute.y + (n.measured.height ?? 0) / 2 });

/** A straight line between two frames' edges, aimed centre to centre (it follows the frames as they move). */
function LinkLine({ id, source, target, markerStart, markerEnd, selected }: EdgeProps<LinkEdge>) {
  const a = useInternalNode(source);
  const b = useInternalNode(target);
  if (!a || !b) return null;
  const p = borderPoint(a, centre(b), 6);
  const q = borderPoint(b, centre(a), 6);
  return (
    <BaseEdge
      id={id}
      path={`M ${p.x},${p.y} L ${q.x},${q.y}`}
      markerStart={markerStart}
      markerEnd={markerEnd}
      interactionWidth={24}
      className={selected ? "link-line selected" : "link-line"}
    />
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

function FrameView({ data, selected }: NodeProps<FrameNode>) {
  const t = useT();
  const zoom = useStore((s) => s.transform[2]);
  const { tool, active, waiting, errors } = data;
  const browser = tool.kind === "browser";
  const cls = ["frame", browser && "browser-frame", selected && "selected", active && "active", waiting && "waiting", data.linking && "linking"].filter(Boolean).join(" ");
  return (
    <div className={cls} style={{ ["--z" as string]: zoom }}>
      {/* Where links attach. With the link tool it covers the frame, so a link starts or ends anywhere on it. */}
      <Handle type="source" position={Position.Top} className="link-handle" isConnectable={data.linking} />
      <div className="frame-label" style={{ transform: `scale(${1 / zoom})` }} title={tool.description || tool.title}>
        <span className="frame-title">{tool.title}</span>
        {tool.name && <span className="frame-name">@{tool.name}</span>}
        <span className="frame-kind">{kindLabel(tool.kind, t)}</span>
        {active && <span className="pill agent">{t("agent working", "agent 작업 중")}</span>}
        {waiting && <span className="pill wait">{t("awaiting reply", "응답 대기")}</span>}
        {errors > 0 && <span className="pill error">{t(`${errors} error${errors > 1 ? "s" : ""}`, `오류 ${errors}`)}</span>}
      </div>
      <div className="frame-body">
        <ToolBody tool={tool} onNotice={data.onNotice} onAppErrors={(n) => data.onAppErrors(tool.id, n)} />
        {tool.kind === "app" && !selected && (
          // First click selects the app; only then does its iframe get the pointer, so scroll/drag keep panning the canvas.
          // (A browser needs no shield: clicks reach the page at once, and a scroll that starts on the board keeps zooming it.)
          <div className="frame-shield" title={t("Click to use the app", "클릭해서 앱 사용")} />
        )}
      </div>
      {selected && !browser && (
        <NodeResizeControl
          variant={ResizeControlVariant.Line}
          position="right"
          minWidth={240}
          maxWidth={1600}
          onResizeEnd={(_e, p) => data.onLayout(tool.id, { x: p.x, y: p.y, w: p.width })}
        />
      )}
      {/* A browser frame resizes from its sides and bottom corners, selected or not (selecting it by clicking the page
          would also click the website). The page takes the frame's new size. */}
      {browser &&
        BROWSER_GRIPS.map(([position, variant]) => (
          <NodeResizeControl
            key={position}
            position={position}
            variant={variant}
            autoScale={false} // the CSS keeps grips the same size on screen at any zoom
            minWidth={BROWSER_WIDTH.min}
            maxWidth={BROWSER_WIDTH.max}
            minHeight={BROWSER_HEIGHT.min}
            maxHeight={BROWSER_HEIGHT.max}
            onResizeEnd={(_e, p) => data.onLayout(tool.id, { x: p.x, y: p.y, w: p.width, h: p.height })}
          />
        ))}
    </div>
  );
}

/** Camera moves the board needs: follow the agent, fit everything, drop new tools where the person looks. */
export function useCanvasActions() {
  const rf = useReactFlow<FrameNode>();
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
