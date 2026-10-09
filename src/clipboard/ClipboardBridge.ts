import { execFile } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { classifyProse, isOwnPrompt, looksLikeReply, looksLikeTruncatedReply, normalizeClipboard } from "../protocol/detect";
export { setClipboardFiles };
import { STATE_DIR } from "../protocol/roots";
import { cfg, resolveInWorkspace, workspaceName, workspaceRoot, writeText } from "../util";
import { ClipboardOwner } from "./ClipboardOwner";
import { FileReplyWatcher } from "./FileReplyWatcher";

/** Windows: vloží do schránky soubory (file drop list); chat je po Ctrl+V připojí jako přílohy. */
function setClipboardFiles(fsPaths: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const list = fsPaths.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Set-Clipboard -Path @(${list})`], { windowsHide: true, timeout: 10000 }, (err) => (err ? reject(err) : resolve()));
  });
}

/** Uživatelská hlavička a patička promptu; zástupné znaky {turn}, {project}. */
export function decoratePrompt(text: string, turn?: number): string {
  const fill = (s: string) => s.replace(/\{turn\}/g, String(turn ?? "")).replace(/\{project\}/g, workspaceName()).trim();
  const header = fill(cfg<string>("prompt.header", ""));
  const footer = fill(cfg<string>("prompt.footer", ""));
  return (header ? header + "\n\n" : "") + text + (footer ? "\n\n" + footer : "");
}

/**
 * Přenos promptů a odpovědí přes schránku. Text jde do schránky okamžitě přes VS Code API (žádné
 * čekání na pomocný proces); na Windows se navíc (volitelně) spustí vlastník schránky, který pozná
 * skutečné vložení promptu a okamžitě ohlásí, že uživatel zkopíroval něco jiného (odpověď).
 * Při čekání se schránka polluje; odpověď se převezme, jakmile obsahuje blok <copy turn=…>.
 */
export class ClipboardBridge implements vscode.Disposable {
  private lastPrompt = "";
  private readonly otherEmitter = new vscode.EventEmitter<void>();
  readonly onDidCopyOther = this.otherEmitter.event;
  private readonly owner = new ClipboardOwner(() => {
    try {
      return path.join(workspaceRoot().fsPath, STATE_DIR, "tmp");
    } catch {
      return undefined; // bez workspace zůstane systémový Temp
    }
  });
  private readonly pasteEmitter = new vscode.EventEmitter<void>();
  readonly onDidPaste = this.pasteEmitter.event;
  private pastedSincePrompt = false;
  private timer: NodeJS.Timeout | undefined;
  private waiter: { resolve: (text: string) => void; reject: (e: Error) => void } | undefined;
  private fileWatcher: FileReplyWatcher | undefined;
  private readonly logEmitter = new vscode.EventEmitter<string>();
  readonly onDidLog = this.logEmitter.event;
  private readonly noticeEmitter = new vscode.EventEmitter<{ text: string; icon?: string }>();
  readonly onDidNotify = this.noticeEmitter.event;
  /** svazky, které se v tomto kole podařilo vložit do historie schránky (Win+V) */
  lastHistoryItems: string[] = [];
  private focusSub: vscode.Disposable;

  constructor() {
    this.owner.onDidPaste(() => {
      this.pastedSincePrompt = true;
      this.pasteEmitter.fire();
    });
    this.owner.onDidLose(() => {
      this.otherEmitter.fire();
      void this.pollOnce();
    });
    // návrat do okna VS Code: uživatel nejspíš právě zkopíroval odpověď → přečíst hned
    this.focusSub = vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) void this.pollOnce();
    });
  }

  private notify(text: string, icon?: string): void {
    this.logEmitter.fire(text);
    this.noticeEmitter.fire({ text, icon });
  }

  get currentPrompt(): string {
    return this.lastPrompt;
  }

  /**
   * Uloží text (jednu část promptu) do schránky: hned přes VS Code API (žádné čekání na pomocný
   * proces); na Windows ho pak vlastník převezme znovu s odloženým vykreslením kvůli detekci vložení.
   */
  async copyText(text: string, turn?: number): Promise<void> {
    text = decoratePrompt(text, turn);
    this.lastPrompt = text;
    this.pastedSincePrompt = false;
    this.lastHistoryItems = [];
    await vscode.env.clipboard.writeText(text);
    if (process.platform === "win32" && cfg<boolean>("clipboard.pasteDetection", true)) {
      void this.owner.take(text).then((ok) => {
        if (!ok) this.logEmitter.fire("Detekce vložení promptu není k dispozici (pomocný proces se nespustil); čekám na odpověď pollingem.");
      });
    }
  }

  /**
   * Dá do schránky soubory (přílohy; volitelně i text promptu jako prompt-N.txt). Jen Windows:
   * chat je po Ctrl+V připojí jako přílohy. Vrací false, když to nejde (uživatel přiloží ručně).
   */
  async copyFiles(rels: string[], promptText?: string, turn?: number): Promise<boolean> {
    await this.owner.release();
    this.pastedSincePrompt = true; // text (pokud byl) už je vložený; teď čekáme na odpověď
    if (process.platform !== "win32") return false;
    try {
      const files = rels.filter((a) => /\.(png|jpe?g|gif|webp|txt|md)$/i.test(a)).map((a) => resolveInWorkspace(a).fsPath);
      if (promptText !== undefined) {
        const uri = vscode.Uri.joinPath(workspaceRoot(), STATE_DIR, `copy-prompt-${turn ?? "x"}.txt`);
        await writeText(uri, decoratePrompt(promptText, turn));
        this.lastPrompt = promptText;
        files.unshift(uri.fsPath);
      }
      if (!files.length) return false;
      await setClipboardFiles(files);
      return true;
    } catch (e) {
      this.logEmitter.fire(`Soubory se nepodařilo dát do schránky: ${(e as Error).message}`);
      return false;
    }
  }

  /** Svazky do historie schránky (Win+V) jako samostatné texty; vrací, co se povedlo. */
  async copyToHistory(rels: string[]): Promise<string[]> {
    const copied: string[] = [];
    for (const a of rels.filter((a) => /\.(txt|md)$/i.test(a))) {
      try {
        const bytes = await vscode.workspace.fs.readFile(resolveInWorkspace(a));
        await vscode.env.clipboard.writeText(Buffer.from(bytes).toString("utf8"));
        await new Promise((r) => setTimeout(r, 400));
        copied.push(a);
      } catch (e) {
        this.notify(`Svazek ${a} se nepodařilo dát do historie schránky (${(e as Error).message}); přiložte ho ručně.`, "alert");
      }
    }
    this.lastHistoryItems = copied;
    return copied;
  }

  private async pollOnce(): Promise<void> {
    if (!this.waiter) return;
    try {
      const text = await vscode.env.clipboard.readText();
      if (this.isReply(text)) this.waiter.resolve(text);
    } catch {
      /* ignore */
    }
  }

  /** Odpověď modelu: úplný blok, nebo (po vložení promptu) useknutý blok či dokument v chatu. */
  private isReply(text: string): boolean {
    if (looksLikeReply(text, this.lastPrompt)) return true;
    const pasted = this.pastedSincePrompt || process.platform !== "win32" || !cfg<boolean>("clipboard.pasteDetection", true);
    if (!pasted) return false;
    if (looksLikeTruncatedReply(text, this.lastPrompt)) return true;
    const t = normalizeClipboard(text);
    if (t.length < 300 || isOwnPrompt(t) || t === normalizeClipboard(this.lastPrompt)) return false;
    return classifyProse(t) === "document";
  }

  static looksLikeReply(text: string, lastPrompt = ""): boolean {
    return looksLikeReply(text, lastPrompt);
  }

  /** Čeká na odpověď ve schránce (nebo ruční vložení přes submitManual). */
  waitForReply(token: vscode.CancellationToken): Promise<string> {
    this.cancelWait(new Error("superseded"));
    return new Promise<string>((resolve, reject) => {
      const sub = token.onCancellationRequested(() => this.cancelWait(new Error("cancelled")));
      this.waiter = {
        resolve: (text) => {
          sub.dispose();
          this.stopPolling();
          this.waiter = undefined;
          resolve(text);
        },
        reject: (e) => {
          sub.dispose();
          this.stopPolling();
          this.waiter = undefined;
          reject(e);
        },
      };
      if (cfg<boolean>("clipboard.watch", true)) this.startPolling();
      this.startFileWatch();
    });
  }

  replyDirs(): string[] {
    return cfg<string>("reply.watchDir", "")
      .split(";")
      .map((d) => d.trim().replace(/[\\/]+$/, ""))
      .filter(Boolean);
  }

  private startFileWatch(): void {
    this.fileWatcher?.stop();
    this.fileWatcher = undefined;
    const dirs = this.replyDirs();
    if (!dirs.length) return;
    this.fileWatcher = new FileReplyWatcher({ dirs, pattern: "*.{xml,md,txt}", pollMs: Math.max(500, cfg<number>("clipboard.pollMs", 300)), lastPrompt: this.lastPrompt, log: (l) => this.logEmitter.fire(l), onReply: (text) => this.waiter?.resolve(text) });
    this.fileWatcher.start();
  }

  submitManual(text: string): boolean {
    if (!this.waiter) return false;
    this.waiter.resolve(text);
    return true;
  }

  private startPolling(): void {
    this.stopPolling();
    const poll = Math.max(150, cfg<number>("clipboard.pollMs", 300));
    let lastSeen = normalizeClipboard(this.lastPrompt);
    this.timer = setInterval(async () => {
      if (!this.waiter) return this.stopPolling();
      // dokud schránku vlastníme my, obsah známe (čtení by vyvolalo naše vlastní vykreslení)
      if (this.owner.alive) return;
      let text: string;
      try {
        text = await vscode.env.clipboard.readText();
      } catch {
        return;
      }
      const seen = normalizeClipboard(text);
      if (seen === lastSeen) return;
      lastSeen = seen;
      if (this.isReply(text)) this.waiter.resolve(text);
      else if (seen !== normalizeClipboard(this.lastPrompt)) this.otherEmitter.fire();
    }, poll);
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.fileWatcher?.stop();
    this.fileWatcher = undefined;
  }

  private cancelWait(err: Error): void {
    const w = this.waiter;
    this.waiter = undefined;
    this.stopPolling();
    w?.reject(err);
  }

  dispose(): void {
    this.cancelWait(new Error("disposed"));
    this.owner.dispose();
    this.focusSub.dispose();
    this.otherEmitter.dispose();
    this.pasteEmitter.dispose();
    this.logEmitter.dispose();
    this.noticeEmitter.dispose();
  }
}
