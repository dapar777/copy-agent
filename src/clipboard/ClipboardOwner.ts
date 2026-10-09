import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Vlastník schránky s odloženým vykreslením (jen Windows, volitelné). Text promptu se do schránky
 * nedává rovnou; systém si ho vyžádá až ve chvíli, kdy ho někdo skutečně vkládá (WM_RENDERFORMAT),
 * tím poznáme, že prompt byl vložen do chatu. Když si schránku vezme jiná aplikace (uživatel
 * zkopíroval odpověď), přijde WM_DESTROYCLIPBOARD a odpověď se přečte hned, bez čekání na polling.
 */
export class ClipboardOwner implements vscode.Disposable {
  private proc: ChildProcess | undefined;
  private stopFile: string | undefined;
  private readonly pasteEmitter = new vscode.EventEmitter<void>();
  private readonly loseEmitter = new vscode.EventEmitter<void>();
  readonly onDidPaste = this.pasteEmitter.event;
  readonly onDidLose = this.loseEmitter.event;
  private static readonly GRACE_MS = 800;

  /**
   * @param tempDir složka pro dočasný soubor s textem (ve workspace .copy-agent/tmp, aby agent nic
   * nevytvářel mimo svou složku); bez workspace systémový Temp.
   */
  constructor(private readonly tempDir: () => string | undefined = () => undefined) {}

  get alive(): boolean {
    return !!this.proc && this.proc.exitCode === null;
  }

