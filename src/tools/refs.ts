import { Host } from "../host/Host";
import { describeRef, FileRef, parseRefs, rangeFor } from "../protocol/refs";
import { numberLines } from "./fs";

export interface ResolvedRef {
  label: string;
  path: string;
  content: string;
  ok: boolean;
  lines?: string;
}

export interface EditorContext {
  path?: string;
  selection?: string;
  selectionRange?: string;
}

const MAX_CHARS = 40_000;

/** Načte obsah pro odkazy `#soubor`, `#soubor:od-do`, `#file` a `#selection`. */
export async function resolveRefs(host: Host, input: string, editor?: EditorContext): Promise<ResolvedRef[]> {
  const refs = parseRefs(input);
  if (!refs.length) return [];
  const out: ResolvedRef[] = [];
  let budget = MAX_CHARS;
  for (const ref of refs) {
    const resolved = await resolveOne(host, ref, editor, budget);
    if (!resolved) continue;
    budget -= resolved.content.length;
    out.push(resolved);
    if (budget <= 0) break;
  }
  return out;
}

async function resolveOne(host: Host, ref: FileRef, editor: EditorContext | undefined, budget: number): Promise<ResolvedRef | undefined> {
  const label = describeRef(ref);
  if (ref.kind === "selection") {
    if (!editor?.selection) return { label, path: editor?.path ?? "", ok: false, content: "(v editoru není nic vybráno)" };
    return { label, path: editor.path ?? "", ok: true, lines: editor.selectionRange, content: editor.selection };
  }
  const path = ref.kind === "file" ? editor?.path : ref.path;
  if (!path) return { label, path: "", ok: false, content: "(v editoru není otevřený žádný soubor z tohoto projektu)" };
  try {
    host.assertInside(path);
  } catch {
    return { label, path, ok: false, content: "(cesta leží mimo workspace)" };
  }
  if (!(await host.exists(path))) {
    const base = path.split("/").pop() ?? path;
    const hits = (await host.listFiles("**/" + base, 20)).slice(0, 5);
    return { label, path, ok: false, content: `(soubor neexistuje)${hits.length ? " Podobné: " + hits.join(", ") : ""}` };
  }
  let text: string;
  try {
    text = await host.readFile(path);
  } catch (e) {
    return { label, path, ok: false, content: `(soubor nelze přečíst: ${(e as Error).message})` };
  }
  const all = text.split("\n");
  const range = rangeFor(ref, all.length);
  const from = range?.from ?? 1;
  const to = range?.to ?? all.length;
  let body = numberLines(all.slice(from - 1, to), from);
  if (body.length > budget) body = body.slice(0, Math.max(0, budget)) + "\n… (zkráceno, vyžádej si zbytek přes <read>)";
  return { label, path, ok: true, lines: range ? `${from}-${to}` : `1-${all.length}`, content: body };
}

export function renderRefs(refs: ResolvedRef[]): string {
  if (!refs.length) return "";
  const parts = ["## Files the user referenced (with #); read them before asking for more", ""];
  for (const r of refs) {
    parts.push(`### ${r.label}${r.path && r.label !== r.path ? ` (${r.path}${r.lines ? ":" + r.lines : ""})` : ""}`, "", r.content, "");
  }
  return parts.join("\n");
}
