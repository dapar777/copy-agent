import * as vscode from "vscode";
import { nowId } from "../protocol/text";
import { cfg, CONFIG } from "../util";

export type ApprovalKind = "command" | "delete";

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  text: string;
  cwd?: string;
  at: string;
  decision?: "allow" | "deny" | "auto";
}

/**
 * Schvalování příkazů a mazání: karta v panelu místo modálních oken. Režim `auto` schválí vše
 * kromě denylistu; „vždy povolit“ přidá regulární výraz do nastavení.
 */
export class ApprovalService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly pending = new Map<string, { req: ApprovalRequest; resolve: (ok: boolean) => void }>();
  readonly history: ApprovalRequest[] = [];

  get mode(): "ask" | "auto" {
    return cfg<"ask" | "auto">("run.approval", "ask");
  }

  async setMode(mode: "ask" | "auto"): Promise<void> {
    await vscode.workspace.getConfiguration(CONFIG).update("run.approval", mode, vscode.ConfigurationTarget.Workspace);
    this.emitter.fire();
  }

  get pendingRequests(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  request(kind: ApprovalKind, text: string, cwd?: string): Promise<boolean> {
    const req: ApprovalRequest = { id: nowId(), kind, text, cwd, at: new Date().toISOString() };
    if (kind === "command" && this.mode === "auto") {
      req.decision = "auto";
      this.history.push(req);
      this.emitter.fire();
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      this.pending.set(req.id, { req, resolve });
      this.emitter.fire();
      void vscode.commands.executeCommand("copyAgent.panel.focus");
      vscode.window.setStatusBarMessage(`$(shield) Copy Agent čeká na schválení: ${text.slice(0, 60)}`, 15000);
    });
  }

  allowPatterns(): { pattern: string; scope: "global" | "workspace" }[] {
    const insp = vscode.workspace.getConfiguration(CONFIG).inspect<string[]>("run.allowPatterns");
    return [
      ...(insp?.globalValue ?? []).map((p) => ({ pattern: p, scope: "global" as const })),
      ...[...(insp?.workspaceValue ?? []), ...(insp?.workspaceFolderValue ?? [])].map((p) => ({ pattern: p, scope: "workspace" as const })),
    ];
  }

  async removeAllowPattern(pattern: string, scope: "global" | "workspace"): Promise<void> {
    const conf = vscode.workspace.getConfiguration(CONFIG);
    const insp = conf.inspect<string[]>("run.allowPatterns");
    const current = (scope === "global" ? insp?.globalValue : insp?.workspaceValue) ?? [];
    await conf.update("run.allowPatterns", current.filter((p) => p !== pattern), scope === "global" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
    this.emitter.fire();
  }

  async switchToAuto(): Promise<void> {
    await this.setMode("auto");
    for (const [id, p] of [...this.pending]) if (p.req.kind === "command") await this.decide(id, true);
  }

  async decide(id: string, allow: boolean, alwaysPattern?: string): Promise<void> {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.req.decision = allow ? "allow" : "deny";
    this.history.push(p.req);
    if (allow && alwaysPattern?.trim()) await this.addAllowPattern(alwaysPattern.trim());
    p.resolve(allow);
    this.emitter.fire();
  }

  async addAllowPattern(pattern: string, global = false): Promise<void> {
    try {
      new RegExp(pattern);
    } catch {
      void vscode.window.showWarningMessage(`Neplatný regulární výraz: ${pattern}`);
      return;
    }
    const conf = vscode.workspace.getConfiguration(CONFIG);
    const inspected = conf.inspect<string[]>("run.allowPatterns");
    const current = (global ? inspected?.globalValue : inspected?.workspaceValue) ?? [];
    if (!current.includes(pattern)) await conf.update("run.allowPatterns", [...current, pattern], global ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
    this.emitter.fire();
  }

  dispose(): void {
    for (const p of this.pending.values()) p.resolve(false);
    this.pending.clear();
    this.emitter.dispose();
  }
}
