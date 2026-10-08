import { Action, BLOCK, BODY_TOOLS, ParsedReply, REQUIRED_ATTRS, RESULTS, TOOL_NAMES } from "./schema";
import { decodeEntities } from "./text";

/**
 * Tolerantní parser odpovědi modelu.
 *
 * Odpověď prošla chatovým UI (Copilot v Teams, claude.ai…), takže může být: zabalená do ``` nebo ````
 * ohrazení (to je dokonce žádoucí: tlačítko „kopírovat“ u bloku kódu dá přesný text), HTML-escapovaná
 * (&lt;copy&gt;), s typografickými uvozovkami, useknutá limitem délky odpovědi, rozdělená na části
 * (part="1/2"), nebo s ukázkami protokolu uvnitř zapisovaného dokumentu. Parser proto hledá blok
 * strukturně (těla akcí přeskakuje), useknutou akci nikdy nevykoná a vše, co sám dorovnal, hlásí
 * v `notes`, aby se to model dozvěděl.
 */

const OPEN_RE = new RegExp(`<${BLOCK}\\b(?!-)([^>]*)>`, "g");
const CLOSE_TAG = `</${BLOCK}>`;

/** Normalizuje typografické uvozovky (jen v atributech, těla jsou verbatim). */
function normalizeQuotes(s: string): string {
  return s.replace(/[“”„″]/g, '"').replace(/[‘’‚′]/g, "'");
}

export function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>\/]+))/g;
  let m: RegExpExecArray | null;
  const src = normalizeQuotes(raw);
  while ((m = re.exec(src))) attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  return attrs;
}

/** Řádek, který je jen ohrazením (```, ````, ~~~, i s jazykem). */
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})[\w.+-]*[ \t]*$/;

/** Odstraní ohrazení kolem CELÉ odpovědi (model zabalil vše do ```). */
function stripOuterFence(s: string): string {
  const lines = s.split("\n");
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first++;
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  if (first < last && FENCE_LINE.test(lines[first]) && FENCE_LINE.test(lines[last])) {
    return lines.slice(first + 1, last).join("\n");
  }
  return s;
}

/** Za uzavíracím tagem těla musí následovat struktura protokolu (další akce, </copy>, konec, nebo ohrazení + struktura). */
const NEXT_STRUCTURE = new RegExp(`^\\s*(?:(?:\`{3,}|~{3,})[\\w.+-]*[ \\t]*\\n\\s*)?(?:<(?:${[...TOOL_NAMES, "think"].join("|")})\\b|</${BLOCK}>|$)`);

/**
 * Najde konec těla tělové akce: první výskyt uzavíracího tagu, za nímž pokračuje struktura
 * protokolu; není-li takový, první výskyt vůbec. Tělo dokumentu tak smí obsahovat text shodný
 * s uzavíracím tagem (ukázka protokolu v dokumentaci).
 */
function findBodyEnd(src: string, from: number, marker: string): number {
  let first = -1;
  let pos = src.indexOf(marker, from);
  while (pos >= 0) {
    if (first < 0) first = pos;
    if (NEXT_STRUCTURE.test(src.slice(pos + marker.length))) return pos;
    pos = src.indexOf(marker, pos + marker.length);
  }
  return first;
}

/** Nejbližší uzavírací tag jiné tělové akce, za kterým pokračuje struktura (model zaměnil </edit> a </write>). */
function findWrongClose(src: string, from: number): { tag: string; end: number } | null {
  const re = new RegExp(`</(${[...BODY_TOOLS].join("|")})>`, "g");
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (NEXT_STRUCTURE.test(src.slice(m.index + m[0].length))) return { tag: m[0], end: m.index + m[0].length };
  }
  return null;
}

interface Scan {
  actions: Action[];
  errors: string[];
  notes: string[];
  /** index uzavíracího </copy> na úrovni akcí, -1 když chybí */
  close: number;
  truncatedAction?: ParsedReply["truncatedAction"];
}

