# Kill switch under unexpected service termination: does any traffic leave
# the device outside the tunnel when apexyd dies without cleaning up?
#
#   powershell -ExecutionPolicy Bypass -File scripts\validate-killswitch.ps1
#
# Asks for elevation. Uses the installed service if there is one (Windows
# restarts it via its recovery actions), otherwise the development build
# (target\debug, dev\service.json), which it restarts itself. Needs a signed-in,
# enrolled device and the default kill switch ("on while connected" or
# "always on").
#
# Steps: note the real exit IP → connect, note the VPN exit IP → hard-kill
# apexyd (TerminateProcess, no cleanup) → probe for 12 s: HTTPS, DNS to a
# resolver outside the tunnel, raw TCP; check the persistent WFP filters →
# let the service come back and check it reconnects → disconnect and check
# the internet is back. Writes dev\killswitch-report.json.
#
# Safety: if anything is left blocking at the end, it runs `apexyd reset-firewall`.

$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell -Verb RunAs -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    exit
}

$root = Split-Path -Parent $PSScriptRoot
$installed = [bool](Get-Service -Name ApexyVPN -ErrorAction SilentlyContinue)
if ($installed) {
    $svcPath = (Get-CimInstance Win32_Service -Filter "Name='ApexyVPN'").PathName -replace '^"([^"]+)".*$', '$1' -replace ' run-service$', ''
    $dir = Split-Path -Parent $svcPath
    $cli = Join-Path $dir 'apexy.exe'
    $daemon = $svcPath
} else {
    $cli = Join-Path $root 'target\debug\apexy.exe'
    $daemon = Join-Path $root 'target\debug\apexyd.exe'
}
$providerKey = '{6d657269-6469-616e-7766-700000000001}'
$report = [ordered]@{ started = (Get-Date).ToString('o'); mode = $(if ($installed) { 'installed service' } else { 'development build' }); steps = @(); leaks = @(); result = 'incomplete' }

function Step($name, $ok, $detail) {
    $script:report.steps += [ordered]@{ step = $name; ok = $ok; detail = "$detail" }
    $mark = if ($ok) { 'PASS' } else { 'FAIL' }
    $color = if ($ok) { 'Green' } else { 'Red' }
    Write-Host ("[{0}] {1}: {2}" -f $mark, $name, $detail) -ForegroundColor $color
}

function State {
    try { (& $cli --json status 2>$null | Out-String | ConvertFrom-Json).state } catch { $null }
}

function ExitIp($timeoutSec = 3) {
    try { (Invoke-WebRequest -Uri 'https://api.ipify.org' -UseBasicParsing -TimeoutSec $timeoutSec).Content.Trim() } catch { $null }
}

# Right after connecting, the first HTTPS request can be slow (DNS through
# the tunnel, TLS to a distant server): give it a few tries.
function ExitIpSoon($seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) { $ip = ExitIp 5; if ($ip) { return $ip }; Start-Sleep -Milliseconds 500 }
    return $null
}

function TcpOpen($target, $port) {
    $c = New-Object System.Net.Sockets.TcpClient
    try { return $c.ConnectAsync($target, $port).Wait(1500) -and $c.Connected } catch { return $false } finally { $c.Dispose() }
}

function DnsOutside {
    # 8.8.8.8 is not the tunnel's resolver: the kill switch must drop this.
    try { $null = Resolve-DnsName -Name 'example.com' -Server 8.8.8.8 -DnsOnly -QuickTimeout -ErrorAction Stop; return $true } catch { return $false }
}

function OurFilters {
    $file = Join-Path $env:TEMP "apexy-wfp-$PID.xml"
    & netsh wfp show filters file=$file | Out-Null
    $count = ([regex]::Matches((Get-Content -Raw $file), [regex]::Escape($providerKey), 'IgnoreCase')).Count
    Remove-Item $file -ErrorAction SilentlyContinue
    return $count
}

function WaitFor($seconds, [scriptblock]$cond) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 500 }
    return $false
}

