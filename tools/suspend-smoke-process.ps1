param(
    [Parameter(Mandatory=$true)][int]$TestProcessId,
    [Parameter(Mandatory=$true)][string]$ExpectedPath
)
$ErrorActionPreference = 'Stop'
# Only the executable launched by smoke-tauri.cjs may be paused. Keep one process
# handle throughout so PID reuse cannot redirect the resume operation.
$expected = [IO.Path]::GetFullPath($ExpectedPath)
$allowed = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\src-tauri\target\debug\petdesk.exe'))
if ($expected -ne $allowed) { throw 'Not the isolated smoke executable' }
$testProcess = Get-Process -Id $TestProcessId -ErrorAction Stop
if ($testProcess.Path -ne $expected) { throw 'Smoke process path mismatch' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SmokeSuspend {
    [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
    [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);
}
'@
$handle = $testProcess.Handle
$suspended = $false
try {
    $status = [SmokeSuspend]::NtSuspendProcess($handle)
    if ($status -ne 0) { throw "Suspend failed: $status" }
    $suspended = $true
    Start-Sleep -Seconds 12
} finally {
    if ($suspended) {
        $status = [SmokeSuspend]::NtResumeProcess($handle)
        if ($status -ne 0) { throw "Resume failed: $status" }
    }
    $testProcess.Dispose()
}
Write-Output 'Isolated smoke process suspended for 12 seconds and resumed.'
