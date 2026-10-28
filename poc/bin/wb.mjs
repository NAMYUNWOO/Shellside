#!/usr/bin/env node
// wb: the board from the shell, for agents without MCP and for scripts. Acts as the agent.
import path from "node:path";

const BASE = process.env.WB_URL ?? "http://127.0.0.1:4100";
// Each WorkBoard terminal sets WB_BOARD to its own board; --board overrides.
const boardFlag = process.argv.indexOf("--board");
const BOARD = boardFlag > 0 ? process.argv.splice(boardFlag, 2)[1] : process.env.WB_BOARD;

const HELP = `wb — WorkBoard from the terminal (acts as the agent)

  wb ls                                   list tools and pending asks
  wb get <toolId>                         print a tool (props, state, version)
  wb catalog                              tool kinds and state shapes
  wb create <kind> <title> [--desc d] [--props json] [--state json]
  wb set <toolId> <path> <json-value> [--base N]     replace one value, e.g. wb set t1 /items/0/done true
  wb add <toolId> <path> <json-value> [--base N]     add a value, e.g. wb add t1 /rows/- '{"id":"r1"}'
  wb patch <toolId> '<json-patch>' [--base N]
  wb ask approval <title> [--message m] [--tool id --item id] [--timeout s]
  wb ask input <title> --fields '<json>' [--message m] [--timeout s]
  wb wait [--timeout s]                   wait for messages / edits / stop from the person
  (all commands act on the board in $WB_BOARD; add --board <id> to pick another)

  apps (free-form React UI; rules: wb catalog)
  wb app create <title> <file.jsx> [--desc d] [--state json]
  wb app update <toolId> [file.jsx]       reload code (default: the file it was created from)
  wb snapshot <toolId>                    text, fields and buttons the app shows now
  wb invoke <toolId> <action> [json-args] call an action the app registered
  wb logs <toolId> [--clear]              runtime errors and console output

  channels (live values every app on the board shares; apps use useChannel)
  wb ch ls                                list channels
  wb ch get <name>                        print a channel's value and version
  wb ch set <name> <json-value> [--base N]   set it (apps update at once)
  wb ch rm <name>                         delete it

Exit codes: 0 ok, 1 error, 2 rejected by the person, 3 still pending (timeout).`;

function parse(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) opts[a.slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "true" : argv[++i];
    else pos.push(a);
  }
  return { pos, opts };
}

function json(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    // Bare words are strings: `wb set t1 /items/0/note done` → "done"
    if (what === "value") return text;
    die(`${what} is not valid JSON: ${text}`);
  }
}

function die(msg, code = 1) {
  console.error(`wb: ${msg}`);
  process.exit(code);
}

