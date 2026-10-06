import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunResult } from "@zet-harness/tools";

/** Native isolation, independent of application-level approval. No host execution fallback. */
export async function executeWindowsSandboxedProjectCommand(
  request: { cwd: string; command: string; signal?: AbortSignal },
  options: { trustedGitRoot?: string } = {},
): Promise<ProcessRunResult> {
  if (process.platform !== "win32" || !["node-version", "git-status"].includes(request.command))
    throw new Error("Windows process sandbox unavailable or command unsupported.");
  request.signal?.throwIfAborted();
  if (request.command === "git-status" && !options.trustedGitRoot)
    throw new Error("Configure a trusted Git installation for Windows diagnostics.");
  return bridge(
    {
      mode: "run",
      command: request.command,
      cwd: request.cwd,
      node: process.execPath,
      gitRoot: options.trustedGitRoot ?? "",
    },
    request.signal,
  );
}

/** Fixed private kernel probes used by Windows CI; never accepts executable source. */
export async function probeWindowsProcessSandbox(request: {
  cwd: string;
  outside: string;
  port: number;
  hold?: boolean;
  signal?: AbortSignal;
}): Promise<ProcessRunResult> {
  if (
    process.platform !== "win32" ||
    !Number.isInteger(request.port) ||
    request.port < 1 ||
    request.port > 65535
  )
    throw new Error("Windows kernel probe refused.");
  return bridge(
    {
      mode: "run",
      command: request.hold ? "probe-hold" : "probe",
      cwd: request.cwd,
      node: process.execPath,
      gitRoot: "",
      outside: request.outside,
      port: String(request.port),
    },
    request.signal,
  );
}

/** Compile native interop without creating profiles or touching desktop/workspace data. */
export async function validateWindowsProcessSandboxBridge(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows required.");
  await bridge({ mode: "compile" });
}

async function bridge(
  payload: Record<string, string>,
  signal?: AbortSignal,
): Promise<ProcessRunResult> {
  const temporary = await mkdtemp(join(tmpdir(), "zet-win-process-"));
  const profile = `zet-harness-${randomUUID()}`;
  const path = join(temporary, "bridge.ps1");
  const started = Date.now();
  try {
    await writeFile(path, WINDOWS_PROCESS_BRIDGE, { mode: 0o600 });
    const result = await invoke(path, { ...payload, temporary, profile }, signal);
    if (payload["mode"] === "compile") return emptyResult(started);
    const parsed: unknown = JSON.parse(result);
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid sandbox result.");
    const value = parsed as Record<string, unknown>;
    if (typeof value["failure"] === "string" && /^[a-z-]+:-?\d{1,12}$/.test(value["failure"]))
      throw new Error(`Windows process sandbox refused (${value["failure"]}); no host fallback.`);
    if (
      typeof value["code"] !== "number" ||
      typeof value["stdout"] !== "string" ||
      typeof value["stderr"] !== "string" ||
      typeof value["timedOut"] !== "boolean"
    )
      throw new Error("Invalid sandbox result.");
    return {
      outcome: value["timedOut"] ? "timed-out" : "exited",
      exitCode: value["timedOut"] ? null : value["code"],
      signal: null,
      stdout: value["stdout"],
      stderr: value["stderr"],
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (
      error instanceof Error &&
      /^Windows process sandbox refused \([a-z-]+:-?\d{1,12}\); no host fallback\.$/.test(
        error.message,
      )
    )
      throw error;
    throw new Error("Windows process sandbox failed; no host fallback.");
  } finally {
    // A terminated host closes the JobObject. A second bridge removes its profile after cancellation.
    await invoke(path, { mode: "cleanup", profile, temporary }).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}
function emptyResult(started: number): ProcessRunResult {
  return {
    outcome: "exited",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: Date.now() - started,
  };
}
async function invoke(
  path: string,
  payload: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(
      join(
        process.env["SystemRoot"] ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows",
          // AppContainer setup expands profile variables in the trusted launcher too.
          // These point to this private invocation, never the host user profile.
          LOCALAPPDATA: payload["temporary"]!,
          APPDATA: payload["temporary"]!,
          USERPROFILE: payload["temporary"]!,
          windir: process.env["SystemRoot"] ?? "C:\\Windows",
          TEMP: tmpdir(),
          TMP: tmpdir(),
        },
      },
    );
    let output = "";
    let failed = false;
    const kill = () => {
      failed = true;
      child.kill();
    };
    const timer = setTimeout(kill, 75_000);
    signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 300_000) kill();
    });
    child.stderr.on("data", () => {
      /* Native diagnostics may contain private paths: discard. */
    });
    child.stdin.on("error", kill);
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (failed || code !== 0) reject(new Error("Native sandbox refused."));
      else resolve(output);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

