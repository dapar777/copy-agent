import * as vscode from "vscode";
import { DiffHunk, diffLines } from "../protocol/diff";
import { fileExists, openDocumentWithEncoding, readText, resolveInWorkspace, tryToRel, writeText } from "../util";

/**
 * Review změn po vzoru Copilotu: soubor na disku už změnu obsahuje, manažer drží „baseline“
 * (stav před změnou). Čekající hunky = diff(baseline, soubor). Přijmout hunk = posunout baseline;
 * zamítnout hunk = vrátit soubor. Diffy se cachují podle obsahu souboru.
 */
export interface PendingChange {
  path: string;
  kind: "create" | "modify" | "delete";
  baseline: string;
  turn: number;
  deletedContent?: string;
}

export interface PendingHunk {
  path: string;
  index: number;
  total: number;
  hunk: DiffHunk;
}

export const ORIG_SCHEME = "copy-agent-orig";

export class ReviewManager implements vscode.Disposable {
  private readonly changes = new Map<string, PendingChange>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly notes: string[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly codeLensEmitter = new vscode.EventEmitter<void>();
  private readonly diffCache = new Map<string, { baseline: string; live: string; hunks: DiffHunk[] }>();

  private readonly addedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly removedDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: "2px 0 0 0",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    after: { contentText: "  ⟵ Copy Agent: zde byly odstraněny řádky (viz CodeLens)", color: new vscode.ThemeColor("editorCodeLens.foreground"), fontStyle: "italic" },
  });

  constructor() {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(ORIG_SCHEME, {
        provideTextDocumentContent: (uri) => this.changes.get(uri.path.replace(/^\//, ""))?.baseline ?? "",
      }),
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, { onDidChangeCodeLenses: this.codeLensEmitter.event, provideCodeLenses: (doc) => this.provideCodeLenses(doc) }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const rel = tryToRel(e.document.uri);
        if (rel && this.changes.has(rel)) this.refreshDecorations();
      }),
    );
  }

  register(path: string, kind: "create" | "modify", baseline: string, turn: number): void {
    const existing = this.changes.get(path);
    if (existing) existing.turn = turn;
    else this.changes.set(path, { path, kind, baseline, turn });
    this.fire();
  }

  registerDelete(path: string, content: string, turn: number): void {
    this.changes.set(path, { path, kind: "delete", baseline: "", turn, deletedContent: content });
    this.fire();
  }

  get pendingFiles(): PendingChange[] {
    return [...this.changes.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async pendingHunks(): Promise<PendingHunk[]> {
    const out: PendingHunk[] = [];
    for (const c of this.pendingFiles) {
      const hunks = await this.hunksFor(c);
      hunks.forEach((h, i) => out.push({ path: c.path, index: i, total: hunks.length, hunk: h }));
    }
    return out;
  }

  get hasPending(): boolean {
    return this.changes.size > 0;
  }

  drainNotes(): string[] {
    return this.notes.splice(0, this.notes.length);
  }

  private async hunksFor(c: PendingChange): Promise<DiffHunk[]> {
    if (c.kind === "delete") return [{ oldStart: 0, oldLines: (c.deletedContent ?? "").split(/\r?\n/), newStart: 0, newLines: [] }];
    const uri = resolveInWorkspace(c.path);
    if (!(await fileExists(uri))) return [];
    const live = await readText(uri);
    const cached = this.diffCache.get(c.path);
    if (cached && cached.baseline === c.baseline && cached.live === live) return cached.hunks;
    const hunks = diffLines(c.baseline, live);
    this.diffCache.set(c.path, { baseline: c.baseline, live, hunks });
    return hunks;
  }

  async accept(path: string, hunkIndex?: number): Promise<void> {
    const c = this.changes.get(path);
    if (!c) return;
    if (c.kind === "delete" || hunkIndex === undefined) {
      this.changes.delete(path);
      return this.fire();
    }
    const hunks = await this.hunksFor(c);
    const h = hunks[hunkIndex];
    if (!h) return;
    const base = c.baseline.replace(/\r\n/g, "\n").split("\n");
    base.splice(h.oldStart, h.oldLines.length, ...h.newLines);
    c.baseline = base.join("\n");
    if (hunks.length <= 1) this.changes.delete(path);
    this.fire();
  }

  async reject(path: string, hunkIndex?: number): Promise<void> {
    const c = this.changes.get(path);
    if (!c) return;
    const uri = resolveInWorkspace(c.path);
    if (c.kind === "delete") {
      await writeText(uri, c.deletedContent ?? "");
      this.notes.push(`The user rejected the deletion of ${c.path}; the file was restored.`);
      this.changes.delete(path);
      return this.fire();
    }
    if (hunkIndex === undefined) {
      if (c.kind === "create") {
        if (await fileExists(uri)) await vscode.workspace.fs.delete(uri);
        this.notes.push(`The user rejected the new file ${c.path}; it was removed.`);
      } else {
        await writeText(uri, c.baseline);
        this.notes.push(`The user rejected all changes to ${c.path}; the file was restored to its previous content.`);
      }
      this.changes.delete(path);
      return this.fire();
    }
    const hunks = await this.hunksFor(c);
    const h = hunks[hunkIndex];
    if (!h) return;
    const live = (await readText(uri)).replace(/\r\n/g, "\n").split("\n");
    live.splice(h.newStart, h.newLines.length, ...h.oldLines);
    await writeText(uri, live.join("\n"));
    const preview = h.newLines.slice(0, 3).join("\n");
    this.notes.push(`The user rejected a change in ${c.path} near line ${h.newStart + 1}${preview ? `:\n${preview}${h.newLines.length > 3 ? "\n…" : ""}` : ""}\nDo not re-apply it unless asked.`);
    if (hunks.length <= 1) this.changes.delete(path);
    this.fire();
  }

  async acceptAll(): Promise<void> {
    this.changes.clear();
    this.fire();
  }

  async rejectAll(): Promise<void> {
    for (const c of this.pendingFiles) await this.reject(c.path);
  }

  forgetTurn(turn: number): void {
    for (const [k, c] of this.changes) if (c.turn === turn) this.changes.delete(k);
    this.fire();
  }

  async openDiff(path: string): Promise<void> {
    const c = this.changes.get(path);
    if (!c || c.kind === "delete") return;
    const orig = vscode.Uri.from({ scheme: ORIG_SCHEME, path: "/" + path });
    // živá strana diffu se musí otevřít v kódování souboru (windows-1250…), jinak diff ukáže falešné změny v diakritice
    const live = resolveInWorkspace(path);
    await openDocumentWithEncoding(live);
    await vscode.commands.executeCommand("vscode.diff", orig, live, `${path} (před ↔ po)`);
  }

  async goToNext(after?: { path: string; index: number }): Promise<boolean> {
    const all = await this.pendingHunks();
    if (all.length === 0) return false;
    let next = all[0];
    if (after) {
      const i = all.findIndex((h) => h.path > after.path || (h.path === after.path && h.index >= after.index));
      if (i >= 0) next = all[i];
    }
    const c = this.changes.get(next.path)!;
    if (c.kind === "delete") {
      const pick = await vscode.window.showWarningMessage(`Copy Agent smazal soubor ${c.path}.`, "Přijmout", "Zamítnout (obnovit)");
      if (pick === "Přijmout") await this.accept(c.path);
      else if (pick) await this.reject(c.path);
      return true;
    }
    const doc = await openDocumentWithEncoding(resolveInWorkspace(next.path));
    const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
    const range = this.rangeFor(doc, next.hunk);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(range.start, range.start);
    return true;
  }

  private rangeFor(doc: vscode.TextDocument, h: DiffHunk): vscode.Range {
    const start = Math.min(h.newStart, Math.max(0, doc.lineCount - 1));
    const endLine = h.newLines.length ? Math.min(doc.lineCount - 1, h.newStart + h.newLines.length - 1) : start;
    return new vscode.Range(start, 0, endLine, doc.lineAt(endLine).text.length);
  }

  private async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const path = tryToRel(doc.uri);
    const c = path ? this.changes.get(path) : undefined;
    if (!c || !path) return [];
    const hunks = await this.hunksFor(c);
    if (hunks.length === 0) return [];
    const lenses: vscode.CodeLens[] = [];
    const top = new vscode.Range(0, 0, 0, 0);
    lenses.push(
      new vscode.CodeLens(top, { title: `Copy Agent: ${hunks.length} změn v souboru`, command: "" }),
      new vscode.CodeLens(top, { title: "$(check-all) Přijmout vše", command: "copyAgent.review.acceptFile", arguments: [path] }),
      new vscode.CodeLens(top, { title: "$(close-all) Zamítnout vše", command: "copyAgent.review.rejectFile", arguments: [path] }),
      new vscode.CodeLens(top, { title: "$(diff) Diff", command: "copyAgent.review.openDiff", arguments: [path] }),
    );
    hunks.forEach((h, i) => {
      const r = this.rangeFor(doc, h);
      const label = h.newLines.length === 0 ? `−${h.oldLines.length} řádků` : h.oldLines.length === 0 ? `+${h.newLines.length}` : `~${h.oldLines.length}→${h.newLines.length}`;
      lenses.push(
        new vscode.CodeLens(r, { title: `Změna ${i + 1}/${hunks.length} (${label})`, command: "" }),
        new vscode.CodeLens(r, { title: "$(check) Přijmout", command: "copyAgent.review.acceptHunk", arguments: [path, i] }),
        new vscode.CodeLens(r, { title: "$(x) Zamítnout", command: "copyAgent.review.rejectHunk", arguments: [path, i] }),
      );
    });
    return lenses;
  }

  async refreshDecorations(): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      const rel = tryToRel(editor.document.uri);
      const c = rel ? this.changes.get(rel) : undefined;
      if (!c) {
        editor.setDecorations(this.addedDeco, []);
        editor.setDecorations(this.removedDeco, []);
        continue;
      }
      const hunks = await this.hunksFor(c);
      const added: vscode.Range[] = [];
      const removed: vscode.Range[] = [];
      for (const h of hunks) {
        const r = this.rangeFor(editor.document, h);
        (h.newLines.length ? added : removed).push(r);
      }
      editor.setDecorations(this.addedDeco, added);
      editor.setDecorations(this.removedDeco, removed);
    }
  }

  private fire(): void {
    this.emitter.fire();
    this.codeLensEmitter.fire();
    void this.refreshDecorations();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.addedDeco.dispose();
    this.removedDeco.dispose();
  }
}
