// Sales data: an editable table that publishes the "sales" channel.
// The scatter plot and the summary read the same channel, so every edit shows up there at once.
import { useChannel } from "board";

const REGIONS = ["North", "South", "West"];
const COLORS = { North: "#0d99ff", South: "#f2994a", West: "#7c4dd6" };
const EMPTY = { columns: [], rows: [] };

export default function App() {
  const [data, setData] = useChannel("sales", EMPTY);
  const [selection, setSelection] = useChannel("selection", null);
  const rows = data.rows ?? [];

  const edit = (id, key, value) =>
    setData((d) => ({ ...d, rows: d.rows.map((r) => (r.id === id ? { ...r, [key]: key === "region" ? value : Number(value) } : r)) }));
  const add = () =>
    setData((d) => ({ ...d, rows: [...d.rows, { id: "r" + Date.now().toString(36), region: "North", spend: 20, revenue: 80 }] }));
  const remove = (id) => setData((d) => ({ ...d, rows: d.rows.filter((r) => r.id !== id) }));

  return (
    <div className="sheet">
      <style>{`
        :root { --text: #1d1d1b; --text2: #4a4945; --muted: #6b6a65; --faint: #8a8984; --line: #e3e2de; --soft: #f0efeb; --grid: #eeede9; --surface: #fff; --sel: #e5f4ff; }
        @media (prefers-color-scheme: dark) { :root { --text: #ecebe7; --text2: #d6d5d0; --muted: #a3a29c; --faint: #85847f; --line: #3a3a37; --soft: #2c2c2a; --grid: #333331; --surface: #262624; --sel: #17324b; } }
        .sheet { font-size: 13px; }
        .sheet table { width: 100%; border-collapse: collapse; }
        .sheet th { text-align: left; font-weight: 600; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; padding: 4px 6px; border-bottom: 1px solid var(--line); }
        .sheet td { padding: 2px 6px; border-bottom: 1px solid var(--soft); }
        .sheet tr.sel td { background: var(--sel); }
        .sheet input, .sheet select { font: inherit; color: inherit; border: 1px solid transparent; background: transparent; border-radius: 4px; padding: 3px 4px; width: 72px; }
        .sheet input:hover, .sheet select:hover, .sheet input:focus { border-color: var(--line); background: var(--surface); outline: none; }
        .sheet .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
        .sheet .x { border: 0; background: none; color: var(--faint); cursor: pointer; }
        .sheet .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; color: var(--muted); font-size: 12px; }
        .sheet .add { border: 1px solid var(--line); background: var(--surface); color: inherit; border-radius: 6px; padding: 4px 10px; cursor: pointer; font: inherit; }
        .sheet code { background: var(--soft); border-radius: 4px; padding: 1px 5px; }
      `}</style>
      <table>
        <thead>
          <tr>
            <th>Region</th>
            <th>Ad spend ($k)</th>
            <th>Revenue ($k)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={selection?.rowId === r.id ? "sel" : ""} onClick={() => setSelection({ rowId: r.id })}>
              <td>
                <span className="dot" style={{ background: COLORS[r.region] ?? "#999" }} />
                <select aria-label="Region" value={r.region} onChange={(e) => edit(r.id, "region", e.target.value)}>
                  {REGIONS.map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </select>
              </td>
              <td>
                <input aria-label="Ad spend" type="number" value={r.spend} onChange={(e) => edit(r.id, "spend", e.target.value)} />
              </td>
              <td>
                <input aria-label="Revenue" type="number" value={r.revenue} onChange={(e) => edit(r.id, "revenue", e.target.value)} />
              </td>
              <td>
                <button className="x" aria-label="Delete row" onClick={(e) => (e.stopPropagation(), remove(r.id))}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="foot">
        <button className="add" onClick={add}>
          + Add row
        </button>
        <span>
          {rows.length} rows · publishes <code>sales</code>
        </span>
      </div>
    </div>
  );
}
