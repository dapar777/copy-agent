import { ChildProcess, spawn } from "child_process";
import { sanitizeSecrets, stripAnsi } from "../protocol/text";
import { RunResult } from "./Host";

const MAX_OUTPUT = 2_000_000;
const TICK_MS = 500;
/** Delší mezera mezi tiky = proces (i my) stál, typicky uspaný počítač. */
const SUSPEND_GAP_MS = 5_000;

/** Ukončí celý strom procesů (na Windows přes taskkill /T, jinak skupinu). */
function terminate(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      const tk = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      const fallback = () => {
        if (child.exitCode === null && !child.killed) child.kill();
      };
      tk.on("exit", fallback);
      tk.on("error", fallback);
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* skupina už neexistuje */
      }
      child.kill("SIGKILL");
    }
  } catch {
    /* proces už neběží */
  }
}

/** Jména proměnných prostředí, kterými se skriptům skillů předává rozložení workspace. */
export const ENV_ROOTS = "COPY_AGENT_ROOTS";
export const ENV_WORKSPACE_FILE = "COPY_AGENT_WORKSPACE_FILE";

/**
 * Proměnné prostředí pro spouštěné příkazy: kořenové složky workspace oddělené oddělovačem cest
 * (`;` na Windows, jinde `:`) a cesta souboru .code-workspace, pokud nějaký je. Skript skillu tak pozná
 * multi-root workspace, i když běží v první složce.
 */
export function workspaceEnv(roots: string[], workspaceFile?: string, delimiter: string = process.platform === "win32" ? ";" : ":"): Record<string, string> {
  const env: Record<string, string> = {};
  if (roots.length) env[ENV_ROOTS] = roots.join(delimiter);
  if (workspaceFile) env[ENV_WORKSPACE_FILE] = workspaceFile;
  return env;
}

/** Spustí shellový příkaz a posbírá stdout+stderr. Lhůty se měří aktivním časem (uspání se nepočítá). */
export function spawnCommand(command: string, cwd: string, timeoutMs: number, probeMs?: number, signal?: AbortSignal, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const started = Date.now();
  return new Promise<RunResult>((resolve) => {
    const chunks: string[] = [];
    let size = 0;
    let timedOut = false;
    let stillRunning = false;
    let interrupted = false;
    if (signal?.aborted) {
      resolve({ output: "", exit: -1, timedOut: false, interrupted: true, durationMs: 0 });
      return;
    }
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", FORCE_COLOR: "0", PYTHONIOENCODING: "utf-8", ...extraEnv };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NoDefaultCurrentDirectoryInExePath;
    const child = spawn(command, { cwd, shell: true, env, windowsHide: true, detached: process.platform !== "win32" });
    const onData = (d: Buffer) => {
      if (size > MAX_OUTPUT) return;
      const s = d.toString("utf8");
      size += s.length;
      chunks.push(s);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let active = 0;
    let suspendedMs = 0;
    let lastTick = Date.now();
    const ticker = setInterval(() => {
      const now = Date.now();
      const gap = now - lastTick;
      lastTick = now;
      if (gap > SUSPEND_GAP_MS) {
        suspendedMs += gap - TICK_MS;
        active += TICK_MS;
      } else active += gap;
      if (probeMs && !stillRunning && !timedOut && active >= probeMs) {
        stillRunning = true;
        terminate(child);
      } else if (!timedOut && !stillRunning && active >= timeoutMs) {
        timedOut = true;
        terminate(child);
      }
    }, TICK_MS);
    const onAbort = () => {
      interrupted = true;
      terminate(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (exit: number, extra = "") => {
      clearInterval(ticker);
      signal?.removeEventListener("abort", onAbort);
      const output = sanitizeSecrets(stripAnsi(extra + chunks.join(""))).trim();
      resolve({ output, exit, timedOut, stillRunning, interrupted, durationMs: Date.now() - started - suspendedMs, suspendedMs });
    };
    child.on("error", (err) => finish(-1, `Failed to start: ${err.message}\n`));
    child.on("close", (code) => finish(code ?? -1));
  });
}
