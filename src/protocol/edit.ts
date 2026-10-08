/**
 * Čistá logika SEARCH/REPLACE úprav (bez závislosti na vscode), aby šla testovat.
 * Hledání: přesně → bílé znaky → sjednocené uvozovky/pomlčky → odstavec po slovech.
 * Víc než jedna shoda = chyba (nikdy se tiše nepřepíše první výskyt).
 */

export interface Hunk {
  search: string;
  replace: string;
}

export interface ApplyResult {
  content: string;
  applied: number;
  failures: { hunk: number; reason: string }[];
  /** co agent u úspěšných hunků sám dorovnal (řádkové prefixy, uvozovky, zalomení) */
  notes: string[];
}

const SEARCH_LINE = /^<{5,}\s*SEARCH\b/;
const REPLACE_LINE = /^>{5,}\s*REPLACE\b/;
const DIVIDER_LINE = /^={5,}\s*$/;

/**
 * Rozebere hunky po řádcích. Oddělovač je řádek `=======`; když je jich mezi SEARCH a REPLACE
 * víc (markdown se setextovým podtržením), bere se ten s přesně sedmi znaky, jinak poslední.
 */
export function parseHunks(body: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    if (!SEARCH_LINE.test(lines[i])) {
      i++;
      continue;
    }
    const start = i + 1;
    let end = start;
    while (end < lines.length && !REPLACE_LINE.test(lines[end])) end++;
    const inner = lines.slice(start, end);
    const dividers = inner.map((l, k) => (DIVIDER_LINE.test(l) ? k : -1)).filter((k) => k >= 0);
    if (dividers.length) {
      const exact = dividers.filter((k) => inner[k].trim() === "=======");
      const d = exact.length === 1 ? exact[0] : exact.length > 1 ? exact[exact.length - 1] : dividers[dividers.length - 1];
      hunks.push({ search: inner.slice(0, d).join("\n"), replace: inner.slice(d + 1).join("\n") });
    }
    i = end + 1;
  }
  return hunks;
}

function normalizeLine(l: string): string {
  return l.replace(/\s+/g, " ").trim();
}

/** Typografické uvozovky a pomlčky sjednocené, aby šel najít text, který chat „vylepšil“. */
function foldPunct(l: string): string {
  return normalizeLine(l).replace(/[“”„″]/g, '"').replace(/[‘’‚′]/g, "'").replace(/[–—]/g, "-");
}

/** Prefix čísla řádku z <read> („26| “), který model omylem nechal v SEARCH. */
const LINE_PREFIX = /^\s*\d+\|\s?/;

interface Loc {
  start: number;
  end: number;
  mode: "exact" | "ws" | "punct" | "flow";
}

function lineOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (const l of lines) {
    offsets.push(acc);
    acc += l.length + 1;
  }
  return offsets;
}

