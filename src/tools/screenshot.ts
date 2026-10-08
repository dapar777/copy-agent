import { Host } from "../host/Host";
import { STATE_DIR } from "../protocol/roots";
import { ActionResult } from "../protocol/schema";

export const SHOTS_DIR = `${STATE_DIR}/shots`;

export async function takeScreenshot(host: Host, turn: number, index: number, opts: { window?: string; name?: string }): Promise<ActionResult> {
  const safe = (opts.name ?? (opts.window ? opts.window : "screen")).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "screen";
  const rel = `${SHOTS_DIR}/shot-${turn}-${index}-${safe}.png`;
  const attrs: Record<string, string> = {};
  if (opts.window) attrs.window = opts.window;
  try {
    const info = await host.screenshot(rel, { window: opts.window });
    host.log(`screenshot → ${rel} (${info.width}x${info.height}${info.window ? `, "${info.window}"` : ""})`);
    return {
      tool: "screenshot",
      attrs,
      status: "ok",
      output: `Screenshot saved and attached as image "${rel.split("/").pop()}"${info.window ? ` (window "${info.window}")` : " (whole screen)"}, ${info.width}x${info.height}px.`,
      meta: { file: rel.split("/").pop() ?? rel, size: `${info.width}x${info.height}` },
      attachments: [rel],
    };
  } catch (e) {
    return { tool: "screenshot", attrs, status: "error", output: `Screenshot failed: ${(e as Error).message}` };
  }
}
