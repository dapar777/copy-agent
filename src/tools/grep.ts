import { Host } from "../host/Host";
import { ActionResult } from "../protocol/schema";

const MAX_FILE_CHARS = 512 * 1024;
const MAX_MATCHES = 150;
const CONCURRENCY = 16;

/** Grep nad soubory workspace; soubory se čtou souběžně (v dávkách), výstup v pořadí cest. */
export async function toolGrep(host: Host, attrs: Record<string, string>): Promise<ActionResult> {
  let re: RegExp;
  try {
    re = new RegExp(attrs.pattern, "i");
  } catch (e) {
    return { tool: "grep", attrs, status: "error", output: `Invalid regex: ${(e as Error).message}` };
  }
  const context = Math.min(5, Math.max(0, Number(attrs.context) || 0));
  const files = await host.listFiles(attrs.glob || "**/*", 5000);
  const out: string[] = [];
  let matches = 0;
  let scanned = 0;
  for (let i = 0; i < files.length && matches < MAX_MATCHES; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const texts = await Promise.all(
      batch.map(async (f) => {
        try {
          return await host.readFile(f);
        } catch {
          return undefined;
        }
      }),
    );
    for (let k = 0; k < batch.length && matches < MAX_MATCHES; k++) {
      const text = texts[k];
      const f = batch[k];
      if (text === undefined || text.length > MAX_FILE_CHARS || text.includes("\u0000")) continue;
      scanned++;
      const lines = text.split("\n");
      const hits: number[] = [];
      for (let n = 0; n < lines.length && matches < MAX_MATCHES; n++) {
        if (!re.test(lines[n])) continue;
        matches++;
        hits.push(n);
      }
      if (!context) {
        for (const n of hits) out.push(`${f}:${n + 1}: ${lines[n].slice(0, 300)}`);
        continue;
      }
      const hitSet = new Set(hits);
      let printedTo = -1;
      for (const n of hits) {
        const from = Math.max(0, n - context, printedTo + 1);
        const to = Math.min(lines.length - 1, n + context);
        if (from > to) continue;
        if (printedTo >= 0 && from > printedTo + 1) out.push("--");
        for (let q = from; q <= to; q++) out.push(`${f}:${q + 1}${hitSet.has(q) ? ":" : "-"} ${lines[q].slice(0, 300)}`);
        printedTo = to;
      }
      if (hits.length) out.push("--");
    }
  }
  const capped = matches >= MAX_MATCHES ? `\n… (capped at ${MAX_MATCHES} matches; narrow the pattern or glob)` : "";
  return { tool: "grep", attrs, status: "ok", output: (out.join("\n") || "(no matches)") + capped, meta: { matches, files: scanned } };
}
