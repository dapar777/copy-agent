import * as path from "path";
import * as vscode from "vscode";
import { relOf, resolveRel, RootFolder, uniqueRoots } from "./protocol/roots";
import { applyEol, decodeBytes, detectEncoding, encodeText, FileEncoding, normalizeEncoding, toLf } from "./tools/encoding";

export const CONFIG = "copyAgent";
export const EXTENSION_ID = "dapar.copy-agent";

/** První složka workspace: tam žije stav agenta (.copy-agent/) a tam běží příkazy bez cwd. */
export function workspaceRoot(): vscode.Uri {
  const f = vscode.workspace.workspaceFolders?.[0];
  if (!f) throw new Error("Není otevřený žádný workspace (složka). Otevřete složku projektu a zkuste to znovu.");
  return f.uri;
}

export function workspaceFolders(): RootFolder[] {
  return uniqueRoots((vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, fsPath: f.uri.fsPath })));
}

export function workspaceName(): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length > 1) return vscode.workspace.name ?? folders.map((f) => f.name).join(" + ");
  return folders[0]?.name ?? "workspace";
}

export function resolveInWorkspace(rel: string): vscode.Uri {
  return vscode.Uri.file(resolveRel(rel, workspaceFolders()).fsPath);
}

export function tryToRel(uri: vscode.Uri): string | undefined {
  return uri.scheme === "file" ? relOf(uri.fsPath, workspaceFolders()) : undefined;
}

export function toRel(uri: vscode.Uri): string {
  return tryToRel(uri) ?? path.relative(workspaceRoot().fsPath, uri.fsPath).replace(/\\/g, "/");
}

export function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration(CONFIG).get<T>(key, fallback);
}

export async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function fileEncodingOf(uri: vscode.Uri): Promise<FileEncoding> {
  const fallback = cfg<string>("files.fallbackEncoding", "windows-1250");
  try {
    return detectEncoding(Buffer.from(await vscode.workspace.fs.readFile(uri)), fallback);
  } catch {
    const eolSetting = vscode.workspace.getConfiguration("files", uri).get<string>("eol", "auto");
    const def = cfg<string>("files.defaultEncoding", "utf8");
    return { encoding: normalizeEncoding(def), bom: def === "utf8bom", eol: eolSetting === "\r\n" ? "crlf" : "lf" };
  }
}

function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
}

/**
 * Obsah souboru s LF. Z otevřeného dokumentu se bere jen text s NEULOŽENÝMI změnami (ty na disku
 * nejsou); jinak se čtou bajty z disku a kódování se pozná z nich. Editor totiž může mít soubor
 * otevřený v jiném kódování (výchozí UTF-8 u souboru ve windows-1250 ukáže nahrazovací znaky)
 * a ten text by zkazil diakritiku modelu i následný zápis.
 */
export async function readText(uri: vscode.Uri): Promise<string> {
  const open = openDocument(uri);
  if (open?.isDirty) return toLf(open.getText());
  const buf = Buffer.from(await vscode.workspace.fs.readFile(uri));
  return toLf(decodeBytes(buf, detectEncoding(buf, cfg<string>("files.fallbackEncoding", "windows-1250")).encoding));
}

/**
 * Zápis; u existujícího souboru se zachová jeho kódování, BOM i konce řádků. Jde přímo na disk
 * v původním kódování (editor si otevřený neuložený dokument sám obnoví); jen dokument s neuloženými
 * změnami se přepíše přes editor, aby se změny neztratily (uloží se pak v kódování editoru).
 */
export async function writeText(uri: vscode.Uri, text: string): Promise<void> {
  const enc = await fileEncodingOf(uri);
  const open = openDocument(uri);
  if (open?.isDirty) {
    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length));
    edit.replace(uri, full, toLf(text));
    await vscode.workspace.applyEdit(edit);
    await open.save();
    return;
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
  await vscode.workspace.fs.writeFile(uri, encodeText(applyEol(text, enc.eol), enc));
}

export function kb(s: string | number): string {
  const n = typeof s === "string" ? s.length : s;
  return `${(n / 1000).toFixed(1)} k znaků`;
}
