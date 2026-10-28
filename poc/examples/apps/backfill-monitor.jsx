// Backfill monitor: the agent writes progress to the "backfill" channel while it runs a long job
// (channel_write or `wb ch set backfill …`); this app draws it. Pause/Stop reach the agent via board.emit.
import { useChannel, board } from "board";
import { useState } from "react";

const fmt = (n) => (n ?? 0).toLocaleString("en-US");

function Sparkline({ values }) {
  if (!values?.length) return null;
  const w = 460;
  const h = 56;
  const lo = Math.min(...values) * 0.8;
  const hi = Math.max(...values) * 1.05 || 1;
  const pts = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * w},${h - ((v - lo) / (hi - lo || 1)) * h}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" aria-label="Rows per second">
      <polyline points={`0,${h} ${pts} ${w},${h}`} style={{ fill: "var(--sel)" }} stroke="none" />
      <polyline points={pts} fill="none" stroke="#0d99ff" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function App() {
  const [job] = useChannel("backfill", null);
  const [sent, setSent] = useState("");
  if (!job) return <p style={{ color: "#8a8984" }}>Waiting for the agent to start the job…</p>;

  const pct = job.total ? Math.min(100, (job.done / job.total) * 100) : 0;
  const rate = job.rate?.at(-1) ?? 0;
  const eta = rate ? Math.round((job.total - job.done) / rate / 60) : null;
  const control = async (action) => {
    await board.emit("control", { action, at: job.done });
    setSent(`${action} requested. Claude picks it up with board_wait_event.`);
  };
  const pill = { running: ["#2e8b57", "Running"], paused: ["#b26a00", "Paused"], done: ["#6b6a65", "Done"] }[job.status] ?? ["#6b6a65", job.status];

  return (
    <div style={{ fontSize: 13 }}>
      <style>{`
        :root { --text: #1d1d1b; --text2: #4a4945; --muted: #6b6a65; --faint: #8a8984; --line: #e3e2de; --soft: #f0efeb; --grid: #eeede9; --surface: #fff; --sel: #e5f4ff; }
        @media (prefers-color-scheme: dark) { :root { --text: #ecebe7; --text2: #d6d5d0; --muted: #a3a29c; --faint: #85847f; --line: #3a3a37; --soft: #2c2c2a; --grid: #333331; --surface: #262624; --sel: #17324b; } }
      `}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <b>{job.name}</b>
        <span style={{ fontSize: 11, color: "#fff", background: pill[0], borderRadius: 10, padding: "1px 8px" }}>{pill[1]}</span>
        <span style={{ marginLeft: "auto", color: "var(--faint)", fontSize: 12 }}>{job.lastBatch}</span>
      </div>
      <div style={{ height: 10, background: "var(--grid)", borderRadius: 5, margin: "10px 0 6px", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "#0d99ff", transition: "width .4s" }} />
      </div>
      <div style={{ display: "flex", gap: 18, color: "var(--text2)" }}>
        <span>
          <b>{pct.toFixed(1)}%</b> · {fmt(job.done)} / {fmt(job.total)} rows
        </span>
        <span>{fmt(rate)} rows/s</span>
        <span>{eta === null ? "" : `~${eta} min left`}</span>
        <span style={{ color: job.errors ? "#c43d3d" : "var(--faint)" }}>{job.errors} errors</span>
      </div>
      <div style={{ marginTop: 10 }}>
        <Sparkline values={job.rate} />
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
        <button onClick={() => control("pause")} style={btn}>
          Pause
        </button>
        <button onClick={() => control("stop")} style={{ ...btn, color: "#c43d3d", borderColor: "#e8b4b4" }}>
          Stop
        </button>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>{sent}</span>
      </div>
    </div>
  );
}

const btn = { font: "inherit", color: "inherit", border: "1px solid var(--line)", background: "var(--surface)", borderRadius: 6, padding: "4px 12px", cursor: "pointer" };
