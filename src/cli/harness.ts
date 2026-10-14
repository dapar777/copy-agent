/**
 * Headless harness: stejné jádro jako extension, ale „schránka“ je soubor.
 *
 *   harness start <root> "<task>" [--generic] [--plan]   → .copy-agent/outbox.md (prompt; části outbox-1.md…)
 *   harness reply <root> [inbox]                          → vykoná odpověď z .copy-agent/inbox.md, další prompt do outboxu
 *   harness answer <root> "<odpověď na ask>"
 *   harness suggest <root>
 *   harness status <root>
 *   harness instructions                                  → instrukce pro agenta v Copilotu
 */
import * as fs from "fs/promises";
import * as path from "path";
import { TurnEngine } from "../engine/TurnEngine";
import { createSession, SessionData } from "../engine/SessionData";
import { describeActions, describeResults, Transcript } from "../engine/Transcript";
import { NodeHost } from "../host/NodeHost";
import { buildAgentInstructions, DEFAULT_OPTIONS, splitPrompt } from "../protocol/prompt";
import { BUILTIN_COMMANDS, composeTask, parseInput } from "../protocol/slash";
import { STATE_DIR } from "../protocol/roots";
import { loadSkills } from "../skills/Skills";

const OUTBOX = `${STATE_DIR}/outbox.md`;
const INBOX = `${STATE_DIR}/inbox.md`;
const STATE = `${STATE_DIR}/session.json`;

