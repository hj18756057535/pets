$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$electronPath = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronPath)) {
    Write-Host 'Please run npm install first.'
    exit 1
}
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath $electronPath -ArgumentList ('"' + $projectRoot + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden
