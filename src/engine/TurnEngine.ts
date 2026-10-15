import { Host } from "../host/Host";
import { classifyProse } from "../protocol/detect";
import { mergeParts, parseReply } from "../protocol/parser";
import {
  buildContinuePrompt,
  buildCorrectionPrompt,
  buildInitialPrompt,
  buildResultsPrompt,
  buildResumePrompt,
  buildSuggestPrompt,
  documentPathInTask,
  ProjectContext,
  PromptOptions,
  SuggestionHistory,
  summarizeTurn,
} from "../protocol/prompt";
import { STATE_DIR } from "../protocol/roots";
import { Action, ActionResult, ParsedReply, REMARK_TOOLS } from "../protocol/schema";
import { nowId } from "../protocol/text";
import { readGlobalInstructions, readGlobalRules } from "../skills/GlobalConfig";
import { loadHooks, runHooks } from "../skills/Hooks";
import { toolBundle } from "../tools/bundle";
import { collectAutoContext, renderAutoContext } from "../tools/context";
import { collectDiagnosticsSettled } from "../tools/diagnostics";
import { renderTree } from "../tools/fs";
import { ChangeListener, looksLikePlaceholder, PLAN_FILE, RunContext, RunOutcome, ToolRunner } from "../tools/runner";
import { SessionData, Suggestion, TurnRecord } from "./SessionData";

/** Projektová pravidla chování agenta (jedno na řádek). */
export const RULES_FILE = `${STATE_DIR}/rules.md`;
/** Soubory s instrukcemi projektu (první existující se použije). */
export const INSTRUCTION_FILES = ["AGENTS.md", "COPY-AGENT.md"];

