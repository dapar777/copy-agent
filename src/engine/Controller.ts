import * as fs from "fs";
import * as os from "os";
import * as vscode from "vscode";
import { ClipboardBridge, decoratePrompt } from "../clipboard/ClipboardBridge";
import { VsCodeHost } from "../host/VsCodeHost";
import { classifyProse, isOwnPrompt, looksLikeReply } from "../protocol/detect";
import { buildAgentInstructions, buildCorrectionPrompt, BundleUsage, ProjectContext, ReviewMode, splitPrompt, Target } from "../protocol/prompt";
import { parseRefs } from "../protocol/refs";
import { STATE_DIR } from "../protocol/roots";
import { BUILTIN_COMMANDS, composeTask, isHelpRequest, parseInput, skillHelp, SlashCommand } from "../protocol/slash";
import { decodeEntities } from "../protocol/text";
import { ReviewManager } from "../review/ReviewManager";
import { ApprovalService } from "../safety/Approvals";
import { Checkpoint } from "../safety/Checkpoint";
import { ensureVcsIgnore } from "../safety/VcsIgnore";
import { addGlobalHook, appendAgentFeedback, appendGlobalInstructions, appendGlobalRule, readGlobalHooks, readGlobalInstructions, readGlobalRules, replaceGlobalHook, replaceGlobalRule } from "../skills/GlobalConfig";
import { addHook, loadHooks, loadProjectHooks, saveProjectHooks } from "../skills/Hooks";
import { loadSkills, saveScript, saveSkill } from "../skills/Skills";
import { renderRefs, resolveRefs } from "../tools/refs";
import { ChangeListener, PLAN_FILE } from "../tools/runner";
import { cfg, CONFIG, kb, openDocumentWithEncoding, resolveInWorkspace, tryToRel, workspaceFolders, workspaceRoot } from "../util";
import { Session } from "./Session";
import { Suggestion } from "./SessionData";
import { describeActions, describeResults, Transcript, TranscriptEvent } from "./Transcript";
import { INSTRUCTION_FILES, RULES_FILE, TurnEngine } from "./TurnEngine";

const HELP = [
  "Napište zadání a odešlete (Enter). Prompt se zkopíruje do schránky; vložte ho do chatu (Copilot v Teams, claude.ai…),",
  "zkopírujte odpověď modelu (tlačítko kopírovat u bloku kódu) a Copy Agent ji sám převezme.",
  "",
  "Příkazy: /plan zadání (režim PLAN s checklistem), /suggest (návrhy skillů, hooků a úkolů z průběhu), /auto (schvalování",
  "příkazů), /resend (nový chat), /undo (vrátit kolo), /stop, /new (vyčistit), /status, /skills, /instructions (instrukce",
  "pro agenta v Copilotu do schránky), /název-skillu zadání.",
  "",
  "Vestavěné skilly: /init (AGENTS.md z průzkumu projektu), /commit, /review, /test, /fix <chyba>, /explain <co>, /docs, /deps.",
  "Vlastní skilly: .copy-agent/skills/ (projekt) nebo ~/.copy-agent/skills/ (uživatel).",
  "",
  "Během čekání na odpověď můžete psát poznámky; přiloží se k dalšímu promptu. Když se model zeptá, odpověď napište sem.",
  "Nastavení: tlačítko ⚙ v horní liště, nebo Ctrl+, a hledat „copyAgent“. Instrukce pro projekt: AGENTS.md v kořeni.",
].join("\n");