async function main(): Promise<void> {
  const [cmd, root, ...rest] = process.argv.slice(2);
  if (cmd === "instructions") {
    process.stdout.write(buildAgentInstructions() + "\n");
    return;
  }
  if (!cmd || !root) {
    console.log("usage: harness start <root> <task> [--generic] [--plan] [--no-full] [--no-auto] [--max=N] | reply <root> [inbox] | answer <root> <text> | suggest <root> | status <root> | instructions");
    process.exit(2);
  }
  const rootAbs = path.resolve(root);
  const host = new NodeHost(rootAbs, { autoConfirm: true, log: (l) => console.log("  " + l) });
  const transcript = new Transcript(host);
  const engine = new TurnEngine(host, {
    ...DEFAULT_OPTIONS,
    target: rest.includes("--generic") ? "generic" : "copilot-agent",
    maxChars: Number(rest.find((r) => r.startsWith("--max="))?.split("=")[1]) || DEFAULT_OPTIONS.maxChars,
    treeMaxEntries: 120,
    autoContext: !rest.includes("--no-auto"),
    bundleInline: false,
  });

  const load = async (): Promise<SessionData> => JSON.parse(await host.readFile(STATE)) as SessionData;
  const save = async (s: SessionData): Promise<void> => host.writeFile(STATE, JSON.stringify(s, null, 2));
  const emit = async (s: SessionData, prompt: string, attachments: string[] = []): Promise<void> => {
    s.pendingPrompt = prompt;
    s.pendingAttachments = attachments;
    s.state = "waitingForReply";
    await save(s);
    await host.writeFile(OUTBOX, prompt);
    const parts = splitPrompt(prompt, engine["opts"].maxChars, engine["opts"].language);
    if (parts.length > 1) for (let i = 0; i < parts.length; i++) await host.writeFile(`${STATE_DIR}/outbox-${i + 1}.md`, parts[i]);
    console.log(`→ OUTBOX ${OUTBOX} (${prompt.length} chars${parts.length > 1 ? `, ${parts.length} parts in outbox-N.md` : ""}) for turn ${s.turn}`);
    if (attachments.length) console.log(`📎 attachments: ${attachments.join(", ")}`);
  };

  switch (cmd) {
    case "start": {
      const skills = loadSkills(rootAbs, path.join(__dirname, "..", "skills"));
      const parsed = parseInput(rest.filter((r) => !r.startsWith("--")).join(" "), [...BUILTIN_COMMANDS, ...skills]);
      for (const u of parsed.unknown) console.log(`! unknown command /${u}`);
      const task = composeTask(parsed);
      const s = createSession(task);
      s.planMode = rest.includes("--plan") || parsed.commands.includes("plan");
      let previous: string | undefined;
      try {
        previous = (await load()).id;
      } catch {
        /* první sezení */
      }
      await engine.archivePlan(previous);
      const ctx = await engine.gatherContext(undefined, skills.map((k) => ({ name: k.name, description: k.description })), task);
      // celá codebase jako příloha (jako v extensionu); --no-full ji vynechá
      const bundle = await engine.attachInitialBundle(ctx, s.turn, !rest.includes("--no-full"));
      if (bundle.reason) console.log(`! codebase not attached: ${bundle.reason}`);
      await emit(s, engine.initialPrompt(s, ctx), bundle.file ? [bundle.file] : []);
      await transcript.append({ session: s.id, kind: "task", text: task, data: { planMode: s.planMode } });
      return;
    }
    case "suggest": {
      const events = await transcript.readAll();
      const s = createSession("/suggest");
      const ctx = await engine.gatherContext();
      await emit(s, engine.suggestPrompt(s, Transcript.summarize(events), ctx, Transcript.suggestionHistory(events)));
      return;
    }
    case "reply": {
      const s = await load();
      const inbox = rest[0] ?? INBOX;
      const text = await fs.readFile(path.resolve(rootAbs, inbox), "utf8");
      const parsed = engine.parse(text, s.turn);
      if (parsed.turn !== null && parsed.turn !== s.turn) console.log(`! turn mismatch: reply says ${parsed.turn}, expected ${s.turn} (continuing)`);
      if (parsed.errors.length) console.log(`! parse errors: ${parsed.errors.join(" | ")}`);
      console.log(`← reply turn ${s.turn}: ${parsed.actions.length} actions [${parsed.actions.map((a) => a.tool).join(", ")}]${parsed.part ? ` part ${parsed.part.index}/${parsed.part.total}` : ""}`);
      const turn = s.turn;
      const step = await engine.execute(s, parsed, s.pendingPrompt.length);
      if (step.kind === "next" || step.kind === "done" || step.kind === "ask") {
        const rec = step.record;
        await transcript.append({ session: s.id, kind: "actions", turn, text: describeActions(rec.actions) });
        await transcript.append({ session: s.id, kind: "results", turn, text: describeResults(rec.results) });
        if (step.kind === "done") await transcript.append({ session: s.id, kind: "done", text: step.summary });
        if (step.kind === "ask") await transcript.append({ session: s.id, kind: "ask", text: step.question });
      }
      switch (step.kind) {
        case "correction":
          console.log("✖ CORRECTION prompt issued");
          await emit(s, step.prompt);
          break;
        case "continue":
          console.log(`… part ${step.received}/${step.total} received, asking for the next one`);
          await emit(s, step.prompt);
          break;
        case "next":
          if (step.review) console.log(`🔍 review round ${step.review.round}: ${step.review.files.join(", ")}`);
          await emit(s, step.prompt, step.attachments);
          break;
        case "done":
          s.state = "done";
          s.finalSummary = step.summary;
          await save(s);
          console.log(`✔ DONE after ${s.history.length} turns:\n${step.summary}`);
          break;
        case "ask":
          s.state = "awaitingUser";
          s.pendingQuestion = step.question;
          await save(s);
          console.log(`❓ ASK: ${step.question}${step.options ? ` [${step.options.join(" | ")}]` : ""}\n   (answer with: harness answer <root> "<text>")`);
          break;
      }
      return;
    }
    case "answer": {
      const s = await load();
      const prompt = await engine.answerPrompt(s, rest.join(" "), []);
      await transcript.append({ session: s.id, kind: "answer", text: rest.join(" ") });
      s.pendingQuestion = undefined;
      await emit(s, prompt, engine.undeliveredAttachments(s));
      return;
    }
    case "status": {
      const s = await load();
      console.log(`session ${s.id} state=${s.state} turn=${s.turn} history=${s.history.length}`);
      for (const h of s.history) {
        const errs = h.results.filter((r) => r.status !== "ok").length;
        console.log(`  turn ${h.turn}: ${h.actions.map((a) => a.tool).join(",")} (${errs} non-ok) ${h.status ?? ""}`);
      }
      return;
    }
    default:
      console.log(`unknown command ${cmd}`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
