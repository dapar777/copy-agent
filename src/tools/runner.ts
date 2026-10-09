import { Host } from "../host/Host";
import { applyHunks, parseHunks } from "../protocol/edit";
import { STATE_DIR } from "../protocol/roots";
import { Action, ActionResult, READ_ONLY_TOOLS, SILENT_TOOLS } from "../protocol/schema";
import { applySection } from "../protocol/section";
import { OK_RUN_OUTPUT_MAX } from "../protocol/text";
import { isProtectedPath } from "../safety/Policy";
import { BundleOptions, toolBundle } from "./bundle";
import { checkWrittenFile, renderIssues } from "./check";
import { toolDiagnostics } from "./diagnostics";
import { describeEncodingEn, isPlainUtf8Lf } from "./encoding";
import { toolGlob, toolLs, toolRead } from "./fs";
import { toolGrep } from "./grep";
import { toolRun } from "./run";
import { takeScreenshot } from "./screenshot";

/** Napojení na review změn (ve VS Code); headless běh ho nepotřebuje. */
export interface ChangeListener {
  onWillChange(path: string, kind: "create" | "modify", baseline: string, turn: number): void;
  onWillDelete(path: string, content: string, turn: number): void;
  /** volitelné schválení před zápisem; undefined = vždy povoleno */
  approve?(path: string, before: string, after: string): Promise<boolean>;
}

export interface SuggestionDraft {
  kind: string;
  scope: "project" | "global";
  title: string;
  body: string;
  update?: string;
  lang?: string;
  file?: string;
}

export interface ChangedFile {
  path: string;
  kind: "create" | "modify" | "delete" | "move";
  /** počet řádků nového obsahu (pro heuristiku revize) */
  lines?: number;
  /** celý soubor byl přepsán (<write> existujícího souboru) */
  rewritten?: boolean;
}

export interface RunOutcome {
  results: ActionResult[];
  changedFiles: boolean;
  changedPaths: string[];
  changes: ChangedFile[];
  statuses: string[];
  dialog: { from: "model" | "user"; text: string }[];
  plan?: string;
  suggestions: SuggestionDraft[];
  doneReviewed?: boolean;
  question?: string;
  questionOptions?: string[];
  questionMulti?: boolean;
  done?: string;
}

export const PLAN_FILE = `${STATE_DIR}/plan.md`;

export interface RunContext {
  signal?: AbortSignal;
  onStart?: (action: Action) => void;
  onEnd?: (action: Action, durationMs: number) => void;
}

const SUGGEST_KINDS = new Set(["skill", "script", "instructions", "rule", "hook", "allow", "setting", "task", "agent"]);
const PARALLEL = 6;

/**
 * Vykonává akce bloku. Souvislé skupiny čtecích akcí (read, grep, ls, glob, bundle, diagnostics)
 * běží souběžně, zápisy a příkazy v pořadí; výsledky se vrací v pořadí akcí.
 */
export class ToolRunner {
  constructor(
    private readonly host: Host,
    private readonly resultMaxChars: number,
    private readonly listener?: ChangeListener,
    private readonly bundleOptions: BundleOptions = {},
  ) {}

  async runAll(actions: Action[], turn: number, ctx: RunContext = {}): Promise<RunOutcome> {
    const outcome: RunOutcome = { results: [], changedFiles: false, changedPaths: [], changes: [], statuses: [], dialog: [], suggestions: [] };
    let i = 0;
    while (i < actions.length) {
      if (ctx.signal?.aborted) {
        const a = actions[i++];
        if (!SILENT_TOOLS.has(a.tool)) outcome.results.push({ tool: a.tool, attrs: a.attrs, status: "skipped", output: "Not executed: the user interrupted this turn before this action.", meta: { interrupted: "before start" } });
        continue;
      }
      // skupina čtecích akcí (bez screenshotů, ty mění popředí) běží souběžně
      const group: Action[] = [];
      while (i < actions.length && READ_ONLY_TOOLS.has(actions[i].tool) && actions[i].tool !== "screenshot" && group.length < PARALLEL) group.push(actions[i++]);
      if (group.length > 1) {
        const results = await Promise.all(group.map((a) => this.timed(a, turn, outcome, ctx)));
        for (const r of results) if (r) outcome.results.push(r);
        continue;
      }
      const a = group[0] ?? actions[i++];
      const r = await this.timed(a, turn, outcome, ctx);
      if (r) outcome.results.push(r);
    }
    return outcome;
  }

