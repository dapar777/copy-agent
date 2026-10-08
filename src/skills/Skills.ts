import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseSkillFile, SlashCommand } from "../protocol/slash";
import { STATE_DIR } from "../protocol/roots";

/**
 * Skilly dostupné přes /název:
 *  - <workspace>/.copy-agent/skills/*.md a *\/SKILL.md (projekt)
 *  - ~/.copy-agent/skills/…                              (uživatel)
 *  - skills/ v rozšíření                                 (vestavěné: /init, /commit, /review, /test, /fix, /explain, /docs, /deps)
 * Při shodě jména vyhrává projekt, pak uživatel, vestavěný lze tedy přepsat.
 */
export function loadSkills(workspaceRoot: string, builtinDir?: string): SlashCommand[] {
  const home = os.homedir();
  const sources: { dir: string; nested: boolean; builtin?: boolean }[] = [
    { dir: path.join(workspaceRoot, STATE_DIR, "skills"), nested: false },
    { dir: path.join(workspaceRoot, STATE_DIR, "skills"), nested: true },
    { dir: path.join(home, ".copy-agent", "skills"), nested: false },
    { dir: path.join(home, ".copy-agent", "skills"), nested: true },
  ];
  if (builtinDir) sources.push({ dir: builtinDir, nested: true, builtin: true }, { dir: builtinDir, nested: false, builtin: true });
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  for (const src of sources) {
    for (const file of listSkillFiles(src.dir, src.nested)) {
      try {
        const content = fs.readFileSync(file, "utf8");
        const fallback = src.nested ? path.basename(path.dirname(file)) : path.basename(file, ".md");
        const parsed = parseSkillFile(content, fallback);
        if (!parsed.name || seen.has(parsed.name)) continue;
        seen.add(parsed.name);
        const body = parsed.body + describeSkillScripts(file, workspaceRoot);
        out.push({ name: parsed.name, kind: "skill", description: parsed.description || "(skill)", body, source: file, builtin: src.builtin });
      } catch {
        /* nečitelný skill přeskočíme */
      }
    }
  }
  return out;
}

const SCRIPT_EXT = /\.(py|js|mjs|cjs|ts|sh|ps1|cmd|bat|rb|pl)$/i;

/** Skill uložený jako adresář může vedle playbooku nést skripty; vypíšou se modelu i s příkazem ke spuštění. */
function describeSkillScripts(skillFile: string, workspaceRoot: string): string {
  const dir = path.dirname(skillFile);
  if (path.basename(skillFile).toLowerCase() !== "skill.md") return "";
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => SCRIPT_EXT.test(n));
  } catch {
    return "";
  }
  try {
    for (const n of fs.readdirSync(path.join(dir, "scripts")).filter((n) => SCRIPT_EXT.test(n))) names.push(path.join("scripts", n));
  } catch {
    /* podsložka scripts/ nemusí existovat */
  }
  if (!names.length) return "";
  const lines = names.sort().map((n) => {
    const abs = path.join(dir, n);
    const rel = abs.startsWith(workspaceRoot) ? path.relative(workspaceRoot, abs).replace(/\\/g, "/") : abs.replace(/\\/g, "/");
    return `- \`${runCommandFor(rel)}\``;
  });
  return ["", "", "## Scripts shipped with this skill", "", "Run them with <run> instead of writing the same code again (`--help` where available):", ...lines].join("\n");
}

function listSkillFiles(dir: string, nested: boolean): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const e of entries) {
    if (nested) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const candidate = path.join(dir, e.name, "SKILL.md");
      if (fs.existsSync(candidate)) files.push(candidate);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      files.push(path.join(dir, e.name));
    }
  }
  return files.sort();
}

export function saveSkill(workspaceRoot: string, name: string, body: string, global = false): string {
  const dir = global ? path.join(os.homedir(), ".copy-agent", "skills") : path.join(workspaceRoot, STATE_DIR, "skills");
  fs.mkdirSync(dir, { recursive: true });
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
  const file = path.join(dir, `${slug}.md`);
  const content = body.trim().startsWith("#") ? body.trim() : `# ${slug}\n\n${body.trim()}`;
  fs.writeFileSync(file, content + "\n", "utf8");
  return file;
}