async function call(method, path, body) {
  if (!BOARD) die("WB_BOARD is not set. Run wb inside a WorkBoard terminal, or pass --board <boardId>.");
  path = path.replace(/^\/api\//, `/api/b/${BOARD}/`);
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { "content-type": "application/json", "x-wb-actor": "agent", "x-wb-client": "cli" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    die(`cannot reach the board at ${BASE} (${err.cause?.code ?? err.message}). Is the WorkBoard server running?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(data.error ?? `HTTP ${res.status}`);
  return data;
}

const out = (v) => console.log(JSON.stringify(v, null, 2));
const num = (v) => (v === undefined ? undefined : Number(v));

const { pos, opts } = parse(process.argv.slice(2));
const [cmd, ...args] = pos;

switch (cmd) {
  case "ls": {
    const b = await call("GET", "/api/board");
    for (const t of b.tools) console.log(`${t.id}\t${t.kind}\tv${t.version}\t${t.title}`);
    if (b.asks.length) console.log(`\npending asks:\n` + b.asks.map((a) => `${a.id}\t${a.kind}\t${a.title}`).join("\n"));
    break;
  }
  case "get":
    if (!args[0]) die("usage: wb get <toolId>");
    out(await call("GET", `/api/tools/${args[0]}`));
    break;
  case "catalog":
    console.log((await call("GET", "/api/catalog")).doc);
    break;
  case "create": {
    const [kind, ...title] = args;
    if (!kind || !title.length) die("usage: wb create <kind> <title> [--props json] [--state json]");
    out(
      await call("POST", "/api/tools", {
        kind,
        title: title.join(" "),
        description: opts.desc,
        props: opts.props ? json(opts.props, "--props") : undefined,
        state: opts.state ? json(opts.state, "--state") : undefined,
      }),
    );
    break;
  }
  case "set":
  case "add": {
    const [toolId, path, value] = args;
    if (!toolId || !path || value === undefined) die(`usage: wb ${cmd} <toolId> <path> <json-value>`);
    const op = cmd === "set" ? "replace" : "add";
    const t = await call("POST", `/api/tools/${toolId}/patch`, { patch: [{ op, path, value: json(value, "value") }], baseVersion: num(opts.base) });
    console.log(`ok · ${t.id} v${t.version}`);
    break;
  }
  case "patch": {
    const [toolId, patch] = args;
    if (!toolId || !patch) die("usage: wb patch <toolId> '<json-patch>'");
    const t = await call("POST", `/api/tools/${toolId}/patch`, { patch: json(patch, "patch"), baseVersion: num(opts.base) });
    console.log(`ok · ${t.id} v${t.version}`);
    break;
  }
  case "ask": {
    const [kind, ...title] = args;
    if (!["approval", "input"].includes(kind) || !title.length) die("usage: wb ask approval|input <title> ...");
    const timeout = opts.timeout ?? "120";
    let a = await call("POST", `/api/asks?wait=${timeout}`, {
      kind,
      title: title.join(" "),
      message: opts.message,
      toolId: opts.tool,
      itemId: opts.item,
      fields: opts.fields ? json(opts.fields, "--fields") : undefined,
    });
    out(a);
    if (a.status === "pending") process.exit(3);
    if (a.status === "answered" && kind === "approval" && !a.answer?.approved) process.exit(2);
    break;
  }
  case "app": {
    const [sub, a, b] = args;
    if (sub === "create") {
      if (!a || !b) die("usage: wb app create <title> <file.jsx>");
      // Files are relative to where you run wb, not to the board's folder.
      const t = await call("POST", "/api/apps", { title: a, sourcePath: path.resolve(b), description: opts.desc, state: opts.state ? json(opts.state, "--state") : undefined });
      console.log(`ok · ${t.id} v${t.version} (from ${t.props.sourcePath}). Check it: wb logs ${t.id}; wb snapshot ${t.id}`);
    } else if (sub === "update") {
      if (!a) die("usage: wb app update <toolId> [file.jsx]");
      const t = await call("PATCH", `/api/apps/${a}`, { sourcePath: b ? path.resolve(b) : undefined });
      console.log(`ok · ${t.id} v${t.version} (from ${t.props.sourcePath ?? "inline source"})`);
    } else die("usage: wb app create|update ...");
    break;
  }
  case "ch":
  case "channel": {
    const [sub, name, value] = args;
    const at = (n) => `/api/channels/${encodeURIComponent(n)}`;
    if (sub === "ls" || sub === undefined) {
      const r = await call("GET", "/api/channels");
      if (!r.channels.length) console.log("(no channels)");
      for (const c of r.channels) console.log(`${c.name}\tv${c.version}\t${c.updatedBy}${c.toolId ? ` (${c.toolId})` : ""}\t${JSON.stringify(c.value).slice(0, 80)}`);
    } else if (sub === "get") {
      if (!name) die("usage: wb ch get <name>");
      out(await call("GET", at(name)));
    } else if (sub === "set") {
      if (!name || value === undefined) die("usage: wb ch set <name> <json-value>");
      const c = await call("PUT", at(name), { value: json(value, "value"), baseVersion: num(opts.base) });
      console.log(`ok · ${c.name} v${c.version}`);
    } else if (sub === "rm") {
      if (!name) die("usage: wb ch rm <name>");
      await call("DELETE", at(name));
      console.log(`ok · deleted ${name}`);
    } else die("usage: wb ch ls|get|set|rm ...");
    break;
  }
  case "snapshot":
    if (!args[0]) die("usage: wb snapshot <toolId>");
    out(await call("GET", `/api/apps/${args[0]}/snapshot`));
    break;
  case "invoke": {
    const [toolId, action, a] = args;
    if (!toolId || !action) die("usage: wb invoke <toolId> <action> [json-args]");
    out(await call("POST", `/api/apps/${toolId}/invoke`, { action, args: a === undefined ? undefined : json(a, "value") }));
    break;
  }
  case "logs": {
    if (!args[0]) die("usage: wb logs <toolId> [--clear]");
    const r = await call("GET", `/api/apps/${args[0]}/logs${opts.clear ? "?clear=1" : ""}`);
    if (!r.logs.length) console.log("(no logs)");
    for (const l of r.logs) console.log(`${l.at}\t${l.level}\t${l.message}`);
    break;
  }
  case "hook": {
    if (!BOARD) process.exit(0);
    // Called by Claude Code hooks (see the board workspace's .claude/settings.json). Reports Claude's state to the
    // board and prints NOTHING: some hooks' stdout is added to Claude's context. Never fails Claude's turn.
    const event = args[0] ?? "unknown";
    let input = "";
    try {
      for await (const chunk of process.stdin) input += chunk;
    } catch {}
    let data = {};
    try {
      data = JSON.parse(input || "{}");
    } catch {}
    try {
      await fetch(`${BASE}/api/b/${BOARD}/agent/hook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-wb-actor": "agent" },
        body: JSON.stringify({ event, notificationType: data.notification_type, message: data.message, sessionId: data.session_id, tool: data.tool_name }),
        signal: AbortSignal.timeout(1500),
      });
    } catch {}
    process.exit(0);
  }
  case "wait": {
    const r = await call("GET", `/api/events/wait?timeout=${opts.timeout ?? 60}`);
    if (!r.events.length) console.log("(no events)");
    for (const e of r.events) console.log(`${e.at}\t${e.type}\t${e.summary}`);
    break;
  }
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    die(`unknown command "${cmd}". Run: wb help`);
}
