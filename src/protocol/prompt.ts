import { ActionResult, BLOCK, RESULTS, TOOLS } from "./schema";
import { compactOkOutput, truncate } from "./text";

/**
 * Stavitel promptů. Dva cíle:
 *  - `copilot-agent`: model běží jako agent v Copilotu (Teams) s instrukcemi z buildAgentInstructions();
 *    protokol zná, prompty jsou krátké (kontext + zadání, výsledky + připomínka).
 *  - `generic`: obecný chat bez instrukcí; první prompt nese celý popis protokolu.
 * Každý prompt se dělí na části podle limitu chatu (splitPrompt).
 */

export type Target = "copilot-agent" | "generic";
export type BundleUsage = "off" | "allow" | "encourage" | "prefer";
export type ReviewMode = "always" | "auto" | "off";

export interface PromptOptions {
  target: Target;
  /** maximální délka jedné zprávy pro chat */
  maxChars: number;
  /** nejvýš kolik částí smí jeden prompt mít; co se nevejde, se odloží */
  maxParts: number;
  /** maximální délka výstupu příkazu/hledání v promptu */
  resultMaxChars: number;
  /** kolik znaků má model nejvýš dát do jedné odpovědi (limit chatu na odpověď) */
  replyMaxChars: number;
  language: string;
  planMode?: boolean;
  planAuto?: boolean;
  continuousSuggest?: boolean;
  directDialog?: boolean;
  bundleUsage?: BundleUsage;
  reviewBeforeDone?: ReviewMode;
}

export const DEFAULT_OPTIONS: PromptOptions = {
  target: "copilot-agent",
  maxChars: 80000,
  maxParts: 6,
  resultMaxChars: 6000,
  replyMaxChars: 9000,
  language: "cs",
  reviewBeforeDone: "off",
};

export interface ProjectContext {
  workspaceName: string;
  /** obsah AGENTS.md / COPY-AGENT.md, pokud existuje */
  instructions?: string;
  tree: string;
  active?: { path: string; selection?: string; selectionRange?: string };
  diagnostics?: string;
  plan?: string;
  globalInstructions?: string;
  rules?: string[];
  skills?: { name: string; description: string; scope?: "built-in" | "global" | "project" }[];
  /** obsah souborů, na které uživatel odkázal přes #soubor (blok už hotový) */
  refs?: string;
  /** automaticky vybrané soubory podle zadání (blok už hotový) */
  autoContext?: string;
  /** celá codebase přiložená k tomuto promptu jako soubor */
  initialBundle?: { file: string; files: number; chars: number; skipped: number };
  roots?: { name: string; path: string }[];
  existing?: {
    hooks?: string[];
    allowPatterns?: string[];
    autoAllow?: string[];
    planOpen?: string[];
    settings?: Record<string, unknown>;
    skillBodies?: { name: string; body: string }[];
  };
}

export interface SuggestionHistory {
  approved: string[];
  rejected: string[];
}

export interface TurnSummary {
  turn: number;
  lines: string[];
}

export interface ResultsExtras {
  diagnostics?: string;
  userNotes?: string[];
  parseErrors?: string[];
  agentNotes?: string[];
  docTarget?: string;
}

const cs = (lang: string) => lang.toLowerCase().startsWith("cs");

