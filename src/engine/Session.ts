import * as vscode from "vscode";
import { STATE_DIR } from "../protocol/roots";
import { fileExists, readText, workspaceRoot, writeText } from "../util";
import { createSession, SessionData } from "./SessionData";

export type { SessionData, SessionState, TurnRecord } from "./SessionData";

const FILE = `${STATE_DIR}/session.json`;

/** Stav sezení ve VS Code: události pro UI + persistence do .copy-agent/session.json (obnova po restartu). */
export class Session implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<SessionData | undefined>();
  readonly onDidChange = this.emitter.event;
  private data: SessionData | undefined;
  private persistTimer: NodeJS.Timeout | undefined;

  get current(): SessionData | undefined {
    return this.data;
  }

  start(task: string): SessionData {
    this.data = createSession(task);
    this.notify();
    return this.data;
  }

  update(patch: Partial<SessionData>): SessionData {
    if (!this.data) throw new Error("Žádné aktivní sezení.");
    Object.assign(this.data, patch);
    this.notify();
    return this.data;
  }

  clear(): void {
    this.data = undefined;
    this.notify();
  }

  dispose(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.emitter.dispose();
  }

  private notify(): void {
    this.emitter.fire(this.data);
    // persistence se sbírá (více změn za sebou = jeden zápis)
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => void this.persist(), 150);
  }

  async persist(): Promise<void> {
    try {
      const uri = vscode.Uri.joinPath(workspaceRoot(), FILE);
      if (!this.data) {
        if (await fileExists(uri)) await vscode.workspace.fs.delete(uri);
        return;
      }
      await writeText(uri, JSON.stringify(this.data, null, 2));
    } catch {
      /* bez workspace nebo bez práv */
    }
  }

  async restore(): Promise<SessionData | undefined> {
    try {
      const uri = vscode.Uri.joinPath(workspaceRoot(), FILE);
      if (!(await fileExists(uri))) return undefined;
      const d = JSON.parse(await readText(uri)) as SessionData;
      if (d.state === "done" || d.state === "idle") return undefined;
      if (d.state === "executing" || d.state === "composing") d.state = "waitingForReply";
      this.data = d;
      this.emitter.fire(d);
      return d;
    } catch {
      return undefined;
    }
  }
}
