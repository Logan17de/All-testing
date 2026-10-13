import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFile, lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
export interface BrowserWorkerTransport {
  send(value: unknown): void;
  on(event: "message", callback: (value: unknown) => void): this;
  on(event: "exit" | "error", callback: () => void): this;
  terminate(): Promise<void>;
}
export const BROWSER_STDERR_SIGNATURES = [
  ["Sandbox cannot access executable ", "browser-sandbox-executable-denied"],
  ["process did exit: exitCode=-1073741819,", "browser-access-violation"],
  ["process did exit: exitCode=-1073741790,", "browser-access-denied"],
  ["ERR_MODULE_NOT_FOUND", "worker-module-unavailable"],
] as const;
export function classifyBrowserWorkerStderr(text: string): string | undefined {
  for (const [signature, code] of BROWSER_STDERR_SIGNATURES)
    if (text.includes(signature)) return code;
  if (
    text.includes("_CRSession._onMessage") &&
    (text.includes("Assertion error") || text.includes("AssertionError"))
  )
    return "protocol-assertion";
  const exit = /process did exit: exitCode=(-?[0-9]{1,10}),/u.exec(text);
  if (exit)
    return exit[1] === "0"
      ? "browser-exit-zero"
      : exit[1] === "1"
        ? "browser-exit-one"
        : "browser-exit-other";
  return undefined;
}
const fixedStderrClassifier = BROWSER_STDERR_SIGNATURES.map(
  ([signature, code]) =>
    `if(text.Contains(${JSON.stringify(signature)}))return ${JSON.stringify(code)};`,
).join("\n");
export const BROWSER_STARTUP_PROTOCOL_NAMES = [
  "Target.createTarget",
  "Target.setAutoAttach",
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
  "Target.targetCreated",
  "Target.targetInfoChanged",
  "Inspector.targetCrashed",
  "Page.enable",
  "Page.getFrameTree",
  "Page.setLifecycleEventsEnabled",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.createIsolatedWorld",
  "Page.lifecycleEvent",
  "Page.frameNavigated",
  "Page.frameStartedLoading",
  "Page.frameStoppedLoading",
  "Page.domContentEventFired",
  "Page.loadEventFired",
  "Runtime.enable",
  "Runtime.runIfWaitingForDebugger",
  "Runtime.executionContextCreated",
  "Runtime.addBinding",
  "Runtime.evaluate",
  "Network.enable",
  "Network.setCacheDisabled",
  "Fetch.enable",
  "Log.enable",
  "Emulation.setFocusEmulationEnabled",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setEmulatedMedia",
  "Page.setFontFamilies",
  "Page.setInterceptFileChooserDialog",
] as const;
const protocolNamesCSharp = BROWSER_STARTUP_PROTOCOL_NAMES.map((name) => JSON.stringify(name)).join(
  ",",
);
export const WINDOWS_BROWSER_JOB = String.raw`
param([string]$NodePath,[string]$WorkerPath,[string]$Directory,[switch]$CompileOnly)
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$source=@"
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ZetBrowserJob {
 [StructLayout(LayoutKind.Sequential)] struct SA { public int size; public IntPtr descriptor; public int inherit; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI { public int cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct SIX { public SI si; public IntPtr list; }
 [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct LIMIT { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct EXT { public LIMIT limit; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
 [DllImport("kernel32.dll")] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll")] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr prev,IntPtr ret);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr psa,IntPtr tsa,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
 [DllImport("kernel32.dll")] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA sa,uint size);
 [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll")] static extern IntPtr CreateJobObject(IntPtr sa,string name);
 [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXT value,uint size);
 [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool assigned);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static void Check(bool ok) { if(!ok) throw new InvalidOperationException(); }
 static string Quote(string value) { return "\""+value.Replace("\"","\\\"")+"\""; }
 static readonly System.Collections.Generic.HashSet<string> ProtocolNames=new System.Collections.Generic.HashSet<string>(new string[]{${protocolNamesCSharp}});
 static void ProtocolLine(string text,System.Collections.Generic.Dictionary<int,string> outstanding,System.Collections.Generic.Dictionary<string,int[]> counts){
  var prefix=System.Text.RegularExpressions.Regex.Match(text,"^[0-9]{4}-[^ ]+ pw:protocol (SEND \\u25BA|\\u25C0 RECV) (\\{.*)$");if(!prefix.Success)return;
  bool send=prefix.Groups[1].Value.StartsWith("SEND");bool recv=!send;string envelope=prefix.Groups[2].Value;
  var match=System.Text.RegularExpressions.Regex.Match(envelope,"^\\{\\\"id\\\":([0-9]{1,9})(?:,\\\"method\\\":\\\"([A-Za-z.]+)\\\")?");  string name=null;int id;
  if(match.Success&&int.TryParse(match.Groups[1].Value,out id)){
   if(send){name=match.Groups[2].Value;if(!ProtocolNames.Contains(name)||outstanding.Count>=256||outstanding.ContainsKey(id))return;outstanding[id]=name;}
   else {if(!outstanding.TryGetValue(id,out name))return;outstanding.Remove(id);}
  }else if(recv){var evt=System.Text.RegularExpressions.Regex.Match(envelope,"^\\{\\\"method\\\":\\\"([A-Za-z.]+)\\\"");name=evt.Success?evt.Groups[1].Value:null;}
  if(name==null||!ProtocolNames.Contains(name))return;
  int[] count;if(!counts.TryGetValue(name,out count)){count=new int[3];counts[name]=count;}
  int column=send?0:match.Success?1:2;if(count[column]>=256)return;count[column]++;
  int pending=0;foreach(string value in outstanding.Values)if(value==name)pending++;
  Console.WriteLine("{\"kind\":\"protocol\",\"name\":\""+name+"\",\"sent\":"+count[0]+",\"received\":"+count[1]+",\"events\":"+count[2]+",\"outstanding\":"+pending+"}");
 }
 static string Classify(string text){
 ${fixedStderrClassifier}
 if(text.Contains("_CRSession._onMessage")&&(text.Contains("Assertion error")||text.Contains("AssertionError")))return "protocol-assertion";
 var exit=System.Text.RegularExpressions.Regex.Match(text,"process did exit: exitCode=(-?[0-9]{1,10}),");
 if(exit.Success)return exit.Groups[1].Value=="0"?"browser-exit-zero":exit.Groups[1].Value=="1"?"browser-exit-one":"browser-exit-other";
 return null;
 }
 public static int Run(string node,string worker,string directory) {
  IntPtr job=IntPtr.Zero,list=IntPtr.Zero,jobmem=IntPtr.Zero,handles=IntPtr.Zero;
  IntPtr inR=IntPtr.Zero,inW=IntPtr.Zero,outR=IntPtr.Zero,outW=IntPtr.Zero,errR=IntPtr.Zero,errW=IntPtr.Zero; PI pi=new PI();
  try {
   Check(Path.IsPathRooted(node)&&Path.IsPathRooted(worker)&&Path.IsPathRooted(directory));
   job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);
   EXT limit=new EXT();limit.limit.flags=0x2000;Check(SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(typeof(EXT))));
   SA sa=new SA();sa.size=Marshal.SizeOf(typeof(SA));sa.inherit=1;
   Check(CreatePipe(out inR,out inW,ref sa,0));Check(SetHandleInformation(inW,1,0));
   Check(CreatePipe(out outR,out outW,ref sa,0));Check(SetHandleInformation(outR,1,0));
   Check(CreatePipe(out errR,out errW,ref sa,0));Check(SetHandleInformation(errR,1,0));
   IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);list=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(list,2,0,ref size));
   jobmem=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobmem,job);
   Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x2000D),jobmem,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
   handles=Marshal.AllocHGlobal(3*IntPtr.Size);Marshal.WriteIntPtr(handles,0,inR);Marshal.WriteIntPtr(handles,IntPtr.Size,outW);Marshal.WriteIntPtr(handles,2*IntPtr.Size,errW);
   Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
   SIX startup=new SIX();startup.si.cb=Marshal.SizeOf(typeof(SIX));startup.si.flags=0x100;startup.si.input=inR;startup.si.output=outW;startup.si.error=errW;startup.list=list;
   Check(CreateProcess(node,new StringBuilder(Quote(node)+" "+Quote(worker)),IntPtr.Zero,IntPtr.Zero,true,0x80000|0x400|4|0x08000000,IntPtr.Zero,directory,ref startup,out pi));
   bool assigned;Check(IsProcessInJob(pi.process,job,out assigned)&&assigned);Check(ResumeThread(pi.thread)!=0xffffffff);
   Thread watcher=new Thread(()=>{WaitForSingleObject(pi.process,0xffffffff);IntPtr owned=Interlocked.Exchange(ref job,IntPtr.Zero);if(owned!=IntPtr.Zero)CloseHandle(owned);});watcher.IsBackground=true;watcher.Start();
   CloseHandle(inR);inR=IntPtr.Zero;CloseHandle(outW);outW=IntPtr.Zero;CloseHandle(errW);errW=IntPtr.Zero;
   var input=new StreamWriter(new FileStream(new SafeFileHandle(inW,true),FileAccess.Write),new UTF8Encoding(false));inW=IntPtr.Zero;input.AutoFlush=true;
   Thread pump=new Thread(()=>{try {string line;while((line=Console.ReadLine())!=null) input.WriteLine(line);}catch{} finally {input.Dispose();}});pump.IsBackground=true;pump.Start();
   var errors=new StreamReader(new FileStream(new SafeFileHandle(errR,true),FileAccess.Read));errR=IntPtr.Zero;
      Thread drain=new Thread(()=>{try{
    StringBuilder evidence=new StringBuilder();var emitted=new System.Collections.Generic.HashSet<string>();int character;bool oversized=false;bool assertion=false;
    var outstanding=new System.Collections.Generic.Dictionary<int,string>();var counts=new System.Collections.Generic.Dictionary<string,int[]>();
    while((character=errors.Read())!=-1){
     if(character!=10){if(evidence.Length<8192&&!oversized)evidence.Append((char)character);else oversized=true;continue;}
     if(!oversized){string line=evidence.ToString();ProtocolLine(line,outstanding,counts);string diagnosticCode=Classify(line);
      if(line.Contains("Assertion error")||line.Contains("AssertionError"))assertion=true;
      if(assertion&&line.Contains("_CRSession._onMessage"))diagnosticCode="protocol-assertion";
      if(diagnosticCode!=null&&emitted.Add(diagnosticCode))Console.WriteLine("{\"kind\":\"diagnostic\",\"code\":\""+diagnosticCode+"\"}");}
     evidence.Clear();oversized=false;
    }   }catch{}finally{errors.Dispose();}});drain.IsBackground=true;drain.Start();
   using(var output=new StreamReader(new FileStream(new SafeFileHandle(outR,true),FileAccess.Read))) {outR=IntPtr.Zero;string line;while((line=output.ReadLine())!=null) Console.WriteLine(line);}
   drain.Join(500);WaitForSingleObject(pi.process,3000);uint code;Check(GetExitCodeProcess(pi.process,out code));return (int)code;
  } finally {
   IntPtr finalJob=Interlocked.Exchange(ref job,IntPtr.Zero);if(finalJob!=IntPtr.Zero)CloseHandle(finalJob);
   foreach(IntPtr handle in new IntPtr[]{pi.process,pi.thread,inR,inW,outR,outW,errR,errW}) if(handle!=IntPtr.Zero) CloseHandle(handle);
   if(list!=IntPtr.Zero){DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(list);}if(jobmem!=IntPtr.Zero)Marshal.FreeHGlobal(jobmem);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);
  }
 }
}
"@
Add-Type -TypeDefinition $source
if(-not $CompileOnly){exit [ZetBrowserJob]::Run($NodePath,$WorkerPath,$Directory)}
`;
export async function canonicalBrowserWorkerDirectory(directory: string): Promise<string> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Browser worker unavailable");
  return realpath(directory);
}
export async function launchBrowserWorker(directory: string): Promise<BrowserWorkerTransport> {
  directory = await canonicalBrowserWorkerDirectory(directory);
  const worker = fileURLToPath(new URL("./runtime-browser-worker.js", import.meta.url));
  const environment: NodeJS.ProcessEnv = {
    DEBUG:
      process.env["ZET_BROWSER_STARTUP_PROTOCOL_DIAGNOSTICS"] === "1"
        ? "pw:browser,pw:protocol"
        : "pw:browser",
    TEMP: directory,
    TMP: directory,
    ZET_BROWSER_STARTUP_PROTOCOL_DIAGNOSTICS:
      process.env["ZET_BROWSER_STARTUP_PROTOCOL_DIAGNOSTICS"] === "1" ? "1" : "0",
    HOME: directory,
    USERPROFILE: directory,
  };
  for (const key of ["SystemRoot", "WINDIR", "PATH", "LOCALAPPDATA", "PLAYWRIGHT_BROWSERS_PATH"])
    if (process.env[key]) environment[key] = process.env[key];
  let command: string;
  let args: string[];
  if (process.platform === "win32") {
    const script = join(directory, "browser-job.ps1");
    await writeFile(script, WINDOWS_BROWSER_JOB);
    const system = process.env["SystemRoot"];
    if (!system) throw new Error("Browser worker unavailable");
    command = join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const quote = (value: string) => "'" + value.replace(/'/gu, "''") + "'";
    const fixed =
      `$NodePath=${quote(process.execPath)}; $WorkerPath=${quote(worker)}; $Directory=${quote(directory)}; $CompileOnly=$false;\n` +
      WINDOWS_BROWSER_JOB.replace(/^param\([^\n]*\)\r?$/mu, "");
    args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(fixed, "utf16le").toString("base64"),
    ];
  } else {
    command = process.execPath;
    args = [worker];
  }
  const child = spawn(command, args, {
    cwd: directory,
    env: environment,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const events = new EventEmitter();
  let failed = false;
  let exited = false;
  const failure = () => {
    failed = true;
    events.emit("failure");
  };
  const decoder = new StringDecoder("utf8");
  let pending = "";
  child.stdout.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk);
    if (Buffer.byteLength(pending) > 262144) {
      failure();
      return;
    }
    let index: number;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      try {
        events.emit("message", JSON.parse(line));
      } catch {
        failure();
      }
    }
  });
  child.stderr.resume();
  child.stdin.on("error", () => failure());
  child.on("error", () => failure());
  child.on("exit", () => {
    exited = true;
    events.emit("exit");
  });
  let terminated = false;
  const result: BrowserWorkerTransport = {
    send(value) {
      const line = JSON.stringify(value);
      if (terminated || Buffer.byteLength(line) > 131072)
        throw new Error("Browser worker unavailable");
      child.stdin.write(line + "\n");
    },
    on(event: "message" | "exit" | "error", callback: (value?: unknown) => void) {
      events.on(event === "error" ? "failure" : event, callback);
      if ((event === "error" && failed) || (event === "exit" && exited))
        queueMicrotask(() => callback());
      return result;
    },
    async terminate() {
      if (terminated) return;
      terminated = true;
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      } else if (child.exitCode === null) child.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
  return result;
}
