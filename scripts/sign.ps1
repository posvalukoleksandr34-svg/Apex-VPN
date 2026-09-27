# Authenticode-signs one file for a release build. Tauri calls this for the
# app and each installer (bundle.windows.signCommand); prepare-bundle.ps1
# calls it for the service and CLI.
#
# Configure with environment variables (nothing is stored in the repo):
#   APEXY_SIGN_PFX, APEXY_SIGN_PFX_PASSWORD
#       a .pfx certificate file and its password (e.g. CI secrets)
#   APEXY_SIGN_THUMBPRINT
#       SHA-1 thumbprint of a certificate in the Windows certificate store
#       (EV certificates on a hardware token or HSM work this way)
#   APEXY_SIGN_TIMESTAMP_URL   RFC 3161 server (default: DigiCert)
#   APEXY_SIGNTOOL             signtool.exe path (default: newest Windows SDK)
#   APEXY_RELEASE=1            fail instead of skipping when no certificate is configured
#
# Without a certificate (development) it prints that it skipped and succeeds.

param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) { throw "sign.ps1: no such file: $Path" }
$name = Split-Path -Leaf $Path

$pfx = $env:APEXY_SIGN_PFX
$thumbprint = $env:APEXY_SIGN_THUMBPRINT
if (-not $pfx -and -not $thumbprint) {
    if ($env:APEXY_RELEASE -eq '1') { throw "sign.ps1: APEXY_RELEASE=1 but no certificate is configured (APEXY_SIGN_PFX or APEXY_SIGN_THUMBPRINT)" }
    [Console]::Error.WriteLine("sign.ps1: not signing $name (no certificate configured)")
    exit 0
}

$signtool = $env:APEXY_SIGNTOOL
if (-not $signtool) {
    $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $signtool = Get-ChildItem -Path $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signtool -or -not (Test-Path $signtool)) { throw "sign.ps1: signtool.exe not found; install the Windows SDK or set APEXY_SIGNTOOL" }

$timestamp = if ($env:APEXY_SIGN_TIMESTAMP_URL) { $env:APEXY_SIGN_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }
$common = @('sign', '/fd', 'sha256', '/tr', $timestamp, '/td', 'sha256', '/d', 'Apexy VPN')
$certArgs = if ($pfx) { @('/f', $pfx, '/p', $env:APEXY_SIGN_PFX_PASSWORD) } else { @('/sha1', $thumbprint) }

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