  private async timed(a: Action, turn: number, outcome: RunOutcome, ctx: RunContext): Promise<ActionResult | undefined> {
    ctx.onStart?.(a);
    const started = Date.now();
    const r = await this.runOne(a, turn, outcome, ctx.signal);
    ctx.onEnd?.(a, Date.now() - started);
    if (!r) return undefined;
    if (r.meta?.duration === undefined && Date.now() - started > 1500) r.meta = { ...r.meta, duration: ((Date.now() - started) / 1000).toFixed(1) + "s" };
    const saveAbove = a.tool === "run" && r.status === "ok" ? Math.min(this.resultMaxChars, OK_RUN_OUTPUT_MAX) : this.resultMaxChars;
    if (r.output && r.output.length > saveAbove && a.tool !== "read" && a.tool !== "bundle") r.fullOutputPath = await this.saveFullOutput(turn, a, r.output);
    this.host.log(`${a.tool} ${a.attrs.path ?? a.attrs.pattern ?? a.attrs.title ?? a.attrs.from ?? ""} → ${r.status}${r.meta ? " " + JSON.stringify(r.meta) : ""}`);
    return r;
  }

  private async runOne(a: Action, turn: number, outcome: RunOutcome, signal?: AbortSignal): Promise<ActionResult | undefined> {
    try {
      switch (a.tool) {
        case "read":
          return await toolRead(this.host, a.attrs);
        case "ls":
          return await toolLs(this.host, a.attrs);
        case "glob":
          return await toolGlob(this.host, a.attrs);
        case "grep":
          return await toolGrep(this.host, a.attrs);
        case "diagnostics":
          return await toolDiagnostics(this.host, a.attrs);
        case "write":
          return await this.checked(await this.write(a, turn, outcome));
        case "edit":
          return await this.checked(await this.edit(a, turn, outcome));
        case "move":
          return await this.move(a, turn, outcome);
        case "delete":
          return await this.delete(a, turn, outcome);
        case "run":
          return await toolRun(this.host, a.attrs, a.body ?? "", turn, a.index, signal);
        case "screenshot":
          return await takeScreenshot(this.host, turn, a.index, { window: a.attrs.window, name: a.attrs.name });
        case "bundle":
          return await toolBundle(this.host, a.attrs, turn, a.index, this.bundleOptions);
        case "plan":
          return await this.plan(a, outcome);
        case "suggest":
          return this.suggest(a, outcome);
        case "status":
          outcome.statuses.push(a.body ?? "");
          this.host.log(`● ${a.body ?? ""}`);
          return undefined;
        case "dialog": {
          const from = (a.attrs.from ?? "").toLowerCase() === "user" ? "user" : "model";
          outcome.dialog.push({ from, text: (a.body ?? "").trim() });
          return undefined;
        }
        case "ask": {
          outcome.question = a.body ?? "";
          const opts = (a.attrs.options ?? "").split("|").map((o) => o.trim()).filter(Boolean);
          if (opts.length) outcome.questionOptions = opts;
          outcome.questionMulti = /^(true|1|yes|ano)$/i.test(a.attrs.multi ?? "");
          return undefined;
        }
        case "done":
          outcome.done = a.body ?? "";
          outcome.doneReviewed = /^(true|1|yes|ano)$/i.test(a.attrs.reviewed ?? "");
          return undefined;
        default:
          return { tool: a.tool, attrs: a.attrs, status: "error", output: `Unknown action ${a.tool}` };
      }
    } catch (e) {
      return { tool: a.tool, attrs: a.attrs, status: "error", output: (e as Error).message };
    }
  }

  private guard(path: string): string | null {
    this.host.assertInside(path);
    const insideFolder = this.host.folders.length > 1 ? path.replace(/\\/g, "/").split("/").slice(1).join("/") : "";
    if (isProtectedPath(path, this.host.policy) || (insideFolder && isProtectedPath(insideFolder, this.host.policy))) return `Path "${path}" is protected by policy; changes are not allowed.`;
    return null;
  }

  private async approve(path: string, before: string, after: string): Promise<boolean> {
    return this.listener?.approve ? this.listener.approve(path, before, after) : true;
  }

