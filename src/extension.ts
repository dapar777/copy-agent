import * as vscode from "vscode";
import { ClipboardBridge } from "./clipboard/ClipboardBridge";
import { Controller } from "./engine/Controller";
import { Session } from "./engine/Session";
import { ReviewManager } from "./review/ReviewManager";
import { ApprovalService } from "./safety/Approvals";
import { Checkpoint } from "./safety/Checkpoint";
import { SidebarView } from "./ui/SidebarView";
import { EXTENSION_ID } from "./util";

export function activate(context: vscode.ExtensionContext): void {
  const session = new Session();
  const review = new ReviewManager();
  const clipboard = new ClipboardBridge();
  const checkpoint = new Checkpoint();
  const approvals = new ApprovalService();
  const controller = new Controller(session, review, clipboard, checkpoint, approvals);
  controller.builtinSkillsDir = vscode.Uri.joinPath(context.extensionUri, "skills").fsPath;
  controller.reloadSkills();
  const sidebar = new SidebarView(controller, context.extensionUri);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "copyAgent.panel.focus";
  const renderStatus = () => {
    const s = session.current;
    const parts = s?.pendingSteps?.length ?? 1;
    const partIdx = (s?.pendingStepIndex ?? 0) + 1;
    const map: Record<string, string> = {
      waitingForReply:
        parts > 1 && partIdx < parts
          ? `$(clippy) Copy Agent: kolo ${s?.turn} – krok ${partIdx}/${parts} ve schránce`
          : controller.promptPhase === "sent"
            ? `$(clock) Copy Agent: kolo ${s?.turn} – čekám na odpověď modelu`
            : `$(clippy) Copy Agent: kolo ${s?.turn} – prompt ve schránce, vlož ho do chatu`,
      executing: "$(gear~spin) Copy Agent: provádím akce",
      awaitingUser: "$(question) Copy Agent: model se ptá",
      done: "$(check) Copy Agent: hotovo",
      composing: "$(loading~spin) Copy Agent: sestavuji prompt",
    };
    const pendingApprovals = approvals.pendingRequests.length;
    status.text = pendingApprovals ? `$(shield) Copy Agent: ${pendingApprovals} ke schválení` : s ? (map[s.state] ?? `$(comment) Copy Agent: ${s.state}`) : "$(comment) Copy Agent";
    status.backgroundColor = pendingApprovals || s?.state === "awaitingUser" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    const pending = review.pendingFiles.length;
    status.tooltip = pending ? `${pending} souborů čeká na schválení změn` : "Copy Agent";
    status.show();
    const attention = pendingApprovals + (s?.state === "awaitingUser" ? 1 : 0);
    sidebar.setBadge(attention, attention === 1 && s?.state === "awaitingUser" && !pendingApprovals ? "Model se ptá" : `${attention} ke schválení`);
  };
  session.onDidChange(renderStatus);
  review.onDidChange(renderStatus);
  approvals.onDidChange(renderStatus);
  controller.onDidChange(renderStatus);
  renderStatus();

  const cmd = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);

  context.subscriptions.push(
    session,
    review,
    clipboard,
    controller,
    approvals,
    status,
    vscode.window.registerWebviewViewProvider(SidebarView.viewId, sidebar, { webviewOptions: { retainContextWhenHidden: true } }),

    cmd("copyAgent.newTask", async () => {
      const task = await vscode.window.showInputBox({ title: "Copy Agent – nový úkol", prompt: "Co má agent udělat? (/plan pro režim s checklistem, /název-skillu pro skill)", placeHolder: "Např. Přidej validaci e-mailu do registračního formuláře", ignoreFocusOut: true });
      if (task?.trim()) await controller.submit(task.trim());
    }),
    cmd("copyAgent.pasteReply", async () => {
      const text = await vscode.env.clipboard.readText();
      if (!ClipboardBridge.looksLikeReply(text, clipboard.currentPrompt)) {
        const pick = await vscode.window.showWarningMessage("Schránka neobsahuje blok <copy>…</copy>. Použít obsah přesto?", "Použít");
        if (pick !== "Použít") return;
      }
      controller.submitReply(text);
    }),
    cmd("copyAgent.copyPromptAgain", () => controller.copyPromptAgain()),
    cmd("copyAgent.nextPart", () => controller.nextStep(false)),
    cmd("copyAgent.showPrompt", () => controller.showPrompt()),
    cmd("copyAgent.showTranscript", () => controller.showTranscript()),
    cmd("copyAgent.resendContext", () => controller.resendContext()),
    cmd("copyAgent.undoTurn", () => controller.undoTurn()),
    cmd("copyAgent.abort", () => controller.abort()),
    cmd("copyAgent.interrupt", () => controller.interrupt()),
    cmd("copyAgent.suggest", () => controller.runSuggest()),
    cmd("copyAgent.reloadSkills", () => controller.reloadSkills()),
    cmd("copyAgent.copyAgentInstructions", () => controller.copyAgentInstructions()),
    cmd("copyAgent.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${EXTENSION_ID}`)),
    cmd("copyAgent.toggleAutoApprove", () => approvals.setMode(approvals.mode === "auto" ? "ask" : "auto")),

    cmd("copyAgent.review.next", async () => {
      if (!(await review.goToNext())) void vscode.window.showInformationMessage("Žádné změny ke schválení.");
    }),
    cmd("copyAgent.review.acceptHunk", async (path: string, i: number) => {
      await review.accept(path, i);
      await review.goToNext({ path, index: i });
    }),
    cmd("copyAgent.review.rejectHunk", async (path: string, i: number) => {
      await review.reject(path, i);
      await review.goToNext({ path, index: i });
    }),
    cmd("copyAgent.review.acceptFile", (path: string) => review.accept(path)),
    cmd("copyAgent.review.rejectFile", (path: string) => review.reject(path)),
    cmd("copyAgent.review.acceptAll", () => review.acceptAll()),
    cmd("copyAgent.review.rejectAll", () => review.rejectAll()),
    cmd("copyAgent.review.openDiff", (path: string) => review.openDiff(path)),
  );

  void controller.resume();
}

export function deactivate(): void {
  /* subscriptions se uklidí samy */
}
