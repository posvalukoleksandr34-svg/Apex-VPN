# Starts Apexy VPN for development, rebuilt from source:
#   1. the account API, in its own window (http://127.0.0.1:8787)
#   2. the service (apexyd), in its own window as administrator; Windows asks for permission
#   3. the desktop app, in this window
#
#   powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
#
# To stop: disconnect, close the app, then Ctrl+C in the service window and
# in the API window.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Test-Listening([int]$port) {
    [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}
function Get-PortOwner([int]$port) {
    $owner = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($owner) { Get-CimInstance Win32_Process -Filter "ProcessId=$owner" }
}
function Invoke-Native([string]$what, [scriptblock]$run) {
    & $run
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

Write-Host "== Checks" -ForegroundColor Cyan
if (-not (Test-Path 'node_modules')) { Invoke-Native 'npm install' { npm install } }
if (-not (Test-Path 'dev\service.json') -or -not (Test-Path 'server\api\.env.local')) {
    Invoke-Native 'dev keys' { npm run dev:keys -w server/api }
}
$old = Get-Process meridiand, meridian-app -ErrorAction SilentlyContinue
if ($old) {
    throw "The old Meridian build is running ($(($old | ForEach-Object { "$($_.ProcessName) PID $($_.Id)" }) -join ', ')). Close it (Ctrl+C in its window) and run this again."
}
if (Test-Listening 1420) {
    $p = Get-PortOwner 1420
    throw "Port 1420 (the app's UI server) is taken by $($p.Name) PID $($p.ProcessId): $($p.CommandLine). Close it and run this again."
}

Write-Host "== Account API" -ForegroundColor Cyan
if (Test-Listening 8787) {
    Write-Host "Already running on port 8787."
} else {
    Start-Process powershell -WorkingDirectory $root -ArgumentList @(
        '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle = 'Apexy API'; npm run api:dev")
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Listening 8787)) {
        if ((Get-Date) -gt $deadline) { throw "The API didn't start; see its window." }
        Start-Sleep -Milliseconds 500
    }
    Write-Host "Running on http://127.0.0.1:8787"
}

Write-Host "== Service (apexyd)" -ForegroundColor Cyan
$svc = Get-Process apexyd -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host "Already running (PID $($svc.Id)). To run a fresh build, stop it (Ctrl+C in its window) and run this again."
} else {
    Invoke-Native 'building the service' { cargo build -p vpn-daemon -p vpn-cli }
    Start-Process powershell -Verb RunAs -ArgumentList @(
        '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$root\scripts\dev-service.ps1`"")
    Write-Host "Started in an administrator window."
}

Write-Host "== App (first build takes a few minutes)" -ForegroundColor Cyan
Set-Location (Join-Path $root 'apps\desktop')
Invoke-Native 'the app' { npm run tauri dev }