  /** Po zápisu soubor zkontroluje; neplatný soubor = neúspěšná akce. */
  private async checked(r: ActionResult): Promise<ActionResult> {
    if (r.status !== "ok" || !r.attrs.path) return r;
    const issues = await checkWrittenFile(this.host, r.attrs.path);
    if (!issues.length) return r;
    const bad = issues.some((i) => i.severity === "error");
    this.host.log(`${bad ? "✗" : "⚠"} check ${r.attrs.path}: ${issues.map((i) => i.message).join("; ")}`);
    return { ...r, status: bad ? "error" : r.status, output: [r.output, renderIssues(r.attrs.path, issues)].filter(Boolean).join("\n"), meta: { ...r.meta, [bad ? "invalid" : "warning"]: "true" } };
  }

  private markChanged(outcome: RunOutcome, change: ChangedFile): void {
    outcome.changedFiles = true;
    if (!outcome.changedPaths.includes(change.path)) outcome.changedPaths.push(change.path);
    outcome.changes.push(change);
  }

  private async write(a: Action, turn: number, outcome: RunOutcome): Promise<ActionResult> {
    const path = a.attrs.path;
    const blocked = this.guard(path);
    if (blocked) return { tool: "write", attrs: a.attrs, status: "denied", output: blocked };
    const exists = await this.host.exists(path);
    const baseline = exists ? await this.host.readFile(path) : "";
    const body = a.body ?? "";
    // ochrana obsahu: existující soubor se nesmí přepsat zástupným textem („viz výše“) ani zlomkem
    // původní délky; takový <write> by soubor fakticky smazal. Model dostane, co poslat místo toho.
    if (exists && !/^(true|1|yes)$/i.test(a.attrs.force ?? "")) {
      const refusal = refuseWrite(body, baseline);
      if (refusal) return { tool: "write", attrs: a.attrs, status: "error", output: refusal.text, meta: { refused: refusal.reason } };
    }
    const content = ensureTrailingNewline(body, baseline);
    if (!(await this.approve(path, baseline, content))) return { tool: "write", attrs: a.attrs, status: "denied", output: "The user declined this change." };
    this.listener?.onWillChange(path, exists ? "modify" : "create", baseline, turn);
    const enc = await this.host.fileEncoding(path);
    await this.host.writeFile(path, content);
    const lines = content.split("\n").length;
    this.markChanged(outcome, { path, kind: exists ? "modify" : "create", lines, rewritten: exists });
    const meta: Record<string, string | number> = { [exists ? "overwritten" : "created"]: `${lines} lines` };
    if (!isPlainUtf8Lf(enc)) meta.encoding = describeEncodingEn(enc);
    return this.verifyEncoding(path, enc, content, { tool: "write", attrs: a.attrs, status: "ok", meta });
  }

  /**
   * Po zápisu ověří, že soubor zůstal ve svém kódování (editor mohl uložit jinak). Rozdíl se hlásí
   * jako varování ve výsledku, aby o něm věděl model i uživatel.
   */
  private async verifyEncoding(path: string, before: { encoding: string; bom: boolean; eol: "lf" | "crlf" }, content: string, r: ActionResult): Promise<ActionResult> {
    if (!/[^\x00-\x7f]/.test(content)) return r; // bez znaků mimo ASCII se kódování poznat nedá (a nezáleží na něm)
    try {
      const after = await this.host.fileEncoding(path);
      if (after.encoding === before.encoding && after.bom === before.bom) return r;
      const warn = `Warning: the encoding of ${path} changed from ${describeEncodingEn(before)} to ${describeEncodingEn(after)} while saving (the editor saved it with its own encoding). Check the file's diacritics; set VS Code "files.encoding" or "files.autoGuessEncoding" for this project if it is wrong.`;
      this.host.log(`⚠ ${warn}`);
      return { ...r, output: [r.output, warn].filter(Boolean).join("\n"), meta: { ...r.meta, encodingChanged: describeEncodingEn(after) } };
    } catch {
      return r;
    }
  }

