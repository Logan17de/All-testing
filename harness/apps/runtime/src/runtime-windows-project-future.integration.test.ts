import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { executeWindowsSandboxedProjectScript } from "./runtime-windows-project-sandbox.js";

const system = process.env["SystemRoot"] ?? "C:\\Windows";
const powershell = join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
function ps(script: string): string {
  return execFileSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(`$ErrorActionPreference='Stop';${script}`, "utf16le").toString("base64"),
    ],
    { timeout: 15000, maxBuffer: 16384, encoding: "utf8", windowsHide: true },
  ).trim();
}
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
function acl(root: string, args: string[]): void {
  execFileSync(join(system, "System32", "icacls.exe"), [root, ...args], {
    timeout: 15000,
    maxBuffer: 16384,
    windowsHide: true,
    stdio: "pipe",
  });
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "win-future-project-")));
  const state = await realpath(await mkdtemp(join(tmpdir(), "win-future-state-")));
  const npm = process.env["ZET_NPM_CLI"] ?? process.env["npm_execpath"];
  if (!npm) throw new Error("Native fixture requires trusted npm.");
  const npmCliPath = await realpath(npm);
  const database = join(state, "fixture.sqlite");
  await writeFile(database, "synthetic private state");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node check.cjs" } }),
  );
  await writeFile(join(root, "check.cjs"), "console.log('unexpected-project-execution');");
  return {
    root,
    state,
    npmCliPath,
    privatePaths: [database, `${database}-wal`, `${database}-shm`],
  };
}