export class Controller implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly output = vscode.window.createOutputChannel("Copy Agent");
  private cts: vscode.CancellationTokenSource | undefined;
  private pendingNotes: string[] = [];
  private engine: TurnEngine | undefined;
  private host: VsCodeHost | undefined;
  private transcript: Transcript | undefined;
  items: TranscriptEvent[] = [];
  skills: SlashCommand[] = [];
  log: string[] = [];
  currentAction: { tool: string; target: string; startedAt: number; index: number; total: number } | undefined;
  private execAbort: AbortController | undefined;
  /** "fresh" = prompt ve schránce, ještě nevložen; "sent" = vložen, čeká se na model */
  promptPhase: "fresh" | "sent" | undefined;
  builtinSkillsDir?: string;
  /** přiložit celou codebase k dalšímu úkolu (zaškrtávátko v panelu; výchozí z copyAgent.context.fullBundle) */
  fullBundle = true;
  private readonly configSub: vscode.Disposable;

  setFullBundle(value: boolean): void {
    this.fullBundle = value;
    this.changeEmitter.fire();
  }

  constructor(
    readonly session: Session,
    readonly review: ReviewManager,
    readonly clipboard: ClipboardBridge,
    private readonly checkpoint: Checkpoint,
    readonly approvals: ApprovalService,
  ) {
    approvals.onDidChange(() => this.changeEmitter.fire());
    clipboard.onDidPaste(() => {
      // vícekrokové doručení: po vložení textu se další krok (část textu, nebo přílohy) zkopíruje sám
      const s = this.session.current;
      if (s?.pendingSteps && (s.pendingStepIndex ?? 0) < s.pendingSteps.length - 1) setTimeout(() => void this.nextStep(true), 500);
      else if (this.promptPhase === "fresh") this.setPromptPhase("sent");
    });
    clipboard.onDidCopyOther(() => {
      if (this.promptPhase === "fresh") this.setPromptPhase("sent");
    });
    clipboard.onDidLog((l) => this.logLine(l));
    clipboard.onDidNotify((n) => this.pushItem({ kind: "info", turn: this.session.current?.turn, text: n.text, data: { icon: n.icon } }));
    this.fullBundle = cfg<boolean>("context.fullBundle", true);
    // změna nastavení přepíše zaškrtávátko v panelu na novou výchozí hodnotu
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG}.context.fullBundle`)) this.setFullBundle(cfg<boolean>("context.fullBundle", true));
    });
    this.reloadSkills();
  }

  private setPromptPhase(phase: "fresh" | "sent" | undefined): void {
    if (this.promptPhase === phase) return;
    this.promptPhase = phase;
    this.changeEmitter.fire();
  }

  // ---------- veřejné API pro UI ----------

  commands(): SlashCommand[] {
    return [...BUILTIN_COMMANDS, ...this.skills];
  }

  reloadSkills(): void {
    try {
      this.skills = loadSkills(workspaceRoot().fsPath, this.builtinSkillsDir);
    } catch {
      this.skills = [];
    }
    this.changeEmitter.fire();
  }

  /** Odkud skill je: vestavěný (součást rozšíření), globální (~/.copy-agent/skills), projektový (.copy-agent/skills). */
  private skillScope(k: SlashCommand): "built-in" | "global" | "project" {
    if (k.builtin) return "built-in";
    return k.source?.startsWith(os.homedir()) ? "global" : "project";
  }

  private skillsForPrompt(): { name: string; description: string; scope: "built-in" | "global" | "project" }[] {
    return this.skills.map((k) => ({ name: k.name, description: k.description, scope: this.skillScope(k) }));
  }

  /** Instrukce pro agenta v Copilotu (Teams) do schránky. */
  async copyAgentInstructions(): Promise<void> {
    const text = buildAgentInstructions({ language: cfg("prompt.language", "cs"), replyMaxChars: cfg("reply.maxChars", 9000), bundleUsage: cfg<BundleUsage>("bundle.usage", "encourage"), reviewBeforeDone: cfg<ReviewMode>("review.beforeDone", "auto") });
    await vscode.env.clipboard.writeText(text);
    this.pushItem({ kind: "system", text: `Instrukce pro agenta v Copilotu jsou ve schránce (${text.length} znaků z limitu 8 000). V Teams: Copilot → Agenti → Vytvořit agenta → Konfigurovat → Pokyny → vložit. Návod: copilot-agent/NAVOD.md.` });
    vscode.window.setStatusBarMessage(`$(clippy) Copy Agent: instrukce pro agenta ve schránce (${text.length} znaků)`, 6000);
  }

  /** Jediný vstup z chatu: zadání, odpověď na otázku, poznámka, ruční vložení odpovědi, /příkazy. */
  async submit(input: string): Promise<void> {
    const raw = input.trim();
    if (!raw) return;
    const s = this.session.current;
    if (s && s.state === "waitingForReply" && looksLikeReply(raw, this.clipboard.currentPrompt)) {
      this.submitReply(raw);
      return;
    }
    const parsed = parseInput(raw, this.commands());
    for (const u of parsed.unknown) this.pushItem({ kind: "error", text: `Neznámý příkaz /${u}` });
    for (const c of parsed.commands) {
      switch (c) {
        case "stop":
          this.abort();
          return;
        case "undo":
          await this.undoTurn();
          return;
        case "resend":
          await this.resendContext();
          return;
        case "auto":
          await this.approvals.setMode(this.approvals.mode === "auto" ? "ask" : "auto");
          this.pushItem({ kind: "system", text: `Schvalování příkazů: ${this.approvals.mode === "auto" ? "automaticky" : "ptát se"}` });
          return;
        case "help":
          this.pushItem({ kind: "system", text: HELP });
          return;
        case "instructions":
          await this.copyAgentInstructions();
          return;
        case "new":
          if (s && !["idle", "done"].includes(s.state)) this.abort();
          this.items = [];
          this.pushItem({ kind: "system", text: "Panel vyčištěn. Napište nové zadání." });
          return;
        case "status":
          this.pushItem({ kind: "system", text: this.describeStatus() });
          return;
        case "skills":
          this.pushItem({
            kind: "system",
            text: this.skills.length
              ? "Skilly (nápověda: /název --help):\n" + this.skills.map((k) => `/${k.name} – ${k.description} [${this.skillScope(k)}]`).join("\n") + "\n\nNový skill: /skill-creator <název> <k čemu je> [--local]"
              : "Žádné skilly. Nový vytvoříte přes /skill-creator <název> <k čemu je>.",
          });
          return;
        case "suggest":
          await this.runSuggest();
          return;
      }
    }
    // `/skill --help`: nápověda ze SKILL.md rovnou v panelu, bez kola s modelem
    if (parsed.skills.length && isHelpRequest(parsed.text)) {
      for (const k of parsed.skills) this.pushItem({ kind: "system", text: skillHelp(k) + `\n\n(${this.skillScope(k)}: ${k.source ?? "vestavěný"})` });
      return;
    }
    const planMode = parsed.commands.includes("plan");
    if (s && s.state === "awaitingUser" && parsed.text) {
      await this.answerQuestion(parsed.text);
      return;
    }
    const looksLikeModelReply = raw.includes("<copy") || (raw.length > 1500 && classifyProse(raw) === "document");
    if (s && (s.state === "waitingForReply" || s.state === "awaitingUser") && parsed.commands.length === 0 && looksLikeModelReply) {
      this.submitReply(raw);
      return;
    }
    if (s && (s.state === "waitingForReply" || s.state === "executing") && parsed.text) {
      const noteText = parsed.text + (await this.refsBlock(parsed.text));
      s.notes = [...(s.notes ?? []), noteText];
      this.session.update({ notes: s.notes });
      this.pushItem({ kind: "note", text: parsed.text, data: { refs: parseRefs(parsed.text).map((r) => r.raw) } });
      await this.transcript?.append({ session: s.id, kind: "note", text: parsed.text });
      return;
    }
    if (!parsed.text && parsed.skills.length === 0) {
      if (planMode) this.pushItem({ kind: "system", text: "Napište za /plan i zadání úkolu." });
      return;
    }
    await this.start(composeTask(parsed), planMode, raw);
  }

  private describeStatus(): string {
    const s = this.session.current;
    if (!s) return "Žádné sezení. Napište zadání.";
    const states: Record<string, string> = {
      idle: "nečinný",
      waitingForReply: this.promptPhase === "sent" ? "čekám na odpověď modelu (prompt vložen)" : "prompt je ve schránce, ještě nebyl vložen",
      executing: `provádím akce${this.currentAction ? ` (${this.currentAction.tool})` : ""}`,
      awaitingUser: "čekám na vaši odpověď",
      done: "hotovo",
    };
    const lines = [`Sezení ${s.id}: ${states[s.state] ?? s.state}, kolo ${s.turn}${s.planMode ? " + PLAN" : ""}.`, `Schvalování příkazů: ${this.approvals.mode === "auto" ? "automaticky" : "ptát se"}; výjimek: ${this.approvals.allowPatterns().length}.`];
    if (s.pendingSteps && s.pendingSteps.length > 1) lines.push(`Doručení promptu má ${s.pendingSteps.length} kroků, ve schránce je krok ${(s.pendingStepIndex ?? 0) + 1}.`);
    if (s.plan) {
      const items = s.plan.split("\n").filter((l) => /^\s*- \[[ xX]\]/.test(l));
      lines.push(`Plán: ${items.filter((l) => /\[[xX]\]/.test(l)).length}/${items.length} hotovo.`);
    }
    if (s.pendingQuestion) lines.push(`Otázka: ${s.pendingQuestion}`);
    return lines.join("\n");
  }

  async start(task: string, planMode = false, original?: string): Promise<void> {
    if (this.session.current && !["idle", "done"].includes(this.session.current.state)) {
      const pick = await vscode.window.showWarningMessage("Běží jiný úkol. Zrušit ho a začít nový?", { modal: true }, "Zrušit a začít");
      if (pick !== "Zrušit a začít") return;
      this.abort();
    }
    workspaceRoot();
    const previous = this.session.current?.id;
    const s = this.session.start(task);
    s.planMode = planMode;
    this.items = [];
    this.pushItem({ kind: "task", text: original ?? task, data: { planMode } });
    this.logLine(`▶ Nový úkol${planMode ? " (PLAN)" : ""}: ${task.split("\n")[0]}`);
    const engine = this.newEngine();
    await this.ensureVcsIgnore();
    await engine.archivePlan(previous);
    await this.transcript?.append({ session: s.id, kind: "task", text: task, data: { planMode } });
    const refs = await resolveRefs(engine.host, original ?? task, this.activeEditor());
    const ctx = await engine.gatherContext(this.activeEditor(), this.skillsForPrompt(), original ?? task, refs.map((r) => r.path));
    ctx.refs = renderRefs(refs);
    // celá codebase jako jeden .txt k úvodnímu promptu: model má vše hned, úkol zvládne v méně kolech
    const bundle = await engine.attachInitialBundle(ctx, s.turn, this.fullBundle);
    if (bundle.info) this.pushItem({ kind: "info", turn: s.turn, text: `Celá codebase přiložena jako ${bundle.info.file.split("/").pop()} (${bundle.info.files} souborů, ${kb(bundle.info.chars)}).`, data: { icon: "paperclip" } });
    else if (bundle.reason === "disabled") this.pushItem({ kind: "info", turn: s.turn, text: "Celá codebase se nepřikládá (vypnuto zaškrtávátkem v panelu); v promptu jsou jen automaticky vybrané soubory.", data: { icon: "info" } });
    else if (bundle.reason) this.pushItem({ kind: "info", turn: s.turn, text: `Codebase se nepodařilo zabalit (${bundle.reason}); v promptu jsou jen automaticky vybrané soubory.`, data: { icon: "info" } });
    const prompt = engine.initialPrompt(s, ctx);
    void this.loop(prompt, false, bundle.file ? [bundle.file] : []);
  }

  async runSuggest(): Promise<void> {
    workspaceRoot();
    const engine = this.engine ?? this.newEngine();
    const events = (await this.transcript?.readAll()) ?? [];
    if (events.length === 0) {
      this.pushItem({ kind: "system", text: "Zatím není žádný průběh k analýze (.copy-agent/transcript.jsonl je prázdný)." });
      return;
    }
    let s = this.session.current;
    if (!s || ["done", "idle"].includes(s.state)) {
      s = this.session.start("/suggest");
      this.items = [];
    } else if (s.state !== "awaitingUser") {
      this.pushItem({ kind: "system", text: "Návrhy jde spustit až po dokončení běžícího úkolu (nebo použijte /stop)." });
      return;
    }
    this.pushItem({ kind: "task", text: "/suggest – návrhy z průběhu práce" });
    const summary = Transcript.summarize(events);
    const ctx = await engine.gatherContext(undefined, this.skillsForPrompt());
    ctx.existing = { ...ctx.existing, skillBodies: this.skills.slice(0, 12).map((k) => ({ name: k.name, body: k.body ?? "" })) };
    const prompt = engine.suggestPrompt(s, summary, ctx, Transcript.suggestionHistory(events));
    this.logLine("💡 Žádám model o návrhy z průběhu.");
    void this.loop(prompt);
  }

  async decideSuggestion(id: string, approve: boolean): Promise<void> {
    const s = this.session.current;
    const sug = s?.suggestions?.find((x) => x.id === id);
    if (!s || !sug || sug.decision) return;
    sug.decision = approve ? "approved" : "rejected";
    if (approve) {
      try {
        await this.applySuggestion(sug);
        this.pushItem({ kind: "system", text: `Návrh „${sug.title}“ použit (${sug.kind}).` });
      } catch (e) {
        sug.decision = undefined;
        this.pushItem({ kind: "error", text: `Návrh se nepodařilo použít: ${(e as Error).message}` });
      }
    }
    await this.transcript?.append({ session: s.id, kind: "suggestion", text: `${sug.kind}: ${sug.title} → ${sug.decision}` });
    this.session.update({ suggestions: s.suggestions });
  }

  async decideAllSuggestions(approve: boolean): Promise<void> {
    const pending = (this.session.current?.suggestions ?? []).filter((x) => !x.decision);
    for (const sug of pending) await this.decideSuggestion(sug.id, approve);
  }

  private async isDuplicateSuggestion(sug: Suggestion): Promise<boolean> {
    if (sug.update) return false;
    const host = this.host ?? this.newEngine().host;
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const body = norm(sug.body);
    try {
      switch (sug.kind) {
        case "skill":
          return this.skills.some((k) => k.name === norm(sug.title).replace(/[^a-z0-9._-]+/g, "-") || (k.body && norm(k.body) === body));
        case "rule": {
          const rules = [...readGlobalRules()];
          if (await host.exists(RULES_FILE)) rules.push(...(await host.readFile(RULES_FILE)).split(/\r?\n/).map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean));
          return rules.some((r) => norm(r) === body);
        }
        case "instructions": {
          const texts = [readGlobalInstructions()];
          for (const f of INSTRUCTION_FILES) if (await host.exists(f)) texts.push(await host.readFile(f));
          return body.length > 0 && texts.map(norm).some((t) => t.includes(body));
        }
        case "hook": {
          const h = JSON.parse(sug.body) as { match?: string; run?: string };
          return [...readGlobalHooks(), ...(await loadHooks(host))].some((x) => x.match === h.match && x.run === h.run);
        }
        case "allow":
          return (host.policy.allowPatterns ?? []).includes(sug.body.trim()) || host.policy.autoAllow.some((a) => norm(a) === body);
        case "task": {
          const plan = (await host.exists(PLAN_FILE)) ? norm(await host.readFile(PLAN_FILE)) : "";
          return plan.includes(norm(sug.title));
        }
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  private async applySuggestion(sug: Suggestion): Promise<void> {
    const host = this.host ?? this.newEngine().host;
    const global = sug.scope === "global";
    if (["rule", "instructions", "skill", "script", "agent", "task"].includes(sug.kind)) sug.body = decodeEntities(sug.body);
    switch (sug.kind) {
      case "skill": {
        if (sug.update) {
          const existing = this.skills.find((k) => k.name === sug.update!.toLowerCase().replace(/^\//, ""));
          if (!existing?.source) throw new Error(`skill /${sug.update} neexistuje`);
          fs.writeFileSync(existing.source, sug.body.trim() + "\n", "utf8");
        } else saveSkill(workspaceRoot().fsPath, sug.title, sug.body, global);
        this.reloadSkills();
        return;
      }
      case "script": {
        const saved = saveScript(workspaceRoot().fsPath, sug.title, sug.body, { global, lang: sug.lang, file: sug.file });
        this.pushItem({ kind: "system", text: `Skript uložen do ${saved.rel}. Spustíte ho příkazem: ${saved.command}` });
        return;
      }
      case "instructions": {
        if (global) appendGlobalInstructions(sug.body);
        else {
          const file = (await Promise.all(INSTRUCTION_FILES.map(async (f) => ((await host.exists(f)) ? f : undefined)))).find(Boolean) ?? INSTRUCTION_FILES[0];
          await host.appendFile(file, `\n${sug.body.trim()}\n`);
        }
        return;
      }
      case "rule": {
        const rule = sug.body.replace(/\s+/g, " ").trim() || sug.title;
        if (sug.update) {
          const n = Number((sug.update.match(/(\d+)/) ?? [])[1]);
          const globalRules = readGlobalRules();
          if (!n) throw new Error(`neplatný cíl úpravy "${sug.update}", čekáno "rule N"`);
          if (n <= globalRules.length) replaceGlobalRule(n - 1, rule);
          else {
            const lines = (await host.exists(RULES_FILE)) ? (await host.readFile(RULES_FILE)).split(/\r?\n/) : [];
            const idx = lines.map((l, i) => (l.replace(/^\s*[-*]\s+/, "").trim() && !l.trim().startsWith("#") ? i : -1)).filter((i) => i >= 0)[n - globalRules.length - 1];
            if (idx === undefined) throw new Error(`pravidlo ${n} neexistuje`);
            lines[idx] = `- ${rule}`;
            await host.writeFile(RULES_FILE, lines.join("\n"));
          }
          return;
        }
        if (global) appendGlobalRule(rule);
        else await host.appendFile(RULES_FILE, `- ${rule}\n`);
        return;
      }
      case "hook": {
        const hook = JSON.parse(sug.body) as { match?: string; run?: string; cwd?: string };
        if (!hook.match || !hook.run) throw new Error('hook musí být JSON s "match" a "run"');
        const entry = { match: hook.match, run: hook.run, cwd: hook.cwd };
        if (sug.update) {
          if (replaceGlobalHook(sug.update, entry)) return;
          const own = await loadProjectHooks(host);
          const j = own.findIndex((h) => h.match === sug.update);
          if (j < 0) throw new Error(`hook s match "${sug.update}" neexistuje`);
          own[j] = entry;
          await saveProjectHooks(host, own);
          return;
        }
        if (global) addGlobalHook(entry);
        else await addHook(host, entry);
        return;
      }
      case "allow":
        await this.approvals.addAllowPattern(sug.body.trim(), global);
        return;
      case "setting": {
        const s = JSON.parse(sug.body) as { key?: string; value?: unknown };
        if (!s.key || !s.key.startsWith(`${CONFIG}.`) || s.value === undefined) throw new Error(`setting musí být JSON {"key": "${CONFIG}.…", "value": …}`);
        await vscode.workspace.getConfiguration(CONFIG).update(s.key.slice(CONFIG.length + 1), s.value, global ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
        return;
      }
      case "agent":
        appendAgentFeedback(sug.title, sug.body, workspaceRoot().fsPath);
        return;
      case "task": {
        const current = (await host.exists(PLAN_FILE)) ? await host.readFile(PLAN_FILE) : "";
        const line = `- [ ] ${sug.title}${sug.body.trim() ? `: ${sug.body.trim().split("\n")[0]}` : ""}`;
        const plan = current.trimEnd() + (current.trim() ? "\n" : "") + line + "\n";
        await host.writeFile(PLAN_FILE, plan);
        this.session.update({ plan });
        return;
      }
    }
  }

  async answerQuestion(answer: string): Promise<void> {
    const s = this.session.current;
    if (!s || s.state !== "awaitingUser" || !this.engine) return;
    this.pushItem({ kind: "answer", text: answer });
    await this.transcript?.append({ session: s.id, kind: "answer", text: answer });
    const attachments = this.engine.undeliveredAttachments(s);
    const prompt = await this.engine.answerPrompt(s, answer + (await this.refsBlock(answer)), this.drainNotes());
    this.session.update({ pendingQuestion: undefined, pendingOptions: undefined, pendingMulti: undefined });
    void this.loop(prompt, false, attachments);
  }

  submitReply(text: string): void {
    if (!this.clipboard.submitManual(text)) vscode.window.setStatusBarMessage("Copy Agent teď na žádnou odpověď nečeká.", 4000);
  }

  /** Zkopíruje do schránky aktuální krok doručení (část promptu nebo přílohy) znovu. */
  async copyPromptAgain(): Promise<void> {
    const s = this.session.current;
    if (!s?.pendingPrompt) return void vscode.window.setStatusBarMessage("Copy Agent: není žádný prompt k zkopírování.", 4000);
    await this.copyStep(s.pendingStepIndex ?? 0, false);
  }

  /** Další krok doručení do schránky (ručně tlačítkem/Ctrl+Alt+N, nebo automaticky po vložení textu). */
  async nextStep(auto = false): Promise<void> {
    const s = this.session.current;
    if (!s?.pendingSteps || s.pendingSteps.length <= 1) {
      if (!auto) vscode.window.setStatusBarMessage("Copy Agent: prompt má jen jeden krok.", 4000);
      return;
    }
    const next = (s.pendingStepIndex ?? 0) + 1;
    if (next >= s.pendingSteps.length) {
      if (!auto) vscode.window.setStatusBarMessage("Copy Agent: všechny kroky už byly zkopírovány.", 4000);
      return;
    }
    await this.copyStep(next, auto);
  }

  /**
   * Kroky doručení promptu: text po částech (limit chatu), pak přílohy jako soubory. S prompt.asFile
   * jde text jako copy-prompt-N.txt spolu s přílohami v jediném kroku (jedno Ctrl+V).
   */
  private buildSteps(prompt: string, attachments: string[]): import("./SessionData").DeliveryStep[] {
    const delivery = cfg<"text" | "history" | "file">("bundle.delivery", "file");
    const asFile = process.platform === "win32" && cfg<boolean>("prompt.asFile", false);
    const files = attachments.filter((a) => /\.(png|jpe?g|gif|webp|txt|md)$/i.test(a));
    if (asFile) return [{ kind: "files", files, promptFile: true }];
    const parts = splitPrompt(prompt, cfg<number>("prompt.maxChars", 80000), cfg("prompt.language", "cs"));
    const steps: import("./SessionData").DeliveryStep[] = parts.map((text, i) => ({ kind: "text", text, part: i + 1, total: parts.length }));
    if (files.length && delivery !== "history") steps.push({ kind: "files", files });
    return steps;
  }

  private async copyStep(index: number, auto: boolean): Promise<void> {
    const s = this.session.current;
    if (!s?.pendingSteps) return;
    const steps = s.pendingSteps;
    const step = steps[index];
    if (!step) return;
    const total = steps.length;
    if (step.kind === "text") {
      await this.clipboard.copyText(step.text, s.turn);
      this.session.update({ pendingStepIndex: index });
      this.setPromptPhase("fresh");
      this.notifyCopied(step.text.length, s.turn, "text", index, total);
      return;
    }
    const ok = await this.clipboard.copyFiles(step.files, step.promptFile ? s.pendingPrompt : undefined, s.turn);
    this.session.update({ pendingStepIndex: index });
    this.setPromptPhase(step.promptFile ? "fresh" : "sent");
    if (!ok) {
      if (delivery() === "history" || process.platform !== "win32") await this.clipboard.copyToHistory(step.files);
      this.logLine(`Přílohu přiložte ručně: ${step.files.join(", ")}`);
    }
    this.notifyCopied(0, s.turn, "file", index, total);
    function delivery(): string {
      return cfg<string>("bundle.delivery", "file");
    }
  }

  async showPrompt(): Promise<void> {
    const p = this.session.current?.pendingPrompt;
    if (!p) return;
    const doc = await vscode.workspace.openTextDocument({ content: decoratePrompt(p, this.session.current?.turn), language: "markdown" });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async showTranscript(): Promise<void> {
    await vscode.window.showTextDocument(vscode.Uri.joinPath(workspaceRoot(), STATE_DIR, "transcript.jsonl"), { preview: true });
  }

  async resendContext(): Promise<void> {
    const s = this.session.current;
    if (!s) return void vscode.window.showInformationMessage("Není aktivní úkol.");
    this.cancelWait();
    const engine = this.engine ?? this.newEngine();
    const ctx = await engine.gatherContext(this.activeEditor(), this.skillsForPrompt());
    const prompt = engine.resumePrompt(s, ctx);
    this.pushItem({ kind: "system", text: "Kontext znovu odeslán (nový chat)." });
    void this.loop(prompt);
  }

  async undoTurn(): Promise<void> {
    const s = this.session.current;
    const last = s?.history[s.history.length - 1];
    if (!s || !last) return void vscode.window.showInformationMessage("Není co vracet.");
    const msg = await this.checkpoint.undoLast();
    this.review.forgetTurn(last.turn);
    this.pendingNotes.push(`The user reverted ALL file changes made in turn ${last.turn}. The workspace is back to the state before that turn.`);
    this.pushItem({ kind: "undo", turn: last.turn, text: msg });
    await this.transcript?.append({ session: s.id, kind: "undo", turn: last.turn, text: msg });
  }

  abort(): void {
    const id = this.session.current?.id;
    this.cancelWait();
    this.execAbort?.abort();
    this.session.clear();
    this.setPromptPhase(undefined);
    this.pushItem({ kind: "system", text: "Úkol zrušen." });
    if (id) void this.transcript?.append({ session: id, kind: "error", text: "task aborted by user" });
  }

  /** Přeruší běžící provádění akcí; modelu se pošlou dosavadní výsledky s vysvětlením. */
  interrupt(): void {
    if (!this.execAbort) {
      vscode.window.setStatusBarMessage("Copy Agent: teď se nic neprovádí.", 3000);
      return;
    }
    this.execAbort.abort();
    this.pushItem({ kind: "system", text: "Provádění přerušeno uživatelem; výsledky a vysvětlení jdou modelu." });
  }

  /** Ručně pošle opravný prompt (odpověď bez bloku nebyla otázka, ale chyba protokolu). */
  async sendCorrection(): Promise<void> {
    const s = this.session.current;
    if (!s || s.state !== "waitingForReply") return;
    this.cancelWait();
    this.pushItem({ kind: "system", text: "Posílám opravný prompt." });
    void this.loop(buildCorrectionPrompt(s.id, s.turn, ["The previous reply contained no <copy> block with actions."], { language: cfg("prompt.language", "cs") }));
  }

  /**
   * Pomocné soubory agenta (.copy-agent/) a AGENTS.md nepatří do správy verzí: doplní je do .gitignore
   * a svn:ignore každé složky workspace pod gitem/SVN (copyAgent.vcs.autoIgnore). Nikdy nevyhazuje.
   */
  private async ensureVcsIgnore(): Promise<void> {
    if (!cfg<boolean>("vcs.autoIgnore", true)) return;
    try {
      const notes = await ensureVcsIgnore(workspaceFolders().map((f) => f.fsPath), { log: (l) => this.logLine(l) });
      for (const n of notes) this.pushItem({ kind: "system", text: n });
    } catch (e) {
      this.logLine(`ignore ve správě verzí: ${(e as Error).message}`);
    }
  }

  /** Po restartu VS Code naváže na uložené sezení. */
  async resume(): Promise<void> {
    const s = await this.session.restore();
    if (!s) return;
    this.newEngine();
    await this.ensureVcsIgnore();
    const events = (await this.transcript?.readAll()) ?? [];
    this.items = events.filter((e) => e.session === s.id && e.kind !== "prompt");
    this.logLine(`↻ Obnoveno sezení ${s.id}, kolo ${s.turn}, stav ${s.state}.`);
    if (s.state === "waitingForReply" && s.pendingPrompt) void this.loop(s.pendingPrompt, true, s.pendingAttachments ?? []);
    this.changeEmitter.fire();
  }

  // ---------- smyčka ----------

  private async loop(prompt: string, skipCopy = false, attachments: string[] = []): Promise<void> {
    this.cancelWait();
    this.cts = new vscode.CancellationTokenSource();
    const token = this.cts.token;
    const engine = this.engine!;
    let copyMode: "copy" | "recopy" | "none" = skipCopy ? "recopy" : "copy";
    let awaitingChat = false;
    try {
      while (!token.isCancellationRequested) {
        const s = this.session.current;
        if (!s) return;
        if (copyMode === "copy") {
          const steps = this.buildSteps(prompt, attachments);
          this.session.update({ state: "waitingForReply", pendingPrompt: prompt, pendingSteps: steps, pendingStepIndex: 0, pendingAttachments: attachments });
          const textParts = steps.filter((x) => x.kind === "text").length;
          this.pushItem({ kind: "prompt", turn: s.turn, text: textParts > 1 ? `${textParts} částí` : "text", data: { chars: prompt.length, parts: textParts, steps: steps.length, attachments } });
          await this.transcript?.append({ session: s.id, kind: "prompt", turn: s.turn, data: { chars: prompt.length, steps: steps.length } });
          await this.copyStep(0, false);
        } else if (copyMode === "recopy") {
          if (!awaitingChat) this.session.update({ state: "waitingForReply" });
          if (!s.pendingSteps) this.session.update({ pendingSteps: this.buildSteps(prompt, attachments), pendingStepIndex: 0 });
          await this.copyStep(s.pendingStepIndex ?? 0, false);
        } else if (!awaitingChat) this.session.update({ state: "waitingForReply" });
        copyMode = "copy";

        let replyText: string;
        try {
          replyText = await this.clipboard.waitForReply(token);
        } catch {
          this.setPromptPhase(undefined);
          return;
        }
        this.setPromptPhase(undefined);
        if (isOwnPrompt(replyText)) {
          this.logLine("⚠ Ve schránce je náš prompt, ne odpověď modelu; čekám dál.");
          copyMode = "none";
          continue;
        }
        if (awaitingChat) {
          awaitingChat = false;
          this.pushItem({ kind: "answer", text: "(odpovězeno přímo v chatu)" });
          this.session.update({ pendingQuestion: undefined, pendingOptions: undefined, pendingMulti: undefined });
        }
        const parsed = engine.parse(replyText, s.turn);
        if (parsed.turn !== null && parsed.turn !== s.turn) {
          const pick = await vscode.window.showWarningMessage(`Odpověď vypadá jako kolo ${parsed.turn}, ale čekám kolo ${s.turn}. Použít ji přesto?`, "Použít", "Ignorovat");
          if (pick !== "Použít") {
            copyMode = "none";
            continue;
          }
        }
        await this.transcript?.append({ session: s.id, kind: "reply", turn: s.turn, text: replyText.slice(0, 20000) });
        if (parsed.prose) this.pushItem({ kind: "status", turn: s.turn, text: parsed.prose.slice(0, 600) });
        const kind = parsed.actions.length ? "actions" : classifyProse(parsed.prose || replyText);
        if (kind === "question" && cfg<boolean>("ask.direct", true) && (s.noBlockReplies ?? 0) < 1) {
          this.session.update({ noBlockReplies: (s.noBlockReplies ?? 0) + 1 });
          this.pushItem({ kind: "dialog", turn: s.turn, text: replyText.trim().slice(0, 1500), data: { from: "model", live: true } });
          this.pushItem({ kind: "system", text: "Model odpověděl bez bloku akcí, nejspíš se ptá přímo v chatu. Odpovězte mu tam a zkopírujte jeho další odpověď. Pokud jde o chybu, použijte „Poslat opravný prompt“." });
          copyMode = "none";
          continue;
        }
        if (parsed.part) this.pushItem({ kind: "info", turn: s.turn, text: `Přijata část ${parsed.part.index}/${parsed.part.total} odpovědi.`, data: { icon: "clipboard" } });
        if (parsed.truncated) this.pushItem({ kind: "info", turn: s.turn, text: "Odpověď je useknutá (chat ořezal délku). Hotové akce se provedou, o zbytek si agent řekne.", data: { icon: "alert" } });
        if (parsed.errors.length) this.pushItem({ kind: "error", turn: s.turn, text: parsed.errors.join("\n") });
        if (parsed.notes.length) this.pushItem({ kind: "system", turn: s.turn, text: "Agent dorovnal: " + parsed.notes.join(" ") });
        const isFinalPart = !parsed.part || parsed.part.index >= parsed.part.total;
        if (parsed.actions.length && isFinalPart) {
          this.session.update({ state: "executing" });
          const all = [...(s.replyParts ?? []).flatMap((p) => p.actions), ...parsed.actions];
          this.pushItem({ kind: "actions", turn: s.turn, text: describeActions(all), data: all.map((a) => ({ tool: a.tool, target: a.attrs.path ?? a.attrs.pattern ?? a.attrs.title ?? a.attrs.from ?? (a.tool === "run" ? (a.body ?? "").trim().slice(0, 120) : "") })) });
          await this.transcript?.append({ session: s.id, kind: "actions", turn: s.turn, text: describeActions(all) });
          await this.checkpoint.take(s.turn);
        }
        this.execAbort = new AbortController();
        let idx = 0;
        const step = await engine.execute(s, parsed, prompt.length, this.drainNotes(), {
          signal: this.execAbort.signal,
          onStart: (a) => {
            idx++;
            const target = a.attrs.path ?? a.attrs.pattern ?? a.attrs.title ?? a.attrs.from ?? (a.tool === "run" ? (a.body ?? "").trim().split("\n")[0].slice(0, 100) : "");
            this.currentAction = { tool: a.tool, target, startedAt: Date.now(), index: idx, total: parsed.actions.filter((x) => !["status", "ask", "done", "dialog"].includes(x.tool)).length };
            this.changeEmitter.fire();
          },
          onEnd: () => {
            this.currentAction = undefined;
            this.changeEmitter.fire();
          },
        });
        const wasInterrupted = this.execAbort.signal.aborted;
        this.execAbort = undefined;
        this.currentAction = undefined;
        if (wasInterrupted) await this.transcript?.append({ session: s.id, kind: "error", turn: s.turn, text: "execution interrupted by user" });
        if (token.isCancellationRequested) return;
        this.session.update({});

        if (step.kind === "next" || step.kind === "done" || step.kind === "ask") {
          const rec = step.record;
          for (const d of rec.dialog ?? []) {
            this.pushItem({ kind: "dialog", turn: rec.turn, text: d.text, data: { from: d.from } });
            await this.transcript?.append({ session: s.id, kind: "dialog", turn: rec.turn, text: `${d.from}: ${d.text}` });
          }
          if (rec.status) this.pushItem({ kind: "status", turn: rec.turn, text: rec.status });
          this.pushItem({ kind: "results", turn: rec.turn, text: describeResults(rec.results), data: rec.results.map((r) => ({ tool: r.tool, target: r.attrs.path ?? r.attrs.pattern ?? r.meta?.command ?? "", status: r.status, meta: r.meta })) });
          if (rec.results.some((r) => ["write", "edit", "move", "delete"].includes(r.tool) && /(^|\/)\.copy-agent\/skills\//.test(String(r.attrs.path ?? r.attrs.to ?? r.attrs.from ?? "")))) this.reloadSkills();
          await this.transcript?.append({ session: s.id, kind: "results", turn: rec.turn, text: describeResults(rec.results) });
          if (s.plan && rec.actions.some((a) => a.tool === "plan")) {
            this.pushItem({ kind: "plan", turn: rec.turn, text: s.plan });
            await this.transcript?.append({ session: s.id, kind: "plan", turn: rec.turn, text: s.plan });
          }
          for (const sug of (s.suggestions ?? []).filter((x) => x.turn === rec.turn)) {
            if (await this.isDuplicateSuggestion(sug)) {
              sug.duplicate = true;
              sug.decision = "rejected";
            }
            this.pushItem({ kind: "suggestion", turn: rec.turn, text: `${sug.kind}: ${sug.title}`, data: sug });
            await this.transcript?.append({ session: s.id, kind: "suggestion", turn: rec.turn, text: `${sug.kind}: ${sug.title}${sug.duplicate ? " → duplicate" : ""}` });
          }
        }

        switch (step.kind) {
          case "correction":
            this.pushItem({ kind: "error", text: "Odpověď nešla zpracovat, posílám opravný prompt." });
            prompt = step.prompt;
            attachments = [];
            continue;
          case "continue":
            this.pushItem({ kind: "info", turn: s.turn, text: `Čekám na část ${step.received + 1}/${step.total} odpovědi; žádost o ni je ve schránce.`, data: { icon: "clipboard" } });
            prompt = step.prompt;
            attachments = [];
            continue;
          case "done":
            this.session.update({ state: "done", finalSummary: step.summary, pendingSteps: undefined });
            this.pushItem({ kind: "done", text: step.summary });
            await this.transcript?.append({ session: s.id, kind: "done", text: step.summary });
            this.notifyDone();
            return;
          case "ask":
            this.session.update({ state: "awaitingUser", pendingQuestion: step.question, pendingOptions: step.options, pendingMulti: step.multi, pendingSteps: undefined });
            this.pushItem({ kind: "ask", text: step.question, data: { options: step.options, multi: step.multi } });
            await this.transcript?.append({ session: s.id, kind: "ask", text: step.question });
            vscode.window.setStatusBarMessage(`$(question) Copy Agent se ptá: ${step.question.split("\n")[0].slice(0, 80)}`, 10000);
            awaitingChat = true;
            copyMode = "none";
            continue;
          case "next":
            if (step.review) {
              const line = `Revize ${step.review.round}: model poslal done, posílám mu celé znění ${step.review.files.length} změněných souborů ke kontrole. Finální je až done reviewed="true".`;
              this.pushItem({ kind: "info", turn: s.turn, text: line, data: { icon: "search" } });
              await this.transcript?.append({ session: s.id, kind: "status", turn: s.turn, text: line });
            }
            prompt = step.prompt;
            attachments = step.attachments;
        }
      }
    } catch (e) {
      this.pushItem({ kind: "error", text: `Chyba: ${(e as Error).message}` });
      void vscode.window.showErrorMessage(`Copy Agent: ${(e as Error).message}`);
      if (this.session.current) this.session.update({ state: "waitingForReply" });
    }
  }

  // ---------- pomocné ----------

  private newEngine(): TurnEngine {
    this.host?.dispose();
    const host = new VsCodeHost(this.output, this.approvals);
    this.host = host;
    this.transcript = new Transcript(host);
    const listener: ChangeListener = {
      onWillChange: (path, kind, baseline, turn) => {
        this.review.register(path, kind, baseline, turn);
        if (kind === "create") this.checkpoint.noteCreated(turn, path);
      },
      onWillDelete: (path, content, turn) => this.review.registerDelete(path, content, turn),
      approve: cfg<boolean>("review.requireApproval", false) ? (p, b, a) => this.approveDiff(p, b, a) : undefined,
    };
    const engine = new TurnEngine(
      host,
      {
        target: cfg<Target>("target", "copilot-agent"),
        maxChars: cfg("prompt.maxChars", 80000),
        maxParts: 6,
        resultMaxChars: cfg("prompt.resultMaxChars", 6000),
        replyMaxChars: cfg("reply.maxChars", 9000),
        language: cfg("prompt.language", "cs"),
        treeMaxEntries: cfg("prompt.treeMaxEntries", 120),
        planAuto: cfg("plan.auto", true),
        continuousSuggest: cfg("suggest.continuous", false),
        directDialog: cfg("ask.direct", true),
        bundleUsage: cfg<BundleUsage>("bundle.usage", "encourage"),
        reviewBeforeDone: cfg<ReviewMode>("review.beforeDone", "off"),
        autoContext: cfg("context.auto", true),
        autoContextMaxChars: cfg("context.autoMaxChars", 14000),
        bundleInline: cfg<string>("bundle.delivery", "file") === "text",
        fullContext: cfg<boolean>("context.fullBundle", true),
      },
      listener,
    );
    this.engine = engine;
    return engine;
  }

  private async approveDiff(path: string, before: string, after: string): Promise<boolean> {
    const left = await vscode.workspace.openTextDocument({ content: before });
    const right = await vscode.workspace.openTextDocument({ content: after });
    await vscode.commands.executeCommand("vscode.diff", left.uri, right.uri, `${path}: navrhovaná změna`);
    const pick = await vscode.window.showInformationMessage(`Aplikovat změnu v ${path}?`, { modal: true }, "Aplikovat");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    return pick === "Aplikovat";
  }

  private activeEditor(): ProjectContext["active"] | undefined {
    const editor = vscode.window.activeTextEditor;
    const rel = editor ? tryToRel(editor.document.uri) : undefined;
    if (!editor || !rel) return undefined;
    const sel = editor.selection;
    const active: ProjectContext["active"] = { path: rel };
    if (!sel.isEmpty) {
      active.selection = editor.document.getText(sel).slice(0, 4000);
      active.selectionRange = `${sel.start.line + 1}-${sel.end.line + 1}`;
    }
    return active;
  }

  async openFileAt(rel: string, line?: number, col?: number): Promise<void> {
    if (!rel) return;
    try {
      const doc = await openDocumentWithEncoding(resolveInWorkspace(rel));
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (line && line > 0) {
        const pos = new vscode.Position(Math.min(line - 1, doc.lineCount - 1), Math.max(0, (col ?? 1) - 1));
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      vscode.window.setStatusBarMessage(`Copy Agent: soubor ${rel} nelze otevřít.`, 4000);
    }
  }

  attachmentInfo(): { name: string; path: string; chars: number }[] {
    return (this.session.current?.pendingAttachments ?? []).map((rel) => {
      let chars = 0;
      try {
        chars = fs.statSync(resolveInWorkspace(rel).fsPath).size;
      } catch {
        /* soubor mohl zmizet */
      }
      return { name: rel.split("/").pop() ?? rel, path: rel, chars };
    });
  }

  async workspaceFiles(): Promise<string[]> {
    try {
      const host = this.host ?? this.newEngine().host;
      return await host.listFiles("**/*", 4000);
    } catch {
      return [];
    }
  }

  editorInfo(): { path?: string; selection?: string } | undefined {
    const a = this.activeEditor();
    return a ? { path: a.path, selection: a.selectionRange } : undefined;
  }

  private async refsBlock(text: string): Promise<string> {
    if (!parseRefs(text).length) return "";
    try {
      const host = this.host ?? this.newEngine().host;
      const block = renderRefs(await resolveRefs(host, text, this.activeEditor()));
      return block ? "\n\n" + block : "";
    } catch {
      return "";
    }
  }

  private drainNotes(): string[] {
    const s = this.session.current;
    const userNotes = (s?.notes ?? []).splice(0).map((n) => `User note while waiting: ${n}`);
    if (s) s.notes = [];
    return [...this.pendingNotes.splice(0), ...userNotes, ...this.review.drainNotes()];
  }

  private notifyCopied(chars: number, turn: number, mode: "text" | "file", index: number, total: number): void {
    const step = total > 1 ? ` (krok ${index + 1}/${total})` : "";
    vscode.window.setStatusBarMessage(mode === "file" ? `$(clippy) Copy Agent: kolo ${turn}${step}: soubory ve schránce, Ctrl+V v chatu` : `$(clippy) Copy Agent: prompt pro kolo ${turn}${step} je ve schránce (${kb(chars)})`, 6000);
    this.logLine(`📋 Kolo ${turn}${step}: ${mode === "file" ? "soubory ve schránce" : `prompt zkopírován (${kb(chars)})`}.`);
  }

  private notifyDone(): void {
    vscode.window.setStatusBarMessage(`$(check) Copy Agent dokončil úkol${this.review.hasPending ? ", zbývají změny ke schválení" : ""}`, 8000);
  }

  private pushItem(item: Omit<TranscriptEvent, "at" | "session">): void {
    const ev: TranscriptEvent = { at: new Date().toISOString(), session: this.session.current?.id ?? "-", ...item };
    this.items.push(ev);
    if (this.items.length > 400) this.items.shift();
    this.logLine(`${item.kind}${item.turn ? ` ${item.turn}` : ""}: ${(item.text ?? "").split("\n")[0].slice(0, 160)}`);
    this.changeEmitter.fire();
  }

  private cancelWait(): void {
    this.cts?.cancel();
    this.cts?.dispose();
    this.cts = undefined;
  }

  private logLine(line: string): void {
    const stamp = new Date().toLocaleTimeString("cs-CZ");
    this.output.appendLine(`[${stamp}] ${line}`);
    this.log.push(line);
    if (this.log.length > 300) this.log.shift();
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.cancelWait();
    this.configSub.dispose();
    this.host?.dispose();
    this.output.dispose();
    this.changeEmitter.dispose();
  }
}