  private async edit(a: Action, turn: number, outcome: RunOutcome): Promise<ActionResult> {
    const path = a.attrs.path;
    const blocked = this.guard(path);
    if (blocked) return { tool: "edit", attrs: a.attrs, status: "denied", output: blocked };
    if (!(await this.host.exists(path))) return { tool: "edit", attrs: a.attrs, status: "error", output: `File not found: ${path}. Use <write> to create it.` };
    const baseline = await this.host.readFile(path);
    const isDoc = /\.(md|markdown|txt)$/i.test(path);
    if (a.attrs.section) {
      const mode = a.attrs.insert === "before" || a.attrs.insert === "after" ? a.attrs.insert : "replace";
      const sec = applySection(baseline, a.attrs.section, a.body ?? "", mode);
      if (sec.error) return { tool: "edit", attrs: a.attrs, status: "error", output: sec.error };
      if (!(await this.approve(path, baseline, sec.content))) return { tool: "edit", attrs: a.attrs, status: "denied", output: "The user declined this change." };
      this.listener?.onWillChange(path, "modify", baseline, turn);
      const enc = await this.host.fileEncoding(path);
      await this.host.writeFile(path, sec.content);
      this.markChanged(outcome, { path, kind: "modify", lines: sec.content.split("\n").length });
      const r = sec.replaced!;
      const what = mode === "replace" ? `Section "${r.heading}" (lines ${r.from}-${r.to}) replaced.` : `New section inserted ${mode} "${r.heading}" (now lines ${r.from}-${r.to}).`;
      return this.verifyEncoding(path, enc, sec.content, { tool: "edit", attrs: a.attrs, status: "ok", output: what, meta: { section: r.heading, lines: `${r.from}-${r.to}` } });
    }
    const hunks = parseHunks(a.body ?? "");
    const sectionHint = isDoc ? '\n\nTip: for a markdown document, <edit path="…" section="## Heading"> replaces the whole section without any SEARCH text.' : "";
    if (hunks.length === 0) return { tool: "edit", attrs: a.attrs, status: "error", output: "No SEARCH/REPLACE hunks found. Format:\n<<<<<<< SEARCH\n(old)\n=======\n(new)\n>>>>>>> REPLACE" + sectionHint };
    const res = applyHunks(baseline, hunks);
    const meta = { hunks: `${res.applied}/${hunks.length}` };
    const notes = res.notes.join("\n");
    if (res.applied === 0) return { tool: "edit", attrs: a.attrs, status: "error", output: res.failures.map((f) => `Hunk ${f.hunk}: ${f.reason}`).join("\n\n") + sectionHint, meta };
    if (!(await this.approve(path, baseline, res.content))) return { tool: "edit", attrs: a.attrs, status: "denied", output: "The user declined this change.", meta };
    this.listener?.onWillChange(path, "modify", baseline, turn);
    const enc = await this.host.fileEncoding(path);
    await this.host.writeFile(path, res.content);
    this.markChanged(outcome, { path, kind: "modify", lines: res.content.split("\n").length });
    const failText = res.failures.map((f) => `Hunk ${f.hunk} FAILED (others applied): ${f.reason}`).join("\n\n");
    const output = [failText, notes].filter(Boolean).join("\n\n");
    return this.verifyEncoding(path, enc, res.content, { tool: "edit", attrs: a.attrs, status: res.failures.length ? "error" : "ok", output: output || undefined, meta });
  }

  private async move(a: Action, turn: number, outcome: RunOutcome): Promise<ActionResult> {
    const from = a.attrs.from;
    const to = a.attrs.to;
    const blocked = this.guard(from) ?? this.guard(to);
    if (blocked) return { tool: "move", attrs: a.attrs, status: "denied", output: blocked };
    if (!(await this.host.exists(from))) return { tool: "move", attrs: a.attrs, status: "error", output: `File not found: ${from}` };
    if (await this.host.exists(to)) return { tool: "move", attrs: a.attrs, status: "error", output: `Target already exists: ${to}` };
    const content = await this.host.readFile(from);
    this.listener?.onWillDelete(from, content, turn);
    this.listener?.onWillChange(to, "create", "", turn);
    await this.host.moveFile(from, to);
    this.markChanged(outcome, { path: from, kind: "delete" });
    this.markChanged(outcome, { path: to, kind: "move" });
    return { tool: "move", attrs: a.attrs, status: "ok" };
  }

  private async delete(a: Action, turn: number, outcome: RunOutcome): Promise<ActionResult> {
    const path = a.attrs.path;
    const blocked = this.guard(path);
    if (blocked) return { tool: "delete", attrs: a.attrs, status: "denied", output: blocked };
    if (!(await this.host.exists(path))) return { tool: "delete", attrs: a.attrs, status: "error", output: `File not found: ${path}` };
    if (!(await this.host.confirmDelete(path))) return { tool: "delete", attrs: a.attrs, status: "denied", output: "The user declined the deletion." };
    const content = await this.host.readFile(path);
    this.listener?.onWillDelete(path, content, turn);
    await this.host.deleteFile(path);
    this.markChanged(outcome, { path, kind: "delete" });
    return { tool: "delete", attrs: a.attrs, status: "ok" };
  }