it.skipIf(process.platform !== "win32")(
  "native future security refuses inheritable readable and weak-label source descriptors",
  async () => {
    for (const mode of [
      "low",
      "no-write-up",
      "inherited-read",
      "grandchild-read",
      "conditional",
    ] as const) {
      const f = await fixture();
      try {
        const target = join(f.root, "empty-future-target");
        await mkdir(target);
        if (mode === "low" || mode === "no-write-up") {
          const label = mode === "low" ? "S:(ML;OIIO;NW;;;LW)" : "S:(ML;OIIO;NR;;;ME)";
          // LABEL_SECURITY_INFORMATION modifies only this synthetic root's mandatory label.
          ps(`Add-Type @'
using System;using System.Runtime.InteropServices;
public static class LabelFixture {
[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string s,uint r,out IntPtr p,out uint n);
[DllImport("advapi32.dll",SetLastError=true)]public static extern bool GetSecurityDescriptorSacl(IntPtr p,out bool present,out IntPtr acl,out bool def);
[DllImport("advapi32.dll",CharSet=CharSet.Unicode)]public static extern uint SetNamedSecurityInfo(string p,uint t,uint info,IntPtr o,IntPtr g,IntPtr d,IntPtr s);
[DllImport("advapi32.dll",CharSet=CharSet.Unicode)]public static extern uint GetNamedSecurityInfo(string p,uint t,uint info,out IntPtr o,out IntPtr g,out IntPtr d,out IntPtr s,out IntPtr sd);
[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr sd,uint r,uint info,out IntPtr text,out uint n);
[DllImport("kernel32.dll")]public static extern IntPtr LocalFree(IntPtr p);
}
'@; $sd=[IntPtr]::Zero;$n=0;if(-not[LabelFixture]::ConvertStringSecurityDescriptorToSecurityDescriptor(${literal(label)},1,[ref]$sd,[ref]$n)){throw 'fixture-label-construct'};try{$present=$false;$default=$false;$sacl=[IntPtr]::Zero;if(-not[LabelFixture]::GetSecurityDescriptorSacl($sd,[ref]$present,[ref]$sacl,[ref]$default)){throw 'fixture-label-read'};$code=[LabelFixture]::SetNamedSecurityInfo(${literal(target)},1,16,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,$sacl);if($code-ne0){throw 'fixture-label-set'};$o=[IntPtr]::Zero;$g=[IntPtr]::Zero;$d=[IntPtr]::Zero;$sa=[IntPtr]::Zero;$read=[IntPtr]::Zero;$text=[IntPtr]::Zero;$len=0;try{if([LabelFixture]::GetNamedSecurityInfo(${literal(target)},1,16,[ref]$o,[ref]$g,[ref]$d,[ref]$sa,[ref]$read)-ne0){throw 'fixture-label-readback'};if(-not[LabelFixture]::ConvertSecurityDescriptorToStringSecurityDescriptor($read,1,16,[ref]$text,[ref]$len)){throw 'fixture-label-serialize'};if([Runtime.InteropServices.Marshal]::PtrToStringUni($text)-cne${literal(label)}){throw 'fixture-label-normalized'}}finally{if($text-ne[IntPtr]::Zero){[void][LabelFixture]::LocalFree($text)};if($read-ne[IntPtr]::Zero){[void][LabelFixture]::LocalFree($read)}}}finally{[void][LabelFixture]::LocalFree($sd)}`);
        }
        if (mode === "inherited-read") acl(target, ["/grant", "*S-1-15-2-1:(OI)(CI)(IO)(R)"]);
        if (mode === "grandchild-read")
          ps(
            `$p=${literal(target)};$a=Get-Acl -LiteralPath $p;$sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-15-2-1');$inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::ReadData,$inherit,[System.Security.AccessControl.PropagationFlags]'InheritOnly,NoPropagateInherit',[System.Security.AccessControl.AccessControlType]::Deny));$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::ReadData,$inherit,[System.Security.AccessControl.PropagationFlags]::InheritOnly,[System.Security.AccessControl.AccessControlType]::Allow));Set-Acl -LiteralPath $p -AclObject $a;$rules=@((Get-Acl -LiteralPath $p).GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier])|Where-Object{$_.IdentityReference.Value-eq'S-1-15-2-1'});$deny=@($rules|Where-Object{$_.AccessControlType-eq'Deny'-and[int]$_.InheritanceFlags-eq3-and[int]$_.PropagationFlags-eq3-and(([int]$_.FileSystemRights-band1)-eq1)});$allow=@($rules|Where-Object{$_.AccessControlType-eq'Allow'-and[int]$_.InheritanceFlags-eq3-and[int]$_.PropagationFlags-eq2-and(([int]$_.FileSystemRights-band1)-eq1)});if($deny.Count-ne1-or$allow.Count-ne1){throw 'fixture-grandchild-inheritance-normalized'}`,
          );
        if (mode === "conditional") {
          ps(`Add-Type @'
using System;using System.Runtime.InteropServices;
public static class ConditionalFixture {
[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string s,uint r,out IntPtr p,out uint n);
[DllImport("advapi32.dll",SetLastError=true)]public static extern bool GetSecurityDescriptorDacl(IntPtr p,out bool present,out IntPtr acl,out bool def);
[DllImport("advapi32.dll",CharSet=CharSet.Unicode)]public static extern uint SetNamedSecurityInfo(string p,uint t,uint info,IntPtr o,IntPtr g,IntPtr d,IntPtr s);
[DllImport("advapi32.dll",CharSet=CharSet.Unicode)]public static extern uint GetNamedSecurityInfo(string p,uint t,uint info,out IntPtr o,out IntPtr g,out IntPtr d,out IntPtr s,out IntPtr sd);
[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr sd,uint r,uint info,out IntPtr text,out uint n);
[DllImport("kernel32.dll")]public static extern IntPtr LocalFree(IntPtr p);
}
'@;$p=${literal(target)};$original=(Get-Acl -LiteralPath $p).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access);$input=$original+'(XA;OIIO;FR;;;AC;(@Resource.ZetFixture == "yes"))';$sd=[IntPtr]::Zero;$n=0;if(-not[ConditionalFixture]::ConvertStringSecurityDescriptorToSecurityDescriptor($input,1,[ref]$sd,[ref]$n)){throw 'fixture-conditional-construct'};try{$present=$false;$default=$false;$dacl=[IntPtr]::Zero;if(-not[ConditionalFixture]::GetSecurityDescriptorDacl($sd,[ref]$present,[ref]$dacl,[ref]$default)){throw 'fixture-conditional-read'};if([ConditionalFixture]::SetNamedSecurityInfo($p,1,4,[IntPtr]::Zero,[IntPtr]::Zero,$dacl,[IntPtr]::Zero)-ne0){throw 'fixture-conditional-set'};$o=[IntPtr]::Zero;$g=[IntPtr]::Zero;$d=[IntPtr]::Zero;$sa=[IntPtr]::Zero;$read=[IntPtr]::Zero;$text=[IntPtr]::Zero;$len=0;try{if([ConditionalFixture]::GetNamedSecurityInfo($p,1,4,[ref]$o,[ref]$g,[ref]$d,[ref]$sa,[ref]$read)-ne0){throw 'fixture-conditional-readback'};if(-not[ConditionalFixture]::ConvertSecurityDescriptorToStringSecurityDescriptor($read,1,4,[ref]$text,[ref]$len)){throw 'fixture-conditional-serialize'};$actual=[Runtime.InteropServices.Marshal]::PtrToStringUni($text);if(-not$actual.Contains('(XA;OIIO;')-or-not$actual.Contains('@Resource.ZetFixture')){throw 'fixture-conditional-normalized'}}finally{if($text-ne[IntPtr]::Zero){[void][ConditionalFixture]::LocalFree($text)};if($read-ne[IntPtr]::Zero){[void][ConditionalFixture]::LocalFree($read)}}}finally{[void][ConditionalFixture]::LocalFree($sd)}`);
        }
        await expect(
          executeWindowsSandboxedProjectScript({ cwd: f.root, command: "project-test" }, f),
        ).rejects.toThrow(
          mode === "conditional" ? "project-source-acl-shape" : "project-source-future-access",
        );
      } finally {
        await rm(f.root, { recursive: true, force: true });
        await rm(f.state, { recursive: true, force: true });
      }
    }
  },
  1000000,
);

