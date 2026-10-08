import { TurnSummary } from "../protocol/prompt";
import { Action, ActionResult, ParsedReply } from "../protocol/schema";
import { nowId } from "../protocol/text";

export type SessionState = "idle" | "composing" | "waitingForReply" | "executing" | "awaitingUser" | "done";

/**
 * Jeden krok doručení promptu: text (jedna část podle limitu chatu) nebo soubory (přílohy; na Windows
 * jdou do schránky, jinde se přiloží ručně). Kroky jdou po sobě: každý = jedno Ctrl+V v chatu.
 */
export type DeliveryStep = { kind: "text"; text: string; part: number; total: number } | { kind: "files"; files: string[]; promptFile?: boolean };

export interface TurnRecord {
  turn: number;
  at: string;
  promptChars: number;
  actions: Action[];
  results: ActionResult[];
  prose?: string;
  status?: string;
  errors?: string[];
  dialog?: { from: "model" | "user"; text: string }[];
  /** výsledky kola s <ask> ještě nebyly modelu odeslány (uživatel odpověděl v chatu) */
  undelivered?: boolean;
}

export interface SessionData {
  id: string;
  task: string;
  state: SessionState;
  /** číslo kola, na které právě čekáme / které se vykonává */
  turn: number;
  history: TurnRecord[];
  summaries: TurnSummary[];
  /** čekající prompt: celý text (bez dělení na části) */
  pendingPrompt: string;
  /** kroky doručení promptu do chatu (části textu podle limitu chatu, pak přílohy); který je ve schránce */
  pendingSteps?: DeliveryStep[];
  pendingStepIndex?: number;
  pendingAttachments?: string[];
  pendingQuestion?: string;
  pendingOptions?: string[];
  pendingMulti?: boolean;
  /** přijaté části vícedílné odpovědi modelu (part="i/n") čekající na zbytek */
  replyParts?: ParsedReply[];
  createdAt: string;
  finalSummary?: string;
  planMode?: boolean;
  plan?: string;
  suggestions?: Suggestion[];
  notes?: string[];
  noBlockReplies?: number;
  changedFiles?: string[];
  changedSinceReview?: string[];
  reviewRounds?: number;
  /** heuristika revize: od poslední revize došlo k větší změně (více souborů / celý přepis) */
  bigChangeSinceReview?: boolean;
}

export type SuggestionKind = "skill" | "script" | "instructions" | "rule" | "hook" | "allow" | "setting" | "task" | "agent";

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  scope: "project" | "global";
  title: string;
  body: string;
  turn: number;
  update?: string;
  lang?: string;
  file?: string;
  duplicate?: boolean;
  decision?: "approved" | "rejected";
}

export function createSession(task: string): SessionData {
  return { id: nowId(), task, state: "composing", turn: 1, history: [], summaries: [], pendingPrompt: "", createdAt: new Date().toISOString() };
}