  /** Převezme schránku s daným textem. Vrací false, když to nejde (zůstává běžný zápis). */
  async take(text: string): Promise<boolean> {
    if (process.platform !== "win32") return false;
    await this.release();
    let base = this.tempDir();
    try {
      if (base) fs.mkdirSync(base, { recursive: true });
    } catch {
      base = undefined;
    }
    const dir = fs.mkdtempSync(path.join(base ?? os.tmpdir(), "clip-"));
    const textFile = path.join(dir, "prompt.txt");
    this.stopFile = path.join(dir, "stop");
    fs.writeFileSync(textFile, text, "utf8");
    return new Promise<boolean>((resolve) => {
      const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT], {
        windowsHide: true,
        env: { ...process.env, CA_CLIP_FILE: textFile, CA_CLIP_STOP: this.stopFile },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.proc = proc;
      let ready = false;
      let buf = "";
      const timer = setTimeout(() => {
        if (!ready) {
          this.kill(proc);
          resolve(false);
        }
      }, 6000);
      proc.stdout?.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line === "READY") {
            ready = true;
            clearTimeout(timer);
            resolve(true);
          } else if (line.startsWith("RENDER ")) {
            const [, msText, reader = ""] = line.split(" ");
            const ms = Number(msText);
            const viaWindow = reader.startsWith("open:") && !/^open:(svchost|cbdhsvc|explorer|SearchHost|powershell)/i.test(reader);
            if (viaWindow || ms >= ClipboardOwner.GRACE_MS) this.pasteEmitter.fire();
          } else if (line === "LOST") this.loseEmitter.fire();
          else if (line === "FAIL") {
            clearTimeout(timer);
            resolve(false);
          }
        }
      });
      proc.on("exit", () => {
        if (this.proc === proc) this.proc = undefined;
        if (!ready) {
          clearTimeout(timer);
          resolve(false);
        }
        fs.rm(dir, { recursive: true, force: true }, () => undefined);
      });
      proc.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  /** Uvolní schránku; text v ní zůstane (proces ho před ukončením vykreslí). */
  async release(): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    if (this.stopFile) {
      try {
        fs.writeFileSync(this.stopFile, "stop");
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.kill(proc);
        resolve();
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    if (this.proc === proc) this.proc = undefined;
  }

  private kill(proc: ChildProcess): void {
    try {
      proc.kill();
    } catch {
      /* už neběží */
    }
  }

  dispose(): void {
    void this.release();
    this.pasteEmitter.dispose();
    this.loseEmitter.dispose();
  }
}

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
public class ClipOwner : NativeWindow {
  [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  [DllImport("user32.dll")] static extern bool EmptyClipboard();
  [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint fmt, IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
  [DllImport("user32.dll")] static extern IntPtr GetOpenClipboardWindow();
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
  const int WM_RENDERFORMAT = 0x0305, WM_RENDERALLFORMATS = 0x0306, WM_DESTROYCLIPBOARD = 0x0307;
  const uint CF_UNICODETEXT = 13, GMEM_MOVEABLE = 2;
  readonly string text; DateTime setAt; public bool Lost;
  bool rearming; public bool RenderedSinceArm; bool initialRearmDone; IntPtr fgLast; readonly uint myPid;
  public ClipOwner(string t) { text = t; myPid = (uint)System.Diagnostics.Process.GetCurrentProcess().Id; CreateHandle(new CreateParams()); }
  public bool Take() {
    for (int i = 0; i < 10; i++) { if (OpenClipboard(Handle)) break; System.Threading.Thread.Sleep(50); if (i == 9) return false; }
    EmptyClipboard(); SetClipboardData(CF_UNICODETEXT, IntPtr.Zero); CloseClipboard(); setAt = DateTime.UtcNow; RenderedSinceArm = false; return true;
  }
  void ReArm() {
    if (Lost || GetClipboardOwner() != Handle || !OpenClipboard(Handle)) return;
    rearming = true;
    try { EmptyClipboard(); SetClipboardData(CF_UNICODETEXT, IntPtr.Zero); } finally { CloseClipboard(); rearming = false; }
    setAt = DateTime.UtcNow; RenderedSinceArm = false;
  }
  public void Tick() {
    if (Lost) return;
    IntPtr fg = GetForegroundWindow();
    if (fg != fgLast) {
      fgLast = fg; uint pid = 0; if (fg != IntPtr.Zero) GetWindowThreadProcessId(fg, out pid);
      if (RenderedSinceArm && pid != myPid) ReArm();
      return;
    }
    if (RenderedSinceArm && !initialRearmDone && (DateTime.UtcNow - setAt).TotalMilliseconds > 1500) { initialRearmDone = true; ReArm(); }
  }
  void Render() {
    var bytes = Encoding.Unicode.GetBytes(text + "\\0");
    var h = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes.Length);
    var p = GlobalLock(h); Marshal.Copy(bytes, 0, p, bytes.Length); GlobalUnlock(h);
    SetClipboardData(CF_UNICODETEXT, h);
  }
  public void RenderNow() { if (Lost) return; if (GetClipboardOwner() != Handle) return; if (OpenClipboard(Handle)) { Render(); CloseClipboard(); } }
  static string Reader() {
    try {
      IntPtr w = GetOpenClipboardWindow(); string via = "open";
      if (w == IntPtr.Zero) { w = GetForegroundWindow(); via = "fg"; }
      if (w == IntPtr.Zero) return "?";
      uint pid; GetWindowThreadProcessId(w, out pid);
      return via + ":" + System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
    } catch (Exception e) { return "?:" + e.GetType().Name; }
  }
  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_RENDERFORMAT) { string r = Reader(); Render(); RenderedSinceArm = true; Console.WriteLine("RENDER " + (int)(DateTime.UtcNow - setAt).TotalMilliseconds + " " + r); Console.Out.Flush(); return; }
    if (m.Msg == WM_RENDERALLFORMATS) { if (OpenClipboard(Handle)) { if (GetClipboardOwner() == Handle) Render(); CloseClipboard(); } return; }
    if (m.Msg == WM_DESTROYCLIPBOARD) { if (rearming) return; Lost = true; Console.WriteLine("LOST"); Console.Out.Flush(); Application.Exit(); return; }
    base.WndProc(ref m);
  }
}
"@
$text = [System.IO.File]::ReadAllText($env:CA_CLIP_FILE)
$owner = New-Object ClipOwner $text
if (-not $owner.Take()) { Write-Output "FAIL"; exit 1 }
Write-Output "READY"
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300
$timer.Add_Tick({ if (Test-Path $env:CA_CLIP_STOP) { $owner.RenderNow(); [System.Windows.Forms.Application]::Exit() } else { $owner.Tick() } })
$timer.Start()
[System.Windows.Forms.Application]::Run()
$owner.RenderNow()
`;
