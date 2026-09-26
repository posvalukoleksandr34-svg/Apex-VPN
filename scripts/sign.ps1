# Authenticode-signs one file for a release build. Tauri calls this for the
# app and each installer (bundle.windows.signCommand); prepare-bundle.ps1
# calls it for the service and CLI.
#
# Configure with environment variables (nothing is stored in the repo):
#   MERIDIAN_SIGN_PFX, MERIDIAN_SIGN_PFX_PASSWORD
#       a .pfx certificate file and its password (e.g. CI secrets)
#   MERIDIAN_SIGN_THUMBPRINT
#       SHA-1 thumbprint of a certificate in the Windows certificate store
#       (EV certificates on a hardware token or HSM work this way)
#   MERIDIAN_SIGN_TIMESTAMP_URL   RFC 3161 server (default: DigiCert)
#   MERIDIAN_SIGNTOOL             signtool.exe path (default: newest Windows SDK)
#   MERIDIAN_RELEASE=1            fail instead of skipping when no certificate is configured
#
# Without a certificate (development) it prints that it skipped and succeeds.

param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) { throw "sign.ps1: no such file: $Path" }
$name = Split-Path -Leaf $Path

$pfx = $env:MERIDIAN_SIGN_PFX
$thumbprint = $env:MERIDIAN_SIGN_THUMBPRINT
if (-not $pfx -and -not $thumbprint) {
    if ($env:MERIDIAN_RELEASE -eq '1') { throw "sign.ps1: MERIDIAN_RELEASE=1 but no certificate is configured (MERIDIAN_SIGN_PFX or MERIDIAN_SIGN_THUMBPRINT)" }
    [Console]::Error.WriteLine("sign.ps1: not signing $name (no certificate configured)")
    exit 0
}

$signtool = $env:MERIDIAN_SIGNTOOL
if (-not $signtool) {
    $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $signtool = Get-ChildItem -Path $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signtool -or -not (Test-Path $signtool)) { throw "sign.ps1: signtool.exe not found; install the Windows SDK or set MERIDIAN_SIGNTOOL" }

$timestamp = if ($env:MERIDIAN_SIGN_TIMESTAMP_URL) { $env:MERIDIAN_SIGN_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }
$common = @('sign', '/fd', 'sha256', '/tr', $timestamp, '/td', 'sha256', '/d', 'Meridian VPN')
$certArgs = if ($pfx) { @('/f', $pfx, '/p', $env:MERIDIAN_SIGN_PFX_PASSWORD) } else { @('/sha1', $thumbprint) }

# Timestamp servers have bad minutes; retry before failing the build.
for ($attempt = 1; $attempt -le 3; $attempt++) {
    & $signtool @common @certArgs $Path | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
    if ($attempt -eq 3) { throw "sign.ps1: signing $name failed (signtool exit $LASTEXITCODE)" }
    Start-Sleep -Seconds (5 * $attempt)
}
& $signtool verify /pa /q $Path | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sign.ps1: $name was signed but does not verify" }
[Console]::Error.WriteLine("sign.ps1: signed $name")
