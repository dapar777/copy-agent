import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeHost } from "../src/host/NodeHost";
import { execFileSync } from "child_process";
import { workspaceEnv } from "../src/host/spawn";
import { canonicalRel, homeStateRelOf, isReviewData, resolveHomeState, resolveRel } from "../src/protocol/roots";
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

describe("built-in /review-plan (data for the Review změn extension)", () => {
  const has = (cmd: string, ...args: string[]) => {
    try {
      execFileSync(cmd, args, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  const python = has("python3", "--version") ? "python3" : has("python", "--version") ? "python" : "";

  it("is loaded with its script and Czech help", () => {
    const skill = loadSkills(fs.mkdtempSync(path.join(os.tmpdir(), "copy-agent-rp-")), path.resolve("skills")).find((s) => s.name === "review-plan");
    expect(skill?.builtin).toBe(true);
    expect(skill?.body).toContain("## Scripts shipped with this skill");
    expect(skill?.body).toMatch(/python .*review-plan\/scripts\/review_data\.py/);
    expect(skillHelp(skill!)).toContain("Použití: /review-plan");
  });

  it("review data is not a project change", () => {
    expect(isReviewData(".review/agent.json")).toBe(true);
    expect(isReviewData("app/.review/agent.json")).toBe(true);
    expect(isReviewData(".copy-agent/review-agent.json")).toBe(true);
    expect(isReviewData("app/.copy-agent/review-agent.json")).toBe(true);
    expect(isReviewData("src/.review/x.ts")).toBe(false);
    expect(isReviewData("src/review/agent.json")).toBe(false);
    expect(isReviewData(".copy-agent/skills/x.md")).toBe(false);
    expect(isReviewData(".review")).toBe(false);
  });

  it("commands learn the workspace roots from the environment", async () => {
    expect(workspaceEnv(["/ws/app", "/ws/lib"], "/ws/x.code-workspace", ":")).toEqual({ COPY_AGENT_ROOTS: "/ws/app:/ws/lib", COPY_AGENT_WORKSPACE_FILE: "/ws/x.code-workspace" });
    expect(workspaceEnv([])).toEqual({});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copy-agent-env-"));
    const host = new NodeHost(dir, { log: () => undefined });
    const r = await host.run('node -e "process.stdout.write(process.env.COPY_AGENT_ROOTS)"', ".", 20000);
    expect(r.output.trim()).toBe(path.resolve(dir));
  });

  it.skipIf(!python || !has("git", "--version"))("the script validates a draft and installs it with fingerprints", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "copy-agent-rp-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: ws, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(ws, ".gitignore"), ".copy-agent/\n");
    fs.writeFileSync(path.join(ws, "a.txt"), "one\ntwo\n");
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
    fs.writeFileSync(path.join(ws, "a.txt"), "one\nTWO\n");
    fs.mkdirSync(path.join(ws, ".copy-agent"));
    const draft = path.join(ws, ".copy-agent", "review-agent.json");
    fs.writeFileSync(draft, JSON.stringify({ kusy: [{ id: "k", soubor: "a.txt", radky: { od: 2, do: 2 }, titulek: "Dva" }], plan: [{ krok: 1, nazev: "Vše", kusy: ["k"] }] }));
    const script = path.resolve("skills/review-plan/scripts/review_data.py");
    const env = { ...process.env, ...workspaceEnv([ws]) };
    expect(execFileSync(python, [script, "diff"], { cwd: ws, env, encoding: "utf8" })).toMatch(/\+2 +TWO/);
    const out = execFileSync(python, [script, "check", "--file", ".copy-agent/review-agent.json"], { cwd: ws, env, encoding: "utf8" });
    expect(out).toMatch(/^OK: 1 pieces, 1 plan steps, 2 of 2 changed lines covered/m);
    const data = JSON.parse(fs.readFileSync(path.join(ws, ".review", "agent.json"), "utf8"));
    expect(data.kusy[0].otisk).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(draft)).toBe(false);
    expect(execFileSync("git", ["status", "--short"], { cwd: ws, encoding: "utf8" })).toBe(" M a.txt\n");
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

describe("multi-root bare paths", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "copy-agent-mr-"));
    fs.mkdirSync(path.join(ws, "app", "src"), { recursive: true });
    fs.mkdirSync(path.join(ws, "lib"), { recursive: true });
    fs.writeFileSync(path.join(ws, "lib", "README.md"), "lib\n");
    fs.writeFileSync(path.join(ws, "app", "package.json"), "{}\n");
    fs.writeFileSync(path.join(ws, "lib", "package.json"), "{}\n");
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("maps a bare path to the one folder that has it, AGENTS.md to the first folder, ambiguous ones fail", () => {
    const roots = [{ name: "app", fsPath: path.join(ws, "app") }, { name: "lib", fsPath: path.join(ws, "lib") }];
    expect(resolveRel("README.md", roots).fsPath).toBe(path.join(ws, "lib", "README.md"));
    expect(canonicalRel("README.md", roots)).toBe("lib/README.md");
    expect(resolveRel("AGENTS.md", roots).fsPath).toBe(path.join(ws, "app", "AGENTS.md"));
    expect(() => resolveRel("package.json", roots)).toThrow(/exists in several workspace folders/);
    expect(() => resolveRel("src/new.ts", roots)).toThrow(/does not start with a workspace folder name/);
    expect(resolveRel("app/src/new.ts", roots).fsPath).toBe(path.join(ws, "app", "src", "new.ts"));
  });
});
