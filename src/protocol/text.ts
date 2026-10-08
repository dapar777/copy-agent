/** Čisté textové utility bez závislosti na vscode. */

/** Jednoduché glob → RegExp (**, *, ?, {a,b} i vnořené, [abc]). Cesty s "/" oddělovači. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  return new RegExp("^" + globBody(g) + "$");
}

function globBody(g: string): string {
  let re = "";
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += g[i + 2] === "/" ? 3 : 2;
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = g.indexOf("]", i);
      if (end > i + 1) {
        re += "[" + g.slice(i + 1, end).replace(/\\/g, "\\\\") + "]";
        i = end + 1;
        continue;
      }
      re += "\\[";
    } else if (c === "{") {
      const end = matchingBrace(g, i);
      if (end > 0) {
        re += "(?:" + splitTopLevel(g.slice(i + 1, end)).map(globBody).join("|") + ")";
        i = end + 1;
        continue;
      }
      re += "\\{";
    } else re += escapeRe(c);
    i++;
  }
  return re;
}

function matchingBrace(g: string, open: number): number {
  let depth = 0;
  for (let i = open; i < g.length; i++) {
    if (g[i] === "{") depth++;
    else if (g[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

export function escapeRe(s: string): string {
  return s.replace(/[.+^$()|[\]\\*?{}]/g, "\\$&");
}

/** Odpovídá cesta některému globu? Neplatný vzor se tiše přeskočí. */
export function matchesAny(rel: string, globs: string[]): boolean {
  const r = rel.replace(/\\/g, "/");
  const base = r.split("/").pop() ?? r;
  return globs.some((g) => {
    try {
      const re = globToRegExp(g);
      return re.test(r) || re.test(base);
    } catch {
      return false;
    }
  });
}

export function nowId(): string {
  return Math.random().toString(36).slice(2, 6) + Date.now().toString(36).slice(-3);
}

export function sanitizeSecrets(text: string): string {
  return text
    .replace(/(api[_-]?key|secret|token|password|passwd|authorization)(["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi, "$1$2***")
    .replace(/\b(sk|ghp|gho|xoxb|xoxp|AKIA)[-_A-Za-z0-9]{16,}\b/g, "***");
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export const DEFAULT_EXCLUDES = [
  "node_modules", ".git", "dist", "out", "build", ".copy-agent", ".whisper", "coverage", ".next", "target",
  "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", "bin", "obj", ".idea",
];

/** Načte jednoduché vzory z .gitignore (jen názvy bez * a bez negací). */
export function parseGitignoreNames(content: string): string[] {
  const names: string[] = [];
  for (const raw of content.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#") || l.startsWith("!") || l.includes("*")) continue;
    names.push(l.replace(/^\/+/, "").replace(/\/+$/, ""));
  }
  return names;
}

/** Dekóduje HTML entity (&lt; &gt; &amp; &quot; &#39; &nbsp;). */
export function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " })[e] ?? _);
}

/** Zkrátí text na hlavu + patu a přidá poznámku. */
export function truncate(text: string, max: number, fullPath?: string): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const omitted = text.length - head - tail;
  const lines = text.slice(head, text.length - tail).split("\n").length;
  const hint = fullPath ? ` Full output: <read path="${fullPath}"/>.` : "";
  return {
    text: `${text.slice(0, head)}\n… (truncated: ${omitted} chars / ~${lines} lines omitted.${hint})\n${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

/** Nad tuto délku se výstup úspěšného příkazu posílá jen jako konec. */
export const OK_RUN_OUTPUT_MAX = 3000;

/** Úspěšný příkaz s dlouhým výstupem: model potřebuje zpravidla jen závěr. */
export function compactOkOutput(text: string, fullPath?: string, max = OK_RUN_OUTPUT_MAX): string {
  if (text.length <= max) return text;
  const tailText = text.slice(text.length - max);
  const cut = tailText.indexOf("\n");
  const tail = cut >= 0 ? tailText.slice(cut + 1) : tailText;
  const omittedLines = text.slice(0, text.length - tail.length).split("\n").length - 1;
  const hint = fullPath ? ` Full output: <read path="${fullPath}"/>.` : "";
  return `… (exit 0; first ${omittedLines} lines omitted, showing the end.${hint})\n${tail}`;
}

/** Odhad tokenů pro informaci v UI (hrubě 4 znaky na token). */
export function approxTokens(chars: number): number {
  return Math.round(chars / 4);
}
