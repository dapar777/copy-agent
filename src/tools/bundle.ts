import { Host } from "../host/Host";
import { STATE_DIR } from "../protocol/roots";
import { ActionResult } from "../protocol/schema";
import { globToRegExp } from "../protocol/text";

/** První řádek svazku; podle něj se pozná, že text ve schránce je náš (ne odpověď modelu). */
export const BUNDLE_MARKER = "# Copy Agent bundle";

const BINARY_EXT = /\.(png|jpe?g|gif|bmp|ico|webp|svgz|pdf|zip|gz|tgz|7z|rar|jar|exe|dll|so|dylib|bin|dat|db|sqlite|woff2?|ttf|otf|eot|mp[34]|wav|ogg|mov|avi|lock|vsix)$/i;

export interface BundleOptions {
  /** limit velikosti svazku ve znacích; 0/undefined = bez limitu */
  maxChars?: number;
  maxFileChars?: number;
  /** compact = bez čísel řádků (úspornější; hunky čísla nepotřebují) */
  format?: "numbered" | "compact";
  /** svazek jde jako text do promptu (ne jako soubor): výsledek nese obsah v output */
  inline?: boolean;
}

function renderFile(p: string, text: string, format: "numbered" | "compact"): string {
  const lines = text.split("\n");
  if (format === "compact") return [`===== FILE: ${p} (${lines.length} lines) =====`, text.replace(/\n+$/, "")].join("\n");
  const width = String(lines.length).length;
  return [`===== FILE: ${p} (${lines.length} lines) =====`, ...lines.map((l, i) => `${String(i + 1).padStart(width)}| ${l}`), `===== END FILE: ${p} =====`].join("\n");
}

/**
 * <bundle>: spojí více souborů (cesty/globy nebo celou codebase) do jednoho strukturovaného textu.
 * Uloží se do .copy-agent/out/ a podle nastavení jde do promptu jako text (inline) nebo jako příloha.
 */
export async function toolBundle(host: Host, attrs: Record<string, string>, turn: number, index: number, opts: BundleOptions = {}): Promise<ActionResult> {
  const format = opts.format ?? "numbered";
  const maxChars = opts.maxChars || Infinity;
  const maxFileChars = opts.maxFileChars || Infinity;
  const all = attrs.all === "true" || attrs.all === "1";
  const patterns = (attrs.paths ?? "")
    .split(/[\n,]/)
    .map((p) => p.trim().replace(/\\/g, "/"))
    .filter(Boolean);
  if (!all && patterns.length === 0) return { tool: "bundle", attrs, status: "error", output: 'Give paths="a.ts, src/**/*.py" (comma-separated paths or globs) or all="true".' };

  const allFiles = await host.listFiles("**/*", 20_000);
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      candidates.push(p);
    }
  };
  if (all) for (const f of allFiles) add(f);
  else {
    for (const pat of patterns) {
      if (/[*?{[]/.test(pat)) {
        const re = globToRegExp(pat);
        for (const f of allFiles) if (re.test(f)) add(f);
      } else if (await host.exists(pat)) {
        const asDir = allFiles.filter((f) => f.startsWith(pat.replace(/\/+$/, "") + "/"));
        if (asDir.length) for (const f of asDir) add(f);
        else add(pat);
      }
    }
  }

  const picked: { path: string; text: string; lines: number }[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const p of candidates.sort()) {
    if (BINARY_EXT.test(p)) {
      skipped.push(`${p} (binary)`);
      continue;
    }
    let text: string;
    try {
      text = await host.readFile(p);
    } catch {
      skipped.push(`${p} (unreadable)`);
      continue;
    }
    if (text.includes("\u0000")) {
      skipped.push(`${p} (binary)`);
      continue;
    }
    if (text.length > maxFileChars) {
      skipped.push(`${p} (${text.length} chars, too large; use <read lines=>)`);
      continue;
    }
    const rendered = renderFile(p, text, format);
    if (total + rendered.length > maxChars) {
      skipped.push(`${p} (bundle limit ${maxChars} chars reached)`);
      continue;
    }
    total += rendered.length;
    picked.push({ path: p, text: rendered, lines: text.split("\n").length });
  }
  if (picked.length === 0) return { tool: "bundle", attrs, status: "error", output: `No readable files matched.${skipped.length ? "\nSkipped: " + skipped.join(", ") : ""}` };

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const out: string[] = [];
  out.push(`${BUNDLE_MARKER}: ${picked.length} files, project "${host.workspaceName}", turn ${turn}`);
  out.push(format === "compact" ? "# Each file starts with '===== FILE: <path> (<n> lines) =====' and runs verbatim until the next such line." : "# Each file: '===== FILE: <path> (<n> lines) =====', numbered lines 'N| text', '===== END FILE ====='.");
  if (skipped.length) out.push(`# Skipped: ${skipped.join("; ")}`);
  out.push("");
  for (const f of picked) out.push(f.text, "");
  const content = out.join("\n");
  const rel = `${STATE_DIR}/out/bundle-${turn}-${index}-${stamp}.txt`;
  await host.writeFile(rel, content);

  if (opts.inline) {
    return {
      tool: "bundle",
      attrs,
      status: "ok",
      output: content,
      meta: { file: rel, files: picked.length, chars: content.length },
    };
  }
  const summary = [
    `Bundle written to ${rel} (${picked.length} files, ${content.length} chars) and attached to this message.`,
    `Read the attached bundle instead of requesting these files with <read>. If you cannot see it, ask the user to attach the file ${rel}.`,
    "Files:",
    ...picked.map((f) => `  ${f.path} (${f.lines} lines)`),
    ...(skipped.length ? ["Skipped:", ...skipped.map((s) => `  ${s}`)] : []),
  ].join("\n");
  return { tool: "bundle", attrs, status: "ok", output: summary, meta: { file: rel, files: picked.length, chars: content.length }, attachments: [rel] };
}
