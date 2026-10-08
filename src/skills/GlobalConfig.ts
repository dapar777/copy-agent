import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Globální (uživatelská) konfigurace agenta v ~/.copy-agent: platí ve všech projektech.
 *  - AGENTS.md         globální instrukce (přidávají se do každého úvodního promptu)
 *  - rules.md          pravidla chování agenta (jedno na řádek)
 *  - hooks.json        globální hooky {"afterChange":[...]}
 *  - skills/           globální skilly
 *  - scripts/          globální skripty
 *  - agent-feedback.md podněty na úpravu samotného agenta (pro vývojáře)
 */
export const GLOBAL_DIR = path.join(os.homedir(), ".copy-agent");

export interface Hook {
  match: string;
  run: string;
  cwd?: string;
}

function readIfExists(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function appendTo(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = readIfExists(file);
  fs.writeFileSync(file, current.trimEnd() + (current.trim() ? "\n" : "") + text.trim() + "\n", "utf8");
}

export function readGlobalInstructions(): string {
  return readIfExists(path.join(GLOBAL_DIR, "AGENTS.md")).trim();
}

export function appendGlobalInstructions(text: string): void {
  appendTo(path.join(GLOBAL_DIR, "AGENTS.md"), text);
}

export function readGlobalRules(): string[] {
  return readIfExists(path.join(GLOBAL_DIR, "rules.md"))
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter((l) => l && !l.startsWith("#"));
}

export function appendGlobalRule(rule: string): void {
  const one = rule.replace(/\s+/g, " ").trim();
  if (readGlobalRules().includes(one)) return;
  appendTo(path.join(GLOBAL_DIR, "rules.md"), `- ${one}`);
}

export function replaceGlobalRule(index: number, text: string): boolean {
  const rules = readGlobalRules();
  if (index < 0 || index >= rules.length) return false;
  rules[index] = text.replace(/\s+/g, " ").trim();
  fs.mkdirSync(GLOBAL_DIR, { recursive: true });
  fs.writeFileSync(path.join(GLOBAL_DIR, "rules.md"), rules.map((r) => `- ${r}`).join("\n") + "\n", "utf8");
  return true;
}

export function readGlobalHooks(): Hook[] {
  try {
    const data = JSON.parse(readIfExists(path.join(GLOBAL_DIR, "hooks.json")) || "{}") as { afterChange?: Hook[] };
    return (data.afterChange ?? []).filter((h) => h && typeof h.match === "string" && typeof h.run === "string");
  } catch {
    return [];
  }
}

function writeGlobalHooks(hooks: Hook[]): void {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true });
  fs.writeFileSync(path.join(GLOBAL_DIR, "hooks.json"), JSON.stringify({ afterChange: hooks }, null, 2) + "\n", "utf8");
}

export function addGlobalHook(hook: Hook): void {
  const hooks = readGlobalHooks();
  if (hooks.some((h) => h.match === hook.match && h.run === hook.run)) return;
  hooks.push(hook);
  writeGlobalHooks(hooks);
}

export function replaceGlobalHook(match: string, hook: Hook): boolean {
  const hooks = readGlobalHooks();
  const i = hooks.findIndex((h) => h.match === match);
  if (i < 0) return false;
  hooks[i] = hook;
  writeGlobalHooks(hooks);
  return true;
}

export function appendAgentFeedback(title: string, body: string, project: string): void {
  appendTo(path.join(GLOBAL_DIR, "agent-feedback.md"), `## ${new Date().toISOString().slice(0, 10)} · ${title} (${project})\n\n${body.trim()}\n`);
}

export function globalSkillsDir(): string {
  return path.join(GLOBAL_DIR, "skills");
}
