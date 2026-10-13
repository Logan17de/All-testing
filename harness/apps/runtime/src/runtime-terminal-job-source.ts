/** Trusted dedicated terminal launcher: cloned native Job Object pattern; browser source remains unchanged. */
export const WINDOWS_TERMINAL_JOB = String.raw`
param([string]$NodePath,[string]$WorkerPath,[string]$Directory,[switch]$CompileOnly,[string]$ExpectedIdentity)
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
public static class ZetTerminalJob {
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
 static string Classify(string text){

 if(text.Contains("_CRSession._onMessage")&&(text.Contains("Assertion error")||text.Contains("AssertionError")))return "protocol-assertion";
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
    StringBuilder evidence=new StringBuilder();var emitted=new System.Collections.Generic.HashSet<string>();int character;
    while((character=errors.Read())!=-1){
     if(evidence.Length==8192)evidence.Remove(0,4096);evidence.Append((char)character);
     if(character==10){string diagnosticCode=Classify(evidence.ToString());
      if(diagnosticCode!=null&&emitted.Add(diagnosticCode))Console.WriteLine("{\"kind\":\"diagnostic\",\"code\":\""+diagnosticCode+"\"}");}
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
$actualIdentity=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if(-not $CompileOnly -and $actualIdentity -cne $ExpectedIdentity){[Console]::Error.WriteLine("terminal-identity-mismatch");exit 125}
[Console]::WriteLine((@{kind="native-ready";windowsIdentity=$actualIdentity}|ConvertTo-Json -Compress))
if(-not $CompileOnly){exit [ZetTerminalJob]::Run($NodePath,$WorkerPath,$Directory)}
`;