/** Strukturní průchod blokem od `start`: střídají se akce a jejich těla; konec je první </copy> mimo tělo. */
function scanBlock(src: string, start: number): Scan {
  const tagRe = new RegExp(`<([a-zA-Z][\\w-]*)\\b([^>]*?)(\\/?)>|</${BLOCK}>`, "g");
  tagRe.lastIndex = start;
  const out: Scan = { actions: [], errors: [], notes: [], close: -1 };
  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = tagRe.exec(src))) {
    if (m[0] === CLOSE_TAG) {
      out.close = m.index;
      break;
    }
    const [full, name, rawAttrs, selfClose] = m;
    if (name === "think") {
      const close = src.indexOf("</think>", m.index);
      tagRe.lastIndex = close < 0 ? src.length : close + "</think>".length;
      continue;
    }
    if (!TOOL_NAMES.has(name)) {
      // zmínka <copy> v próze, echo <copy-results>, HTML v textu mezi akcemi: není to akce
      if (name === BLOCK || name === RESULTS || name === "result" || name === "note" || name === "user") continue;
      out.errors.push(`Unknown action <${name}>; allowed: ${[...TOOL_NAMES].join(", ")}.`);
      continue;
    }
    const attrs = parseAttrs(rawAttrs);
    const action: Action = { tool: name, attrs, index: index++ };
    if (BODY_TOOLS.has(name)) {
      if (selfClose) {
        out.errors.push(`<${name}> requires a body and a closing </${name}> tag.`);
        continue;
      }
      const bodyStart = m.index + full.length;
      const endMarker = `</${name}>`;
      const end = findBodyEnd(src, bodyStart, endMarker);
      const label = `<${name}${attrs.path ? ` path="${attrs.path}"` : ""}>`;
      if (end < 0) {
        const wrong = findWrongClose(src, bodyStart);
        if (wrong) {
          out.errors.push(`${label} was closed with ${wrong.tag} instead of ${endMarker}; the action was SKIPPED. Resend it with the right closing tag.`);
          tagRe.lastIndex = wrong.end;
          continue;
        }
        // useknutá odpověď: tělo se nikdy nevykoná, model dostane přesně, co má poslat znovu
        out.truncatedAction = { tool: name, attrs, index: action.index };
        out.errors.push(`Missing closing ${endMarker} for ${label}: the reply was cut off there, so this action was SKIPPED (actions before it ran). Resend it complete, split into parts if it is long.`);
        break;
      }
      action.body = trimBody(src.slice(bodyStart, end));
      tagRe.lastIndex = end + endMarker.length;
    }
    if (validate(action, out)) out.actions.push(action);
  }
  return out;
}

interface Candidate {
  attrs: Record<string, string>;
  tagStart: number;
  start: number;
  scan: Scan;
}

/**
 * Vybere správný blok. Otevíracích tagů může být víc (ukázka v próze, příklad uvnitř dokumentu).
 * Kandidáti uvnitř jiného uzavřeného kandidáta se zahodí; z ostatních se bere ten s akcemi
 * a uzavřením, přednostně s očekávaným kolem; při shodě poslední.
 */
function pickBlock(src: string, expectedTurn?: number): Candidate | null {
  const all: Candidate[] = [];
  OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN_RE.exec(src))) {
    const start = m.index + m[0].length;
    all.push({ attrs: parseAttrs(m[1]), tagStart: m.index, start, scan: scanBlock(src, start) });
  }
  if (!all.length) return null;
  const top: Candidate[] = [];
  let coveredUntil = -1;
  for (const c of all) {
    if (c.tagStart < coveredUntil) continue;
    top.push(c);
    if (c.scan.close >= 0) coveredUntil = c.scan.close + CLOSE_TAG.length;
  }
  const score = (c: Candidate): number => {
    const turn = Number(c.attrs.turn);
    let s = 0;
    if (c.scan.actions.length) s += 100;
    if (c.scan.close >= 0) s += 10;
    if (c.attrs.turn && !Number.isNaN(turn)) s += 5;
    if (expectedTurn !== undefined && turn === expectedTurn) s += 3;
    return s;
  };
  let best = top[0];
  for (const c of top) if (score(c) >= score(best)) best = c;
  return best;
}

