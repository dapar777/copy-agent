import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addGitignoreEntries, addSvnIgnoreEntries, ensureVcsIgnore, findVcsRoot } from "../src/safety/VcsIgnore";

describe("ignore entries", () => {
  it("adds missing entries to .gitignore and keeps CRLF", () => {
    const r = addGitignoreEntries("node_modules/\r\ndist/\r\n");
    expect(r.added).toEqual([".copy-agent/", "AGENTS.md"]);
    expect(r.content).toBe("node_modules/\r\ndist/\r\n\r\n# Copy Agent: pomocné soubory agenta a instrukce pro něj\r\n.copy-agent/\r\nAGENTS.md\r\n");
  });

  it("recognises existing entries in their usual spellings", () => {
    expect(addGitignoreEntries("/.copy-agent\n**/AGENTS.md\n").added).toEqual([]);
    expect(addGitignoreEntries(".copy-agent/\n").added).toEqual(["AGENTS.md"]);
    expect(addGitignoreEntries("").content).toBe("# Copy Agent: pomocné soubory agenta a instrukce pro něj\n.copy-agent/\nAGENTS.md\n");
  });

  it("adds names (no slash) to svn:ignore", () => {
    const r = addSvnIgnoreEntries("*.log\n");
    expect(r.added).toEqual([".copy-agent", "AGENTS.md"]);
    expect(r.value).toBe("*.log\n.copy-agent\nAGENTS.md\n");
    expect(addSvnIgnoreEntries(".copy-agent\nAGENTS.md").added).toEqual([]);
  });
});

describe("ensureVcsIgnore", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "copy-agent-vcs-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("creates .gitignore in a git working copy subfolder and is idempotent", async () => {
    fs.mkdirSync(path.join(dir, ".git"));
    const sub = path.join(dir, "app");
    fs.mkdirSync(sub);
    expect(findVcsRoot(sub, ".git")).toBe(dir);
    const notes = await ensureVcsIgnore([sub]);
    expect(notes).toHaveLength(1);
    expect(fs.readFileSync(path.join(sub, ".gitignore"), "utf8")).toContain(".copy-agent/");
    expect(await ensureVcsIgnore([sub])).toEqual([]);
  });

  it("does nothing outside version control", async () => {
    expect(await ensureVcsIgnore([dir])).toEqual([]);
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
  });

  it("never throws for an svn working copy even when the svn client is missing", async () => {
    fs.mkdirSync(path.join(dir, ".svn"));
    const log: string[] = [];
    const notes = await ensureVcsIgnore([dir], { log: (l) => log.push(l) });
    expect(Array.isArray(notes)).toBe(true);
  });
});
