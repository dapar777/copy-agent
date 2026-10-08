/**
 * Odkazy na soubory ve vstupu uživatele (jako #file v GitHub Copilotu):
 *   #src/app.ts            celý soubor
 *   #src/app.ts:40-80      jen řádky 40-80
 *   #src/app.ts:120        jeden řádek s okolím
 *   #selection             aktuální výběr v editoru
 *   #file                  aktivní soubor v editoru
 */

export interface FileRef {
  raw: string;
  path: string;
  from?: number;
  to?: number;
  kind: "path" | "file" | "selection";
}

export const LINE_CONTEXT = 20;

const REF = /#([A-Za-z0-9._\-/\\]+)(?::(\d+)(?:\s*-\s*(\d+))?)?/g;

export function parseRefs(input: string): FileRef[] {
  const out: FileRef[] = [];
  const seen = new Set<string>();
  for (const m of input.matchAll(REF)) {
    const token = m[1];
    const lower = token.toLowerCase();
    const kind: FileRef["kind"] = lower === "file" ? "file" : lower === "selection" || lower === "sel" ? "selection" : "path";
    const from = m[2] ? Number(m[2]) : undefined;
    const to = m[3] ? Number(m[3]) : from;
    const key = `${kind}:${kind === "path" ? token : ""}:${from ?? ""}:${to ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ref: FileRef = { raw: m[0], path: kind === "path" ? token.replace(/\\/g, "/") : "", kind };
    if (from !== undefined) {
      ref.from = from;
      ref.to = to;
    }
    out.push(ref);
  }
  return out;
}

export function rangeFor(ref: FileRef, totalLines: number): { from: number; to: number } | undefined {
  if (ref.from === undefined) return undefined;
  const single = ref.to === undefined || ref.to === ref.from;
  const from = single ? Math.max(1, ref.from - LINE_CONTEXT) : Math.max(1, ref.from);
  const to = Math.min(totalLines, single ? ref.from + LINE_CONTEXT : Math.max(ref.from, ref.to ?? ref.from));
  return { from, to };
}

export function describeRef(ref: FileRef): string {
  if (ref.kind === "file") return "aktivní soubor";
  if (ref.kind === "selection") return "výběr v editoru";
  const range = ref.from !== undefined ? `:${ref.from}${ref.to !== undefined && ref.to !== ref.from ? "-" + ref.to : ""}` : "";
  return ref.path + range;
}