/** Rozebere odpověď modelu. `expectedTurn` pomáhá vybrat správný blok, když jich je víc. */
export function parseReply(text: string, expectedTurn?: number): ParsedReply {
  const first = parseOnce(text, expectedTurn);
  if (first.actions.length > 0 || !new RegExp(`&lt;${BLOCK}\\b`).test(text)) return first;
  // model (nebo chat) HTML-escapoval značky protokolu: dekódujeme celou odpověď a zkusíme to znovu
  const second = parseOnce(decodeEntities(text), expectedTurn);
  if (second.actions.length === 0) return first;
  second.raw = text;
  second.notes.unshift(`The protocol tags in your reply were HTML-escaped (&lt;${BLOCK}&gt;…); the tool decoded the whole reply, so any &lt; or &amp; meant literally became < or &. Send the tags unescaped, inside a code fence.`);
  return second;
}

function parseOnce(text: string, expectedTurn?: number): ParsedReply {
  const result: ParsedReply = { turn: null, session: null, actions: [], errors: [], notes: [], prose: "", outside: "", raw: text };
  const cleaned = stripOuterFence(text.replace(/\r\n/g, "\n").replace(/​|﻿/g, ""));
  const block = pickBlock(cleaned, expectedTurn);
  if (!block) {
    result.errors.push(`No <${BLOCK} turn="N"> ... </${BLOCK}> block found in the reply.`);
    result.prose = text.trim();
    result.outside = result.prose;
    return result;
  }
  if (block.scan.close < 0) {
    result.truncated = true;
    if (!block.scan.truncatedAction) result.errors.push(`Missing closing </${BLOCK}> tag (the reply was probably cut off by the chat's length limit).`);
  }
  if (block.scan.truncatedAction) {
    result.truncated = true;
    result.truncatedAction = block.scan.truncatedAction;
  }
  const turn = Number(block.attrs.turn);
  result.turn = block.attrs.turn && !Number.isNaN(turn) ? turn : null;
  result.session = block.attrs.session ?? null;
  const part = (block.attrs.part ?? "").match(/^\s*(\d+)\s*(?:\/|of)\s*(\d+)\s*$/);
  if (part) result.part = { index: Number(part[1]), total: Number(part[2]) };
  // text před blokem bez případného ohrazení, které blok obklopovalo
  result.prose = block.tagStart > 0 ? cleaned.slice(0, block.tagStart).trim().replace(/\n?(?:`{3,}|~{3,})[\w.+-]*[ \t]*$/, "").trim() : "";
  const after = block.scan.close >= 0 ? cleaned.slice(block.scan.close + CLOSE_TAG.length).trim().replace(/^(?:`{3,}|~{3,})[ \t]*\n?/, "").trim() : "";
  result.outside = [result.prose, after].filter(Boolean).join("\n\n");
  result.actions = block.scan.actions;
  result.errors.push(...block.scan.errors);
  result.notes.push(...block.scan.notes);
  if (result.actions.length === 0 && block.scan.errors.length === 0) result.errors.push(`The <${BLOCK}> block contains no actions.`);
  return result;
}

/** Odstraní právě jeden úvodní newline a koncové bílé znaky posledního řádku. */
function trimBody(s: string): string {
  return s.replace(/^[ \t]*\n/, "").replace(/\n[ \t]*$/, "");
}

/** Model občas HTML-escapuje značky hunků uvnitř dokumentu; do souboru patří skutečné znaky. */
function decodeHunkMarkers(body: string): string {
  return body
    .replace(/^(\s*)(?:&lt;){5,}(\s*SEARCH)/gm, (_m, ws: string, tail: string) => `${ws}<<<<<<<${tail}`)
    .replace(/^(\s*)(?:&gt;){5,}(\s*REPLACE)/gm, (_m, ws: string, tail: string) => `${ws}>>>>>>>${tail}`);
}

