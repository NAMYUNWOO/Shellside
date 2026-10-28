// Spend vs revenue: a scatter plot of the "sales" channel. Clicking a point writes the "selection" channel,
// which the data table and the summary highlight. No app knows about the others: they only share channels.
import { useChannel } from "board";

const COLORS = { North: "#0d99ff", South: "#f2994a", West: "#7c4dd6" };
const W = 520;
const H = 300;
const M = { top: 16, right: 16, bottom: 36, left: 44 };

const niceMax = (v) => {
  const step = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1))));
  return Math.ceil(v / step) * step;
};

function fit(points) {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((s, p) => s + p.spend, 0) / n;
  const my = points.reduce((s, p) => s + p.revenue, 0) / n;
  const sxx = points.reduce((s, p) => s + (p.spend - mx) ** 2, 0);
  if (!sxx) return null;
  const slope = points.reduce((s, p) => s + (p.spend - mx) * (p.revenue - my), 0) / sxx;
  return { slope, intercept: my - slope * mx };
}

export default function App() {
  const [data] = useChannel("sales", { columns: [], rows: [] });
  const [selection, setSelection] = useChannel("selection", null);
  const rows = (data.rows ?? []).filter((r) => Number.isFinite(r.spend) && Number.isFinite(r.revenue));
  const maxX = niceMax(Math.max(10, ...rows.map((r) => r.spend)));
  const maxY = niceMax(Math.max(10, ...rows.map((r) => r.revenue)));
  const x = (v) => M.left + (v / maxX) * (W - M.left - M.right);
  const y = (v) => H - M.bottom - (v / maxY) * (H - M.top - M.bottom);
  const ticks = (max) => [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * max));
  const line = fit(rows);

  return (
    <div style={{ fontSize: 12, color: "var(--muted)" }}>
      <style>{`
        :root { --text: #1d1d1b; --text2: #4a4945; --muted: #6b6a65; --faint: #8a8984; --line: #e3e2de; --soft: #f0efeb; --grid: #eeede9; --surface: #fff; --sel: #e5f4ff; }
        @media (prefers-color-scheme: dark) { :root { --text: #ecebe7; --text2: #d6d5d0; --muted: #a3a29c; --faint: #85847f; --line: #3a3a37; --soft: #2c2c2a; --grid: #333331; --surface: #262624; --sel: #17324b; } }
        .grid { stroke: var(--grid); }
        .tick { fill: var(--faint); font-size: 11px; }
        .axis { fill: var(--muted); font-size: 11px; }
        .trend { stroke: var(--faint); }
        code { background: var(--soft); border-radius: 4px; padding: 1px 5px; }
      `}</style>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Scatter plot of ad spend against revenue">
        {ticks(maxY).map((t) => (
          <g key={"y" + t}>
            <line className="grid" x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
            <text className="tick" x={M.left - 8} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {ticks(maxX).map((t) => (
          <text className="tick" key={"x" + t} x={x(t)} y={H - M.bottom + 16} textAnchor="middle">
            {t}
          </text>
        ))}
        <text className="axis" x={(W + M.left) / 2} y={H - 4} textAnchor="middle">
          Ad spend ($k)
        </text>
        <text className="axis" x={12} y={(H - M.bottom) / 2} textAnchor="middle" transform={`rotate(-90 12 ${(H - M.bottom) / 2})`}>
          Revenue ($k)
        </text>
        {line && (
          <line x1={x(0)} y1={y(Math.max(0, line.intercept))} x2={x(maxX)} y2={y(Math.min(maxY, line.intercept + line.slope * maxX))} className="trend" strokeDasharray="4 4" />
        )}
        {rows.map((r) => {
          const on = selection?.rowId === r.id;
          return (
            <circle
              key={r.id}
              cx={x(r.spend)}
              cy={y(r.revenue)}
              r={on ? 8 : 5.5}
              fill={COLORS[r.region] ?? "#999"}
              fillOpacity={on ? 1 : 0.85}
              strokeWidth={on ? 2.5 : 1.5}
              style={{ cursor: "pointer", stroke: on ? "var(--text)" : "var(--surface)" }}
              onClick={() => setSelection({ rowId: r.id })}
            >
              <title>{`${r.region}: spend ${r.spend}, revenue ${r.revenue}`}</title>
            </circle>
          );
        })}
      </svg>
      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        {Object.entries(COLORS).map(([g, c]) => (
          <span key={g}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: c, marginRight: 5 }} />
            {g}
          </span>
        ))}
        <span style={{ marginLeft: "auto" }}>
          reads <code>sales</code> · click a point to select
        </span>
      </div>
    </div>
  );
}
