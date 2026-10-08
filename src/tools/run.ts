import { Host } from "../host/Host";
import { ActionResult } from "../protocol/schema";
import { isAutoAllowedCommand, isDeniedCommand } from "../safety/Policy";
import { takeScreenshot } from "./screenshot";

export async function toolRun(host: Host, attrs: Record<string, string>, body: string, turn = 0, index = 0, signal?: AbortSignal): Promise<ActionResult> {
  const command = body.trim();
  const meta: Record<string, string | number> = { command: command.split("\n")[0].slice(0, 200) };
  const denied = isDeniedCommand(command, host.policy);
  if (denied) return { tool: "run", attrs, status: "denied", output: `Command blocked by policy (matches "${denied}").`, meta };
  const cwd = attrs.cwd || ".";
  if (cwd !== ".") host.assertInside(cwd);
  if (!isAutoAllowedCommand(command, host.policy)) {
    const ok = await host.confirmCommand(command, cwd);
    if (!ok) return { tool: "run", attrs, status: "denied", output: "The user declined to run this command.", meta };
  }
  const timeoutMs = Math.min(1800, Math.max(5, Number(attrs.timeout) || 120)) * 1000;
  const captureMs = attrs.capture ? Math.min(120, Math.max(1, Number(attrs.capture) || 3)) * 1000 : undefined;
  let probeMs = attrs.probe ? Math.min(120, Math.max(1, Number(attrs.probe) || 5)) * 1000 : undefined;
  if (captureMs && (!probeMs || probeMs <= captureMs)) probeMs = captureMs + 1500;
  host.log(`$ ${command}${probeMs ? ` (probe ${probeMs / 1000}s)` : ""}${captureMs ? ` (capture ${captureMs / 1000}s)` : ""}`);
  const running = host.run(command, cwd, timeoutMs, probeMs, signal);
  let shot: ActionResult | undefined;
  if (captureMs) {
    await new Promise((res) => setTimeout(res, captureMs));
    shot = await takeScreenshot(host, turn, index, { window: attrs.window, name: "run" });
  }
  const r = await running;
  const shotNote = shot ? `\n[${shot.output}]` : "";
  const attachments = shot?.attachments;
  const suspended = r.suspendedMs && r.suspendedMs > 5000 ? `[note: the computer was asleep for ${Math.round(r.suspendedMs / 1000)}s while this command ran; that time is not counted]\n` : "";
  if (suspended) meta.suspended = Math.round(r.suspendedMs! / 1000) + "s";
  const duration = (r.durationMs / 1000).toFixed(1) + "s";
  if (r.interrupted) {
    return {
      tool: "run",
      attrs,
      status: "error",
      output: suspended + `[INTERRUPTED by the user after ${duration}; the process was killed. Partial output follows.]\n` + (r.output || "(no output)"),
      meta: { ...meta, exit: "interrupted", duration },
      attachments,
    };
  }
  if (r.stillRunning) {
    return {
      tool: "run",
      attrs,
      status: "ok",
      output: suspended + `[probe: process was still running after ${probeMs! / 1000}s, so it started successfully; it was then stopped]${shotNote}\n` + (r.output || "(no output)"),
      meta: { ...meta, exit: "running", duration, ...(shot?.meta?.file ? { screenshot: shot.meta.file } : {}) },
      attachments,
    };
  }
  return {
    tool: "run",
    attrs,
    status: r.exit === 0 && !r.timedOut ? "ok" : "error",
    output:
      suspended +
      (r.timedOut ? `[timed out after ${timeoutMs / 1000}s and was killed; for servers or GUI apps use probe="N"]\n` : "") +
      (probeMs && r.exit !== 0 ? `[probe: process exited with code ${r.exit} before ${probeMs / 1000}s elapsed, so it did NOT start properly]\n` : "") +
      (shotNote ? shotNote.trim() + "\n" : "") +
      (r.output || "(no output)"),
    meta: { ...meta, exit: r.exit, duration, ...(shot?.meta?.file ? { screenshot: shot.meta.file } : {}) },
    attachments,
  };
}