/** Tělo zabalené celé do ``` … ``` (model „pro jistotu“): ohrazení pryč, obsah zůstává. */
function stripBodyFence(body: string): string | null {
  const m = body.match(/^(`{3,}|~{3,})[\w.+-]*[ \t]*\n([\s\S]*?)\n\1[ \t]*$/);
  return m ? m[2] : null;
}

/** Akce, jejichž tělo je text pro uživatele, ne obsah souboru či příkaz (entity se dekódují vždy). */
const TEXT_TOOLS = new Set(["status", "done", "ask", "dialog", "plan", "suggest"]);

/**
 * Model občas escapuje < > & v celém těle. U souborů a příkazů se dekóduje jen tělo bez jediného
 * syrového < nebo > (tam je to escapování, ne obsah). Texty pro uživatele vždy.
 */
function decodeEntitiesIfConsistent(body: string, always: boolean): string | null {
  if (!/&(lt|gt|amp|quot|#39);/.test(body)) return null;
  if (!always && /[<>]/.test(body)) return null;
  return decodeEntities(body);
}

/** Tělo zabalené do <![CDATA[ … ]]>: obal do souboru nepatří; sekce spojit. */
function stripCdata(body: string): string | null {
  const t = body.trim();
  if (!t.startsWith("<![CDATA[") || !t.endsWith("]]>")) return null;
  return trimBody(t.slice("<![CDATA[".length, -"]]>".length).replace(/\]\]><!\[CDATA\[/g, ""));
}

/** Vrátí false, když je akce natolik poškozená, že se nemá vykonat. */
function validate(action: Action, out: Scan): boolean {
  let ok = true;
  for (const a of REQUIRED_ATTRS[action.tool] ?? []) {
    if (!action.attrs[a]) {
      out.errors.push(`<${action.tool}> is missing required attribute "${a}".`);
      ok = false;
    }
  }
  if (BODY_TOOLS.has(action.tool) && action.tool !== "status" && !action.body?.trim()) {
    out.errors.push(`<${action.tool}> has an empty body.`);
    ok = false;
  }
  if (action.body && BODY_TOOLS.has(action.tool)) {
    const where = action.attrs.path ? ` path="${action.attrs.path}"` : "";
    const bare = stripCdata(action.body);
    if (bare !== null) {
      action.body = bare;
      out.notes.push(`<${action.tool}${where}>: the body was wrapped in <![CDATA[ … ]]>; the wrapper was removed. Bodies are verbatim text, never CDATA.`);
    }
    const textual = TEXT_TOOLS.has(action.tool);
    const decoded = decodeEntitiesIfConsistent(action.body, textual);
    if (decoded !== null) {
      action.body = decoded;
      if (!textual || !out.notes.some((n) => n.includes("HTML-escaped"))) {
        out.notes.push(`<${action.tool}${where}>: the body was HTML-escaped (&lt; &gt; &amp;); the tool decoded it. Write <, > and & as plain characters.`);
      }
    }
    if (action.tool === "write" || action.tool === "run") {
      const unfenced = stripBodyFence(action.body);
      if (unfenced !== null) {
        action.body = unfenced;
        out.notes.push(`<${action.tool}${where}>: the whole body was wrapped in a code fence; the fence was removed, bodies are verbatim.`);
      }
    }
    if (action.tool === "write" || action.tool === "edit") action.body = decodeHunkMarkers(action.body);
  }
  return ok;
}

/** Spojí části vícedílné odpovědi (part="i/n") do jedné: akce za sebou, chyby a poznámky dohromady. */
export function mergeParts(parts: ParsedReply[]): ParsedReply {
  const sorted = [...parts].sort((a, b) => (a.part?.index ?? 0) - (b.part?.index ?? 0));
  const merged: ParsedReply = {
    turn: sorted[0]?.turn ?? null,
    session: sorted[0]?.session ?? null,
    actions: [],
    errors: [],
    notes: [],
    prose: sorted.map((p) => p.prose).filter(Boolean).join("\n\n"),
    outside: sorted.map((p) => p.outside).filter(Boolean).join("\n\n"),
    raw: sorted.map((p) => p.raw).join("\n\n"),
  };
  let index = 0;
  for (const p of sorted) {
    for (const a of p.actions) merged.actions.push({ ...a, index: index++ });
    // chyba „blok bez akcí“ u dílčí části není chyba celku
    merged.errors.push(...p.errors.filter((e) => !/contains no actions/.test(e)));
    merged.notes.push(...p.notes);
    if (p.truncated) merged.truncated = true;
    if (p.truncatedAction) merged.truncatedAction = { ...p.truncatedAction, index: index };
  }
  if (merged.actions.length === 0 && merged.errors.length === 0) merged.errors.push(`The <${BLOCK}> block contains no actions.`);
  return merged;
}
