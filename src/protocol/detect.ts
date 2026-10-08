import { BLOCK, RESULTS } from "./schema";

/** Rozpoznání, zda text ve schránce je odpověď modelu (a ne náš vlastní prompt). */

export function normalizeClipboard(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

/** Značka na začátku každého promptu, který agent vyrábí (podle ní se pozná vlastní text). */
export const PROMPT_MARK = "# Copy Agent";

/** Text je jeden z promptů, které agent sám vyrábí. */
export function isOwnPrompt(text: string): boolean {
  const t = normalizeClipboard(text);
  if (t.startsWith(`<${RESULTS}`) || t.startsWith(PROMPT_MARK)) return true;
  const head = t.slice(0, 3000);
  return new RegExp(`^(<${RESULTS}[\\s>]|${PROMPT_MARK}\\b)`, "m").test(head);
}

/** Text obsahuje otevírací tag bloku s číselným kolem (i HTML-escapovaný). */
export function hasBlockStart(text: string): boolean {
  return new RegExp(`(?:<|&lt;)${BLOCK}\\b[^>]*\\bturn\\s*=\\s*["“”„']?\\d+`).test(text);
}

/**
 * Text vypadá jako úplná odpověď modelu: otevírací tag s číselným kolem a uzavírací tag,
 * není to náš prompt a není shodný s naposledy zkopírovaným promptem.
 */
export function looksLikeReply(text: string, lastPrompt = ""): boolean {
  const t = normalizeClipboard(text);
  if (!t || t === normalizeClipboard(lastPrompt)) return false;
  if (isOwnPrompt(t)) return false;
  return hasBlockStart(t) && (t.includes(`</${BLOCK}>`) || t.includes(`&lt;/${BLOCK}&gt;`));
}

/** Rozepsaný blok bez uzavření (odpověď useknutá limitem chatu): bere se jen po vložení promptu. */
export function looksLikeTruncatedReply(text: string, lastPrompt = ""): boolean {
  const t = normalizeClipboard(text);
  if (!t || t === normalizeClipboard(lastPrompt) || isOwnPrompt(t)) return false;
  return hasBlockStart(t) && t.length > 120;
}

/** Hrubý odhad, zda text bez bloku je dokument (nadpisy, odrážky), nebo spíš otázka/komentář. */
export function classifyProse(prose: string): "document" | "question" | "other" {
  const t = prose.trim();
  if (!t) return "other";
  const lines = t.split("\n");
  const structured = lines.filter((l) => /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)/.test(l)).length;
  const lastLines = lines.slice(-3).join(" ");
  if (t.length < 700 && /\?\s*$/.test(lastLines)) return "question";
  if (structured >= 3 && t.length >= 400) return "document";
  if (/\?\s*$/.test(lastLines)) return "question";
  return "other";
}
