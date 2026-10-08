import { Host } from "../host/Host";
import { ActionResult } from "../protocol/schema";
import { matchesAny } from "../protocol/text";
import { STATE_DIR } from "../protocol/roots";
import { Hook, readGlobalHooks } from "./GlobalConfig";

export type { Hook } from "./GlobalConfig";

const FILE = `${STATE_DIR}/hooks.json`;

/** Projektové hooky (.copy-agent/hooks.json) + globální (~/.copy-agent/hooks.json). */
export async function loadHooks(host: Host): Promise<Hook[]> {
  const hooks: Hook[] = [...readGlobalHooks()];
  for (const h of await loadProjectHooks(host)) {
    if (!hooks.some((x) => x.match === h.match && x.run === h.run)) hooks.push(h);
  }
  return hooks;
}

export async function loadProjectHooks(host: Host): Promise<Hook[]> {
  if (!(await host.exists(FILE))) return [];
  try {
    const data = JSON.parse(await host.readFile(FILE)) as { afterChange?: Hook[] };
    return (data.afterChange ?? []).filter((h) => h && typeof h.match === "string" && typeof h.run === "string");
  } catch {
    return [];
  }
}

export async function saveProjectHooks(host: Host, hooks: Hook[]): Promise<void> {
  await host.writeFile(FILE, JSON.stringify({ afterChange: hooks }, null, 2) + "\n");
}

export async function addHook(host: Host, hook: Hook): Promise<void> {
  const hooks = await loadProjectHooks(host);
  if (hooks.some((h) => h.match === hook.match && h.run === hook.run)) return;
  hooks.push(hook);
  await saveProjectHooks(host, hooks);
}

/** Spustí hooky, jejichž glob odpovídá některé změněné cestě; výsledky jdou modelu jako `hook`. */
export async function runHooks(host: Host, changedPaths: string[]): Promise<ActionResult[]> {
  if (changedPaths.length === 0) return [];
  const results: ActionResult[] = [];
  for (const hook of await loadHooks(host)) {
    try {
      if (!changedPaths.some((p) => matchesAny(p, [hook.match]))) continue;
      host.log(`hook: ${hook.run}`);
      const r = await host.run(hook.run, hook.cwd ?? ".", 300_000);
      results.push({
        tool: "hook",
        attrs: { match: hook.match, run: hook.run },
        status: r.exit === 0 && !r.timedOut ? "ok" : "error",
        output: (r.timedOut ? "[timed out]\n" : "") + (r.output || "(no output)"),
        meta: { exit: r.exit, duration: (r.durationMs / 1000).toFixed(1) + "s" },
      });
    } catch (e) {
      results.push({ tool: "hook", attrs: { match: hook.match, run: hook.run }, status: "error", output: `Hook failed: ${(e as Error).message}` });
    }
  }
  return results;
}
