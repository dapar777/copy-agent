import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeHost } from "../src/host/NodeHost";
import { canonicalRel, homeStateRelOf, resolveHomeState, resolveRel } from "../src/protocol/roots";
import { isHelpRequest, parseInput, skillHelp } from "../src/protocol/slash";
import { loadSkills } from "../src/skills/Skills";

describe("~/.copy-agent paths", () => {
  it("resolves only inside the home state dir", () => {
    const home = path.resolve("/tmp/home");
    expect(resolveHomeState("~/.copy-agent/skills/x/SKILL.md", home)).toBe(path.join(home, ".copy-agent", "skills", "x", "SKILL.md"));
    expect(() => resolveHomeState("~/.copy-agent/../secret", home)).toThrow(/outside/);
    expect(resolveHomeState("~/other", home)).toBeUndefined();
    expect(resolveHomeState("src/a.ts", home)).toBeUndefined();
    expect(homeStateRelOf(path.join(home, ".copy-agent", "scripts", "r.py"), home)).toBe("~/.copy-agent/scripts/r.py");
    expect(homeStateRelOf(path.join(home, "x.txt"), home)).toBeUndefined();
  });

  it("is accepted by resolveRel next to workspace paths", () => {
    const roots = [{ name: "app", fsPath: path.resolve("/ws/app") }];
    expect(resolveRel("~/.copy-agent/skills/a/SKILL.md", roots).fsPath).toBe(path.join(os.homedir(), ".copy-agent", "skills", "a", "SKILL.md"));
    expect(resolveRel("src/a.ts", roots).fsPath).toBe(path.resolve("/ws/app/src/a.ts"));
  });
});

describe("skill help", () => {
  it("recognises help requests and extracts the Help section", () => {
    expect(isHelpRequest("--help")).toBe(true);
    expect(isHelpRequest(" -h ")).toBe(true);
    expect(isHelpRequest("nápověda")).toBe(true);
    expect(isHelpRequest("fix the bug")).toBe(false);
    const skill = { name: "rn", kind: "skill" as const, description: "release notes", body: "# rn\n\nSteps for the model.\n\n## Help\nPoužití: /rn --since <tag>\nPříklady:\n- /rn --since v1.2\n\n## Other\nignored" };
    expect(skillHelp(skill)).toBe("/rn – release notes\n\nPoužití: /rn --since <tag>\nPříklady:\n- /rn --since v1.2");
    expect(skillHelp({ ...skill, body: "# rn\n\nonly steps" })).toContain("nemá sekci Help");
    const parsed = parseInput("/rn --help", [skill]);
    expect(parsed.skills[0].name).toBe("rn");
    expect(isHelpRequest(parsed.text)).toBe(true);
  });
});

describe("global skills via NodeHost", () => {
  let home: string;
  let ws: string;
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "copy-agent-home-"));
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "copy-agent-ws-"));
    process.env.USERPROFILE = home;
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.USERPROFILE = saved.USERPROFILE;
    process.env.HOME = saved.HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("writes a global skill through the host and loadSkills finds it with its Help section", async () => {
    const host = new NodeHost(ws, { log: () => undefined });
    const rel = "~/.copy-agent/skills/release-notes/SKILL.md";
    await host.writeFile(rel, "---\nname: release-notes\ndescription: Poznámky k vydání\n---\nDo it.\n\n## Help\nPoužití: /release-notes --since <tag>\n");
    expect(await host.exists(rel)).toBe(true);
    expect(fs.existsSync(path.join(home, ".copy-agent", "skills", "release-notes", "SKILL.md"))).toBe(true);
    expect(await host.readFile(rel)).toContain("## Help");
    await expect(host.writeFile("~/.copy-agent/../evil.txt", "x")).rejects.toThrow(/outside/);
    await expect(host.writeFile("../evil.txt", "x")).rejects.toThrow(/outside/);
    const skills = loadSkills(ws, path.resolve("skills"));
    const rn = skills.find((s) => s.name === "release-notes");
    expect(rn?.description).toBe("Poznámky k vydání");
    expect(rn?.source?.startsWith(home)).toBe(true);
    expect(skills.some((s) => s.name === "skill-creator" && s.builtin)).toBe(true);
    for (const s of skills.filter((x) => x.builtin)) expect(skillHelp(s)).toContain("Použití:");
  });
});

describe("path spellings the model uses", () => {
  const roots = [{ name: "app", fsPath: path.resolve("/ws/app") }, { name: "lib", fsPath: path.resolve("/ws/lib") }];
  const home = os.homedir();
  it("accepts absolute, expanded-home and multi-root spellings of global paths", () => {
    const target = path.join(home, ".copy-agent", "skills", "rn", "SKILL.md");
    expect(resolveRel(path.join(home, ".copy-agent", "skills", "rn", "SKILL.md"), roots).fsPath).toBe(target);
    expect(resolveRel("$HOME/.copy-agent/skills/rn/SKILL.md", roots).fsPath).toBe(target);
    expect(resolveRel("%USERPROFILE%\\.copy-agent\\skills\\rn\\SKILL.md", roots).fsPath).toBe(target);
    expect(resolveRel("~\\.copy-agent\\skills\\rn\\SKILL.md", roots).fsPath).toBe(target);
    expect(canonicalRel("$HOME/.copy-agent/skills/rn/SKILL.md", roots)).toBe("~/.copy-agent/skills/rn/SKILL.md");
  });
  it("converts absolute workspace paths and explains the rest", () => {
    expect(canonicalRel(path.resolve("/ws/lib/src/x.ts"), roots)).toBe("lib/src/x.ts");
    expect(canonicalRel(path.resolve("/ws/app/a.ts"), [roots[0]])).toBe("a.ts");
    expect(() => resolveRel("SKILL.md", roots)).toThrow(/~\/\.copy-agent\/skills\/my-skill\/SKILL\.md/);
    expect(() => resolveRel(path.resolve("/elsewhere/x.ts"), roots)).toThrow(/outside the workspace. Allowed paths/);
    expect(() => resolveRel("../x.ts", [roots[0]])).toThrow(/Allowed paths/);
  });
});
