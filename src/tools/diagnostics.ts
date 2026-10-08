import { Host } from "../host/Host";
import { ActionResult } from "../protocol/schema";

/** Po zápisu chvíli počká, aby language server stihl přepočítat (host může čekat chytřeji). */
export async function collectDiagnosticsSettled(host: Host, onlyPath?: string, waitMs = 1200): Promise<string> {
  await new Promise((r) => setTimeout(r, waitMs));
  return host.diagnostics(onlyPath);
}

export async function toolDiagnostics(host: Host, attrs: Record<string, string>): Promise<ActionResult> {
  const text = await collectDiagnosticsSettled(host, attrs.path);
  return { tool: "diagnostics", attrs, status: "ok", output: text || "(no errors or warnings reported by the editor; run the compiler or tests with <run> to be sure)" };
}
