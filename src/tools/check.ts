import { execFile } from "child_process";
import { createRequire } from "module";
import * as path from "path";
import { Host } from "../host/Host";
import { BLOCK } from "../protocol/schema";

/**
 * Kontrola souboru po <write>/<edit>: zbytky protokolu (CDATA, entity, značky hunků, ohrazení, tagy)
 * ve všech souborech; syntaxe tam, kde jde ověřit (JSON, Python přes `ast.parse`, JS přes
 * `node --check`, TypeScript přes `typescript` z node_modules projektu). Chyba = neúspěšná akce.
 */

export interface CheckIssue {
  severity: "error" | "warning";
  message: string;
}

const MARKUP = /\.(html?|xhtml|xml|svg|xsl|xslt|plist|csproj|vcxproj|props|targets|resx|xaml|config)$/i;
const DOCS = /\.(md|markdown|mdx|txt|rst)$/i;
const CHECK_TIMEOUT_MS = 15_000;

export async function checkWrittenFile(host: Host, rel: string): Promise<CheckIssue[]> {
  let text: string;
  try {
    text = await host.readFile(rel);
  } catch {
    return [];
  }
  const issues = residue(rel, text);
  try {
    issues.push(...(await syntax(host, rel, text)));
  } catch {
    /* kontrola syntaxe není k dispozici */
  }
  return issues;
}

export function renderIssues(rel: string, issues: CheckIssue[]): string {
  const errors = issues.filter((i) => i.severity === "error");
  const head = errors.length ? `The file ${rel} was written, but it is NOT valid:` : `The file ${rel} was written; check these warnings:`;
  const tail = errors.length ? "Fix it with small <edit> hunks (do not rewrite the whole file). The task cannot finish while a file is invalid." : "";
  return [head, ...issues.map((i) => `- ${i.severity === "error" ? "ERROR" : "warning"}: ${i.message}`), tail].filter(Boolean).join("\n");
}

export function residue(rel: string, text: string): CheckIssue[] {
  const out: CheckIssue[] = [];
  const lines = text.split(/\r?\n/);
  const at = (re: RegExp): number | undefined => {
    const i = lines.findIndex((l) => re.test(l));
    return i < 0 ? undefined : i + 1;
  };
  const isMarkup = MARKUP.test(rel);
  const isDoc = DOCS.test(rel);
  if (!isMarkup) {
    const l = at(/<!\[CDATA\[|\]\]>/);
    if (l !== undefined) out.push({ severity: "error", message: `line ${l}: <![CDATA[ … ]]> wrapper left in the file (protocol residue; bodies are plain text, never CDATA)` });
  }
  const tag = at(new RegExp(`^\\s*</?(write|edit|${BLOCK})\\b[^>]*>\\s*$`));
  if (tag !== undefined) out.push({ severity: "error", message: `line ${tag}: protocol tag (<${BLOCK}>, <write> or <edit>) left in the file` });
  if (!isDoc) {
    const s = at(/^<{7} SEARCH\b/);
    const r = at(/^>{7} REPLACE\b/);
    if (s !== undefined || r !== undefined) out.push({ severity: "error", message: `line ${s ?? r}: SEARCH/REPLACE hunk markers left in the file` });
    const last = [...lines].reverse().find((l) => l.trim());
    if (/^(`{3,}|~{3,})/.test(lines[0] ?? "") && /^(`{3,}|~{3,})\s*$/.test(last ?? "")) {
      out.push({ severity: "error", message: "line 1: the whole file is wrapped in a code fence (protocol residue; bodies are verbatim, no fence)" });
    }
  }
  if (!isMarkup && !/[<>]/.test(text) && /&(lt|gt);/.test(text)) {
    out.push({ severity: "warning", message: `line ${at(/&(lt|gt);/)}: HTML entities (&lt; &gt;) but not a single raw < or >: the content looks HTML-escaped` });
  }
  return out;
}

async function syntax(host: Host, rel: string, text: string): Promise<CheckIssue[]> {
  const ext = path.extname(rel).toLowerCase();
  if (ext === ".json") return jsonCheck(rel, text);
  const abs = host.absolutePath(rel);
  if (ext === ".py" || ext === ".pyw") return pyCheck(abs);
  if ([".js", ".mjs", ".cjs"].includes(ext)) return nodeCheck(abs);
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return tsCheck(host.absolutePath("."), rel, text);
  return [];
}

function jsonCheck(rel: string, text: string): CheckIssue[] {
  if (/(^|\/)(tsconfig|jsconfig)[^/]*\.json$|(^|\/)\.vscode\/|\.jsonc$/i.test(rel)) return [];
  try {
    JSON.parse(text.replace(/^﻿/, ""));
    return [];
  } catch (e) {
    return [{ severity: "error", message: `JSON syntax: ${(e as Error).message}` }];
  }
}

function exec(cmd: string, args: string[]): Promise<{ code: number | string; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: CHECK_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({ code: e ? (e.code ?? 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

const PY_PROBE = ["import ast, sys", "try:", "    ast.parse(open(sys.argv[1], encoding='utf-8-sig').read(), sys.argv[1])", "except SyntaxError as e:", "    print(f'line {e.lineno}: {e.msg}'); sys.exit(1)"].join("\n");

async function pyCheck(abs: string): Promise<CheckIssue[]> {
  let r = await exec("python", ["-c", PY_PROBE, abs]);
  if (r.code === "ENOENT" || (r.code === 9009 && !r.stdout)) r = await exec("py", ["-3", "-c", PY_PROBE, abs]);
  if (r.code === 1 && r.stdout.trim()) return [{ severity: "error", message: `Python syntax: ${r.stdout.trim().split("\n")[0]}` }];
  return [];
}

async function nodeCheck(abs: string): Promise<CheckIssue[]> {
  const r = await exec("node", ["--check", abs]);
  if (r.code === 1 && /SyntaxError/.test(r.stderr)) {
    const line = new RegExp(`${abs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`).exec(r.stderr)?.[1];
    const msg = /SyntaxError: (.*)/.exec(r.stderr)?.[1] ?? "syntax error";
    return [{ severity: "error", message: `JavaScript syntax: ${line ? `line ${line}: ` : ""}${msg}` }];
  }
  return [];
}

interface TsLike {
  transpileModule(text: string, opts: unknown): { diagnostics?: { messageText: unknown; start?: number; file?: { getLineAndCharacterOfPosition(p: number): { line: number } } }[] };
  flattenDiagnosticMessageText(m: unknown, nl: string): string;
  JsxEmit: { Preserve: number };
}

function tsCheck(rootAbs: string, rel: string, text: string): CheckIssue[] {
  let ts: TsLike;
  try {
    const req = createRequire(path.join(rootAbs, "package.json"));
    ts = req(req.resolve("typescript")) as TsLike;
  } catch {
    return [];
  }
  const out = ts.transpileModule(text, { reportDiagnostics: true, fileName: rel, compilerOptions: { jsx: ts.JsxEmit.Preserve } });
  return (out.diagnostics ?? []).slice(0, 3).map((d) => {
    const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : undefined;
    return { severity: "error" as const, message: `TypeScript syntax: ${line ? `line ${line}: ` : ""}${ts.flattenDiagnosticMessageText(d.messageText, " ")}` };
  });
}
