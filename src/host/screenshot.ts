import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface ScreenshotOptions {
  window?: string;
}

/** Pořídí PNG snímek obrazovky nebo okna (Windows, PowerShell + .NET). Jinde vyhodí chybu. */
export function captureScreenshot(outAbsPath: string, opts: ScreenshotOptions = {}): Promise<{ width: number; height: number; window?: string }> {
  if (process.platform !== "win32") return Promise.reject(new Error("Screenshots are only supported on Windows in this version."));
  fs.mkdirSync(path.dirname(outAbsPath), { recursive: true });
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinApi {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT rect, int size);
  public static RECT VisibleRect(IntPtr hWnd) {
    RECT r;
    if (DwmGetWindowAttribute(hWnd, 9, out r, Marshal.SizeOf(typeof(RECT))) == 0 && r.Right > r.Left) return r;
    GetWindowRect(hWnd, out r);
    return r;
  }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr Find(string part) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.ToString().IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
[void][WinApi]::SetProcessDPIAware()
$part = $env:CA_SHOT_WINDOW
$title = ''
if ($part) {
  $h = [WinApi]::Find($part)
  if ($h -eq [IntPtr]::Zero) { throw "No visible window with title containing '$part'" }
  [void][WinApi]::SetForegroundWindow($h); Start-Sleep -Milliseconds 250
  $r = [WinApi]::VisibleRect($h)
  $bounds = New-Object System.Drawing.Rectangle($r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top))
  $sb = New-Object System.Text.StringBuilder 512; [void][WinApi]::GetWindowText($h, $sb, 512); $title = $sb.ToString()
} else {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
}
if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw "Window has no size (minimized?)" }
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save($env:CA_SHOT_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ("{0}x{1}|{2}" -f $bounds.Width, $bounds.Height, $title)
`;
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 20000, env: { ...process.env, CA_SHOT_OUT: outAbsPath, CA_SHOT_WINDOW: opts.window ?? "" } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).toString().trim().split("\n")[0]));
        const m = stdout.toString().trim().match(/^(\d+)x(\d+)\|(.*)$/);
        resolve({ width: m ? Number(m[1]) : 0, height: m ? Number(m[2]) : 0, window: m && m[3] ? m[3] : undefined });
      },
    );
  });
}