it.skipIf(process.platform !== "win32")(
  "native running project cannot read or modify ordinary host files created after preflight",
  async () => {
    const f = await fixture();
    const nonce = randomUUID().replaceAll("-", "");
    const filename = `owned-${nonce}.cjs`;
    const later = join(f.root, `future-${nonce}.txt`);
    const laterDirectory = join(f.root, `future-dir-${nonce}`);
    const abort = new AbortController();
    let pending: Promise<unknown> | undefined;
    try {
      await writeFile(
        join(f.root, "package.json"),
        JSON.stringify({ scripts: { test: `node ${filename}` } }),
      );
      await writeFile(
        join(f.root, filename),
        `const fs=require('node:fs'),assert=require('node:assert/strict');const denied=e=>e.code==='EACCES'||e.code==='EPERM';setTimeout(()=>{let attempts=0;const timer=setInterval(()=>{const attemptAt=Date.now();assert.throws(()=>fs.readFileSync(${JSON.stringify(later)}),denied);assert.throws(()=>fs.writeFileSync(${JSON.stringify(later)},'bad'),denied);assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(laterDirectory, "bad.txt"))},'bad'),denied);if(++attempts===3){clearInterval(timer);console.log('future-host-kernel-denial:'+attemptAt);}},500);},15000);`,
      );
      let ended = false;
      const outcome = executeWindowsSandboxedProjectScript(
        { cwd: f.root, command: "project-test", signal: abort.signal },
        f,
      )
        .then(
          (value) => ({ value }),
          () => ({ error: true }),
        )
        .finally(() => {
          ended = true;
        });
      pending = outcome;
      const deadline = performance.now() + 180000;
      let ready = false;
      while (!ended && performance.now() < deadline) {
        // Query only our nonce-bearing fixture command; output PID only, never argv.
        const pid = ps(
          `Get-CimInstance Win32_Process -Filter ${literal(`Name='node.exe' AND CommandLine LIKE '%${filename}%'`)} | Select-Object -ExpandProperty ProcessId`,
        );
        if (/^\d+(\s+\d+)*$/.test(pid)) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(ready, "Owned sandbox payload did not reach the post-preflight delay.").toBe(true);
      await mkdir(laterDirectory);
      await writeFile(later, "ordinary host-created bytes");
      const createdAt = Date.now();
      const result = await outcome;
      expect("value" in result).toBe(true);
      if (!("value" in result)) throw new Error("Native sandbox fixture failed.");
      expect(result.value.exitCode).toBe(0);
      expect(result.value.stdout).toContain("future-host-kernel-denial");
      const finishedAt = /future-host-kernel-denial:(\d+)/.exec(result.value.stdout)?.[1];
      expect(Number(finishedAt)).toBeGreaterThan(createdAt);
      await expect(readFile(join(laterDirectory, "bad.txt"))).rejects.toThrow();
      expect(await readFile(later, "utf8")).toBe("ordinary host-created bytes");
    } finally {
      abort.abort();
      await pending;
      await rm(f.root, { recursive: true, force: true });
      await rm(f.state, { recursive: true, force: true });
    }
  },
  240000,
);
