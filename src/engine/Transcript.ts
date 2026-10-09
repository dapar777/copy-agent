import { Host } from "../host/Host";
import { STATE_DIR } from "../protocol/roots";

/** Jedna událost průběhu (úkol, prompt, odpověď, akce, schválení, otázka, návrh…). */
export interface TranscriptEvent {
  at: string;
  session: string;
  kind: "task" | "prompt" | "reply" | "actions" | "results" | "status" | "system" | "approval" | "ask" | "answer" | "note" | "dialog" | "plan" | "suggestion" | "done" | "error" | "undo" | "info";
  turn?: number;
  text?: string;
  data?: unknown;
}

type ActionLike = { tool: string; attrs: Record<string, string>; body?: string };
type ResultLike = { tool: string; attrs: Record<string, string>; status: string; output?: string; meta?: Record<string, string | number> };

export function describeActions(actions: ActionLike[]): string {
  return actions
    .filter((a) => a.tool !== "status")
    .map((a) => {
      const target = a.attrs.path ?? a.attrs.pattern ?? a.attrs.title ?? a.attrs.from ?? (a.tool === "run" ? (a.body ?? "").trim().split("\n")[0].slice(0, 80) : "");
      return target ? `${a.tool} ${target}` : a.tool;
    })
    .join(", ");
}

function firstTellingLine(output: string | undefined): string {
  if (!output) return "";
  const marked = output.match(/^\[(timed out[^\]]*|INTERRUPTED[^\]]*)\]/m);
  if (marked) return marked[1].slice(0, 160);
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(">") && !l.startsWith("["));
  const pick = lines.find((l) => /^not ok\b|error|fail|exception|traceback|not found|cannot|unable|denied|assert/i.test(l)) ?? lines[0] ?? "";
  return pick.slice(0, 160);
}

export function describeResults(results: ResultLike[]): string {
  const bad = results.filter((r) => r.status !== "ok");
  const okList = results
    .filter((r) => r.status === "ok")
    .map((r) => {
      if (r.tool === "run") return `run \`${String(r.meta?.command ?? "").split("\n")[0].slice(0, 60)}\`${r.meta?.exit === "running" ? " (probe: still running)" : ""}`;
      return `${r.tool}${r.attrs.path ? " " + r.attrs.path : ""}`;
    });
  const parts: string[] = [];
  if (okList.length) parts.push(`${okList.length} ok (${okList.join(", ")})`);
  for (const r of bad) {
    const target = r.attrs.path ?? (r.tool === "run" ? "`" + String(r.meta?.command ?? "").slice(0, 80) + "`" : "");
    const why = firstTellingLine(r.output);
    const exit = r.meta?.exit !== undefined ? ` exit=${r.meta.exit}` : "";
    parts.push(`${r.tool}${target ? " " + target : ""} → ${r.status}${exit}${why ? `: ${why}` : ""}`);
  }
  return `${results.length} výsledků${bad.length ? `, ${bad.length} neúspěšných` : ""}: ${parts.join("; ")}`;
}

const FILE = `${STATE_DIR}/transcript.jsonl`;

/** Celý průběh práce agenta (append-only, přes všechna sezení). */
export class Transcript {
  constructor(private readonly host: Host) {}

  async append(ev: Omit<TranscriptEvent, "at">): Promise<void> {
    try {
      await this.host.appendFile(FILE, JSON.stringify({ at: new Date().toISOString(), ...ev }) + "\n");
    } catch {
      /* bez práv k zápisu */
    }
  }

  async readAll(): Promise<TranscriptEvent[]> {
    if (!(await this.host.exists(FILE))) return [];
    const text = await this.host.readFile(FILE);
    const out: TranscriptEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as TranscriptEvent);
      } catch {
        /* poškozený řádek */
      }
    }
    return out;
  }

  static suggestionHistory(events: TranscriptEvent[]): { approved: string[]; rejected: string[] } {
    const approved: string[] = [];
    const rejected: string[] = [];
    for (const e of events) {
      if (e.kind !== "suggestion" || !e.text) continue;
      const m = e.text.match(/^(.*) → (approved|rejected)$/);
      if (!m) continue;
      (m[2] === "approved" ? approved : rejected).push(m[1].trim());
    }
    return { approved: [...new Set(approved)], rejected: [...new Set(rejected)].filter((r) => !approved.includes(r)) };
  }

  static summarize(events: TranscriptEvent[], maxChars = 16000): string {
    const lines: string[] = [];
    let session = "";
    for (const e of events) {
      if (e.session !== session) {
        session = e.session;
        lines.push(`\n### Session ${session}`);
      }
      const t = (e.text ?? "").replace(/\s+/g, " ").trim();
      switch (e.kind) {
        case "task":
          lines.push(`TASK: ${t.slice(0, 400)}`);
          break;
        case "actions":
          lines.push(`turn ${e.turn}: actions ${t.slice(0, 500)}`);
          break;
        case "results":
          lines.push(`turn ${e.turn}: results ${t.slice(0, /neúspěšných/.test(t) ? 900 : 300)}`);
          break;
        case "status":
          lines.push(`status: ${t.slice(0, 200)}`);
          break;
        case "approval":
          lines.push(`approval: ${t.slice(0, 200)}`);
          break;
        case "ask":
          lines.push(`model asked: ${t.slice(0, 300)}`);
          break;
        case "answer":
          lines.push(`user answered: ${t.slice(0, 300)}`);
          break;
        case "note":
          lines.push(`user note: ${t.slice(0, 300)}`);
          break;
        case "dialog":
          lines.push(`chat ${t.slice(0, 300)}`);
          break;
        case "plan":
          lines.push(`plan updated (${t.split("- [").length - 1} items)`);
          break;
        case "suggestion":
          lines.push(`suggestion ${t.slice(0, 200)}`);
          break;
        case "done":
          lines.push(`DONE: ${t.slice(0, 1200)}`);
          break;
        case "error":
          lines.push(`error: ${t.slice(0, 200)}`);
          break;
        case "undo":
          lines.push(`user undid turn ${e.turn}`);
          break;
        default:
          break;
      }
    }
    const text = lines.join("\n").trim();
    return text.length > maxChars ? "…\n" + text.slice(text.length - maxChars) : text;
  }
}
