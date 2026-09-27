# Builds the service (apexyd) and CLI (apexy) in release mode and
# stages them as Tauri sidecars: apps/desktop/src-tauri/binaries/<name>-<target triple>.exe.
# The installer places them next to the app as apexyd.exe / apexy.exe.
# Signed here when signing is configured (see sign.ps1).
#
# Runs from `npm run release -w apps/desktop` (beforeBuildCommand in
# tauri.release.conf.json). Build-time configuration baked into the service:
#   APEXY_API_URL      https://… account API
#   APEXY_RELAY_KEYS   "keyid:BASE64,…" Ed25519 keys that may sign the server list
# With APEXY_RELEASE=1 both (and a signing certificate) are required.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($env:APEXY_RELEASE -eq '1') {
    if (-not ($env:APEXY_API_URL -like 'https://*')) { throw 'APEXY_RELEASE=1 needs APEXY_API_URL=https://…' }
    if (-not $env:APEXY_RELAY_KEYS) { throw 'APEXY_RELEASE=1 needs APEXY_RELAY_KEYS (the service would trust no server list)' }
} else {
    if (-not $env:APEXY_RELAY_KEYS) { [Console]::Error.WriteLine('prepare-bundle: APEXY_RELAY_KEYS not set; this build trusts no server list unless service.json provides keys') }
}

$triple = ((& rustc -vV) | Select-String '^host: (.+)$').Matches[0].Groups[1].Value
& cargo build --release -p vpn-daemon -p vpn-cli --manifest-path (Join-Path $root 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }

$dest = Join-Path $root 'apps\desktop\src-tauri\binaries'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($name in 'apexyd', 'apexy') {
    $target = Join-Path $dest "$name-$triple.exe"
    Copy-Item -Force (Join-Path $root "target\release\$name.exe") $target
    & (Join-Path $PSScriptRoot 'sign.ps1') $target
    if ($LASTEXITCODE -ne 0) { throw "signing $name failed" }
}
[Console]::Error.WriteLine("prepare-bundle: staged apexyd and apexy for $triple")
