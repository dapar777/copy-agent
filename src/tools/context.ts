import { Host } from "../host/Host";
import { parseRefs } from "../protocol/refs";
import { outline } from "../protocol/section";
import { numberLines } from "./fs";

/**
 * Automatický kontext: podle zadání (cesty, identifikátory) a aktivního editoru vybere soubory,
 * které model nejspíš potřebuje, a přiloží je už k úvodnímu promptu. Ušetří to průzkumné kolo:
 * s dobrým kontextem model často edituje hned v první odpovědi.
 */

export interface AutoContextOptions {
  /** celkový rozpočet ve znacích */
  maxChars: number;
  /** nejvýš kolik souborů */
  maxFiles?: number;
  /** soubory, které už jsou v promptu jinak (#odkazy): přeskočí se */
  exclude?: string[];
}

export interface AutoPick {
  path: string;
  /** proč byl soubor vybrán */
  reason: string;
  /** celý soubor, nebo okna kolem shod */
  mode: "full" | "excerpt" | "outline";
  content: string;
}

const STOP = new Set(
  (
    "the and for with that this from into when then than have will would could should about which where there their they them some more most such only also just like make made " +
    "přidej přidat uprav upravit oprav opravit změň změnit vytvoř vytvořit smaž smazat použij použít aby když jako tak jen také ještě které který která kde proč jak soubor souboru funkce metoda " +
    "file files function method class test tests add fix change update create remove delete implement write read use using new old code"
  ).split(" "),
);

/** Kandidátní identifikátory ze zadání: CamelCase, snake_case, tečkové cesty, slova s číslicemi. */
export function identifiersFrom(text: string): string[] {
  const out = new Map<string, number>();
  for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g)) {
    const w = m[0];
    const lower = w.toLowerCase();
    if (STOP.has(lower) || w.length < 4) continue;
    const identish = /[A-Z]/.test(w.slice(1)) || w.includes("_") || /\d/.test(w) || w.length >= 9;
    if (!identish) continue;
    out.set(w, (out.get(w) ?? 0) + 1);
  }
  return [...out.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([w]) => w)
    .slice(0, 8);
}

/** Cesty zmíněné v zadání (i bez #), které existují. */
export async function pathsFrom(host: Host, text: string, files: string[]): Promise<string[]> {
  const set = new Set(files);
  const byBase = new Map<string, string[]>();
  for (const f of files) {
    const b = f.split("/").pop() ?? f;
    byBase.set(b, [...(byBase.get(b) ?? []), f]);
  }
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w/#])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8})(?![\w/])/g)) {
    const p = m[1].replace(/^\.\//, "");
    if (set.has(p)) {
      if (!out.includes(p)) out.push(p);
      continue;
    }
    // jen název souboru: když je v projektu jednoznačný, bereme ho
    const hits = byBase.get(p) ?? [];
    if (hits.length === 1 && !out.includes(hits[0])) out.push(hits[0]);
  }
  void host;
  return out.slice(0, 10);
}

const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|cpp|cc|c|h|hpp|php|swift|scala|sql|sh|ps1|bat|cmd|md|markdown|txt|json|jsonc|yaml|yml|toml|xml|html|css|scss|less|vue|svelte|ini|cfg|conf|env|csv|rst|tex)$/i;