/** Ořízne chatové věty kolem dokumentu napsaného do chatu (úvod před prvním nadpisem, závěrečná nabídka). */
export function trimChatter(body: string): { body: string; dropped: string[] } {
  const dropped: string[] = [];
  let lines = body.replace(/\r\n/g, "\n").split("\n");
  const firstHeading = lines.findIndex((l) => /^#{1,6}\s/.test(l));
  if (firstHeading > 0 && firstHeading <= 15) {
    const intro = lines.slice(0, firstHeading).join("\n").trim();
    if (intro) dropped.push(intro);
    lines = lines.slice(firstHeading);
  }
  const paras = lines.join("\n").split(/\n{2,}/);
  while (paras.length > 1) {
    const last = paras[paras.length - 1].trim();
    const isRule = /^-{3,}$|^\*{3,}$|^```[\w-]*$/.test(last);
    const isQuestion = last.length <= 400 && /\?\s*$/.test(last) && !/^#{1,6}\s/.test(last);
    const isOffer = last.length <= 400 && /^(chcete|mám|mohu|shall i|would you like|let me know|do you want)/i.test(last);
    const isLeadIn = last.length <= 200 && /:\s*$/.test(last) && !/^#{1,6}\s/.test(last) && !/^[-*]\s|^\d+\.\s/.test(last);
    if (isRule || isQuestion || isOffer || isLeadIn) {
      if (!isRule) dropped.push(last);
      paras.pop();
      continue;
    }
    break;
  }
  return { body: paras.join("\n\n").trim(), dropped };
}

export type StepResult =
  | { kind: "correction"; prompt: string; errors: string[] }
  | { kind: "continue"; prompt: string; received: number; total: number }
  | { kind: "next"; prompt: string; record: TurnRecord; attachments: string[]; review?: { round: number; files: string[] } }
  | { kind: "done"; summary: string; record: TurnRecord }
  | { kind: "ask"; question: string; options?: string[]; multi?: boolean; record: TurnRecord };

export interface EngineOptions extends PromptOptions {
  treeMaxEntries: number;
  /** automatický kontext k úvodnímu promptu */
  autoContext?: boolean;
  autoContextMaxChars?: number;
  /** svazky jdou do promptu jako text (inline), ne jako příloha */
  bundleInline?: boolean;
  /** celá codebase jako příloha úvodního promptu (bez limitu velikosti); výchozí ano */
  fullContext?: boolean;
}

export interface InitialBundle {
  /** relativní cesta souboru svazku (příloha) */
  file: string;
  files: number;
  chars: number;
  skipped: number;
}

/**
 * Jádro smyčky nezávislé na UI: sestaví prompt, zpracuje odpověď modelu (i po částech),
 * vykoná akce (čtecí souběžně), udržuje plán, návrhy a revizi. Mutuje předaný SessionData.
 */
export class TurnEngine {
  private readonly runner: ToolRunner;

  constructor(
    readonly host: Host,
    private readonly opts: EngineOptions,
    listener?: ChangeListener,
  ) {
    this.runner = new ToolRunner(host, opts.resultMaxChars, listener, { inline: opts.bundleInline ?? true });
  }

  /** Před novým úkolem odloží plán předchozího sezení (hotový smaže, rozpracovaný archivuje). */
  async archivePlan(previousSessionId?: string): Promise<void> {
    if (!(await this.host.exists(PLAN_FILE))) return;
    const plan = await this.host.readFile(PLAN_FILE);
    const open = plan.split("\n").some((l) => /^\s*- \[ \]/.test(l));
    if (open && previousSessionId) await this.host.writeFile(`${STATE_DIR}/plan-${previousSessionId}.md`, plan);
    await this.host.deleteFile(PLAN_FILE);
  }

  async gatherContext(active?: ProjectContext["active"], skills?: ProjectContext["skills"], task?: string, excludeAuto: string[] = []): Promise<ProjectContext> {
    const ctx: ProjectContext = { workspaceName: this.host.workspaceName, tree: await renderTree(this.host, this.opts.treeMaxEntries) };
    const folders = this.host.folders;
    if (folders.length > 1) {
      ctx.roots = folders;
      const parts: string[] = [];
      for (const f of folders) {
        for (const name of INSTRUCTION_FILES) {
          const rel = `${f.name}/${name}`;
          if (await this.host.exists(rel)) {
            parts.push(`### ${rel}\n\n${(await this.host.readFile(rel)).trim()}`);
            break;
          }
        }
      }
      if (parts.length) ctx.instructions = parts.join("\n\n");
    } else {
      for (const name of INSTRUCTION_FILES) {
        if (await this.host.exists(name)) {
          ctx.instructions = await this.host.readFile(name);
          break;
        }
      }
    }
    if (await this.host.exists(PLAN_FILE)) ctx.plan = await this.host.readFile(PLAN_FILE);
    const globalInstructions = readGlobalInstructions();
    if (globalInstructions) ctx.globalInstructions = globalInstructions;
    const rules = [...readGlobalRules()];
    if (await this.host.exists(RULES_FILE)) {
      for (const l of (await this.host.readFile(RULES_FILE)).split(/\r?\n/)) {
        const r = l.replace(/^\s*[-*]\s+/, "").trim();
        if (r && !r.startsWith("#") && !rules.includes(r)) rules.push(r);
      }
    }
    if (rules.length) ctx.rules = rules;
    const hooks = await loadHooks(this.host);
    const policy = this.host.policy;
    ctx.existing = {
      hooks: hooks.map((h) => `${h.match} → ${h.run}${h.cwd ? ` (cwd ${h.cwd})` : ""}`),
      allowPatterns: policy.allowPatterns ?? [],
      autoAllow: policy.autoAllow,
      planOpen: (ctx.plan ?? "")
        .split(/\r?\n/)
        .filter((l) => /^\s*[-*]\s+\[ \]/.test(l))
        .map((l) => l.replace(/^\s*[-*]\s+\[ \]\s*/, "").trim()),
    };
    if (active) ctx.active = active;
    if (skills?.length) ctx.skills = skills;
    const diag = await this.host.diagnostics();
    if (diag) ctx.diagnostics = diag;
    if (task && this.opts.autoContext !== false) {
      try {
        const picks = await collectAutoContext(this.host, task, active, { maxChars: this.opts.autoContextMaxChars ?? 14000, exclude: excludeAuto });
        if (picks.length) {
          ctx.autoContext = renderAutoContext(picks);
          this.host.log(`auto-context: ${picks.map((p) => `${p.path} (${p.mode})`).join(", ")}`);
        }
      } catch (e) {
        this.host.log(`auto-context failed: ${(e as Error).message}`);
      }
    }
    return ctx;
  }

  private optsFor(session: SessionData): EngineOptions {
    return { ...this.opts, planMode: !!session.planMode };
  }

  /**
   * Celá codebase jako jeden soubor .txt k úvodnímu promptu (nejméně kol: model má vše hned), bez
   * limitu velikosti (vynechají se jen binární a ignorované soubory). `enabled` přebíjí nastavení
   * (zaškrtávátko v panelu). Doplní ctx.initialBundle a vrátí cestu přílohy, nebo důvod, proč není.
   */
  async attachInitialBundle(ctx: ProjectContext, turn: number, enabled?: boolean): Promise<{ file?: string; info?: InitialBundle; reason?: string }> {
    if (!(enabled ?? this.opts.fullContext ?? true)) return { reason: "disabled" };
    const b = await toolBundle(this.host, { all: "true" }, turn, 0, { format: "compact", inline: false });
    if (b.status !== "ok" || !b.attachments?.length) return { reason: (b.output ?? "").split("\n")[0] };
    const output = b.output ?? "";
    const skipped = (output.match(/^Skipped:\n((?:  .*\n?)+)/m)?.[1] ?? "").split("\n").filter((l) => l.trim()).length;
    const info: InitialBundle = { file: String(b.meta?.file ?? b.attachments[0]), files: Number(b.meta?.files ?? 0), chars: Number(b.meta?.chars ?? 0), skipped };
    ctx.initialBundle = info;
    // s celou codebase v příloze je automatický výběr souborů zbytečný (a jen zvětšuje prompt)
    ctx.autoContext = undefined;
    this.host.log(`📦 codebase bundle: ${info.file} (${info.files} files, ${info.chars} chars)`);
    return { file: info.file, info };
  }

  initialPrompt(session: SessionData, ctx: ProjectContext): string {
    return buildInitialPrompt(session.id, session.task, ctx, this.optsFor(session));
  }

  resumePrompt(session: SessionData, ctx: ProjectContext): string {
    return buildResumePrompt(session.id, session.task, session.turn, ctx, session.summaries, this.optsFor(session));
  }

  suggestPrompt(session: SessionData, transcriptSummary: string, ctx: ProjectContext, history?: SuggestionHistory): string {
    return buildSuggestPrompt(session.id, session.turn, transcriptSummary, ctx, this.optsFor(session), history);
  }

  /** Prompt s odpovědí uživatele na <ask>; přiloží i výsledky akcí poslaných spolu s otázkou. */
  async answerPrompt(session: SessionData, answer: string, notes: string[]): Promise<string> {
    const last = session.history[session.history.length - 1];
    const pending = last && last.actions.some((a) => a.tool === "ask") ? last.results : [];
    if (last) last.undelivered = false;
    return buildResultsPrompt(session.id, session.turn, pending, { userNotes: [`Answer to your question: ${answer}`, ...notes], parseErrors: last?.errors, docTarget: await this.docTarget(session) }, this.optsFor(session), session.summaries);
  }

  parse(text: string, expectedTurn?: number): ParsedReply {
    return parseReply(text, expectedTurn);
  }

  private async docTarget(session: SessionData): Promise<string | undefined> {
    const p = documentPathInTask(session.task);
    if (!p) return undefined;
    return (await this.host.exists(p)) ? undefined : p;
  }

  private static documentBody(text: string): string | null {
    let body = text
      .replace(/\r\n/g, "\n")
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/^\s*<\/?copy[^>]*>\s*$/gm, "")
      .replace(/^\s*<write\b[^>]*>\s*$/gm, "")
      .replace(/^\s*<\/write>\s*$/gm, "")
      .replace(/^\s*<(status|done)>[\s\S]*?<\/\1>\s*$/gm, "")
      .trim();
    const fenced = body.match(/^(`{3,}|~{3,})[\w-]*[ \t]*\n([\s\S]*?)\n\1[ \t]*$/);
    if (fenced) body = fenced[2].trim();
    if ((body.match(/^`{3,}/gm) ?? []).length % 2 === 1) {
      if (/\n`{3,}[ \t]*$/.test(body)) body = body.replace(/\n`{3,}[ \t]*$/, "").trim();
      else if (/^`{3,}[\w-]*[ \t]*\n/.test(body)) body = body.replace(/^`{3,}[\w-]*[ \t]*\n/, "").trim();
    }
    return classifyProse(body) === "document" ? body : null;
  }

  /** Největší ohrazený blok kódu v textu mimo blok akcí (model ukázal obsah souboru v chatu). */
  private static largestFencedCode(text: string): string | null {
    let best: string | null = null;
    for (const m of text.matchAll(/(`{3,}|~{3,})[\w.+-]*[ \t]*\n([\s\S]*?)\n\1[ \t]*(?:\n|$)/g)) {
      const code = m[2];
      if (/<\/?copy\b/.test(code)) continue; // to je ukázka protokolu, ne obsah souboru
      if (!best || code.length > best.length) best = code;
    }
    return best;
  }

  /**
   * „Dutý“ <write>: tělo jen odkazuje na obsah napsaný do chatu mimo blok („viz výše“). Dokumentu
   * (.md/.txt) se dosadí dokument z chatu, jinému souboru největší ohrazený blok kódu z chatu.
   * Bez náhrady se dutý zápis existujícího souboru stejně odmítne v runneru (ochrana obsahu).
   */
  private static rescueHollowWrite(parsed: ParsedReply): { action: Action; replacement: Action; note: string } | null {
    for (const write of parsed.actions.filter((a) => a.tool === "write")) {
      const body = (write.body ?? "").trim();
      const path = String(write.attrs.path ?? "");
      const isDoc = /\.(md|markdown|txt)$/i.test(path);
      const hollow = looksLikePlaceholder(body) || (isDoc && body.length < 400 && classifyProse(body) !== "document");
      if (!hollow) continue;
      let replacement: string | null = null;
      if (isDoc) {
        const doc = TurnEngine.documentBody(parsed.outside);
        if (doc) replacement = trimChatter(doc).body;
      }
      if (!replacement) {
        const code = TurnEngine.largestFencedCode(parsed.outside);
        if (code && code.trim().length > Math.max(100, body.length)) replacement = code;
      }
      if (!replacement) continue;
      return {
        action: write,
        replacement: { ...write, body: replacement.replace(/\s+$/, "") + "\n" },
        note: `Format requirement: the file content must be INSIDE <write path="${path}">…</write>; your <write> body was only ${JSON.stringify(body.slice(0, 60))} while the content was written in the chat outside the block, which the tool discards. This once the tool used that chat text as the file content (see the write result and check it). From now on put the complete content inside <write>, or change parts with <edit> hunks.`,
      };
    }
    return null;
  }

  private static remarksOnly(actions: Action[]): boolean {
    return actions.length > 0 && actions.every((a) => REMARK_TOOLS.has(a.tool));
  }

  /** Odpověď bez bloku (nebo jen s poznámkou) s dokumentem v chatu: zapíšeme ho sami, když známe cílovou cestu. */
  private async rescueDocument(session: SessionData, parsed: ParsedReply, source: "raw" | "outside"): Promise<{ action: Action; note: string } | null> {
    const text = source === "raw" ? parsed.raw : parsed.outside;
    // odpověď, která se o blok pokusila (rozbitý, useknutý), patří do opravného kola, ne do záchrany
    if (source === "raw" && /<\/?copy\b/.test(text)) return null;
    const fromWrite = text.match(/<write\b[^>]*\bpath\s*=\s*["']([^"']+)["']/)?.[1];
    const path = fromWrite ?? documentPathInTask(session.task);
    // záchrana jen pro markdown dokumenty: .txt ze zadání může být cokoli (vstupní data, log), ne výstup
    if (!path || !/\.(md|markdown)$/i.test(path)) return null;
    const body = TurnEngine.documentBody(text);
    if (!body) return null;
    if (await this.host.exists(path)) return null;
    const trimmed = trimChatter(body);
    const why =
      source === "raw"
        ? `Format requirement: every reply must contain the <copy> block with the work inside it; yours had no usable block (${parsed.errors[0] ?? "no actions"}). `
        : `Format requirement: the work itself must be INSIDE the <copy> block; your block held only ${parsed.actions.map((a) => `<${a.tool}>`).join(", ")} while the document was written outside it. `;
    return {
      action: { tool: "write", attrs: { path }, body: trimmed.body + "\n", index: 0 },
      note:
        why +
        `This once the tool recovered: the task asks for ${path}, your text looked like that document, so it was saved as ${path} (see the write result)` +
        `${trimmed.dropped.length ? `; the chat sentences around it were left out` : ""}. From now on put the document inside <write path="${path}">…</write>. Continue: check the file, fix anything with <edit>, then <done>.`,
    };
  }

  /** Próza, která zmiňuje existující soubory: přečteme je sami, ať model dostane skutečná data. */
  private async rescueReads(parsed: ParsedReply): Promise<{ actions: Action[]; note: string } | null> {
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const m of parsed.outside.matchAll(/(?<![\w/])((?:[\w.-]+\/)+[\w.-]+\.\w{1,10})(?![\w/])/g)) {
      const p = m[1].replace(/^\.\//, "");
      if (seen.has(p) || p.startsWith(`${STATE_DIR}/`)) continue;
      seen.add(p);
      if (await this.host.exists(p)) paths.push(p);
      if (paths.length >= 8) break;
    }
    if (paths.length === 0) return null;
    const had = parsed.actions.length ? `held only ${parsed.actions.map((a) => `<${a.tool}>`).join(", ")}` : "had no block at all";
    return {
      actions: paths.map((path, index) => ({ tool: "read", attrs: { path }, index })),
      note: `Format requirement: every reply must contain the <copy> block with the work inside it; yours ${had}, so nothing was applied. To move on, the tool read the files your text mentions (results above). Now send the actual change as actions inside the block: <edit> hunks (or <write> for new files), <run> for tests, then <done>. Questions go into <ask>.`,
    };
  }

  private async saveProse(session: SessionData, parsed: ParsedReply): Promise<string | undefined> {
    const rel = `${STATE_DIR}/out/reply-${session.turn}-${session.noBlockReplies ?? 1}.md`;
    try {
      await this.host.writeFile(rel, parsed.raw);
      return rel;
    } catch {
      return undefined;
    }
  }

  /**
   * Vícedílná odpověď: část i/n se uloží a vrátí se prompt s žádostí o další část; poslední část
   * se spojí s předchozími. Vrací spojenou odpověď, nebo krok „continue“.
   */
  collectParts(session: SessionData, parsed: ParsedReply): { parsed: ParsedReply } | { step: StepResult } {
    if (!parsed.part || parsed.part.total <= 1) {
      session.replyParts = undefined;
      return { parsed };
    }
    const parts = (session.replyParts ?? []).filter((p) => p.turn === parsed.turn && p.part?.index !== parsed.part?.index);
    parts.push(parsed);
    const got = new Set(parts.map((p) => p.part!.index));
    const total = parsed.part.total;
    if (got.size < total) {
      session.replyParts = parts;
      const received = Math.max(...got);
      return { step: { kind: "continue", prompt: buildContinuePrompt(session.id, session.turn, received, total, this.opts.language), received, total } };
    }
    session.replyParts = undefined;
    return { parsed: mergeParts(parts) };
  }

  /** Vykoná rozparsovanou odpověď pro aktuální kolo a připraví další krok. */
  async execute(session: SessionData, parsedIn: ParsedReply, promptChars: number, notes: string[] = [], ctx: RunContext = {}): Promise<StepResult> {
    const collected = this.collectParts(session, parsedIn);
    if ("step" in collected) return collected.step;
    let parsed = collected.parsed;
    const turn = session.turn;
    const agentNotes: string[] = [...parsed.notes];
    const noBlock = parsed.actions.length === 0;
    const remarksOnly = TurnEngine.remarksOnly(parsed.actions);
    if (noBlock || remarksOnly) {
      const rescued = await this.rescueDocument(session, parsed, noBlock ? "raw" : "outside");
      if (rescued) {
        parsed = { ...parsed, actions: [rescued.action, ...parsed.actions.filter((a) => a.tool !== "done")] };
        agentNotes.push(rescued.note);
      } else {
        const isDoc = !!TurnEngine.documentBody(parsed.outside);
        const docPath = documentPathInTask(session.task);
        const existingDoc = docPath && (await this.host.exists(docPath)) ? docPath : undefined;
        const reads = isDoc && existingDoc ? null : await this.rescueReads(parsed);
        if (reads) {
          parsed = { ...parsed, actions: [...reads.actions, ...parsed.actions.filter((a) => a.tool !== "done")] };
          agentNotes.push(reads.note);
        } else if (noBlock || isDoc) {
          session.noBlockReplies = (session.noBlockReplies ?? 0) + 1;
          const savedTo = await this.saveProse(session, parsed);
          const errors = noBlock ? parsed.errors : [`The block held only ${parsed.actions.map((a) => `<${a.tool}>`).join(", ")}; the document was written outside the block, which the tool discards.`];
          const prompt = buildCorrectionPrompt(session.id, turn, errors, {
            task: session.task,
            prose: noBlock ? parsed.prose || parsed.raw : parsed.outside,
            attempt: session.noBlockReplies,
            userNotes: notes,
            savedTo,
            existingDoc,
            language: this.opts.language,
          });
          return { kind: "correction", prompt, errors };
        }
      }
    }
    session.noBlockReplies = 0;
    const hollow = TurnEngine.rescueHollowWrite(parsed);
    if (hollow) {
      parsed = { ...parsed, actions: parsed.actions.map((a) => (a === hollow.action ? hollow.replacement : a)) };
      agentNotes.push(hollow.note);
    }
    const startedAt = Date.now();
    const outcome = await this.runner.runAll(parsed.actions, turn, ctx);
    if (ctx.signal?.aborted) {
      const stuck = outcome.results.find((r) => r.meta?.exit === "interrupted");
      const skipped = outcome.results.filter((r) => r.meta?.interrupted === "before start").length;
      notes = [
        `The user INTERRUPTED this turn after ${((Date.now() - startedAt) / 1000).toFixed(0)}s of execution` +
          (stuck ? `, while <${stuck.tool}> "${String(stuck.meta?.command ?? stuck.attrs.path ?? "")}" was running (${stuck.meta?.duration}). Its partial output is in its result.` : ".") +
          (skipped ? ` ${skipped} later action(s) were not executed (status="skipped").` : "") +
          " Explain briefly what that step was waiting for, then continue with a safer approach: shorter commands, probe= for servers, smaller batches, or ask the user.",
        ...notes,
      ];
    }
    if (!ctx.signal?.aborted) outcome.results.push(...(await runHooks(this.host, outcome.changedPaths)));

    const statusNote = outcome.statuses.join(" ") || undefined;
    const record: TurnRecord = {
      turn,
      at: new Date().toISOString(),
      promptChars,
      actions: parsed.actions,
      results: outcome.results,
      prose: parsed.prose || undefined,
      status: statusNote,
      errors: parsed.errors.length ? parsed.errors : undefined,
      dialog: outcome.dialog.length ? outcome.dialog : undefined,
    };
    const prev = session.history[session.history.length - 1];
    const carried = prev?.undelivered ? prev.results.filter((r) => r.tool !== "ask") : [];
    if (prev) prev.undelivered = false;
    session.history.push(record);
    session.summaries.push(summarizeTurn(turn, outcome.results, statusNote));
    session.turn = turn + 1;
    if (outcome.plan) session.plan = outcome.plan;
    if (outcome.suggestions.length) {
      session.suggestions = [
        ...(session.suggestions ?? []),
        ...outcome.suggestions.map((s): Suggestion => ({ id: nowId(), kind: s.kind as Suggestion["kind"], scope: s.scope, title: s.title, body: s.body, update: s.update, lang: s.lang, file: s.file, turn })),
      ];
    }
    if (outcome.changedPaths.length) {
      session.changedFiles = [...new Set([...(session.changedFiles ?? []), ...outcome.changedPaths])];
      session.changedSinceReview = [...new Set([...(session.changedSinceReview ?? []), ...outcome.changedPaths])];
      const big = outcome.changes.some((c) => c.rewritten || (c.kind === "create" && (c.lines ?? 0) > 60)) || (session.changedSinceReview?.length ?? 0) >= 2;
      if (big) session.bigChangeSinceReview = true;
    }

    // useknutá odpověď: akce před useknutím proběhly, model má poslat zbytek
    if (parsed.truncated) {
      const t = parsed.truncatedAction;
      agentNotes.push(
        t
          ? `Your reply was cut off by the chat's length limit inside action ${t.index + 1} (<${t.tool}${t.attrs.path ? ` path="${t.attrs.path}"` : ""}>); the ${t.index} action(s) before it were executed (results above) and that one was NOT. Resend only the remaining actions starting with that one, in a shorter reply or split into parts (part="1/2").`
          : `Your reply was cut off by the chat's length limit (no closing tag). The complete actions above were executed. Resend whatever was missing after them, in a shorter reply or split into parts (part="1/2").`,
      );
    }

    const failed = outcome.results.filter((r) => r.status !== "ok");
    // stejná akce selhala i v minulém kole se stejnou chybou: model se točí; řekneme mu to natvrdo
    const prevFailed = new Set((prev?.results ?? []).filter((r) => r.status !== "ok").map((r) => `${r.tool}|${r.attrs.path ?? r.attrs.to ?? ""}|${(r.output ?? "").split("\n")[0]}`));
    const repeated = failed.filter((r) => prevFailed.has(`${r.tool}|${r.attrs.path ?? r.attrs.to ?? ""}|${(r.output ?? "").split("\n")[0]}`));
    if (repeated.length) {
      agentNotes.push(
        `STOP REPEATING: ${repeated.map((r) => `<${r.tool}${r.attrs.path ? ` path="${r.attrs.path}"` : ""}>`).join(", ")} failed in the previous turn with the same error and failed again now. ` +
          `Repeating it a third time will fail too. Read the error text, change what it asks for (path spelling, SEARCH text, command), or explain in <ask> what you need from the user.`,
      );
    }
    let review: { round: number; files: string[] } | undefined;
    if (outcome.done !== undefined && failed.length === 0 && !parsed.truncated) {
      const r = await this.reviewBeforeDone(session, outcome, turn);
      if (!r) return { kind: "done", summary: outcome.done, record };
      notes = [r.note, ...notes];
      if (r.bundle) outcome.results.push(r.bundle);
      review = { round: r.round, files: r.files };
    } else if (outcome.done !== undefined && failed.length) {
      notes = [`You sent <done>, but ${failed.length} action(s) in that block did not succeed (see results). The task continues: fix the problem, or send <done> again if the failure is acceptable and explain why.`, ...notes];
    }
    if (outcome.question !== undefined && !parsed.truncated) {
      record.undelivered = true;
      return { kind: "ask", question: outcome.question, options: outcome.questionOptions, multi: outcome.questionMulti, record };
    }

    const diagnostics = outcome.changedFiles ? await collectDiagnosticsSettled(this.host) : undefined;
    const prompt = buildResultsPrompt(
      session.id,
      session.turn,
      [...carried, ...outcome.results],
      { diagnostics, userNotes: notes, parseErrors: parsed.errors, agentNotes, docTarget: await this.docTarget(session) },
      this.optsFor(session),
      session.summaries,
    );
    return { kind: "next", prompt, record, review, attachments: [...carried, ...outcome.results].flatMap((r) => r.attachments ?? []) };
  }

  /**
   * Revize před dokončením: první <done> po změnách není finální (always), nebo jen po větších
   * změnách (auto). Model dostane celé znění změněných souborů a výzvu zkontrolovat celou práci.
   */
  private async reviewBeforeDone(session: SessionData, outcome: RunOutcome, turn: number): Promise<{ note: string; bundle?: ActionResult; round: number; files: string[] } | null> {
    const mode = this.opts.reviewBeforeDone ?? "auto";
    if (mode === "off") return null;
    const pending = session.changedSinceReview ?? [];
    if (pending.length === 0) return null;
    if (mode === "auto" && !session.bigChangeSinceReview) return null;
    const files: string[] = [];
    for (const p of session.changedFiles ?? []) if (await this.host.exists(p)) files.push(p);
    const round = (session.reviewRounds ?? 0) + 1;
    session.reviewRounds = round;
    session.changedSinceReview = [];
    session.bigChangeSinceReview = false;
    let bundle: ActionResult | undefined;
    if (files.length) {
      const b = await toolBundle(this.host, { paths: files.join(", ") }, turn, 90 + round, { inline: this.opts.bundleInline ?? true, format: "numbered" });
      if (b.status === "ok") bundle = b;
    }
    const attached = bundle
      ? `Included is a bundle with the COMPLETE current content of every file you changed in this task (${files.length}: ${files.join(", ")}).`
      : `The files you changed in this task: ${files.join(", ") || "(none left)"}; read them with <read>.`;
    const sent = outcome.doneReviewed ? '<done reviewed="true">' : "<done>";
    const head =
      round === 1
        ? `REVIEW BEFORE DONE: you sent ${sent}, but after file changes the first <done> is not final; review the work first. ${attached}`
        : `REVIEW BEFORE DONE (round ${round}): you sent ${sent}, but since the last review you changed ${pending.join(", ")}. ${attached} Review the new changes and their effect on the rest.`;
    const note =
      `${head} Check the WHOLE work against the task, not only these files: is everything the task asked for done, in every place it belongs (tests, docs, config)? Anything forgotten, inconsistent, half-done or left as a placeholder? ` +
      `Does every file read as valid, complete code or text? Read other files, grep or run tests if that helps. Fix what you find with small <edit> hunks. When satisfied, finish with <done reviewed="true"> and a summary of what you checked. If you change any file, the tool asks for one more review.`;
    return { note, bundle, round, files };
  }

  undeliveredAttachments(session: SessionData): string[] {
    const last = session.history[session.history.length - 1];
    return last?.undelivered ? last.results.flatMap((r) => r.attachments ?? []) : [];
  }

  /** Znovu sestaví prompt s výsledky posledního vykonaného kola. */
  rebuildLastPrompt(session: SessionData, notes: string[] = []): string | undefined {
    const last = session.history[session.history.length - 1];
    if (!last) return undefined;
    return buildResultsPrompt(session.id, session.turn, last.results, { userNotes: notes, parseErrors: last.errors }, this.optsFor(session), session.summaries);
  }
}