  private async plan(a: Action, outcome: RunOutcome): Promise<ActionResult> {
    const body = (a.body ?? "").trim() + "\n";
    const items = (body.match(/^\s*[-*]\s+\[[ xX]\]/gm) ?? []).length;
    const done = (body.match(/^\s*[-*]\s+\[[xX]\]/gm) ?? []).length;
    if (items === 0) return { tool: "plan", attrs: a.attrs, status: "error", output: "The plan must be a markdown checklist with `- [ ]` / `- [x]` items." };
    await this.host.writeFile(PLAN_FILE, body);
    outcome.plan = body;
    return { tool: "plan", attrs: a.attrs, status: "ok", meta: { items, done } };
  }

  private suggest(a: Action, outcome: RunOutcome): ActionResult {
    const kind = (a.attrs.kind ?? "").toLowerCase();
    if (!SUGGEST_KINDS.has(kind)) return { tool: "suggest", attrs: a.attrs, status: "error", output: `Unknown suggestion kind "${a.attrs.kind}"; use one of ${[...SUGGEST_KINDS].join(", ")}.` };
    const scope = (a.attrs.scope ?? "").toLowerCase() === "global" ? "global" : "project";
    const update = a.attrs.update?.trim() || undefined;
    const lang = a.attrs.lang?.trim() || undefined;
    const file = a.attrs.file?.trim() || undefined;
    outcome.suggestions.push({ kind, scope, title: a.attrs.title ?? kind, body: (a.body ?? "").trim(), update, lang, file });
    return { tool: "suggest", attrs: { kind, scope, title: a.attrs.title ?? kind, ...(update ? { update } : {}) }, status: "ok", meta: { queued: "awaiting user approval" } };
  }

  private async saveFullOutput(turn: number, a: Action, output: string): Promise<string> {
    const rel = `${STATE_DIR}/out/${a.tool}-${turn}-${a.index}.txt`;
    try {
      await this.host.writeFile(rel, output);
      return rel;
    } catch {
      return "";
    }
  }
}

/** Tělo <write>, které není obsah souboru, ale odkaz („viz výše“, „beze změny“, „…“). */
export function looksLikePlaceholder(body: string): boolean {
  const t = body.trim();
  if (!t) return true;
  if (t.length > 240) return false;
  if (/^(\.{3}|…|\/\/ ?\.{3}|# ?\.{3}|<!-- ?\.{3} ?-->)$/.test(t)) return true;
  return /\b(viz|see|as|jak|jako)\s+(above|below|výše|níže|nahoře|dole|previous|earlier|chat)\b|\b(zkopíruj|copy|paste|vlož|použij|use)\b.*\b(above|výše|z chatu|from (the )?chat|z odpovědi)\b|\b(unchanged|beze změny|same as (before|above)|stejn[ýé] jako|no changes?|without changes?)\b|\[(celý|full|complete|whole)\s+(soubor|obsah|file|content)/i.test(
    t,
  );
}

/**
 * Odmítne přepsání existujícího souboru zástupným textem nebo zlomkem původní délky (model napsal
 * obsah do chatu mimo blok, nebo zapomněl zbytek). Vrací důvod a text pro model, nebo null.
 */
export function refuseWrite(body: string, baseline: string): { reason: string; text: string } | null {
  if (looksLikePlaceholder(body)) {
    return {
      reason: "placeholder body",
      text: `REFUSED: the body of this <write> looks like a placeholder (${JSON.stringify(body.trim().slice(0, 80))}), not the file content; writing it would wipe the file. The file was NOT changed. Send the COMPLETE file content inside <write>, or change parts of it with <edit> SEARCH/REPLACE hunks.`,
    };
  }
  const b = baseline.trim().length;
  const n = body.trim().length;
  if (b >= 300 && n < b * 0.3) {
    return {
      reason: "content shrink",
      text: `REFUSED: the new content (${n} chars) is much shorter than the existing file (${b} chars); overwriting would delete most of it. The file was NOT changed. Use <edit> hunks for partial changes, or resend <write path="…" force="true"> if the file really should shrink that much.`,
    };
  }
  return null;
}

function ensureTrailingNewline(content: string, baseline: string): string {
  if (content.endsWith("\n")) return content;
  if (baseline && !baseline.endsWith("\n")) return content;
  return content + "\n";
}