try {
    if (-not (Test-Path $cli)) { throw "CLI not found at $cli" }
    $s = State
    if (-not $s) { throw 'The Apexy VPN service is not running. Start it first (scripts\dev-service.ps1 or the installed service).' }
    if ($s -ne 'disconnected') { & $cli disconnect | Out-Null; $null = WaitFor 15 { (State) -eq 'disconnected' } }

    $realIp = ExitIp
    Step 'baseline' ([bool]$realIp) "exit IP without VPN: $realIp"
    $report.realIp = $realIp

    & $cli connect | Out-Null
    $connected = WaitFor 30 { (State) -eq 'connected' }
    $vpnIp = ExitIpSoon 20
    Step 'connect' ($connected -and $vpnIp -and $vpnIp -ne $realIp) "state connected: $connected; exit IP through VPN: $vpnIp"
    $report.vpnIp = $vpnIp
    if (-not $connected) { throw 'could not connect; nothing to test' }

    $proc = Get-Process -Name apexyd -ErrorAction Stop | Select-Object -First 1
    Stop-Process -Id $proc.Id -Force
    $killedAt = Get-Date
    Step 'terminate' $true "killed apexyd (pid $($proc.Id)) without cleanup"

    Start-Sleep -Milliseconds 300
    $filters = OurFilters
    Step 'filters survive' ($filters -gt 0) "$filters Apexy VPN WFP filters present right after the crash"

    # Probe for a fixed window (short timeouts, so the network isn't held
    # longer than needed), then let the service come back.
    $probeUntil = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $probeUntil) {
        $ip = ExitIp 2
        $dns = DnsOutside
        $tcp = TcpOpen '1.1.1.1' 443
        $st = State
        # A leak: our real address seen outside, DNS answered by a resolver
        # outside the tunnel (blocked in every state), or any connection
        # while the tunnel isn't up.
        $leak = ($ip -and $ip -eq $realIp) -or $dns -or ($tcp -and $st -ne 'connected')
        $probe = [ordered]@{ t = [math]::Round(((Get-Date) - $killedAt).TotalSeconds, 1); exitIp = $ip; dnsOutsideAnswered = $dns; tcp1111 = $tcp; state = $st; leak = $leak }
        $report.leaks += $probe
        Write-Host ("  t+{0,4}s  exit IP: {1,-16} DNS outside tunnel: {2,-5} TCP 1.1.1.1:443: {3,-5} service: {4}" -f $probe.t, $(if ($ip) { $ip } else { 'blocked' }), $dns, $tcp, $(if ($st) { $st } else { 'down' }))
    }
    $leaked = @($report.leaks | Where-Object { $_.leak }).Count
    Step 'no leak while down' ($leaked -eq 0) "$leaked of $($report.leaks.Count) probes reached the internet outside the tunnel"

    if (-not $installed -and -not (Get-Process -Name apexyd -ErrorAction SilentlyContinue)) {
        Start-Process -FilePath $daemon -ArgumentList @('foreground', '--config', (Join-Path $root 'dev\service.json')) -WorkingDirectory $root
    }
    $back = WaitFor 45 { (State) -eq 'connected' }
    $afterIp = ExitIpSoon 20
    Step 'recovers' ($back -and $afterIp -eq $vpnIp) "service back and reconnected: $back; exit IP: $afterIp"

    & $cli disconnect | Out-Null
    $null = WaitFor 15 { (State) -eq 'disconnected' }
    $finalIp = ExitIp
    Step 'released' ($finalIp -eq $realIp) "after disconnect the exit IP is $finalIp"

    $report.result = if (@($report.steps | Where-Object { -not $_.ok }).Count -eq 0) { 'PASS' } else { 'FAIL' }
} catch {
    Step 'error' $false $_.Exception.Message
    $report.result = 'FAIL'
} finally {
    if (-not (ExitIp)) {
        Write-Host 'Network still blocked: clearing Apexy VPN firewall filters.' -ForegroundColor Yellow
        & $daemon reset-firewall | Out-Null
        $report.resetFirewall = $true
    }
    $out = Join-Path $root 'dev\killswitch-report.json'
    New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
    $report | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $out
    Write-Host ""
    Write-Host "Result: $($report.result)   (report: $out)" -ForegroundColor $(if ($report.result -eq 'PASS') { 'Green' } else { 'Red' })
}