function escapeAttr(v: string): string {
  return v.replace(/"/g, "&quot;").replace(/\n/g, " ");
}

/** Cesta dokumentu (.md/.txt) zmíněná v zadání, pokud nějaká je. */
export function documentPathInTask(task: string): string | undefined {
  return task.match(/(?:^|[\s"'`(])((?:[\w.-]+\/)*[\w.-]+\.(?:md|markdown|txt))(?=$|[\s"'`),.;:])/)?.[1];
}

// ---------------------------------------------------------------------------------------------
// Popis protokolu (společný pro instrukce agenta i preambuli obecného chatu)

export const FENCE = "````";

function actionLines(short: boolean): string[] {
  return TOOLS.map((t) => {
    const attrs = t.attrs.map((a) => `${a.name}${a.required ? "" : "?"}`).join(" ");
    const sig = t.hasBody ? `<${t.name}${attrs ? " " + attrs : ""}>body</${t.name}>` : `<${t.name}${attrs ? " " + attrs : ""}/>`;
    if (short) return `- ${sig}: ${t.short ?? t.doc}`;
    const docs = t.attrs.map((a) => `${a.name}${a.required ? "" : "?"}: ${a.doc}`).join("; ");
    return [`### ${sig}`, t.doc, docs ? `Attributes: ${docs}` : "", t.bodyDoc ? `Body: ${t.bodyDoc}` : "", "Example:", t.example, ""].filter((l) => l !== "").join("\n");
  });
}

function formatSection(): string[] {
  return [
    "## Reply format",
    `Every reply contains exactly ONE block, and the whole block sits inside a code fence of four backticks (${FENCE}) so the user copies it with one click:`,
    FENCE,
    `<${BLOCK} turn="N" session="S">`,
    "…actions…",
    `</${BLOCK}>`,
    FENCE,
    "N and S are given in the message you answer. The program reads only the block; everything outside it is discarded (a one-line remark is fine).",
    `Bodies of <write>, <edit>, <run>, <ask>, <status>, <done> are verbatim plain text: write <, > and & as plain characters (never &lt;), no <![CDATA[ ]]>, no extra code fence inside a body. Use <think>…</think> inside the block for reasoning.`,
  ];
}

function rulesSection(o: PromptOptions, short: boolean): string[] {
  const kb = Math.round(o.replyMaxChars / 1000);
  const rules: string[] = [];
  rules.push(
    "FEWEST REPLIES: every reply costs the user manual copy-paste work, so finish the task in as few replies as possible, ideally ONE. The first message usually attaches the complete codebase (one text file) or shows the relevant files: then do the whole job in your first reply (all edits, a test run, <done>). Do not ask questions you can answer with a reasonable assumption; state assumptions in <done>. Ask only when truly blocked.",
  );
  rules.push(
    "BATCH when you must look first: request in ONE reply everything you will plausibly need (5-15 read/grep/ls actions" +
      (o.bundleUsage === "off" ? "" : ", or one <bundle> for a whole module") +
      "). Never ask for files one at a time. Files already shown (attached codebase, referenced or auto-selected files) need no <read>. The prompt itself may arrive as an attached file copy-prompt-N.txt: treat its content as the message.",
  );
  if (o.bundleUsage === "prefer") rules.push("PREFER <bundle> whenever you need more than two files or do not yet know which files matter; keep <read> for one file or a line range.");
  else if (o.bundleUsage === "encourage" || o.bundleUsage === undefined) rules.push("Above about five files use one <bundle> instead of many <read>s.");
  else if (o.bundleUsage === "off") rules.push("Do not use <bundle>; request files with <read>.");
  rules.push("Prefer <edit> with small, unique SEARCH blocks; use <write> only for new files or full rewrites. Never repeat unchanged content.");
  rules.push(
    "After changing code, verify in the same turn: <run> tests/build, then <diagnostics/> last. Fix what comes back. LEAVE EVERY FILE VALID: the program checks syntax and protocol residue (CDATA, entities, hunk markers, fences); an invalid file is a failed action and blocks <done>.",
  );
  rules.push(
    `REPLY SIZE: the chat cuts long replies. Keep one reply under about ${kb} 000 characters. When the work is longer, send it as several replies with part="1/2", part="2/2"… in the ${BLOCK} tag: each part is a complete block (opened and closed) and the actions simply continue; the user forwards each part. A cut-off action is never executed; the program tells you which one to resend.`,
  );
  rules.push('A message marked [PART i/n] is one piece of a longer prompt: reply only "OK" and wait; answer the whole prompt only after the part marked LAST.');
  rules.push(
    `<${RESULTS}> brings the results of your actions. <protocol-error> means your previous reply could not be used (resend it as a proper block); <note> is what the program fixed or did for you; <user> is a note or answer from the user; <diagnostics> are editor errors. Never include <${RESULTS}> in your reply and do not explain the protocol back.`,
  );
  rules.push(
    'DOCUMENTS ARE FILES: when the deliverable is a document (proposal, README, any .md/.txt), put its complete text inside <write path="…"> in the block, never as chat text. To revise an existing document use <edit section="## Heading"> or small hunks.',
  );
  rules.push(
    "Use <ask options=\"A|B\"> when the task is ambiguous or a change is risky (deleting data, public APIs). Finish with <done> (summary for the user) as the LAST action; it may follow final actions in the same block (if one fails, the task continues)." +
      (o.reviewBeforeDone === "off" ? "" : ' After file changes the program may answer <done> with a REVIEW request and the complete content of the changed files: check the whole work against the task, fix what is missing, then <done reviewed="true">.'),
  );
  rules.push("ENCODING: send bodies as plain Unicode with real accented characters (č, š, ž, ü) and LF line breaks; the program keeps each file's own encoding, BOM and CRLF/LF.");
  rules.push(`Write <status>, <ask> and <done> in language "${o.language}"; code, identifiers and commit messages stay as in the project. If a previous action failed, read the error, adjust and retry; never repeat the identical action.`);
  if (o.planMode) {
    rules.push("PLAN MODE is ON: your FIRST block must contain <plan> with a hierarchical markdown checklist; keep it current in later turns (tick done items, add discovered work), resending the complete plan whenever it changes.");
  } else if (o.planAuto !== false) {
    rules.push("For larger tasks (several files or distinct steps) start with <plan> (markdown checklist) and keep it current; small tasks need no plan.");
  }
  if (o.directDialog !== false) {
    rules.push(
      'DIRECT DIALOGUE: the user reads this chat and may answer or clarify in plain text here. Ask with <ask> inside the block; when the user then writes to you directly, start your next block with <dialog from="user">their message verbatim</dialog> so the program records it.',
    );
  }
  if (o.continuousSuggest) {
    rules.push("When you notice something reusable (a repeated instruction, a safe command, a check to run after changes, a follow-up), add a rare, concrete <suggest>; it is never applied automatically.");
  }
  const lines = ["## Rules"];
  rules.forEach((r, i) => lines.push(`${i + 1}. ${short ? r : r}`));
  return lines;
}

function roleSection(short: boolean): string[] {
  return [
    `You are Copy Agent, the coding brain of a small program installed in the user's VS Code. The user pastes your reply into that program; it finds ONE block in your reply, carries out the file and command actions written in it (reads, searches, edits, runs commands; the user reviews every change) and pastes the results back here as the next message. You need no file access, plugin or integration: the program does the file work, you write the actions.${short ? "" : " Work like an experienced engineer dictating to an assistant: explore, change, verify."}`,
  ];
}

/**
 * Instrukce pro agenta v Copilotu (Teams) – Agent Builder má limit 8 000 znaků, proto krátké
 * popisy akcí. Generuje se z téže tabulky nástrojů jako parser, takže nemůže zastarat.
 */
export function buildAgentInstructions(opts: Partial<PromptOptions> = {}): string {
  const o: PromptOptions = { ...DEFAULT_OPTIONS, ...opts, planMode: false };
  return [
    ...roleSection(true),
    "",
    ...formatSection(),
    "",
    `## Actions (executed in order; results come back in the next message as <${RESULTS}>)`,
    ...actionLines(true),
    "",
    ...rulesSection(o, true),
    "",
    `The first message of a task holds the project context and the task; later messages hold <${RESULTS}>. Start every reply with the fenced block; put remarks after it.`,
  ].join("\n");
}

/** Plná preambule pro obecný chat (bez limitu délky; s příklady akcí). */
export function buildPreamble(ctx: ProjectContext, opts: PromptOptions): string {
  const parts: string[] = [];
  parts.push(`# Copy Agent session — project "${ctx.workspaceName}"`, "");
  parts.push(...roleSection(false), "");
  parts.push(...formatSection(), "");
  parts.push("## Actions", "", ...actionLines(false));
  parts.push(...rulesSection(opts, false), "");
  parts.push(...extraInstructions(ctx));
  return parts.join("\n");
}

/** Krátká hlavička pro agenta v Copilotu, který protokol už zná z instrukcí. */
export function buildAgentHeader(ctx: ProjectContext, opts: PromptOptions): string {
  const parts: string[] = [];
  parts.push(`# Copy Agent session — project "${ctx.workspaceName}"`, "");
  parts.push(
    `You are Copy Agent (see your instructions): reply with ONE fenced block <${BLOCK} turn="N" session="S">…</${BLOCK}> with the actions, batch requests, keep files valid, split long replies into parts.` +
      (opts.planMode ? " PLAN MODE is ON: the first block must contain <plan>." : "") +
      ` User language: "${opts.language}".`,
    "",
  );
  parts.push(...extraInstructions(ctx));
  return parts.join("\n");
}

function extraInstructions(ctx: ProjectContext): string[] {
  const parts: string[] = [];
  if (ctx.rules?.length) {
    parts.push("## Additional rules (learned from previous work; follow them)", "");
    ctx.rules.forEach((r, i) => parts.push(`${i + 1}. ${r}`));
    parts.push("");
  }
  if (ctx.globalInstructions?.trim()) parts.push("## User instructions (apply in every project)", "", ctx.globalInstructions.trim(), "");
  if (ctx.instructions?.trim()) parts.push("## Project instructions (AGENTS.md)", "", ctx.instructions.trim(), "");
  return parts;
}

export function buildContext(ctx: ProjectContext): string {
  const parts: string[] = [];
  if (ctx.roots && ctx.roots.length > 1) {
    parts.push(
      "## Workspace folders",
      "",
      `This workspace has ${ctx.roots.length} root folders. EVERY path starts with the folder name (in <read>, <write>, <edit>, <grep glob=…>, <bundle paths=…>, <run cwd=…>):`,
      ...ctx.roots.map((r) => `- ${r.name}/ → ${r.path}`),
      `A bare path like src/x.ts is rejected. <run> without cwd runs in ${ctx.roots[0].name}/.`,
      "",
    );
  }
  parts.push("## Project tree", "", ctx.tree.trim(), "");
  if (ctx.initialBundle) {
    const b = ctx.initialBundle;
    parts.push(
      "## Attached: the complete codebase",
      "",
      `The file ${b.file.split("/").pop()} attached to this message holds the complete codebase: ${b.files} text files (${b.chars} chars${b.skipped ? `; ${b.skipped} binary or ignored files skipped, listed in its header` : ""}). Each file starts with a line '===== FILE: <path> (<n> lines) =====' and continues verbatim.`,
      "Work from the attachment: do NOT request files you can see in it; edit them directly in your first reply. Request with <read> only what the attachment lacks or shows incompletely (large attachments may be shown to you in parts), and remember that files you changed are no longer as in the attachment.",
      "If you cannot see any attachment, say so in one sentence and ask the user to attach it (they have it in .copy-agent/out/).",
      "",
    );
  }
  if (ctx.active) {
    parts.push(`## Active editor: ${ctx.active.path}${ctx.active.selectionRange ? ` (selection ${ctx.active.selectionRange})` : ""}`);
    if (ctx.active.selection) parts.push("", ctx.active.selection);
    parts.push("");
  }
  if (ctx.refs?.trim()) parts.push(ctx.refs.trim(), "");
  if (ctx.autoContext?.trim()) parts.push(ctx.autoContext.trim(), "");
  if (ctx.diagnostics?.trim()) parts.push("## Current diagnostics", "", ctx.diagnostics.trim(), "");
  if (ctx.plan?.trim()) parts.push("## Current plan (maintain it with <plan>)", "", ctx.plan.trim(), "");
  if (ctx.skills?.length) {
    parts.push("## Available skills (the user invokes them with /name; their instructions are included in the task when used)", "");
    for (const s of ctx.skills) parts.push(`- /${s.name}${s.scope ? ` (${s.scope})` : ""}: ${s.description}`);
    parts.push("");
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Připomínka formátu

export interface ReminderOptions {
  docTarget?: string;
  language?: string;
  initial?: boolean;
  session?: string;
}

/** Připomínka formátu v jazyce uživatele a v první osobě (obecné chaty poslouchají hlas uživatele). */
export function replyReminder(turn: number, o: ReminderOptions = {}): string {
  const c = cs(o.language ?? "en");
  const open = `<${BLOCK} turn="${turn}"${o.session ? ` session="${o.session}"` : ""}>`;
  const base = c
    ? `Odpověď mi dej jako jeden blok ${open} … </${BLOCK}> uvnitř ohrazení ${FENCE} (čtyři zpětné apostrofy), samotnou práci dovnitř; můj program čte jen ten blok. Dlouhou odpověď rozděl na části (part="1/2").`
    : `Give me the reply as one block ${open} … </${BLOCK}> inside a ${FENCE} fence (four backticks), with the work itself inside it; my program reads only that block. Split a long reply into parts (part="1/2").`;
  if (o.docTarget) {
    const d = o.docTarget;
    return c
      ? `${base} Výstupem zadání je soubor ${d}, ne text v chatu: napiš ho jednou, uvnitř bloku:\n${FENCE}\n${open}\n<write path="${d}">\n…celý dokument…\n</write>\n<done>krátké shrnutí</done>\n</${BLOCK}>\n${FENCE}`
      : `${base} The output of this task is the file ${d}, not chat text: write it once, inside the block:\n${FENCE}\n${open}\n<write path="${d}">\n…the whole document…\n</write>\n<done>short summary</done>\n</${BLOCK}>\n${FENCE}`;
  }
  if (o.initial) {
    return c
      ? `${base} Chci co nejméně kol: když máš vše potřebné (přiložená codebase, soubory výše), udělej celou práci hned v této odpovědi (úpravy, testy, <done>); jen když ti něco chybí, vyžádej si to všechno najednou, např.:\n${FENCE}\n${open}\n<read path="cesta/k/souboru"/>\n<grep pattern="hledaný_text"/>\n</${BLOCK}>\n${FENCE}\nRadu v próze nebo kód mimo blok můj program nepoužije.`
      : `${base} I want as few turns as possible: when you have what you need (attached codebase, files above), do the whole job right in this reply (edits, tests, <done>); only if something is missing, request all of it at once, e.g.:\n${FENCE}\n${open}\n<read path="path/to/file"/>\n<grep pattern="text_to_find"/>\n</${BLOCK}>\n${FENCE}\nAdvice in prose or code outside the block is not used by my program.`;
  }
  return base;
}

function continueWord(language = "en"): string {
  return cs(language) ? "Pokračuj." : "Continue.";
}

// ---------------------------------------------------------------------------------------------
// Prompty

export function buildInitialPrompt(sessionId: string, task: string, ctx: ProjectContext, opts: PromptOptions): string {
  const head = opts.target === "generic" ? buildPreamble(ctx, opts) : buildAgentHeader(ctx, opts);
  return [
    head,
    buildContext(ctx),
    "## Task",
    "",
    task.trim(),
    "",
    `Session: ${sessionId}, turn 1. ${replyReminder(1, { docTarget: documentPathInTask(task), language: opts.language, initial: true, session: sessionId })}`,
  ].join("\n");
}

export function renderResult(r: ActionResult, opts: PromptOptions): string {
  const attrs = Object.entries(r.attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join("");
  const meta = Object.entries(r.meta ?? {})
    .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
    .join("");
  const attached = r.attachments?.length ? ` attached="${r.attachments.map((a) => a.split("/").pop()).join(",")}"` : "";
  const head = `<result of="${r.tool}"${attrs} status="${r.status}"${meta}${attached}`;
  if (!r.output?.trim()) return `${head}/>`;
  const body = r.output.replace(/\r\n/g, "\n");
  // obsah souboru se nikdy neusekává uprostřed (rozdělí se na části promptu); výstup příkazu ano
  const text = r.tool === "read" || r.tool === "bundle" ? body : r.tool === "run" && r.status === "ok" ? compactOkOutput(body, r.fullOutputPath) : truncate(body, opts.resultMaxChars, r.fullOutputPath).text;
  return `${head}>\n${text}\n</result>`;
}

export function buildResultsPrompt(
  sessionId: string,
  turn: number,
  results: ActionResult[],
  extras: ResultsExtras,
  opts: PromptOptions,
  history: TurnSummary[] = [],
  preambleForStateless?: string,
): string {
  const parts: string[] = [];
  if (preambleForStateless) {
    parts.push(preambleForStateless, "## History so far", "");
    for (const h of history) parts.push(`Turn ${h.turn}:`, ...h.lines.map((l) => `  - ${l}`));
    parts.push("");
  }
  parts.push(`<${RESULTS} turn="${turn - 1}" session="${sessionId}">`);
  for (const e of extras.parseErrors ?? []) parts.push(`<protocol-error>${e}</protocol-error>`);
  const tail: string[] = [];
  if (extras.diagnostics?.trim()) tail.push(`<diagnostics>\n${extras.diagnostics.trim()}\n</diagnostics>`);
  for (const n of extras.agentNotes ?? []) tail.push(`<note>${n.trim()}</note>`);
  for (const n of extras.userNotes ?? []) tail.push(`<user>${n.trim()}</user>`);
  tail.push(`${continueWord(opts.language)} ${replyReminder(turn, { docTarget: extras.docTarget, language: opts.language, session: sessionId })}`);
  tail.push(`</${RESULTS}>`);

  // rozpočet: celkově maxChars × maxParts; co se nevejde, se neusekne, ale odloží (model si to vyžádá znovu)
  const fixed = parts.join("\n").length + tail.join("\n").length + 400;
  let budget = opts.maxChars * Math.max(1, opts.maxParts) - fixed;
  let deferred = 0;
  for (const r of results) {
    const text = renderResult(r, opts);
    if (text.length + 1 <= budget) {
      parts.push(text);
      budget -= text.length + 1;
    } else {
      deferred++;
      parts.push(renderResult({ ...r, output: undefined, fullOutputPath: undefined, status: "skipped", meta: { deferred: "prompt size limit" } }, opts));
    }
  }
  if (deferred) {
    tail.unshift(
      `<note>${deferred} result(s) above are marked deferred="prompt size limit": they were executed, but their output did not fit into this prompt. Request them again next turn, fewer at a time and with lines="A-B" for big files, or continue without them.</note>`,
    );
  }
  const attachments = results.flatMap((r) => r.attachments ?? []);
  const images = attachments.filter((a) => /\.(png|jpe?g|gif|webp)$/i.test(a));
  const bundles = attachments.filter((a) => !/\.(png|jpe?g|gif|webp)$/i.test(a));
  if (images.length) tail.unshift(`<note>Images attached to this message: ${images.map((a) => a.split("/").pop()).join(", ")} (screenshots). If you cannot see any image, tell the user to attach the files from .copy-agent/shots/.</note>`);
  if (bundles.length) tail.unshift(`<note>Bundle(s) attached to this message as a file or text: ${bundles.map((a) => a.split("/").pop()).join(", ")}. Use them instead of reading those files again; if you cannot see any, ask the user to attach the file from .copy-agent/out/.</note>`);
  parts.push(...tail);
  return parts.join("\n");
}

/** Prompt po přijetí části vícedílné odpovědi: jen žádost o další část. */
export function buildContinuePrompt(sessionId: string, turn: number, received: number, total: number, language = "en"): string {
  const next = received + 1;
  return cs(language)
    ? `<${RESULTS} turn="${turn}" session="${sessionId}" part-received="${received}/${total}"/>\nMám část ${received}/${total}. Pošli teď část ${next}/${total} jako blok <${BLOCK} turn="${turn}" session="${sessionId}" part="${next}/${total}"> v ohrazení ${FENCE}; nic z předchozích částí neopakuj.`
    : `<${RESULTS} turn="${turn}" session="${sessionId}" part-received="${received}/${total}"/>\nGot part ${received}/${total}. Now send part ${next}/${total} as a block <${BLOCK} turn="${turn}" session="${sessionId}" part="${next}/${total}"> in a ${FENCE} fence; do not repeat earlier parts.`;
}

export interface CorrectionContext {
  task?: string;
  prose?: string;
  attempt?: number;
  userNotes?: string[];
  savedTo?: string;
  preamble?: string;
  existingDoc?: string;
  language?: string;
}

export function classifyProseKind(prose: string): "document" | "question" | "other" {
  const t = prose.trim();
  if (!t) return "other";
  const lines = t.split("\n");
  const structured = lines.filter((l) => /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)/.test(l)).length;
  const lastLines = lines.slice(-3).join(" ");
  if (t.length < 700 && /\?\s*$/.test(lastLines)) return "question";
  if (structured >= 3 && t.length >= 400) return "document";
  if (/\?\s*$/.test(lastLines)) return "question";
  return "other";
}

export function buildCorrectionPrompt(sessionId: string, turn: number, errors: string[], ctx: CorrectionContext = {}): string {
  const attempt = ctx.attempt ?? 1;
  const lines: string[] = [];
  if (ctx.preamble) lines.push(ctx.preamble, "");
  lines.push(`<${RESULTS} turn="${turn}" session="${sessionId}" correction="true">`);
  for (const e of errors) lines.push(`<protocol-error>${e}</protocol-error>`);
  const kind = ctx.prose ? classifyProseKind(ctx.prose) : "other";
  const open = `<${BLOCK} turn="${turn}" session="${sessionId}">`;
  if (ctx.prose && kind === "document" && ctx.existingDoc) {
    lines.push(
      `<note>Your reply contained no usable <${BLOCK}> block, so NOTHING was changed. The document ${ctx.existingDoc} already exists, so do not paste sections into the chat; apply the changes yourself:`,
      FENCE,
      open,
      `<edit path="${ctx.existingDoc}" section="## Existing heading">…complete new text of that section…</edit>`,
      `<done>…</done>`,
      `</${BLOCK}>`,
      FENCE,
      `Small wording changes can use SEARCH/REPLACE hunks; questions go into <ask options="A|B">…</ask> inside the block.${ctx.savedTo ? ` Your chat text was saved for reference to ${ctx.savedTo}.` : ""}</note>`,
    );
  } else if (ctx.prose && kind === "document") {
    lines.push(
      `<note>Your reply contained no usable <${BLOCK}> block, so NOTHING was executed and no file was created. Your text looks like the document itself; send it again inside the block:`,
      FENCE,
      open,
      `<write path="${(ctx.task && documentPathInTask(ctx.task)) ?? "docs/NAME.md"}">`,
      "…the complete document text, verbatim…",
      "</write>",
      "<done>…</done>",
      `</${BLOCK}>`,
      FENCE,
      `${ctx.savedTo ? `The text you wrote was saved for reference to ${ctx.savedTo}. ` : ""}Use the file path the task asks for.</note>`,
    );
  } else if (ctx.prose && kind === "question") {
    lines.push(`<note>Your reply contained no <${BLOCK}> block. If it was a question for the user, ask it inside the block with <ask options="A|B">…</ask> (the user answers here); otherwise continue with actions.</note>`);
  } else {
    lines.push(
      `<note>Format requirement of the user's program: every reply must contain the block, otherwise the reply cannot be used at all. Send it again as a single ${open} … </${BLOCK}> inside a ${FENCE} fence. Bodies are verbatim; every <write>/<edit>/<run> needs its own closing tag. If you only want to say or ask something, that is a block too: ${open}<ask options="A|B">…</ask></${BLOCK}>.</note>`,
    );
  }
  if (attempt >= 2) {
    lines.push(`<note>This is correction attempt ${attempt}. Start your reply with the ${FENCE} fence and ${open}, end with </${BLOCK}> and the fence; explanations go AFTER it. Without the block the user's work stops here.</note>`);
  }
  if (ctx.task) lines.push(`<task>${ctx.task.trim().slice(0, 600)}</task>`);
  for (const n of ctx.userNotes ?? []) lines.push(`<user>${n.trim()}</user>`);
  lines.push(`</${RESULTS}>`);
  return lines.join("\n");
}

export function buildResumePrompt(sessionId: string, task: string, turn: number, ctx: ProjectContext, history: TurnSummary[], opts: PromptOptions): string {
  const head = opts.target === "generic" ? buildPreamble(ctx, opts) : buildAgentHeader(ctx, opts);
  const parts: string[] = [head, buildContext(ctx), "## Task", "", task.trim(), ""];
  parts.push("## What has happened so far (resumed session; the previous chat context is gone)", "");
  for (const h of history) parts.push(`Turn ${h.turn}:`, ...h.lines.map((l) => `  - ${l}`));
  parts.push("", `Session: ${sessionId}, turn ${turn}. Continue the task. ${replyReminder(turn, { language: opts.language, session: sessionId })}`);
  return parts.join("\n");
}

export function buildSuggestPrompt(sessionId: string, turn: number, transcript: string, ctx: ProjectContext, opts: PromptOptions, history: SuggestionHistory = { approved: [], rejected: [] }): string {
  const existing: string[] = [];
  const ex = ctx.existing ?? {};
  if (ctx.rules?.length) existing.push(`- rules already in the preamble: ${ctx.rules.length} (listed above under "Additional rules")`);
  if (ctx.skills?.length) existing.push(`- skills: ${ctx.skills.map((s) => "/" + s.name).join(", ")}`);
  if (ex.hooks?.length) existing.push(`- hooks: ${ex.hooks.join("; ")}`);
  if (ex.allowPatterns?.length) existing.push(`- allow patterns (regex): ${ex.allowPatterns.join(" , ")}`);
  if (ex.autoAllow?.length) existing.push(`- commands allowed by prefix: ${ex.autoAllow.join(", ")}`);
  if (ex.planOpen?.length) existing.push(`- open plan tasks: ${ex.planOpen.slice(0, 20).join(" | ")}`);
  if (history.approved.length) existing.push(`- suggestions the user already APPROVED earlier: ${history.approved.slice(-30).join(" | ")}`);
  if (history.rejected.length) existing.push(`- suggestions the user REJECTED earlier (do not propose again): ${history.rejected.slice(-30).join(" | ")}`);
  for (const s of ex.skillBodies ?? []) {
    const body = s.body.length > 600 ? s.body.slice(0, 600) + " …" : s.body;
    existing.push(`- skill /${s.name} (current content; improve it with update="${s.name}" instead of adding a similar skill):\n  ${body.replace(/\n/g, "\n  ")}`);
  }
  const head = opts.target === "generic" ? buildPreamble(ctx, opts) : buildAgentHeader(ctx, opts);
  return [
    head,
    "## Already configured (check before proposing; never duplicate or rephrase these)",
    "",
    ...(existing.length ? existing : ["- nothing yet"]),
    "",
    "## Work history to analyse",
    "",
    transcript.trim(),
    "",
    "## Task",
    "",
    "Analyse the work history above and propose improvements for the user to approve or reject. Use ONLY <status> and <suggest> actions, then <done>. Two levels:",
    "",
    'A) This project (scope="project"): skill (reusable instructions invoked with /name; body starts with `# name` and a one-line description), script (a REAL runnable script, see AUTOMATION), instructions (lines for AGENTS.md: conventions, commands, pitfalls seen here), hook (JSON {"match": glob, "run": command} run after matching files change), allow (regex for commands that proved safe), task (follow-up work discovered but not done).',
    "",
    'B) The agent itself, in EVERY project (scope="global"): wasted turns, repeated mistakes, misread results, failed actions, missing verification. Propose: rule (one concise behavioural rule), setting (JSON {"key": "copyAgent.…", "value": …}), allow (regex safe anywhere), skill or instructions with scope=global, agent (feedback for the developer of the agent that cannot be applied automatically).',
    "",
    'AUTOMATION: find work done BY HAND that will repeat (command sequences, checks before a commit or release, file transformations, repeated edits of the same shape) and propose <suggest kind="script" lang="…" file="name.ext" title="…"> whose body is the COMPLETE source of a script doing the whole job in one run (real code, arguments handled, non-zero exit on failure, usage comment at the top). It is saved to .copy-agent/scripts/ and run with <run>.',
    "",
    'Check "Already configured" first: never propose what exists or was rejected; prefer improving an existing item with update="…". At most 10 suggestions, each concrete and justified by the history (say which turn motivates it). If nothing is worth suggesting, say so in <done>.',
    "",
    `Session: ${sessionId}, turn ${turn}. ${replyReminder(turn, { language: opts.language, session: sessionId })}`,
  ].join("\n");
}

/** Jednořádkové shrnutí výsledků kola pro historii (resume / stateless). */
export function summarizeTurn(turn: number, results: ActionResult[], statusNote?: string): TurnSummary {
  const lines = results.map((r) => {
    const target = r.attrs.path ?? r.attrs.pattern ?? (r.tool === "run" ? (r.meta?.command ?? "") : "");
    const meta = r.meta
      ? Object.entries(r.meta)
          .filter(([k]) => k !== "command")
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")
      : "";
    const first = (r.output ?? "").split("\n").find((l) => l.trim())?.slice(0, 80) ?? "";
    return `${r.tool} ${target} → ${r.status}${meta ? " " + meta : ""}${first && r.status !== "ok" ? ` (${first})` : ""}`.trim();
  });
  if (statusNote) lines.push(`status: ${statusNote}`);
  return { turn, lines };
}

// ---------------------------------------------------------------------------------------------
// Dělení promptu na části podle limitu chatu

/**
 * Rozdělí prompt na části ≤ maxChars (na hranicích řádků). Každá část má hlavičku [PART i/n], poslední
 * je označená LAST; mezilehlé části žádají jen „OK“. Jedna část = bez hlavičky (prompt se vejde).
 */
export function splitPrompt(text: string, maxChars: number, language = "en"): string[] {
  if (maxChars <= 0 || text.length <= maxChars) return [text];
  const headerRoom = 260;
  const chunkMax = Math.max(500, maxChars - headerRoom);
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > chunkMax) {
    let cut = rest.lastIndexOf("\n", chunkMax);
    if (cut < chunkMax * 0.5) cut = chunkMax; // dlouhý řádek: řez uprostřed
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length) chunks.push(rest);
  const n = chunks.length;
  const c = cs(language);
  return chunks.map((chunk, i) => {
    const last = i === n - 1;
    const head = last
      ? c
        ? `[PART ${i + 1}/${n} — LAST] Tohle je poslední část promptu; teď odpověz na celý prompt (všechny části dohromady).`
        : `[PART ${i + 1}/${n} — LAST] This is the last part of the prompt; now answer the whole prompt (all parts together).`
      : c
        ? `[PART ${i + 1}/${n}] Prompt je delší než limit chatu, posílám ho po částech. Tohle je část ${i + 1} z ${n}: odpověz jen „OK“ a počkej na část označenou LAST.`
        : `[PART ${i + 1}/${n}] The prompt exceeds the chat limit, so it comes in pieces. This is part ${i + 1} of ${n}: reply only "OK" and wait for the part marked LAST.`;
    return `${head}\n\n${chunk}`;
  });
}
