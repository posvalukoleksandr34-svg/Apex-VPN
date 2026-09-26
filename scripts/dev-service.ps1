# Starts the Meridian service (meridiand) in the foreground as administrator,
# for development. Asks for elevation (UAC) if needed, then keeps the window
# open so you can watch the log. Stop it with Ctrl+C.
#
#   powershell -ExecutionPolicy Bypass -File scripts\dev-service.ps1
#
# Recovery: if the network is ever left blocked, run (as administrator)
#   target\debug\meridiand.exe reset-firewall

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell -Verb RunAs -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    exit
}

$exe = Join-Path $root 'target\debug\meridiand.exe'
$config = Join-Path $root 'dev\service.json'
$dll = Join-Path $root 'target\debug\wireguard.dll'
if (-not (Test-Path $exe)) { throw "Build first: cargo build -p vpn-daemon" }
if (-not (Test-Path $config)) { throw "Generate dev config first: npm run dev:keys -w server/api" }
if (-not (Test-Path $dll)) { Copy-Item (Join-Path $root 'vendor\wireguard-nt\bin\amd64\wireguard.dll') $dll }

Set-Location $root
Write-Host "Starting meridiand (Ctrl+C to stop; disconnect first so the kill switch releases)..." -ForegroundColor Cyan
& $exe foreground --config $config
