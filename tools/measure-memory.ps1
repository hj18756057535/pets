param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$destination = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $destination.StartsWith((Join-Path $repo 'artifacts') + [IO.Path]::DirectorySeparatorChar)) { throw 'Benchmark must use an isolated artifacts directory' }
if (Test-Path -LiteralPath $destination) { throw 'Use a new output directory for each measurement' }
$data = Join-Path $destination '.data'
New-Item -ItemType Directory -Path $data -Force | Out-Null
Copy-Item -LiteralPath $Executable -Destination (Join-Path $destination 'petdesk.exe')
$selection = Get-Content -LiteralPath (Join-Path $repo '.data/selected-pet.json') -Encoding UTF8 | ConvertFrom-Json
if ($selection.directory -notmatch '^pet-import-[0-9a-f-]+$') { throw 'Invalid pet directory' }
Copy-Item -LiteralPath (Join-Path $repo ".data/$($selection.directory)") -Destination (Join-Path $data 'pet') -Recurse
'{"version":1,"settings":{"quiet":true,"eyeBreak":false,"scale":0.6},"position":null,"dock":null,"reminders":[]}' | Set-Content -LiteralPath (Join-Path $data 'state.json') -Encoding UTF8
$app = Start-Process -FilePath (Join-Path $destination 'petdesk.exe') -WindowStyle Hidden -PassThru
try {
    # Close only this benchmark's panel; its normal close handler preserves hidden resources.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PetDeskMemoryBenchmark {
    private delegate bool WindowCallback(IntPtr hwnd, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr state);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    public static int InspectPanel(uint processId, bool close) {
        int visible = 0;
        EnumWindows((hwnd, state) => {
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            if (pid == processId) {
                var title = new StringBuilder(256); GetWindowText(hwnd, title, title.Capacity);
                if (title.ToString() == "PetDesk · 你的桌面小伙伴" && IsWindowVisible(hwnd)) {
                    visible++;
                    if (close) PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
                }
            }
            return true;
        }, IntPtr.Zero);
        return visible;
    }
}
'@
    Start-Sleep -Seconds 3
    $panelsClosed = [PetDeskMemoryBenchmark]::InspectPanel($app.Id, $true)
    Start-Sleep -Seconds 12
    if ([PetDeskMemoryBenchmark]::InspectPanel($app.Id, $false) -ne 0) { throw 'Benchmark panel is still visible' }
    if ($app.HasExited) { throw 'Benchmark app exited unexpectedly (another instance may be running)' }
    $samples = @()
    for ($sample = 0; $sample -lt 3; $sample++) {
        $all = @(Get-CimInstance Win32_Process)
        $ids = @([int]$app.Id)
        do {
            $children = @($all | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids })
            $ids += @($children | ForEach-Object { [int]$_.ProcessId })
        } while ($children.Count)
        $processes = @($all | Where-Object { $_.ProcessId -in $ids } | ForEach-Object {
            $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            if ($process) {
                $kind = if ($_.CommandLine -match '--type=([^ ]+)') { $Matches[1] } else { 'host' }
                [pscustomobject]@{ pid=$process.Id; name=$process.ProcessName; kind=$kind; workingBytes=$process.WorkingSet64; privateBytes=$process.PrivateMemorySize64 }
            }
        })
        $samples += [pscustomobject]@{ processes=$processes; workingBytes=($processes | Measure-Object workingBytes -Sum).Sum; privateBytes=($processes | Measure-Object privateBytes -Sum).Sum }
        Start-Sleep -Seconds 1
    }
    $report = [pscustomobject]@{ executableHash=(Get-FileHash -LiteralPath $Executable).Hash; scenario='Configured pet, panel closed, quiet, scale 0.6, 12s after closing panel, no memory trim'; panelsClosed=$panelsClosed; panelVisible=$false; samples=$samples }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $destination 'memory.json') -Encoding UTF8
    [pscustomobject]@{ report=(Join-Path $destination 'memory.json'); processes=$samples[0].processes.Count; workingMB=[math]::Round(($samples | Measure-Object workingBytes -Average).Average / 1MB,1); privateMB=[math]::Round(($samples | Measure-Object privateBytes -Average).Average / 1MB,1) } | ConvertTo-Json
} finally {
    if (-not $app.HasExited) { Stop-Process -Id $app.Id }
}