// Microsoft: implementing-an-appcontainer; UpdateProcThreadAttribute; Job Objects.
// AppContainer is distinct from Codex's dedicated-user/restricted-token Windows sandbox.
export const WINDOWS_PROCESS_BRIDGE = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class ZetProcessSandbox {
 [StructLayout(LayoutKind.Sequential)] struct SA { public int size; public IntPtr descriptor; public int inherit; }
 [StructLayout(LayoutKind.Sequential)] struct SC { public IntPtr sid, capabilities; public uint count, reserved; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI { public int cb; public string reserved, desktop, title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct SIX { public SI si; public IntPtr list; }
 [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct LIMIT { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct EXT { public LIMIT limit; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
 [StructLayout(LayoutKind.Sequential)] struct INFO { public uint attrs; public System.Runtime.InteropServices.ComTypes.FILETIME creation,access,write; public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow; }
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid,out IntPtr path);
 [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr prev,IntPtr ret);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processSA,IntPtr threadSA,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA sa,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXT value,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool assigned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr sa,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out INFO info);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle file,StringBuilder path,uint size,uint flags);
 static string phase="init"; static int nativeError;
 public static string Failure() { return phase+":"+nativeError; }
 static void Check(bool ok) { if(!ok) {nativeError=Marshal.GetLastWin32Error();throw new InvalidOperationException("Sandbox refused.");} }
 public static void Cleanup(string name) { DeleteAppContainerProfile(name); }
 static string Quote(string value) { Check(!value.Contains("\"") && !value.EndsWith("\\")); return "\"" + value + "\""; }
 static bool Blocked(string name) {
  return System.Text.RegularExpressions.Regex.IsMatch(name,@"^(?:\.env.*|\.git-credentials|\.zet-codex|\.bash_history|\.zsh_history|\.gcloud|\.codex|\.claude|\.aws|\.ssh|\.azure|\.config|\.gnupg|\.kube|\.docker|\.npmrc|\.netrc|\.pypirc|auth\.json|\.credentials(?:\..*)?|\.secrets?(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$|(?:\.(?:pem|key|p12|pfx|jks|keystore)$|(?:^|[._-])(?:token|password|private[._-]?key)(?:[._-]|$))",System.Text.RegularExpressions.RegexOptions.IgnoreCase)
   || name=="node_modules" || name=="hooks" || name=="logs" || name=="config";
 }
 sealed class Locks:IDisposable {
  List<SafeFileHandle> held=new List<SafeFileHandle>();
  public Locks(string path) {
   try {
    string full=Path.GetFullPath(path); Check(!full.StartsWith(@"\\") && full.Length<32000);
    string root=Path.GetPathRoot(full),current=root;
    string[] parts=full.Substring(root.Length).Split(new char[]{'\\'},StringSplitOptions.RemoveEmptyEntries);Check(parts.Length<=128);
    for(int i=-1;i<parts.Length;i++) {
     if(i>=0) {Check(parts[i].IndexOf(':')<0);current=Path.Combine(current,parts[i]);}
     phase="source-directory";SafeFileHandle handle=CreateFile(current,0,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);held.Add(handle);Check(!handle.IsInvalid);
     INFO info;Check(GetFileInformationByHandle(handle,out info));Check((info.attrs&0x400)==0 && (info.attrs&0x10)!=0);
     StringBuilder actual=new StringBuilder(32768);Check(GetFinalPathNameByHandle(handle,actual,32768,0)>0);
     string canonical=actual.ToString();if(canonical.StartsWith(@"\\?\"))canonical=canonical.Substring(4);
     phase="directory-canonical";Check(String.Equals(current.TrimEnd('\\'),canonical.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase));
    }
   } catch {Dispose();throw;}
  }
  public void Dispose() {foreach(SafeFileHandle handle in held)handle.Dispose();held.Clear();}
 }
 static long bytes,byteLimit; static int entries; static DateTime scanStarted;
 static void CopyTree(string root,string destination,bool git) {
  using(Locks locked=new Locks(root)) { foreach(string entry in Directory.GetFileSystemEntries(root)) {
   if(++entries>10000 || (DateTime.UtcNow-scanStarted).TotalSeconds>15) throw new InvalidOperationException();
   string name=Path.GetFileName(entry); if(Blocked(name) || (!git && name==".git")) continue;
   FileAttributes attrs=File.GetAttributes(entry); if((attrs&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException();
   string target=Path.Combine(destination,name);
   if((attrs&FileAttributes.Directory)!=0) { Directory.CreateDirectory(target); CopyTree(entry,target,git); }
   else CopyFile(entry,target);
  }}
 }
 static void CopyFile(string source,string target) {
  using(Locks locked=new Locks(Path.GetDirectoryName(source))) using(SafeFileHandle handle=CreateFile(source,0x80000000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
   phase="source-file";Check(!handle.IsInvalid); INFO info; Check(GetFileInformationByHandle(handle,out info));
   Check((info.attrs&0x410)==0 && info.links==1 && info.sizeHigh==0 && info.sizeLow<=134217728);
   StringBuilder actual=new StringBuilder(32768); Check(GetFinalPathNameByHandle(handle,actual,32768,0)>0);
   string canonical=actual.ToString(); if(canonical.StartsWith(@"\\?\")) canonical=canonical.Substring(4);
   phase="file-canonical";Check(String.Equals(Path.GetFullPath(source),canonical,StringComparison.OrdinalIgnoreCase));
   bytes+=info.sizeLow; Check(bytes<=byteLimit);
   using(FileStream input=new FileStream(handle,FileAccess.Read)) using(FileStream output=new FileStream(target,FileMode.CreateNew,FileAccess.Write)) {
    byte[] buffer=new byte[65536]; long remaining=info.sizeLow; while(remaining>0) { int n=input.Read(buffer,0,(int)Math.Min(buffer.Length,remaining)); Check(n>0); output.Write(buffer,0,n); remaining-=n; } Check(input.ReadByte()==-1);
   }
  }
 }
 static void Grant(string root,SecurityIdentifier sid) {
  DirectorySecurity acl=Directory.GetAccessControl(root);
  acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.ReadAndExecute,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
  Directory.SetAccessControl(root,acl);
 }
 static string ReadPipe(IntPtr pipe) {
  using(SafeFileHandle h=new SafeFileHandle(pipe,true)) using(FileStream stream=new FileStream(h,FileAccess.Read)) {
   byte[] data=new byte[65537]; int length=0; while(length<data.Length) { int n=stream.Read(data,length,data.Length-length); if(n==0) break; length+=n; }
   if(length>65536) throw new InvalidOperationException("Output limit."); return Encoding.UTF8.GetString(data,0,length);
  }
 }
 public static object Run(string temporary,string profile,string command,string cwd,string node,string gitRoot,string outside,string port) {
  IntPtr sid=IntPtr.Zero,list=IntPtr.Zero,scmem=IntPtr.Zero,handles=IntPtr.Zero,jobmem=IntPtr.Zero,env=IntPtr.Zero,job=IntPtr.Zero;
  IntPtr outR=IntPtr.Zero,outW=IntPtr.Zero,errR=IntPtr.Zero,errW=IntPtr.Zero,inR=IntPtr.Zero,inW=IntPtr.Zero; PI pi=new PI();
  bool created=false; DateTime started=DateTime.UtcNow;
  try {
   phase="profile";int profileResult=CreateAppContainerProfile(profile,profile,"Temporary Zet diagnostic isolation",IntPtr.Zero,0,out sid);if(profileResult!=0){nativeError=profileResult;throw new InvalidOperationException();} created=true;
   string workspace=Path.Combine(temporary,"workspace"),runner=Path.Combine(temporary,"runner"); Directory.CreateDirectory(workspace); Directory.CreateDirectory(runner);
   phase="snapshot";bytes=0;entries=0;byteLimit=536870912;scanStarted=DateTime.UtcNow; string executable,args;
   if(command=="node-version" || command=="probe" || command=="probe-hold") { executable=Path.Combine(runner,"node.exe"); CopyFile(node,executable); args="--version";
    if(command.StartsWith("probe")) {
     string script=Path.Combine(workspace,"probe.js");
     string source=command=="probe-hold" ?
      "const {spawn}=require('node:child_process');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(p.pid);setInterval(()=>{},1000);" :
      "const fs=require('node:fs');let denied=false;try{fs.readFileSync(process.env.ZET_PROBE_OUTSIDE)}catch{denied=true}if(!denied)process.exit(20);const net=require('node:net');const s=net.connect({host:'127.0.0.1',port:Number(process.env.ZET_PROBE_PORT)});s.once('connect',()=>process.exit(21));s.once('error',()=>{console.log('outside-file-and-network-denied');process.exit(0)});setTimeout(()=>process.exit(22),3000);";
     File.WriteAllText(script,source);args=Quote(script);
    }
   }
   else if(command=="git-status") {
    Check(Path.IsPathRooted(gitRoot)); CopyTree(Path.GetFullPath(gitRoot),runner,true); bytes=0;entries=0;byteLimit=67108864; CopyTree(Path.GetFullPath(cwd),workspace,true); Check(bytes<=67108864);
    executable=Path.Combine(runner,"cmd","git.exe"); Check(File.Exists(executable));
    args="-c core.fsmonitor=false -c core.untrackedCache=false status --porcelain=v1 --ignore-submodules=all";
   } else throw new InvalidOperationException();
   phase="temporary-acl";Grant(temporary,new SecurityIdentifier(sid));
   phase="pipes";SA sa=new SA();sa.size=Marshal.SizeOf(typeof(SA));sa.inherit=1;
   Check(CreatePipe(out outR,out outW,ref sa,0));Check(SetHandleInformation(outR,1,0));
   Check(CreatePipe(out errR,out errW,ref sa,0));Check(SetHandleInformation(errR,1,0));
   Check(CreatePipe(out inR,out inW,ref sa,0));Check(SetHandleInformation(inW,1,0)); CloseHandle(inW);inW=IntPtr.Zero;
   phase="attributes";IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,3,0,ref size); list=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(list,3,0,ref size));
   SC sc=new SC();sc.sid=sid; scmem=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SC)));Marshal.StructureToPtr(sc,scmem,false);
   Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20009),scmem,new IntPtr(Marshal.SizeOf(typeof(SC))),IntPtr.Zero,IntPtr.Zero));
   handles=Marshal.AllocHGlobal(3*IntPtr.Size);Marshal.WriteIntPtr(handles,0,inR);Marshal.WriteIntPtr(handles,IntPtr.Size,outW);Marshal.WriteIntPtr(handles,2*IntPtr.Size,errW);
   Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
   phase="job";job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);EXT limits=new EXT();limits.limit.flags=0x2000;Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXT))));
   // Atomic job membership prevents an orphan if the host dies between CreateProcess and assignment.
   jobmem=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobmem,job);
   Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x2000D),jobmem,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
   string system=Environment.GetEnvironmentVariable("SystemRoot");
   phase="profile-path";IntPtr profilePathPointer;int pathResult=GetAppContainerFolderPath(new SecurityIdentifier(sid).Value,out profilePathPointer);
   if(pathResult!=0){nativeError=pathResult;throw new InvalidOperationException();}
   string profilePath;try {profilePath=Marshal.PtrToStringUni(profilePathPointer);}finally{Marshal.FreeCoTaskMem(profilePathPointer);}
   Check(!String.IsNullOrEmpty(profilePath));string profileTemp=Path.Combine(profilePath,"Temp");Directory.CreateDirectory(profileTemp);
   // Win32 AppContainer creation reads these from its trusted caller environment.
   Environment.SetEnvironmentVariable("LOCALAPPDATA",profilePath);
   Environment.SetEnvironmentVariable("APPDATA",profilePath);
   Environment.SetEnvironmentVariable("USERPROFILE",workspace);
   string environment="APPDATA="+profilePath+"\0CI=1\0GIT_ALLOW_PROTOCOL=none\0GIT_CONFIG_GLOBAL=NUL\0GIT_CONFIG_NOSYSTEM=1\0GIT_LITERAL_PATHSPECS=1\0GIT_OPTIONAL_LOCKS=0\0GIT_TERMINAL_PROMPT=0\0HOME="+workspace+"\0LOCALAPPDATA="+profilePath+"\0PATH="+runner+"\0SystemRoot="+system+"\0TEMP="+profileTemp+"\0TMP="+profileTemp+"\0USERPROFILE="+workspace+"\0windir="+system+"\0\0";
   if(command.StartsWith("probe")) environment=environment.TrimEnd('\0')+"\0ZET_PROBE_OUTSIDE="+outside+"\0ZET_PROBE_PORT="+port+"\0\0";
   // Windows expects environment keys sorted, including any fixed probe entries.
   string[] environmentEntries=environment.TrimEnd('\0').Split('\0');Array.Sort(environmentEntries,StringComparer.OrdinalIgnoreCase);
   environment=String.Join("\0",environmentEntries)+"\0\0";
   env=Marshal.StringToHGlobalUni(environment);
   SIX startup=new SIX();startup.si.cb=Marshal.SizeOf(typeof(SIX));startup.si.flags=0x100;startup.si.input=inR;startup.si.output=outW;startup.si.error=errW;startup.list=list;
   phase="launch";Check(CreateProcess(executable,new StringBuilder(Quote(executable)+" "+args),IntPtr.Zero,IntPtr.Zero,true,0x80000|0x400|4|0x08000000,env,workspace,ref startup,out pi));
   phase="resume";bool assigned;Check(IsProcessInJob(pi.process,job,out assigned) && assigned); Check(ResumeThread(pi.thread)!=0xffffffff);
   CloseHandle(outW);outW=IntPtr.Zero;CloseHandle(errW);errW=IntPtr.Zero;CloseHandle(inR);inR=IntPtr.Zero;
   IntPtr stdoutPipe=outR,stderrPipe=errR;outR=errR=IntPtr.Zero;
   var stdout=System.Threading.Tasks.Task.Factory.StartNew(()=>ReadPipe(stdoutPipe));var stderr=System.Threading.Tasks.Task.Factory.StartNew(()=>ReadPipe(stderrPipe));
   phase="wait";bool timedOut=WaitForSingleObject(pi.process,10000)!=0; if(timedOut) Check(TerminateJobObject(job,1));
   CloseHandle(job);job=IntPtr.Zero;Check(WaitForSingleObject(pi.process,1000)==0);
   phase="output";Check(System.Threading.Tasks.Task.WaitAll(new System.Threading.Tasks.Task[]{stdout,stderr},2000));
   uint code;Check(GetExitCodeProcess(pi.process,out code));return new {code=code,stdout=stdout.Result,stderr=stderr.Result,timedOut=timedOut};
  } finally {
   if(pi.process!=IntPtr.Zero) TerminateProcess(pi.process,1);
   foreach(IntPtr handle in new IntPtr[]{job,pi.thread,pi.process,outR,outW,errR,errW,inR,inW}) if(handle!=IntPtr.Zero) CloseHandle(handle);
   if(list!=IntPtr.Zero) {DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(list);} foreach(IntPtr memory in new IntPtr[]{scmem,handles,jobmem,env}) if(memory!=IntPtr.Zero) Marshal.FreeHGlobal(memory);
   if(sid!=IntPtr.Zero) FreeSid(sid);if(created) DeleteAppContainerProfile(profile);
  }
 }
}
'@
Add-Type -TypeDefinition $source
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.mode -eq 'compile') { [Console]::Out.Write('{}'); exit 0 }
if ($request.mode -eq 'cleanup') { [ZetProcessSandbox]::Cleanup($request.profile); [Console]::Out.Write('{}'); exit 0 }
try { $result = [ZetProcessSandbox]::Run($request.temporary, $request.profile, $request.command, $request.cwd, $request.node, $request.gitRoot, $request.outside, $request.port) }
catch { $result = @{ failure = [ZetProcessSandbox]::Failure() } }
[Console]::Out.Write(($result | ConvertTo-Json -Compress))
`;
