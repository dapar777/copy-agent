import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/engine/SessionData";
import { TurnEngine } from "../src/engine/TurnEngine";
import { NodeHost } from "../src/host/NodeHost";
import { DEFAULT_OPTIONS } from "../src/protocol/prompt";

describe("TurnEngine", () => {
  let dir: string;
  let engine: TurnEngine;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "copy-agent-engine-"));
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\nworld\n");
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    const host = new NodeHost(dir, { autoConfirm: true, log: () => undefined });
    engine = new TurnEngine(host, { ...DEFAULT_OPTIONS, treeMaxEntries: 50, reviewBeforeDone: "off" });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs read-only actions in parallel groups and keeps result order", async () => {
    const session = createSession("task");
    const parsed = engine.parse('<copy turn="1">\n<read path="a.txt"/>\n<grep pattern="add" glob="src/**"/>\n<ls/>\n<status>ok</status>\n</copy>');
    const step = await engine.execute(session, parsed, 100);
    expect(step.kind).toBe("next");
    if (step.kind === "next") {
      expect(step.record.results.map((r) => r.tool)).toEqual(["read", "grep", "ls"]);
      expect(step.prompt).toContain("1| hello");
      expect(step.prompt).toContain("src/math.ts:1:");
      expect(step.prompt).toContain('<copy turn="2" session="' + session.id + '">');
    }
  });

  it("edits, writes and finishes with <done> in one turn", async () => {
    const session = createSession("task");
    const parsed = engine.parse('<copy turn="1">\n<edit path="src/math.ts">\n<<<<<<< SEARCH\n  return a + b;\n=======\n  return a + b + 0;\n>>>>>>> REPLACE\n</edit>\n<write path="b.txt">\nnew\n</write>\n<done>ok</done>\n</copy>');
    const step = await engine.execute(session, parsed, 100);
    expect(step.kind).toBe("done");
    expect(fs.readFileSync(path.join(dir, "src", "math.ts"), "utf8")).toContain("a + b + 0");
    expect(fs.readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("new\n");
  });

  it("continues instead of finishing when an action before <done> fails", async () => {
    const session = createSession("task");
    const step = await engine.execute(session, engine.parse('<copy turn="1">\n<read path="missing.txt"/>\n<done>all good</done>\n</copy>'), 100);
    expect(step.kind).toBe("next");
    if (step.kind === "next") expect(step.prompt).toContain("You sent <done>, but 1 action(s)");
  });

  it("collects a multi-part reply before executing", async () => {
    const session = createSession("task");
    const first = await engine.execute(session, engine.parse('<copy turn="1" part="1/2">\n<write path="p.txt">\npart one\n</write>\n</copy>', 1), 100);
    expect(first.kind).toBe("continue");
    expect(fs.existsSync(path.join(dir, "p.txt"))).toBe(false);
    expect(session.turn).toBe(1);
    const second = await engine.execute(session, engine.parse('<copy turn="1" part="2/2">\n<done>both</done>\n</copy>', 1), 100);
    expect(second.kind).toBe("done");
    expect(fs.readFileSync(path.join(dir, "p.txt"), "utf8")).toBe("part one\n");
    expect(session.turn).toBe(2);
  });

  it("executes complete actions of a cut-off reply and asks for the rest", async () => {
    const session = createSession("task");
    const step = await engine.execute(session, engine.parse('<copy turn="1">\n<write path="ok.txt">\nfine\n</write>\n<write path="cut.txt">\nhalf'), 100);
    expect(step.kind).toBe("next");
    expect(fs.existsSync(path.join(dir, "ok.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "cut.txt"))).toBe(false);
    if (step.kind === "next") expect(step.prompt).toMatch(/cut off .* inside action 2/);
  });

  it("pauses on <ask> and delivers the pending results with the answer", async () => {
    const session = createSession("task");
    const step = await engine.execute(session, engine.parse('<copy turn="1">\n<read path="a.txt"/>\n<ask options="A|B" multi="true">Which?</ask>\n</copy>'), 100);
    expect(step.kind).toBe("ask");
    if (step.kind === "ask") {
      expect(step.options).toEqual(["A", "B"]);
      expect(step.multi).toBe(true);
    }
    const prompt = await engine.answerPrompt(session, "A", []);
    expect(prompt).toContain("1| hello");
    expect(prompt).toContain("Answer to your question: A");
  });

  it("issues a correction prompt when the reply has no usable actions", async () => {
    const session = createSession("task");
    const step = await engine.execute(session, engine.parse("Sorry, I cannot do that."), 100);
    expect(step.kind).toBe("correction");
    expect(session.turn).toBe(1);
  });

  it("rescues a document written in the chat when the task names the file", async () => {
    const session = createSession("Napiš návrh do docs/navrh.md");
    const doc = "# Návrh\n\n## Cíle\n\n- a\n- b\n- c\n\n## Rizika\n\n- x\n- y\n\n" + "text ".repeat(100);
    const step = await engine.execute(session, engine.parse(doc), 100);
    expect(step.kind).toBe("next");
    expect(fs.readFileSync(path.join(dir, "docs", "navrh.md"), "utf8")).toContain("## Rizika");
    if (step.kind === "next") expect(step.prompt).toContain("the tool recovered");
  });

  it("attaches the whole codebase as one bundle file and skips auto-context then", async () => {
    const ctx = await engine.gatherContext(undefined, undefined, "add function");
    const b = await engine.attachInitialBundle(ctx, 1);
    expect(b.file).toMatch(/\.copy-agent\/out\/bundle-1-0-.*\.txt$/);
    const content = fs.readFileSync(path.join(dir, b.file!), "utf8");
    expect(content).toContain("===== FILE: src/math.ts (4 lines) =====");
    expect(content).toContain("===== FILE: a.txt");
    expect(ctx.initialBundle?.files).toBe(2);
    expect(ctx.autoContext).toBeUndefined();
  });

  it("falls back to auto-context when the codebase is over the limit", async () => {
    const small = new TurnEngine(new NodeHost(dir, { autoConfirm: true, log: () => undefined }), { ...DEFAULT_OPTIONS, treeMaxEntries: 50, fullMaxChars: 50 });
    const ctx = await small.gatherContext(undefined, undefined, "change add in math.ts");
    const b = await small.attachInitialBundle(ctx, 1);
    expect(b.file).toBeUndefined();
    expect(b.reason).toMatch(/larger than/);
    expect(ctx.autoContext).toContain("src/math.ts");
  });

  it("asks for a review before done when enabled and the change is big", async () => {
    const rev = new TurnEngine(new NodeHost(dir, { autoConfirm: true, log: () => undefined }), { ...DEFAULT_OPTIONS, treeMaxEntries: 50, reviewBeforeDone: "always" });
    const session = createSession("task");
    const step = await rev.execute(session, rev.parse('<copy turn="1">\n<write path="src/math.ts">\nexport const add = (a: number, b: number) => a + b;\n</write>\n<done>done</done>\n</copy>'), 100);
    expect(step.kind).toBe("next");
    if (step.kind === "next") {
      expect(step.review?.round).toBe(1);
      expect(step.prompt).toContain("REVIEW BEFORE DONE");
      expect(step.prompt).toContain("===== FILE: src/math.ts");
    }
    const final = await rev.execute(session, rev.parse('<copy turn="2">\n<done reviewed="true">checked</done>\n</copy>'), 100);
    expect(final.kind).toBe("done");
  });
});
