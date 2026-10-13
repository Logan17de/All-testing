import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  DesktopAction,
  DesktopCapture,
  DesktopDriver,
  DesktopMonitor,
  DesktopWindow,
} from "./runtime-desktop-session.js";
import { sameDesktopWindow, windowCaptureScope } from "./runtime-desktop-session.js";

/** Fixed native bridge; caller data is JSON on stdin, never executable code or argv. */
export const WINDOWS_DESKTOP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$references = @('System.dll', [System.Windows.Forms.Form].Assembly.Location, [System.Drawing.Bitmap].Assembly.Location)
Add-Type -ReferencedAssemblies $references -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
public class ZetDesktop {
 [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
 delegate bool EnumProc(IntPtr hwnd, IntPtr data);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
 [StructLayout(LayoutKind.Sequential)] struct RECT { public int left,top,right,bottom; }
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
 [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT point, uint flags);
 [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
 [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; }
 [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
 [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY key; }
 [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int x,y; public uint data,flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] struct KEY { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
 public class Monitor { public string id; public int x,y,width,height; public double scale; }
 public class Rectangle { public int x,y,width,height; }
 public class Window { public string id,title,processStartedAt,windowClass; public uint processId; public bool focused; public Rectangle bounds; }
 public static Window InspectWindow(string id) {
   var hwnd=new IntPtr(Int64.Parse(id)); uint pid; RECT r;
   if(!IsWindow(hwnd)||!IsWindowVisible(hwnd)||IsIconic(hwnd)||GetWindowThreadProcessId(hwnd,out pid)==0||pid==0||!GetWindowRect(hwnd,out r))throw new Exception();
   var title=new StringBuilder(201); GetWindowText(hwnd,title,201); var cls=new StringBuilder(257); if(GetClassName(hwnd,cls,257)==0)throw new Exception();
   string started; using(var process=Process.GetProcessById((int)pid)) { started=process.StartTime.ToUniversalTime().Ticks.ToString(); }
   return new Window{id=id,title=title.ToString(),processId=pid,processStartedAt=started,windowClass=cls.ToString(),focused=GetForegroundWindow()==hwnd,bounds=new Rectangle{x=r.left,y=r.top,width=r.right-r.left,height=r.bottom-r.top}};
 }
 public static void CheckWindow(string id,uint pid,string started,string cls,string title,int x,int y,int width,int height) {
   var w=InspectWindow(id); if(!w.focused||w.processId!=pid||w.processStartedAt!=started||w.windowClass!=cls||w.title!=title||w.bounds.x!=x||w.bounds.y!=y||w.bounds.width!=width||w.bounds.height!=height)throw new Exception();
 }
 public static void CheckMonitor(string id,int x,int y,int width,int height) {
   foreach(var m in Monitors()) { if(m.id==id&&m.x==x&&m.y==y&&m.width==width&&m.height==height)return; } throw new Exception();
 }
 public static string CaptureWindow(string id,uint pid,string started,string cls,string title,int x,int y,int width,int height,int clipX,int clipY,int clipWidth,int clipHeight,string monitorId,int mx,int my,int mw,int mh) {
   if(width<=0||height<=0||width>16384||height>16384||(long)width*height>32000000||clipWidth<=0||clipHeight<=0||clipX<x||clipY<y||(long)clipX+clipWidth>(long)x+width||(long)clipY+clipHeight>(long)y+height)throw new Exception();
   CheckMonitor(monitorId,mx,my,mw,mh);
   if(clipX<mx||clipY<my||(long)clipX+clipWidth>(long)mx+mw||(long)clipY+clipHeight>(long)my+mh)throw new Exception();
   CheckWindow(id,pid,started,cls,title,x,y,width,height);
   using(var image=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
     using(var g=Graphics.FromImage(image)) { g.Clear(Color.Transparent); var dc=g.GetHdc(); try { if(!PrintWindow(new IntPtr(Int64.Parse(id)),dc,2))throw new Exception(); } finally {g.ReleaseHdc(dc);} }
     CheckWindow(id,pid,started,cls,title,x,y,width,height);
     CheckMonitor(monitorId,mx,my,mw,mh);
     using(var clipped=image.Clone(new System.Drawing.Rectangle(clipX-x,clipY-y,clipWidth,clipHeight),PixelFormat.Format32bppArgb)) using(var stream=new MemoryStream()) { clipped.Save(stream,ImageFormat.Png); if(stream.Length>18000000)throw new Exception(); return Convert.ToBase64String(stream.ToArray()); }
   }
 }
 public static void Initialize() { try { if(SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {} SetProcessDPIAware(); }
 public static Monitor[] Monitors() {
   var result = new List<Monitor>(); var v=SystemInformation.VirtualScreen;
   result.Add(new Monitor {id="virtual-desktop",x=v.X,y=v.Y,width=v.Width,height=v.Height,scale=1});
   int index=0;
   foreach(var s in Screen.AllScreens) { var b=s.Bounds; double scale=1; try {uint dx,dy; if(GetDpiForMonitor(MonitorFromPoint(new POINT{x=b.X+1,y=b.Y+1},2),0,out dx,out dy)==0) scale=dx/96.0;} catch {}
     result.Add(new Monitor{id="monitor-"+(index++),x=b.X,y=b.Y,width=b.Width,height=b.Height,scale=scale}); }
   return result.ToArray();
 }
 public static Window[] Windows() { var list=new List<Window>(); EnumWindows((hwnd,data)=>{ if(list.Count>=200)return false; if(!IsWindowVisible(hwnd))return true; try {var window=InspectWindow(hwnd.ToInt64().ToString()); if(window.title.Length>0)list.Add(window);} catch {} return true;},IntPtr.Zero); return list.ToArray(); }
 public static string Capture(int x,int y,int width,int height) {
   if(width<=0||height<=0||width>16384||height>16384||(long)width*height>32000000) throw new Exception();
   var v=SystemInformation.VirtualScreen; if(x<v.X||y<v.Y||(long)x+width>(long)v.X+v.Width||(long)y+height>(long)v.Y+v.Height)throw new Exception();
   using(var image=new Bitmap(width,height,PixelFormat.Format32bppArgb)) using(var g=Graphics.FromImage(image)) using(var stream=new MemoryStream()) { g.CopyFromScreen(x,y,0,0,new Size(width,height),CopyPixelOperation.SourceCopy); image.Save(stream,ImageFormat.Png); if(stream.Length>18000000)throw new Exception(); return Convert.ToBase64String(stream.ToArray()); }
 }
 public static void Focus(string id) { var hwnd=new IntPtr(Int64.Parse(id)); if(!IsWindow(hwnd)||!IsWindowVisible(hwnd)||!SetForegroundWindow(hwnd)||GetForegroundWindow()!=hwnd)throw new Exception(); }
 public static void CheckFocus(string id) { if(!String.IsNullOrEmpty(id)&&GetForegroundWindow()!=new IntPtr(Int64.Parse(id)))throw new Exception(); }
 public static void Mouse(int x,int y,bool click) { var v=SystemInformation.VirtualScreen; if(x<v.X||y<v.Y||x>=(long)v.X+v.Width||y>=(long)v.Y+v.Height||!SetCursorPos(x,y))throw new Exception(); if(click){var inputs=new INPUT[]{new INPUT{type=0,data=new UNION{mouse=new MOUSE{flags=2}}},new INPUT{type=0,data=new UNION{mouse=new MOUSE{flags=4}}}};if(SendInput(2,inputs,Marshal.SizeOf(typeof(INPUT)))!=2)throw new Exception();} }
 public static void Key(string key) { byte value; switch(key){case "Tab":value=9;break;case "Escape":value=27;break;case "Enter":value=13;break;case "Backspace":value=8;break;case "ArrowLeft":value=37;break;case "ArrowUp":value=38;break;case "ArrowRight":value=39;break;case "ArrowDown":value=40;break;default:throw new Exception();} uint extended=value>=37&&value<=40?1u:0u;var inputs=new INPUT[]{new INPUT{type=1,data=new UNION{key=new KEY{key=value,flags=extended}}},new INPUT{type=1,data=new UNION{key=new KEY{key=value,flags=extended|2u}}}};if(SendInput(2,inputs,Marshal.SizeOf(typeof(INPUT)))!=2)throw new Exception(); }
 public static void Text(string text) { if(text.Length>2000)throw new Exception(); foreach(char ch in text){if(Char.IsControl(ch))throw new Exception(); var inputs=new INPUT[]{new INPUT{type=1,data=new UNION{key=new KEY{scan=ch,flags=4}}},new INPUT{type=1,data=new UNION{key=new KEY{scan=ch,flags=6}}}}; if(SendInput(2,inputs,Marshal.SizeOf(typeof(INPUT)))!=2)throw new Exception();} }
}
'@
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
# Compile-only CI validation exits before DPI, Screen, HWND or input access.
if ($data.operation -eq 'validate') { '{"ok":true}'; exit 0 }
[ZetDesktop]::Initialize()
switch ($data.operation) {
 'inventory' { @{monitors=@([ZetDesktop]::Monitors());windows=@([ZetDesktop]::Windows())} | ConvertTo-Json -Depth 5 -Compress }
 'capture' { @{png=[ZetDesktop]::Capture([int]$data.x,[int]$data.y,[int]$data.width,[int]$data.height)} | ConvertTo-Json -Compress }
 'capture-window' { $w=$data.window; $b=$w.bounds; $m=$data.monitor; $png=[ZetDesktop]::CaptureWindow([string]$w.id,[uint32]$w.processId,[string]$w.processStartedAt,[string]$w.windowClass,[string]$w.title,[int]$b.x,[int]$b.y,[int]$b.width,[int]$b.height,[int]$data.x,[int]$data.y,[int]$data.width,[int]$data.height,[string]$m.id,[int]$m.x,[int]$m.y,[int]$m.width,[int]$m.height); @{png=$png;window=[ZetDesktop]::InspectWindow([string]$w.id)} | ConvertTo-Json -Depth 5 -Compress }
 'act' { if($data.kind -ne 'focus') { [ZetDesktop]::CheckFocus([string]$data.selectedWindow) }; switch($data.kind) {
   'focus' { [ZetDesktop]::Focus([string]$data.windowId) }
   'move' { [ZetDesktop]::Mouse([int]$data.x,[int]$data.y,$false) }
   'click' { [ZetDesktop]::Mouse([int]$data.x,[int]$data.y,$true) }
   'key' { [ZetDesktop]::Key([string]$data.key) }
   'text' { [ZetDesktop]::Text([string]$data.text) }
   default { throw 'Invalid action' }
 }; '{"ok":true}' }
 default { throw 'Invalid operation' }
}
} catch { [Console]::Error.WriteLine('Windows desktop operation failed.'); exit 1 }
`;

export type WindowsDesktopRunner = (input: string, signal: AbortSignal) => Promise<string>;
const failure = (): Error => new Error("Windows desktop operation failed or is unavailable.");

async function nativeRun(
  input: string,
  signal: AbortSignal,
  timeoutMs: 15_000 | 60_000 = 15_000,
): Promise<string> {
  signal.throwIfAborted();
  if (process.platform !== "win32") throw failure();
  const windows = process.env.SystemRoot;
  if (!windows || !/^[A-Za-z]:\\[^\0\r\n]+$/u.test(windows) || windows.split("\\").includes(".."))
    throw failure();
  const executable = path.win32.join(
    windows,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WINDOWS_DESKTOP_SCRIPT, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { SystemRoot: windows, WINDIR: windows, TEMP: tmpdir(), TMP: tmpdir() },
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (!ok) child.kill();
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (ok) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(failure());
    };
    const abort = () => {
      child.kill();
      finish(false);
    };
    const timer = setTimeout(abort, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", () => finish(false));
    child.stdin.on("error", () => finish(false));
    child.stdout.on("error", () => finish(false));
    child.stderr.on("error", () => finish(false));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 24_000_000) abort();
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("close", (code) => finish(code === 0));
    child.stdin.end(input, "utf8");
    if (signal.aborted) abort();
  });
}

/**
 * Compile the actual fixed C# bridge on Windows, without interacting with the desktop.
 * Cold Windows CI assembly/compiler startup gets a separate bounded 60-second
 * deadline; production inventory, capture and input remain capped at 15 seconds.
 */
export async function validateWindowsDesktopBridge(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let value: unknown;
  try {
    value = JSON.parse(await nativeRun('{"operation":"validate"}', signal, 60_000));
  } catch {
    signal.throwIfAborted();
    throw failure();
  }
  signal.throwIfAborted();
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).ok !== true
  )
    throw failure();
}

/** Inject a runner only for host-owned tests. Default execution is Windows-only. */
export class RuntimeWindowsDesktopDriver implements DesktopDriver {
  #captures = new Map<string, string>();
  #selectedWindow: string | undefined;
  constructor(readonly runner: WindowsDesktopRunner = nativeRun) {}
  async #invoke(input: object, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    try {
      const value: unknown = JSON.parse(await this.runner(JSON.stringify(input), signal));
      signal.throwIfAborted();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
      return value as Record<string, unknown>;
    } catch {
      signal.throwIfAborted();
      throw failure();
    }
  }
  async inventory(
    signal: AbortSignal,
  ): Promise<{ monitors: DesktopMonitor[]; windows: DesktopWindow[] }> {
    const result = await this.#invoke({ operation: "inventory" }, signal);
    if (
      !Array.isArray(result.monitors) ||
      !Array.isArray(result.windows) ||
      result.monitors.length > 32 ||
      result.windows.length > 200
    )
      throw failure();
    const monitors = result.monitors as DesktopMonitor[];
    const windows = result.windows as DesktopWindow[];
    if (
      !monitors.every(
        (m) =>
          m !== null &&
          typeof m === "object" &&
          typeof m.id === "string" &&
          /^[A-Za-z0-9_.:-]{1,100}$/u.test(m.id) &&
          [m.x, m.y, m.width, m.height].every(Number.isInteger) &&
          m.width > 0 &&
          m.height > 0 &&
          m.width <= 16384 &&
          m.height <= 16384 &&
          Number.isFinite(m.scale) &&
          m.scale > 0 &&
          m.scale <= 8,
      ) ||
      !windows.every(
        (w) =>
          w !== null &&
          typeof w === "object" &&
          typeof w.id === "string" &&
          /^[0-9]{1,19}$/u.test(w.id) &&
          typeof w.title === "string" &&
          w.title.length <= 200,
      )
    )
      throw failure();
    return { monitors, windows };
  }
  async capture(monitor: DesktopMonitor, signal: AbortSignal): Promise<DesktopCapture> {
    if (
      ![monitor.x, monitor.y, monitor.width, monitor.height].every(Number.isInteger) ||
      monitor.width <= 0 ||
      monitor.height <= 0 ||
      monitor.width > 16384 ||
      monitor.height > 16384 ||
      monitor.width * monitor.height > 32_000_000
    )
      throw failure();
    const result = await this.#invoke(
      {
        operation: "capture",
        x: monitor.x,
        y: monitor.y,
        width: monitor.width,
        height: monitor.height,
      },
      signal,
    );
    return this.#storeCapture(result, monitor.width, monitor.height, signal);
  }
  async #storeCapture(
    result: Record<string, unknown>,
    width: number,
    height: number,
    signal: AbortSignal,
    scope?: DesktopCapture["scope"],
  ): Promise<DesktopCapture> {
    if (
      typeof result.png !== "string" ||
      result.png.length > 24_000_000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(result.png)
    )
      throw failure();
    const bytes = Buffer.from(result.png, "base64");
    if (
      bytes.length < 24 ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.readUInt32BE(16) !== width ||
      bytes.readUInt32BE(20) !== height
    )
      throw failure();
    const directory = await mkdtemp(path.join(tmpdir(), "zet-desktop-"));
    const localPath = path.join(directory, "capture.png");
    try {
      signal.throwIfAborted();
      await writeFile(localPath, bytes, { mode: 0o600, flag: "wx" });
      signal.throwIfAborted();
      this.#captures.set(localPath, directory);
      return { localPath, width, height, ...(scope ? { scope } : {}) };
    } catch {
      await rm(directory, { recursive: true, force: true });
      signal.throwIfAborted();
      throw failure();
    }
  }
  async captureWindow(
    window: DesktopWindow,
    monitor: DesktopMonitor,
    signal: AbortSignal,
  ): Promise<DesktopCapture> {
    const scope = windowCaptureScope(monitor, window);
    const result = await this.#invoke(
      {
        operation: "capture-window",
        window: structuredClone(window),
        monitor: structuredClone(monitor),
        x: scope.x,
        y: scope.y,
        width: scope.width,
        height: scope.height,
      },
      signal,
    );
    const returned = result.window as DesktopWindow | undefined;
    if (!returned || !returned.focused || !sameDesktopWindow(window, returned)) throw failure();
    return this.#storeCapture(result, scope.width, scope.height, signal, scope);
  }
  async act(action: DesktopAction, signal: AbortSignal): Promise<void> {
    if (action.kind === "move" || action.kind === "click") {
      if (
        !Number.isInteger(action.x) ||
        !Number.isInteger(action.y) ||
        Math.abs(action.x) > 65536 ||
        Math.abs(action.y) > 65536
      )
        throw failure();
    } else if (action.kind === "focus") {
      if (
        !/^[0-9]{1,19}$/u.test(action.windowId) ||
        BigInt(action.windowId) <= 0n ||
        BigInt(action.windowId) > 9223372036854775807n
      )
        throw failure();
    } else if (action.kind === "key") {
      if (
        ![
          "Tab",
          "Escape",
          "Enter",
          "Backspace",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
        ].includes(action.key)
      )
        throw failure();
    } else if (action.kind === "text") {
      if (
        typeof action.text !== "string" ||
        Buffer.byteLength(action.text) > 2000 ||
        /[\x00-\x1f\x7f]/u.test(action.text)
      )
        throw failure();
    } else throw failure();
    const snapshot: DesktopAction =
      action.kind === "focus"
        ? { kind: "focus", windowId: action.windowId }
        : action.kind === "text"
          ? { kind: "text", text: action.text }
          : action.kind === "key"
            ? { kind: "key", key: action.key }
            : { kind: action.kind, x: action.x, y: action.y };
    const result = await this.#invoke(
      {
        ...snapshot,
        operation: "act",
        selectedWindow: action.kind === "focus" ? undefined : this.#selectedWindow,
      },
      signal,
    );
    if (result.ok !== true) throw failure();
    if (action.kind === "focus") this.#selectedWindow = action.windowId;
  }
  async removeCapture(capture: DesktopCapture): Promise<void> {
    const directory = this.#captures.get(capture.localPath);
    if (!directory) return;
    this.#captures.delete(capture.localPath);
    await rm(directory, { recursive: true, force: true });
  }
}
