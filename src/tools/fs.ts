import * as path from "path";
import { Host } from "../host/Host";
import { ActionResult } from "../protocol/schema";
import { outline } from "../protocol/section";
import { describeEncodingEn, isPlainUtf8Lf } from "./encoding";

/** Nad tolik řádků vrací <read> bez lines= osnovu místo obsahu. */
export const READ_OUTLINE_ABOVE = 300;

/** Předrenderovaný strom pro úvodní prompt: soubory kořene + adresáře s počty, kompaktně. */
export async function renderTree(host: Host, maxEntries: number): Promise<string> {
  const files = await host.listFiles("**/*", 5000);
  if (files.length <= maxEntries) return files.join("\n") || "(empty workspace)";
  const dirs = new Map<string, number>();
  for (const f of files) {
    const d = path.posix.dirname(f);
    dirs.set(d, (dirs.get(d) ?? 0) + 1);
  }
  const rootFiles = files.filter((f) => !f.includes("/"));
  const lines: string[] = [...rootFiles];
  // adresáře do hloubky 2 s počty souborů (hlubší se sčítají do rodiče)
  const agg = new Map<string, number>();
  for (const [d, n] of dirs) {
    if (d === ".") continue;
    const key = d.split("/").slice(0, 2).join("/");
    agg.set(key, (agg.get(key) ?? 0) + n);
  }
  const sorted = [...agg.entries()].sort();
  for (const [d, n] of sorted) {
    if (lines.length >= maxEntries) {
      lines.push(`… (${sorted.length - (lines.length - rootFiles.length)} more directories; use <ls>/<glob> to explore)`);
      break;
    }
    lines.push(`${d}/ (${n} files)`);
  }
  return `${files.length} files total; directories with file counts:\n` + lines.join("\n");
}

/** Očíslované řádky `  12| text`. */
export function numberLines(lines: string[], from: number): string {
  const width = String(from + lines.length - 1).length;
  return lines.map((l, i) => `${String(from + i).padStart(width)}| ${l}`).join("\n");
}

export async function toolRead(host: Host, attrs: Record<string, string>): Promise<ActionResult> {
  if (!(await host.exists(attrs.path))) {
    const base = attrs.path.split("/").pop() ?? attrs.path;
    const similar = base ? (await host.listFiles(`**/${base}`, 5)).slice(0, 5) : [];
    return { tool: "read", attrs, status: "error", output: `File not found: ${attrs.path}${similar.length ? `. Similar: ${similar.join(", ")}` : ""}` };
  }
  const text = await host.readFile(attrs.path);
  const lines = text.split("\n");
  let from = 1;
  let to = lines.length;
  if (attrs.lines) {
    const m = attrs.lines.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) return { tool: "read", attrs, status: "error", output: `Invalid lines="${attrs.lines}", expected "A-B".` };
    from = Math.max(1, Number(m[1]));
    to = Math.min(lines.length, Number(m[2]));
  } else if (lines.length > READ_OUTLINE_ABOVE) {
    const o = outline(text, attrs.path);
    const isDoc = /\.(md|markdown|txt)$/i.test(attrs.path);
    return {
      tool: "read",
      attrs,
      status: "error",
      output:
        `File has ${lines.length} lines; request ranges with lines="A-B" (several ranges in one turn are fine)` +
        (isDoc ? ', or replace a whole section with <edit path="…" section="## Heading">' : "") +
        "." +
        (o ? `\nOutline (Lnn = line number):\n${o}` : ""),
      meta: { totalLines: lines.length },
    };
  }
  const out = numberLines(lines.slice(from - 1, to), from);
  const enc = await host.fileEncoding(attrs.path);
  const meta: Record<string, string | number> = { lines: `${from}-${to}/${lines.length}` };
  if (!isPlainUtf8Lf(enc)) meta.encoding = describeEncodingEn(enc);
  return { tool: "read", attrs, status: "ok", output: out, meta };
}

export async function toolLs(host: Host, attrs: Record<string, string>): Promise<ActionResult> {
  const rel = attrs.path && attrs.path !== "." ? attrs.path.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  const depth = Math.min(4, Math.max(1, Number(attrs.depth) || 1));
  if (rel && !(await host.exists(rel))) return { tool: "ls", attrs, status: "error", output: `Directory not found: ${attrs.path}` };
  const files = await host.listFiles(rel ? `${rel}/**/*` : "**/*", 5000);
  const prefixLen = rel ? rel.length + 1 : 0;
  const entries = new Set<string>();
  for (const f of files) {
    const parts = f.slice(prefixLen).split("/");
    for (let d = 1; d <= Math.min(depth, parts.length); d++) {
      const p = parts.slice(0, d).join("/");
      entries.add(d < parts.length ? p + "/" : p);
    }
  }
  const list = [...entries].sort();
  const shown = list.slice(0, 400);
  const more = list.length > shown.length ? `\n… (${list.length - shown.length} more entries)` : "";
  return { tool: "ls", attrs, status: "ok", output: (shown.join("\n") || "(empty)") + more, meta: { entries: list.length } };
}

export async function toolGlob(host: Host, attrs: Record<string, string>): Promise<ActionResult> {
  const files = await host.listFiles(attrs.pattern, 400);
  return { tool: "glob", attrs, status: "ok", output: files.join("\n") || "(no matches)", meta: { matches: files.length } };
}
