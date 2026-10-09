import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Pomocné soubory agenta (.copy-agent/) a instrukce pro něj (AGENTS.md) nepatří do správy verzí:
 * při startu úkolu se automaticky zapíšou do .gitignore (git) a do vlastnosti svn:ignore (Subversion)
 * každé složky workspace, která je pod správou verzí. Čistá logika nad Node API, bez vscode.
 */

export const IGNORE_ENTRIES = [".copy-agent/", "AGENTS.md"];
const COMMENT = "# Copy Agent: pomocné soubory agenta a instrukce pro něj";

function normalizeEntry(line: string): string {
  return line.trim().replace(/^\/+/, "").replace(/^\*\*\//, "").replace(/\/+$/, "");
}

/** Doplní chybějící položky do obsahu .gitignore (zachová konce řádků); added = co se přidalo. */
export function addGitignoreEntries(content: string, entries: string[] = IGNORE_ENTRIES): { content: string; added: string[] } {
  const present = new Set(content.split(/\r?\n/).filter((l) => !l.trim().startsWith("#")).map(normalizeEntry));
  const missing = entries.filter((e) => !present.has(normalizeEntry(e)));
  if (!missing.length) return { content, added: [] };
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const body = content.replace(/\s+$/, "");
  return { content: (body ? body + eol + eol : "") + [COMMENT, ...missing].join(eol) + eol, added: missing };
}

/** Doplní chybějící položky do hodnoty svn:ignore (jména bez lomítka, jedno na řádek). */
export function addSvnIgnoreEntries(value: string, entries: string[] = IGNORE_ENTRIES): { value: string; added: string[] } {
  const lines = value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const names = entries.map(normalizeEntry);
  const missing = names.filter((n) => !lines.includes(n));
  if (!missing.length) return { value, added: [] };
  return { value: [...lines, ...missing].join("\n") + "\n", added: missing };
}

/** Nejbližší nadřazená složka (včetně start) se značkou správy verzí (.git nebo .svn), nebo undefined. */
export function findVcsRoot(start: string, marker: ".git" | ".svn"): string | undefined {
  let dir = path.resolve(start);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function svn(args: string[], cwd: string): Promise<{ ok: boolean; out: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile("svn", args, { cwd, windowsHide: true, timeout: 15000, encoding: "utf8" }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
      resolve({ ok: !e, out: String(stdout || stderr || "").trim(), missing: e?.code === "ENOENT" });
    });
  });
}

export interface IgnoreOptions {
  entries?: string[];
  log?: (line: string) => void;
}

/**
 * Zajistí ignorování ve všech zadaných složkách: .gitignore ve složce (platí i pro podsložku repa),
 * svn:ignore na složce. Vrací hlášky o tom, co se změnilo (nic = nic se neměnilo). Nikdy nevyhazuje.
 */
export async function ensureVcsIgnore(folders: string[], opts: IgnoreOptions = {}): Promise<string[]> {
  const entries = opts.entries ?? IGNORE_ENTRIES;
  const notes: string[] = [];
  for (const folder of folders) {
    try {
      if (findVcsRoot(folder, ".git")) {
        const file = path.join(folder, ".gitignore");
        const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
        const r = addGitignoreEntries(current, entries);
        if (r.added.length) {
          fs.writeFileSync(file, r.content, "utf8");
          notes.push(`Do ${path.basename(folder)}/.gitignore přidáno: ${r.added.join(", ")}.`);
        }
      }
    } catch (e) {
      opts.log?.(`gitignore: ${(e as Error).message}`);
    }
    try {
      if (findVcsRoot(folder, ".svn")) {
        const get = await svn(["propget", "svn:ignore", "."], folder);
        if (get.missing) {
          opts.log?.("svn: příkaz svn není k dispozici, svn:ignore se nenastaví (přidejte .copy-agent a AGENTS.md ručně).");
          continue;
        }
        const r = addSvnIgnoreEntries(get.ok ? get.out : "", entries);
        if (r.added.length) {
          const set = await svn(["propset", "svn:ignore", r.value, "."], folder);
          if (set.ok) notes.push(`Do svn:ignore složky ${path.basename(folder)} přidáno: ${r.added.join(", ")} (vlastnost je změněná, commitněte ji).`);
          else opts.log?.(`svn propset selhal: ${set.out}`);
        }
      }
    } catch (e) {
      opts.log?.(`svn:ignore: ${(e as Error).message}`);
    }
  }
  return notes;
}
