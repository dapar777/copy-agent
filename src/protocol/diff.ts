/**
 * Řádkový diff pro review změn (Accept / Reject po hunkách). Bez závislosti na vscode.
 * Ořízne společný prefix a sufix a na zbytku spočítá LCS.
 */

export interface DiffHunk {
  /** index prvního řádku v původním souboru (0-based) */
  oldStart: number;
  oldLines: string[];
  /** index prvního řádku v novém souboru (0-based) */
  newStart: number;
  newLines: string[];
}

type Op = { type: "eq" | "del" | "add"; line: string };

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    return [...a.map((line) => ({ type: "del", line }) as Op), ...b.map((line) => ({ type: "add", line }) as Op)];
  }
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", line: a[i++] });
    } else {
      ops.push({ type: "add", line: b[j++] });
    }
  }
  while (i < n) ops.push({ type: "del", line: a[i++] });
  while (j < m) ops.push({ type: "add", line: b[j++] });
  return ops;
}

export function diffLines(oldText: string, newText: string): DiffHunk[] {
  const a = oldText.replace(/\r\n/g, "\n").split("\n");
  const b = newText.replace(/\r\n/g, "\n").split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const ops = lcsOps(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix));
  const hunks: DiffHunk[] = [];
  let oi = prefix;
  let ni = prefix;
  let cur: DiffHunk | null = null;
  for (const op of ops) {
    if (op.type === "eq") {
      cur = null;
      oi++;
      ni++;
      continue;
    }
    if (!cur) {
      cur = { oldStart: oi, oldLines: [], newStart: ni, newLines: [] };
      hunks.push(cur);
    }
    if (op.type === "del") {
      cur.oldLines.push(op.line);
      oi++;
    } else {
      cur.newLines.push(op.line);
      ni++;
    }
  }
  return hunks;
}

/** Počet přidaných a odebraných řádků (pro souhrn v panelu a pro heuristiku revize). */
export function diffStats(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of diffLines(oldText, newText)) {
    added += h.newLines.length;
    removed += h.oldLines.length;
  }
  return { added, removed };
}
