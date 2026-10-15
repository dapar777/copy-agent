import * as os from "os";
import * as path from "path";

/**
 * Cesty ve workspace s více kořenovými složkami (multi-root): každá složka je adresář nejvyšší
 * úrovně pojmenovaný podle svého názvu (`app/src/x.ts`). Jediná složka zůstává bez předpony.
 * Stav agenta (`.copy-agent/`) je vždy v první složce.
 */

export interface RootFolder {
  name: string;
  fsPath: string;
}

export const STATE_DIR = ".copy-agent";
/** Předpona cest do uživatelské konfigurace agenta (~/.copy-agent): globální skilly, skripty, pravidla. */
export const HOME_PREFIX = "~/.copy-agent";

/**
 * Cesta `~/.copy-agent/…` → absolutní cesta v domovské složce; jiné cesty undefined. Jediné místo mimo
 * workspace, kam agent smí (globální skilly a skripty); únik nad ~/.copy-agent se odmítne.
 */
export function resolveHomeState(rel: string, home: string = os.homedir()): string | undefined {
  const c = rel.replace(/\\/g, "/").trim();
  if (c !== HOME_PREFIX && !c.startsWith(HOME_PREFIX + "/")) return undefined;
  const root = path.join(home, STATE_DIR);
  return inside(root, c.slice(HOME_PREFIX.length).replace(/^\/+/, ""));
}

/** Absolutní cesta uvnitř ~/.copy-agent → `~/.copy-agent/…`; jinak undefined. */
export function homeStateRelOf(fsPath: string, home: string = os.homedir()): string | undefined {
  const root = path.join(home, STATE_DIR);
  const rel = path.relative(root, path.resolve(fsPath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel ? `${HOME_PREFIX}/${rel.replace(/\\/g, "/")}` : HOME_PREFIX;
}

export function uniqueRoots(folders: { name: string; fsPath: string }[]): RootFolder[] {
  const seen = new Map<string, number>();
  return folders.map((f) => {
    const base = f.name.replace(/[\\/]/g, "_") || "root";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { name: n === 1 ? base : `${base}-${n}`, fsPath: f.fsPath };
  });
}

function clean(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function inside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  if (back.startsWith("..") || path.isAbsolute(back)) throw new Error(`Path "${rel}" is outside the workspace.`);
  return abs;
}

export function resolveRel(rel: string, roots: RootFolder[]): { fsPath: string; folder: RootFolder; inside: string } {
  if (!roots.length) throw new Error("Není otevřený žádný workspace.");
  const home = resolveHomeState(rel);
  if (home) return { fsPath: home, folder: { name: HOME_PREFIX, fsPath: path.join(os.homedir(), STATE_DIR) }, inside: rel.replace(/\\/g, "/").slice(HOME_PREFIX.length).replace(/^\/+/, "") };
  const c = clean(rel);
  if (roots.length === 1) return { fsPath: inside(roots[0].fsPath, c), folder: roots[0], inside: c };
  const [head, ...rest] = c.split("/");
  const tail = rest.join("/");
  if (head === STATE_DIR || c === "" || c === ".") return { fsPath: inside(roots[0].fsPath, c), folder: roots[0], inside: c };
  const folder = roots.find((r) => r.name === head);
  if (!folder) {
    throw new Error(
      `Path "${rel}" does not start with a workspace folder name. This workspace has several folders; paths start with their names: ` +
        roots.map((r) => `${r.name}/…`).join(", ") +
        ".",
    );
  }
  return { fsPath: inside(folder.fsPath, tail), folder, inside: tail };
}

export function relOf(fsPath: string, roots: RootFolder[]): string | undefined {
  const norm = path.resolve(fsPath);
  const home = homeStateRelOf(norm);
  if (home) return home;
  const match = roots
    .map((r) => ({ r, rel: path.relative(r.fsPath, norm) }))
    .filter(({ rel }) => rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel))
    .sort((a, b) => b.r.fsPath.length - a.r.fsPath.length)[0];
  if (!match) return undefined;
  const rel = match.rel.replace(/\\/g, "/");
  return roots.length === 1 ? rel : `${match.r.name}/${rel}`;
}

export function splitGlob(glob: string, roots: RootFolder[]): { folder: RootFolder; glob: string }[] {
  const g = clean(glob);
  if (roots.length <= 1) return roots.map((folder) => ({ folder, glob: g }));
  const [head, ...rest] = g.split("/");
  const folder = roots.find((r) => r.name === head);
  if (folder && rest.length) return [{ folder, glob: rest.join("/") }];
  if (folder) return [{ folder, glob: "**/*" }];
  return roots.map((f) => ({ folder: f, glob: g }));
}
