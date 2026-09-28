param([switch]$Rebuild)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$dataDir = if ($env:PETDESK_DATA_DIR) { $env:PETDESK_DATA_DIR } else { Join-Path $projectRoot '.data' }
$logPath = Join-Path $dataDir 'launcher.log'
try {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    if ($env:PETDESK_SMOKE -eq '1') { $PID | Out-File -LiteralPath (Join-Path $dataDir 'launcher.pid') -Encoding ascii }
    Set-Location -LiteralPath $projectRoot
    $binary = Join-Path $projectRoot 'src-tauri\target\debug\petdesk.exe'
    $inputs = @('src-tauri\Cargo.toml','src-tauri\Cargo.lock','src-tauri\build.rs','src-tauri\tauri.conf.json','tools\prepare-tauri.cjs','tools\tauri-smoke-page.js') | ForEach-Object { Get-Item -LiteralPath (Join-Path $projectRoot $_) }
    foreach ($folder in @('ui','assets','src-tauri\src','src-tauri\capabilities')) {
        $inputs += Get-ChildItem -LiteralPath (Join-Path $projectRoot $folder) -File -Recurse
    }
    $needsBuild = $Rebuild -or -not (Test-Path -LiteralPath $binary)
    if (-not $needsBuild) {
        $builtAt = (Get-Item -LiteralPath $binary).LastWriteTimeUtc
        $needsBuild = @($inputs | Where-Object { $_.LastWriteTimeUtc -gt $builtAt }).Count -gt 0
    }
    if ($needsBuild) {
        Get-Command node.exe, cargo.exe -ErrorAction Stop | Out-Null
        & node.exe tools/prepare-tauri.cjs 2>&1 | Out-File -LiteralPath $logPath -Encoding UTF8
        if ($LASTEXITCODE -ne 0) { throw 'Frontend preparation failed.' }
        # PowerShell 5.1 treats native stderr (including Cargo progress) as errors.
        $ErrorActionPreference = 'Continue'
        & cargo.exe build --manifest-path src-tauri/Cargo.toml --locked 2>&1 | Out-File -LiteralPath $logPath -Append -Encoding UTF8
        $ErrorActionPreference = 'Stop'
        if ($LASTEXITCODE -ne 0) { throw 'Rust build failed.' }
    } else {
        'Using cached executable; no build required.' | Out-File -LiteralPath $logPath -Encoding UTF8
    }
    $app = Start-Process -FilePath $binary -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    if ($env:PETDESK_SMOKE -eq '1') { $app.Id | Out-File -LiteralPath (Join-Path $dataDir 'app.pid') -Encoding ascii }
    # The GUI owns its lifetime; the launcher must exit immediately.
} catch {
    $message = "PetDesk could not start. $($_.Exception.Message)`nSee: $logPath"
    $message | Out-File -LiteralPath $logPath -Append -Encoding UTF8
    if ($env:PETDESK_SMOKE -ne '1') {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($message, 'PetDesk') | Out-Null
    }
    exit 1
}
