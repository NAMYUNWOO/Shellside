// Region summary: totals and return on ad spend per region, computed live from the "sales" channel.
import { useChannel } from "board";

const COLORS = { North: "#0d99ff", South: "#f2994a", West: "#7c4dd6" };

function pearson(rows) {
  const n = rows.length;
  if (n < 3) return null;
  const mx = rows.reduce((s, r) => s + r.spend, 0) / n;
  const my = rows.reduce((s, r) => s + r.revenue, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const r of rows) {
    sxy += (r.spend - mx) * (r.revenue - my);
    sxx += (r.spend - mx) ** 2;
    syy += (r.revenue - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

export default function App() {
  const [data] = useChannel("sales", { columns: [], rows: [] });
  const [selection] = useChannel("selection", null);
  const rows = data.rows ?? [];
  const groups = Object.keys(COLORS).map((g) => {
    const rs = rows.filter((r) => r.region === g);
    const spend = rs.reduce((s, r) => s + r.spend, 0);
    const revenue = rs.reduce((s, r) => s + r.revenue, 0);
    return { g, n: rs.length, spend, revenue, roas: spend ? revenue / spend : 0 };
  });
  const best = groups.reduce((a, b) => (b.roas > a.roas ? b : a), groups[0]);
  const r = pearson(rows);
  const picked = rows.find((x) => x.id === selection?.rowId);

  return (
    <div style={{ fontSize: 13 }}>
      <style>{`
        :root { --text: #1d1d1b; --text2: #4a4945; --muted: #6b6a65; --faint: #8a8984; --line: #e3e2de; --soft: #f0efeb; --grid: #eeede9; --surface: #fff; --sel: #e5f4ff; }
        @media (prefers-color-scheme: dark) { :root { --text: #ecebe7; --text2: #d6d5d0; --muted: #a3a29c; --faint: #85847f; --line: #3a3a37; --soft: #2c2c2a; --grid: #333331; --surface: #262624; --sel: #17324b; } }
      `}</style>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {groups.map((x) => (
          <div key={x.g} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "8px 10px", borderTop: `3px solid ${COLORS[x.g]}` }}>
            <div style={{ color: "var(--muted)", fontSize: 12 }}>{x.g}</div>
            <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>{x.roas.toFixed(2)}×</div>
            <div style={{ color: "var(--faint)", fontSize: 11 }}>
              ${x.revenue}k from ${x.spend}k · {x.n} rows
            </div>
          </div>
        ))}
      </div>
      <p style={{ margin: "10px 0 0", color: "var(--text2)" }}>
        <b>{best?.g}</b> returns the most per ad dollar. Spend and revenue correlate at <b>r = {r === null ? "–" : r.toFixed(2)}</b>.
      </p>
      <p style={{ margin: "4px 0 0", color: "var(--faint)", fontSize: 12 }}>
        {picked ? `Selected: ${picked.region} · spend $${picked.spend}k · revenue $${picked.revenue}k` : "Select a row or a point to see it here."}
      </p>
    </div>
  );
}