function trimBlankEdges(arr: string[]): string[] {
  const out = [...arr];
  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

function lineMatches(lines: string[], search: string, norm: (l: string) => string): number[] {
  const sLines = trimBlankEdges(search.split("\n").map(norm));
  if (!sLines.length) return [];
  const nLines = lines.map(norm);
  const hits: number[] = [];
  for (let i = 0; i + sLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < sLines.length; j++) {
      if (nLines[i + j] !== sLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** Odstavec přeformátovaný na jiné řádky: shoda po slovech, výsledek se roztáhne na celé řádky. */
function flowMatch(lines: string[], search: string): { from: number; to: number }[] {
  const words = (s: string) => foldPunct(s).split(" ").filter(Boolean);
  const sw = words(search.replace(/\n/g, " "));
  if (sw.length < 4) return [];
  const map: { word: string; line: number }[] = [];
  lines.forEach((l, i) => words(l).forEach((w) => map.push({ word: w, line: i })));
  const hits: { from: number; to: number }[] = [];
  for (let i = 0; i + sw.length <= map.length; i++) {
    let ok = true;
    for (let j = 0; j < sw.length; j++) {
      if (map[i + j].word !== sw[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const from = map[i].line;
    const to = map[i + sw.length - 1].line;
    const startsLine = i === 0 || map[i - 1].line !== from;
    const endsLine = i + sw.length === map.length || map[i + sw.length].line !== to;
    if (startsLine && endsLine) hits.push({ from, to });
  }
  return hits;
}

interface Found {
  loc: Loc;
  note?: string;
}
type Fail = { reason: string };

function locate(content: string, rawSearch: string): Found | Fail {
  if (rawSearch.length === 0) return { reason: "SEARCH is empty." };
  const lines = content.split("\n");
  const offsets = lineOffsets(lines);
  const ambiguous = (rows: number[], how: string): Fail => ({
    reason: `SEARCH is ambiguous (${how}): it matches at lines ${rows.map((r) => r + 1).join(", ")}. Add a neighbouring line so it matches once.`,
  });
  const tryAll = (search: string, note?: string): Found | Fail | null => {
    const exact: number[] = [];
    for (let p = content.indexOf(search); p >= 0; p = content.indexOf(search, p + 1)) exact.push(p);
    if (exact.length > 1) return ambiguous(exact.map((p) => content.slice(0, p).split("\n").length - 1), "exact");
    if (exact.length === 1) return { loc: { start: exact[0], end: exact[0] + search.length, mode: "exact" }, note };
    for (const [mode, norm] of [
      ["ws", normalizeLine],
      ["punct", foldPunct],
    ] as const) {
      const rows = lineMatches(lines, search, norm);
      if (rows.length > 1) return ambiguous(rows, mode === "ws" ? "ignoring whitespace" : "ignoring quote style");
      if (rows.length === 1) {
        const n = trimBlankEdges(search.split("\n").map(norm)).length;
        const last = rows[0] + n - 1;
        return { loc: { start: offsets[rows[0]], end: offsets[last] + lines[last].length, mode }, note: note ?? (mode === "punct" ? "matched after unifying quote/dash characters" : undefined) };
      }
    }
    const flow = flowMatch(lines, search);
    if (flow.length > 1) return ambiguous(flow.map((f) => f.from), "as reflowed text");
    if (flow.length === 1) {
      const f = flow[0];
      return { loc: { start: offsets[f.from], end: offsets[f.to] + lines[f.to].length, mode: "flow" }, note: note ?? "matched as a reflowed paragraph (different line breaks); the whole paragraph was replaced" };
    }
    return null;
  };
  const search = rawSearch.replace(/\r\n/g, "\n");
  const direct = tryAll(search);
  if (direct) return direct;
  const sLines = search.split("\n");
  if (sLines.filter((l) => l.trim()).every((l) => LINE_PREFIX.test(l))) {
    const stripped = tryAll(sLines.map((l) => l.replace(LINE_PREFIX, "")).join("\n"), 'line-number prefixes ("26| ") were removed from SEARCH; do not copy them from <read>');
    if (stripped) return stripped;
  }
  return { reason: `SEARCH text not found.${nearestText(content, search)}` };
}

/** Pro chybové hlášení: nejbližší kandidát podle nejrozlišitelnějšího řádku SEARCH. */
function nearestText(content: string, search: string): string {
  const sLines = search.split("\n").map((l) => foldPunct(l.replace(LINE_PREFIX, ""))).filter((l) => l.length > 0);
  if (!sLines.length) return "";
  const lines = content.split("\n");
  let anchor = "";
  let i = -1;
  for (const cand of [...sLines].sort((a, b) => b.length - a.length)) {
    i = lines.findIndex((l) => foldPunct(l).includes(cand));
    if (i >= 0) {
      anchor = cand;
      break;
    }
  }
  if (i < 0) return " No line of the file resembles your SEARCH; re-read the file (it may have changed) or check the path.";
  const from = Math.max(0, i - 2);
  const to = Math.min(lines.length, i + 4);
  const excerpt = lines
    .slice(from, to)
    .map((l, k) => `  L${from + k + 1}: ${l}`)
    .join("\n");
  return ` Your SEARCH line "${anchor.slice(0, 60)}" resembles line ${i + 1}, but the surrounding lines differ. File excerpt (the "Lnn:" prefix is NOT part of the file):\n${excerpt}`;
}

/** Při shodě s tolerancí bílých znaků přenese odsazení originálu na náhradu. */
function reindent(original: string, replacement: string): string {
  const origIndent = original.match(/^[ \t]*/)?.[0] ?? "";
  const replIndent = replacement.match(/^[ \t]*/)?.[0] ?? "";
  if (origIndent === replIndent) return replacement;
  return replacement
    .split("\n")
    .map((l) => (l.startsWith(replIndent) ? origIndent + l.slice(replIndent.length) : l))
    .join("\n");
}

export function applyHunks(original: string, hunks: Hunk[]): ApplyResult {
  const crlf = original.includes("\r\n");
  let content = original.replace(/\r\n/g, "\n");
  const failures: ApplyResult["failures"] = [];
  const notes: string[] = [];
  let applied = 0;
  hunks.forEach((h, n) => {
    let replace = h.replace.replace(/\r\n/g, "\n");
    const found = locate(content, h.search);
    if ("reason" in found) {
      failures.push({ hunk: n + 1, reason: found.reason });
      return;
    }
    const { loc, note } = found;
    if (note) notes.push(`Hunk ${n + 1}: ${note}`);
    if (loc.mode === "ws" || loc.mode === "punct") replace = reindent(content.slice(loc.start, loc.end), replace);
    content = content.slice(0, loc.start) + replace + content.slice(loc.end);
    applied++;
  });
  return { content: crlf ? content.replace(/\n/g, "\r\n") : content, applied, failures, notes };
}
