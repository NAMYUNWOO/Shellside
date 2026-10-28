#!/usr/bin/env node
// Builds the demo boards shown in the README on a running Shellside server.
// It acts the way Claude does from a board terminal (the same HTTP API the `wb` CLI uses):
//   node examples/seed-demo.mjs              (server at http://127.0.0.1:4100)
//   WB_URL=http://127.0.0.1:4199 node examples/seed-demo.mjs
// It only adds new boards; existing boards are left alone.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.WB_URL ?? "http://127.0.0.1:4100";
const APPS = join(dirname(fileURLToPath(import.meta.url)), "apps");

async function call(method, path, body, actor = "agent") {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(actor === "agent" ? { "x-wb-actor": "agent" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error ?? res.status}`);
  return data;
}
const board = (name) => call("POST", "/api/boards", { name }, "human");
const on = (id) => ({
  tool: (t) => call("POST", `/api/b/${id}/tools`, t),
  app: (title, file, extra = {}) => call("POST", `/api/b/${id}/apps`, { title, source: readFileSync(join(APPS, file), "utf8"), ...extra }),
  ask: (a) => call("POST", `/api/b/${id}/asks`, a),
  patch: (toolId, patch) => call("POST", `/api/b/${id}/tools/${toolId}/patch`, { patch }),
  place: (toolId, layout) => call("PATCH", `/api/b/${id}/tools/${toolId}/layout`, layout),
  channel: (name, value) => call("PUT", `/api/b/${id}/channels/${name}`, { value }),
});

// ── 1. Release checklist: the agent runs the steps, a person approves production ──
const release = await board("Release v2.3");
{
  const b = on(release.id);
  const list = await b.tool({
    kind: "checklist",
    title: "Release v2.3",
    description: "Release steps. Claude checks each step as it finishes; production needs your approval.",
    state: {
      items: [
        { id: "tests", label: "Run unit and integration tests" },
        { id: "build", label: "Build and sign artifacts" },
        { id: "staging", label: "Deploy to staging" },
        { id: "smoke", label: "Smoke tests on staging" },
        { id: "prod", label: "Deploy to production", gate: "human" },
        { id: "notes", label: "Post release notes" },
      ],
    },
  });
  // Claude checks each step as it finishes, with a one-line result.
  const results = ["1,284 passed · 0 failed · 6m 12s", "web 2.3.0 · api 2.3.0 · checksums verified", "4/4 pods healthy", "18/18 checks passed"];
  for (const [i, note] of results.entries()) {
    await b.patch(list.id, [
      { op: "replace", path: `/items/${i}/done`, value: true },
      { op: "add", path: `/items/${i}/note`, value: note },
    ]);
  }
  await b.tool({
    kind: "note",
    title: "Release notes draft",
    description: "Claude drafts these from merged PRs; edit freely.",
    state: {
      text: "## v2.3\n\n- Faster search: results show up 40% sooner on large workspaces.\n- CSV export for every table.\n- Fixed: timezone drift in scheduled reports.\n\nMigration 0042 adds a nullable column (no table lock).",
    },
  });
  await b.ask({
    kind: "approval",
    title: "Deploy v2.3 to production?",
    message: "Staging is healthy (18/18 smoke checks). Rollout: 10% → 50% → 100% over 30 min, with automatic rollback if the error rate goes above 1%.",
    toolId: list.id,
    itemId: "prod",
  });
}

// ── 2. Three small apps that share live data through channels ──
const sales = await board("Sales analysis");
{
  const b = on(sales.id);
  const rows = [
    ["North", 12, 58], ["North", 18, 74], ["North", 25, 96], ["North", 31, 112], ["North", 40, 139],
    ["South", 10, 35], ["South", 16, 49], ["South", 22, 63], ["South", 29, 77], ["South", 35, 92],
    ["West", 14, 66], ["West", 20, 90], ["West", 27, 118], ["West", 33, 131], ["West", 38, 155],
  ].map(([region, spend, revenue], i) => ({ id: `r${i + 1}`, region, spend, revenue }));
  await b.channel("sales", {
    columns: [
      { key: "region", label: "Region", type: "select" },
      { key: "spend", label: "Ad spend ($k)", type: "number" },
      { key: "revenue", label: "Revenue ($k)", type: "number" },
    ],
    rows,
  });
  const table = await b.app("Sales data", "sales-data.jsx", { description: "Editable table. Writes the sales channel; clicking a row writes selection.", width: 420 });
  const plot = await b.app("Spend vs revenue", "scatter-plot.jsx", { description: "Reads sales and selection; clicking a point writes selection.", width: 560 });
  const summary = await b.app("Region summary", "region-summary.jsx", { description: "Reads sales and selection.", width: 560 });
  await b.place(table.id, { x: 0, y: 0 });
  await b.place(plot.id, { x: 460, y: 0 });
  await b.place(summary.id, { x: 460, y: 430 });
}

// ── 3. The agent asks for structured input instead of y/n questions in the terminal ──
const migration = await board("DB migration");
{
  const b = on(migration.id);
  await b.tool({
    kind: "checklist",
    title: "orders → orders_v2 migration",
    description: "Plan Claude follows once the settings are in.",
    state: {
      items: [
        { id: "plan", label: "Generate migration plan", done: false },
        { id: "dry", label: "Dry run on a snapshot", done: false },
        { id: "run", label: "Run the migration", done: false, gate: "human" },
        { id: "verify", label: "Verify row counts and checksums", done: false },
      ],
    },
  });
  await b.ask({
    kind: "input",
    title: "Migration settings",
    message: "I need these before I generate the plan.",
    fields: [
      { name: "target", label: "Target database", type: "select", options: ["staging", "production"], required: true },
      { name: "batchSize", label: "Batch size (rows)", type: "number", placeholder: "25000" },
      { name: "window", label: "Run window", type: "select", options: ["Now", "Tonight 02:00–04:00", "Saturday 01:00–05:00"] },
      { name: "dryRun", label: "Dry run first", type: "checkbox" },
      { name: "notify", label: "Notify channel", type: "text", placeholder: "#db-ops" },
    ],
  });
}

// ── 4. A long job the agent reports on live, with Pause/Stop that reach the agent ──
const backfill = await board("Backfill");
{
  const b = on(backfill.id);
  const rate = [3100, 3350, 3480, 3420, 3600, 3710, 3650, 3820, 3900, 3780, 3950, 4020, 3980, 4100, 4060, 4150, 4120, 4210, 4180, 4240];
  await b.channel("backfill", {
    name: "orders_2025 → warehouse",
    status: "running",
    total: 4_800_000,
    done: 2_916_400,
    rate,
    errors: 0,
    lastBatch: "batch 117 · 25,000 rows",
  });
  await b.app("Backfill progress", "backfill-monitor.jsx", { description: "Reads the backfill channel Claude writes while the job runs.", width: 560 });
}

console.log(`Demo boards ready on ${BASE}: ${[release, sales, migration, backfill].map((x) => `${x.name} (${x.id})`).join(", ")}`);