// ---------------------------------------------------------------------------------------------
// Skripty navržené modelem

export function scriptExtension(body: string, lang?: string): string {
  const first = body.trimStart().split(/\r?\n/, 1)[0] ?? "";
  const hint = (lang ?? "").toLowerCase().trim();
  const table: Record<string, string> = {
    python: ".py", py: ".py", node: ".js", js: ".js", javascript: ".js", ts: ".ts", typescript: ".ts", bash: ".sh", sh: ".sh", shell: ".sh",
    powershell: ".ps1", ps1: ".ps1", pwsh: ".ps1", cmd: ".cmd", bat: ".cmd", batch: ".cmd", ruby: ".rb", perl: ".pl",
  };
  if (hint && table[hint]) return table[hint];
  if (first.startsWith("#!")) {
    if (/\bpython[\d.]*\b/.test(first)) return ".py";
    if (/\bnode\b/.test(first)) return ".js";
    if (/\b(bash|sh|zsh)\b/.test(first)) return ".sh";
    if (/\bpwsh|powershell\b/.test(first)) return ".ps1";
    if (/\bruby\b/.test(first)) return ".rb";
    if (/\bperl\b/.test(first)) return ".pl";
  }
  if (/^@echo off|^rem\s/im.test(body)) return ".cmd";
  if (/^param\s*\(|\$PSScriptRoot|Write-Host/m.test(body)) return ".ps1";
  if (/^\s*(def|import|from)\s+\w/m.test(body)) return ".py";
  if (/\b(require|module\.exports|console\.log)\b/.test(body)) return ".js";
  return process.platform === "win32" ? ".cmd" : ".sh";
}

export function runCommandFor(rel: string): string {
  switch (path.extname(rel).toLowerCase()) {
    case ".py":
      return `python ${rel}`;
    case ".js":
      return `node ${rel}`;
    case ".ts":
      return `npx tsx ${rel}`;
    case ".ps1":
      return `powershell -ExecutionPolicy Bypass -File ${rel}`;
    case ".sh":
      return `bash ${rel}`;
    case ".rb":
      return `ruby ${rel}`;
    case ".pl":
      return `perl ${rel}`;
    default:
      return rel;
  }
}

export function saveScript(workspaceRoot: string, name: string, body: string, opts: { global?: boolean; lang?: string; file?: string } = {}): { rel: string; command: string; absolute: string } {
  const dirAbs = opts.global ? path.join(os.homedir(), ".copy-agent", "scripts") : path.join(workspaceRoot, STATE_DIR, "scripts");
  fs.mkdirSync(dirAbs, { recursive: true });
  const explicit = (opts.file ?? "").trim().replace(/\\/g, "/");
  const base = explicit ? path.basename(explicit) : (name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "script") + scriptExtension(body, opts.lang);
  const fileName = path.extname(base) ? base : base + scriptExtension(body, opts.lang);
  const absolute = path.join(dirAbs, fileName);
  let content = body.replace(/\r\n/g, "\n").trimEnd() + "\n";
  if (/\.(sh|py|js|rb|pl)$/.test(fileName) && !content.startsWith("#!")) {
    const shebang: Record<string, string> = { ".sh": "#!/usr/bin/env bash", ".py": "#!/usr/bin/env python3", ".js": "#!/usr/bin/env node", ".rb": "#!/usr/bin/env ruby", ".pl": "#!/usr/bin/env perl" };
    content = shebang[path.extname(fileName)] + "\n" + content;
  }
  fs.writeFileSync(absolute, content, "utf8");
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(absolute, 0o755);
    } catch {
      /* práva nejdou nastavit */
    }
  }
  const rel = opts.global ? absolute : path.relative(workspaceRoot, absolute).replace(/\\/g, "/");
  return { rel, command: runCommandFor(rel), absolute };
}
