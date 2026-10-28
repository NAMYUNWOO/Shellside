// Component library: tools saved for reuse, by the person or the agent. Lives outside any one board.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_WIDTH, resetState, type Actor, type Tool, type ToolKind } from "../shared/catalog.ts";
import { BoardError } from "./board.ts";

export interface Template {
  id: string;
  name: string;
  description: string;
  kind: ToolKind;
  props: any;
  state: any;
  width: number;
  createdBy: Actor;
  createdAt: string;
  fromToolId?: string;
  uses: number;
}

export class Library {
  private items = new Map<string, Template>();
  private listeners = new Set<(items: Template[]) => void>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private file: string) {
    if (!existsSync(file)) return;
    try {
      for (const t of JSON.parse(readFileSync(file, "utf8")).items ?? []) this.items.set(t.id, t);
    } catch (err) {
      console.error(`[library] could not read ${file}:`, err);
    }
  }

  list(query?: string): Template[] {
    const all = [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const q = query?.trim().toLowerCase();
    if (!q) return all;
    return all.filter((t) => `${t.name} ${t.description} ${t.kind}`.toLowerCase().includes(q));
  }

  get(id: string): Template {
    const t = this.items.get(id);
    if (!t) throw new BoardError(`library item "${id}" not found. Use library_list to see saved components.`, 404);
    return t;
  }

  /** Save a tool as a reusable component. Without includeState, its progress/data is reset but its structure kept. */
  save(actor: Actor, tool: Tool, opts: { name?: string; description?: string; includeState?: boolean }): Template {
    const { sourcePath: _drop, ...props } = tool.props ?? {}; // a template carries its own source, not a path
    const t: Template = {
      id: `tpl_${randomUUID().slice(0, 8)}`,
      name: opts.name?.trim() || tool.title,
      description: (opts.description ?? tool.description ?? "").trim(),
      kind: tool.kind,
      props: structuredClone(props),
      state: structuredClone(opts.includeState ? tool.state : resetState(tool.kind, tool.state)),
      width: tool.layout?.w ?? DEFAULT_WIDTH[tool.kind] ?? 400,
      createdBy: actor,
      createdAt: new Date().toISOString(),
      fromToolId: tool.id,
      uses: 0,
    };
    this.items.set(t.id, t);
    this.changed();
    return t;
  }

  update(id: string, patch: { name?: string; description?: string }) {
    const t = this.get(id);
    const next = { ...t, name: patch.name?.trim() || t.name, description: patch.description?.trim() ?? t.description };
    this.items.set(id, next);
    this.changed();
    return next;
  }

  remove(id: string) {
    this.get(id);
    this.items.delete(id);
    this.changed();
  }

  markUsed(id: string) {
    const t = this.get(id);
    this.items.set(id, { ...t, uses: t.uses + 1 });
    this.changed();
  }

  subscribe(fn: (items: Template[]) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    const items = this.list();
    for (const fn of this.listeners) fn(items);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ items: this.list() }, null, 2));
      renameSync(`${this.file}.tmp`, this.file);
    }, 200);
  }
}