export async function collectAutoContext(host: Host, task: string, active: { path: string } | undefined, opts: AutoContextOptions): Promise<AutoPick[]> {
  const files = (await host.listFiles("**/*", 6000)).filter((f) => TEXT_EXT.test(f));
  const exclude = new Set([...(opts.exclude ?? []), ...parseRefs(task).map((r) => r.path)]);
  const maxFiles = opts.maxFiles ?? 6;
  const picks: { path: string; score: number; reason: string; hits: number[] }[] = [];
  const add = (p: string, score: number, reason: string, hits: number[] = []) => {
    if (exclude.has(p) || !files.includes(p)) return;
    const ex = picks.find((x) => x.path === p);
    if (ex) {
      ex.score += score;
      ex.hits.push(...hits);
      if (!ex.reason.includes(reason)) ex.reason += `, ${reason}`;
    } else picks.push({ path: p, score, reason, hits });
  };
  for (const p of await pathsFrom(host, task, files)) add(p, 100, "mentioned in the task");
  if (active?.path && files.includes(active.path)) add(active.path, 40, "open in the editor");

  const idents = identifiersFrom(task);
  if (idents.length) {
    const res = idents.map((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    // název souboru odpovídá identifikátoru → silný signál
    for (const f of files) {
      const base = (f.split("/").pop() ?? f).replace(/\.[^.]+$/, "").toLowerCase();
      for (const w of idents) if (base === w.toLowerCase() || base.replace(/[-_]/g, "") === w.toLowerCase().replace(/[-_]/g, "")) add(f, 60, `name matches "${w}"`);
    }
    // obsah: skenujeme po dávkách, soubory do 200 kB
    const scan = files.slice(0, 2500);
    for (let i = 0; i < scan.length; i += 24) {
      const batch = scan.slice(i, i + 24);
      const texts = await Promise.all(batch.map((f) => host.readFile(f).catch(() => "")));
      batch.forEach((f, k) => {
        const text = texts[k];
        if (!text || text.length > 200_000 || text.includes("\u0000")) return;
        const lines = text.split("\n");
        let score = 0;
        const hits: number[] = [];
        const matched: string[] = [];
        res.forEach((re, j) => {
          let n = 0;
          for (let l = 0; l < lines.length && n < 20; l++) {
            if (re.test(lines[l])) {
              n++;
              if (hits.length < 40) hits.push(l);
            }
          }
          if (n) {
            score += 10 + Math.min(n, 10);
            matched.push(idents[j]);
          }
        });
        if (score) add(f, score, `mentions ${matched.map((w) => `"${w}"`).join(", ")}`, hits);
      });
    }
  }
  picks.sort((a, b) => b.score - a.score);
  const out: AutoPick[] = [];
  let budget = opts.maxChars;
  for (const p of picks.slice(0, maxFiles * 2)) {
    if (out.length >= maxFiles || budget < 800) break;
    let text: string;
    try {
      text = await host.readFile(p.path);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const perFile = Math.min(budget, Math.max(1500, Math.floor(opts.maxChars / 2)));
    if (text.length <= perFile && lines.length <= 300) {
      const content = numberLines(lines, 1);
      out.push({ path: p.path, reason: p.reason, mode: "full", content });
      budget -= content.length;
      continue;
    }
    // velký soubor: osnova + okna kolem shod
    const o = outline(text, p.path, 40);
    const windows = mergeWindows([...new Set(p.hits)].sort((a, b) => a - b), 12, lines.length);
    const pieces: string[] = [];
    let used = o.length;
    for (const w of windows) {
      const chunk = numberLines(lines.slice(w.from, w.to + 1), w.from + 1);
      if (used + chunk.length > perFile) break;
      pieces.push(chunk);
      used += chunk.length + 8;
    }
    const content = [o ? `Outline (Lnn = line):\n${o}` : "", ...pieces.map((c) => `…\n${c}`)].filter(Boolean).join("\n") + (lines.length > 300 ? `\n… (${lines.length} lines in total; use <read lines="A-B"> for more)` : "");
    out.push({ path: p.path, reason: p.reason, mode: pieces.length ? "excerpt" : "outline", content });
    budget -= content.length;
  }
  return out;
}

function mergeWindows(hits: number[], radius: number, total: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const h of hits) {
    const from = Math.max(0, h - radius);
    const to = Math.min(total - 1, h + radius);
    const last = out[out.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else out.push({ from, to });
  }
  return out.slice(0, 6);
}

export function renderAutoContext(picks: AutoPick[]): string {
  if (!picks.length) return "";
  const parts = ["## Likely relevant files (auto-selected by the tool from the task; no <read> needed for these)", ""];
  for (const p of picks) {
    parts.push(`### ${p.path} (${p.reason}${p.mode === "full" ? ", complete" : p.mode === "excerpt" ? ", excerpts" : ", outline"})`, "", p.content, "");
  }
  return parts.join("\n");
}
