import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JsonValue } from "@zet-harness/plugin-api";
import { createWorkspacePathResolver } from "@zet-harness/tools";
import { isBlockedWorkspacePathSegment } from "./runtime-workspace-read-tools.js";

export type WindowsCodingOperation = "read" | "list" | "write" | "mkdir" | "rename" | "delete";
export interface WindowsCodingRequest {
  readonly operation: WindowsCodingOperation;
  readonly root: string;
  readonly path: string;
  readonly to?: string;
  readonly expectedContent?: string | null;
  readonly content?: string;
}
export interface WindowsCodingResult {
  readonly success: boolean;
  readonly value?: JsonValue;
}
export type WindowsCodingRunner = (input: string, signal: AbortSignal) => Promise<string>;
const denied = (): Error => new Error("Windows workspace operation rejected or unavailable.");

/** Fixed Win32 bridge. File data is JSON stdin, never script source or command arguments. */
export const WINDOWS_CODING_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;
public class ZetFiles {
 const uint REPARSE=0x400,DIR=0x10,READ=0x80000000,WRITE=0x40000000,DELETE=0x10000,ATTR=0x80,FLAGS=0x02200000;
 const int LIMIT=65536;
 [StructLayout(LayoutKind.Sequential)] struct INFO {public uint attrs;public System.Runtime.InteropServices.ComTypes.FILETIME created,accessed,written;public uint volume,high,low,links,indexHigh,indexLow;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out INFO info);
 [DllImport("kernel32.dll")] static extern uint GetFileType(SafeFileHandle handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,StringBuilder name,uint size,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetLongPathNameW(string source,StringBuilder target,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(SafeFileHandle handle,[Out] byte[] buffer,uint count,out uint read,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(SafeFileHandle handle,byte[] buffer,uint count,out uint written,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle handle,long distance,out long position,uint origin);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetEndOfFile(SafeFileHandle handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int kind,IntPtr data,uint size);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string path,IntPtr security);
 static UTF8Encoding Utf8=new UTF8Encoding(false,true);
 static bool Blocked(string value) {return Regex.IsMatch(value,@"^(?:\.env.*|\.git|\.git-credentials|\.zet-codex|\.bash_history|\.zsh_history|\.gcloud|\.codex|\.claude|\.aws|\.ssh|\.azure|\.config|\.gnupg|\.kube|\.docker|\.npmrc|\.netrc|\.pypirc|auth\.json|\.credentials(?:\..*)?|\.secrets?(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$|(?:\.(?:pem|key|p12|pfx|jks|keystore)$|(?:^|[._-])(?:token|password|private[._-]?key)(?:[._-]|$))",RegexOptions.IgnoreCase|RegexOptions.CultureInvariant);}
 static void Segment(string value) {if(String.IsNullOrEmpty(value)||value=="."||value==".."||value.EndsWith(".")||value.EndsWith(" ")||value.IndexOfAny(Path.GetInvalidFileNameChars())>=0||Regex.IsMatch(value,@"~\d")||Regex.IsMatch(value,@"^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9]|LPT[0-9])(?:\.|$)",RegexOptions.IgnoreCase)||Blocked(value))throw new Exception();}
 static string Canonical(SafeFileHandle handle) {var value=new StringBuilder(32768);uint size=GetFinalPathNameByHandleW(handle,value,32768,0);if(size==0||size>=32768)throw new Exception();string result=value.ToString();if(result.StartsWith(@"\\?\"))result=result.Substring(4);if(!Regex.IsMatch(result,@"^[A-Za-z]:\\"))throw new Exception();return result.TrimEnd('\\');}
 static INFO Check(SafeFileHandle handle,string expected,bool directory) {INFO info;if(handle.IsInvalid||GetFileType(handle)!=1||!GetFileInformationByHandle(handle,out info)||(info.attrs&REPARSE)!=0||((info.attrs&DIR)!=0)!=directory||(!directory&&(info.links!=1||info.high!=0||info.low>LIMIT))||!String.Equals(Canonical(handle),expected.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))throw new Exception();return info;}
 class Guard:IDisposable {
   public string root; List<SafeFileHandle> held=new List<SafeFileHandle>();
   public Guard(string requested) {try{if(!Regex.IsMatch(requested??"",@"^[A-Za-z]:\\")||requested.Length>4096||requested.IndexOf('\0')>=0)throw new Exception();string full=Path.GetFullPath(requested);var expanded=new StringBuilder(32768);uint length=GetLongPathNameW(full,expanded,32768);if(length==0||length>=32768)throw new Exception();root=expanded.ToString().TrimEnd('\\');string current=Path.GetPathRoot(root);Hold(current);foreach(string part in root.Substring(current.Length).Split(new char[]{'\\'},StringSplitOptions.RemoveEmptyEntries)){Segment(part);current=Path.Combine(current,part);Hold(current);}}catch{Dispose();throw;}}
   void Hold(string value){var handle=CreateFileW(value,ATTR,3,IntPtr.Zero,3,FLAGS,IntPtr.Zero);try{Check(handle,value,true);held.Add(handle);}catch{handle.Dispose();throw;}}
   public string Parent(string relative){if(String.IsNullOrEmpty(relative)||relative.Length>4096||relative.IndexOf('\\')>=0||relative.IndexOf('\0')>=0||Path.IsPathRooted(relative))throw new Exception();string[] parts=relative.Split('/');string current=root;for(int index=0;index<parts.Length;index++){Segment(parts[index]);current=Path.Combine(current,parts[index]);if(index<parts.Length-1)Hold(current);}return current;}
   public string Directory(string relative){if(relative==".")return root;string target=Parent(relative);Hold(target);return target;}
   public void Dispose(){for(int index=held.Count-1;index>=0;index--)held[index].Dispose();held.Clear();}
 }
 static byte[] Bytes(string value){if(value==null||value.IndexOf('\0')>=0)throw new Exception();byte[] bytes=Utf8.GetBytes(value);if(bytes.Length>LIMIT)throw new Exception();return bytes;}
 static byte[] Read(SafeFileHandle handle){long position;if(!SetFilePointerEx(handle,0,out position,0))throw new Exception();var output=new MemoryStream();var buffer=new byte[4096];uint count;while(true){if(!ReadFile(handle,buffer,4096,out count,IntPtr.Zero))throw new Exception();if(count==0)break;output.Write(buffer,0,(int)count);if(output.Length>LIMIT)throw new Exception();}byte[] result=output.ToArray();output.Dispose();if(Utf8.GetString(result).IndexOf('\0')>=0)throw new Exception();return result;}
 static bool Same(byte[] left,byte[] right){if(left.Length!=right.Length)return false;for(int index=0;index<left.Length;index++)if(left[index]!=right[index])return false;return true;}
 static void Write(SafeFileHandle handle,byte[] bytes){long position;if(!SetFilePointerEx(handle,0,out position,0))throw new Exception();uint written;if(bytes.Length>0&&(!WriteFile(handle,bytes,(uint)bytes.Length,out written,IntPtr.Zero)||written!=bytes.Length))throw new Exception();if(!SetEndOfFile(handle)||!FlushFileBuffers(handle))throw new Exception();}
 static void Discard(SafeFileHandle handle){IntPtr data=Marshal.AllocHGlobal(4);try{Marshal.WriteInt32(data,1);if(!SetFileInformationByHandle(handle,4,data,4))throw new Exception();}finally{Marshal.FreeHGlobal(data);}}
 static void Rename(SafeFileHandle handle,string target){byte[] name=Encoding.Unicode.GetBytes(target);int offset=IntPtr.Size==8?20:12;int size=offset+name.Length+2;IntPtr data=Marshal.AllocHGlobal(size);try{Marshal.Copy(new byte[size],0,data,size);Marshal.WriteInt32(data,IntPtr.Size==8?16:8,name.Length);Marshal.Copy(name,0,IntPtr.Add(data,offset),name.Length);if(!SetFileInformationByHandle(handle,3,data,(uint)size))throw new Exception();}finally{Marshal.FreeHGlobal(data);}}
 public static object Run(string operation,string root,string relative,string target,string expected,string content,bool missing){
  using(var guard=new Guard(root)) {
   if(operation=="list"){string directory=guard.Directory(relative);var entries=new List<object>();int scanned=0;bool truncated=false;foreach(string entry in System.IO.Directory.EnumerateFileSystemEntries(directory)){if(++scanned>2000||entries.Count==200){truncated=true;break;}string name=Path.GetFileName(entry);if(Blocked(name))continue;try{Segment(name);var attrs=File.GetAttributes(entry);if((attrs&FileAttributes.ReparsePoint)!=0)continue;entries.Add(new {name=name,type=(attrs&FileAttributes.Directory)!=0?"directory":"file"});}catch{}}return new {entries=entries.ToArray(),truncated=truncated};}
   string file=guard.Parent(relative);
   if(operation=="mkdir"){if(!CreateDirectoryW(file,IntPtr.Zero))throw new Exception();return new {path=relative,operation=operation};}
   byte[] outgoing=operation=="write"?Bytes(content):null;
   uint access=READ;if(operation=="write")access|=WRITE;if(operation=="delete"||operation=="rename"||(operation=="write"&&missing))access|=DELETE;
   using(var handle=CreateFileW(file,access,0,IntPtr.Zero,operation=="write"&&missing?1u:3u,FLAGS,IntPtr.Zero)) {
    Check(handle,file,false);
    byte[] before=Read(handle);
    if(operation=="read")return new {content=Utf8.GetString(before)};
    if(operation=="write") {
     byte[] after=outgoing;if(!missing&&!Same(before,Bytes(expected)))throw new Exception();
     try{Write(handle,after);}catch{try{if(missing)Discard(handle);else Write(handle,before);}catch{}throw;}
     return new {path=relative,operation=operation,writtenBytes=after.Length};
    }
    if(!Same(before,Bytes(expected)))throw new Exception();
    if(operation=="delete"){Discard(handle);return new {path=relative,operation=operation};}
    if(operation=="rename"){string destination=guard.Parent(target);if(String.Equals(file,destination,StringComparison.OrdinalIgnoreCase))throw new Exception();Rename(handle,destination);return new {path=relative,to=target,operation=operation};}
    throw new Exception();
   }
  }
 }
}
'@
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($data.operation -eq 'validate') { '{"ok":true}'; exit 0 }
$results = @()
foreach ($request in $data.requests) {
 try { $value=[ZetFiles]::Run([string]$request.operation,[string]$request.root,[string]$request.path,[string]$request.to,[string]$request.expectedContent,[string]$request.content,($null -eq $request.expectedContent)); $results += @{success=$true;value=$value} }
 catch { $results += @{success=$false} }
}
@{results=$results} | ConvertTo-Json -Depth 8 -Compress
} catch { [Console]::Error.WriteLine('Windows workspace bridge failed.'); exit 1 }
`;

function relative(value: unknown, listing: boolean): string {
  if (listing && value === ".") return ".";
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.win32.isAbsolute(value) ||
    Buffer.from(value, "utf8").toString("utf8") !== value
  )
    throw denied();
  const parts = value.split("/");
  if (
    parts.some(
      (part) => !part || part === "." || part === ".." || isBlockedWorkspacePathSegment(part),
    )
  )
    throw denied();
  // The shared portable lexical resolver rejects ADS, devices, trailing dots and 8.3 aliases.
  createWorkspacePathResolver({ root: process.platform === "win32" ? "C:\\" : "/" }).resolveLexical(
    value,
  );
  return value;
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value) > 65536 ||
    Buffer.from(value, "utf8").toString("utf8") !== value
  )
    throw denied();
  return value;
}
function requestSnapshot(request: WindowsCodingRequest): WindowsCodingRequest {
  const allowed = {
    read: ["operation", "root", "path"],
    list: ["operation", "root", "path"],
    mkdir: ["operation", "root", "path"],
    write: ["operation", "root", "path", "expectedContent", "content"],
    rename: ["operation", "root", "path", "to", "expectedContent"],
    delete: ["operation", "root", "path", "expectedContent"],
  } as const;
  if (
    !Object.hasOwn(allowed, request.operation) ||
    Object.keys(request).some(
      (key) => !(allowed[request.operation] as readonly string[]).includes(key),
    ) ||
    typeof request.root !== "string" ||
    !/^([A-Za-z]):\\/u.test(request.root) ||
    request.root.length > 4096 ||
    request.root.includes("\0")
  )
    throw denied();
  const snapshot = {
    operation: request.operation,
    root: request.root,
    path: relative(request.path, request.operation === "list"),
    ...(request.to === undefined ? {} : { to: relative(request.to, false) }),
    ...(request.expectedContent === undefined
      ? {}
      : {
          expectedContent: request.expectedContent === null ? null : text(request.expectedContent),
        }),
    ...(request.content === undefined ? {} : { content: text(request.content) }),
  };
  if (
    request.operation === "write" &&
    (!Object.hasOwn(request, "expectedContent") || request.content === undefined)
  )
    throw denied();
  if (
    (request.operation === "rename" || request.operation === "delete") &&
    typeof request.expectedContent !== "string"
  )
    throw denied();
  if (request.operation === "rename" && request.to === undefined) throw denied();
  return Object.freeze(snapshot);
}
async function nativeRun(input: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (process.platform !== "win32") throw denied();
  const windows = process.env.SystemRoot;
  if (!windows || !/^[A-Za-z]:\\[^\0\r\n]+$/u.test(windows) || windows.split("\\").includes(".."))
    throw denied();
  const encoded = Buffer.from(WINDOWS_CODING_SCRIPT, "utf16le").toString("base64");
  if (encoded.length > 30000) throw denied();
  return new Promise((resolve, reject) => {
    const child = spawn(
      path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { SystemRoot: windows, WINDIR: windows, TEMP: tmpdir(), TMP: tmpdir() },
      },
    );
    const chunks: Buffer[] = [];
    let count = 0;
    let finished = false;
    const finish = (success: boolean) => {
      if (finished) return;
      finished = true;
      if (!success) child.kill();
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (success) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(denied());
    };
    const abort = () => finish(false);
    const timer = setTimeout(abort, 60_000);
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", abort);
    child.stdin.on("error", abort);
    child.stdout.on("error", abort);
    child.stderr.on("error", abort);
    child.stderr.resume();
    child.on("close", (code) => finish(code === 0));
    child.stdout.on("data", (chunk: Buffer) => {
      count += chunk.length;
      if (count > 2_000_000) abort();
      else chunks.push(chunk);
    });
    child.stdin.end(input, "utf8");
    if (signal.aborted) abort();
  });
}
/** Host-owned test batches compile once. Every entry remains independently confined. */
export async function executeWindowsCodingBatch(
  requests: readonly WindowsCodingRequest[],
  signal: AbortSignal,
  runner: WindowsCodingRunner = nativeRun,
): Promise<readonly WindowsCodingResult[]> {
  signal.throwIfAborted();
  if (!requests.length || requests.length > 20) throw denied();
  let snapshots: WindowsCodingRequest[];
  try {
    snapshots = requests.map(requestSnapshot);
  } catch {
    throw denied();
  }
  try {
    const raw: unknown = JSON.parse(await runner(JSON.stringify({ requests: snapshots }), signal));
    signal.throwIfAborted();
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).results))
      throw denied();
    const results = (raw as { results: WindowsCodingResult[] }).results;
    if (
      results.length !== requests.length ||
      results.some((result) => !result || typeof result.success !== "boolean")
    )
      throw denied();
    return results;
  } catch {
    signal.throwIfAborted();
    throw denied();
  }
}
export async function executeWindowsCodingOperation(
  request: WindowsCodingRequest,
  signal: AbortSignal,
): Promise<JsonValue> {
  const result = (await executeWindowsCodingBatch([request], signal))[0];
  if (!result?.success || result.value === undefined) throw denied();
  return result.value;
}
/** Compiles the actual bridge without filesystem operations; mandatory in Windows CI. */
export async function validateWindowsCodingBridge(signal: AbortSignal): Promise<void> {
  try {
    const raw: unknown = JSON.parse(await nativeRun('{"operation":"validate"}', signal));
    signal.throwIfAborted();
    if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).ok !== true)
      throw denied();
  } catch {
    signal.throwIfAborted();
    throw denied();
  }
}
