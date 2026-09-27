# Loads KEY=value lines from an env file into this PowerShell session
# (comments and blank lines are skipped). For the release build:
#
#   . .\scripts\load-env.ps1 env\production\desktop-build.env
#   npm run release -w apps/desktop

param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Path)) { throw "No such file: $Path" }
$names = @()
foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') {
        Set-Item -Path "env:$($Matches[1])" -Value $Matches[2]
        $names += $Matches[1]
    }
}
# Names only: the values may be secrets.
Write-Host "Loaded: $($names -join ', ')"
