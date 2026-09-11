# Telga — start both servers for local testing.
#
# Right-click this file and choose "Run with PowerShell".
#
# It opens two windows, one per server, because each has to stay open while it
# runs. Closing a window stops that server.
#
#   Telga app     http://127.0.0.1:4310
#   Admin panel   http://127.0.0.1:4820
#
# Anything already listening on those ports is stopped first. That matters: a
# second server on a taken port exits quietly, and you would carry on testing
# whatever was already there. That has happened.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$db = Join-Path $root 'telga.sqlite'

Write-Host ''
Write-Host '  Telga — local test' -ForegroundColor Cyan
Write-Host '  ------------------'

if (-not (Test-Path $db)) {
    Write-Host "  No database at $db" -ForegroundColor Red
    Write-Host '  Run the migrate and provision commands first. Ask Claude for them.'
    Read-Host '  Press Enter to close'
    exit 1
}

# --- stop anything already serving --------------------------------------
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'merchant-pos|operations-console' }

if ($running) {
    foreach ($p in $running) {
        try { Stop-Process -Id $p.ProcessId -Force; Write-Host "  stopped an old server (pid $($p.ProcessId))" -ForegroundColor DarkYellow }
        catch { }
    }
    Start-Sleep -Seconds 2
}

# --- start each in its own window ----------------------------------------
$posArgs = "apps/merchant-pos/dist/cli.js --db `"$db`" --merchant shop_one --device till_one --operator op_one --port 4310"
$consoleArgs = "apps/operations-console/dist/cli.js --db `"$db`" --port 4820 --single-factor true --deposit-account `"TELGA-TEST-0000`""

Start-Process powershell -ArgumentList @(
    '-NoExit', '-Command',
    "Set-Location '$root'; Write-Host 'TELGA APP  ->  http://127.0.0.1:4310' -ForegroundColor Green; node $posArgs"
)

Start-Process powershell -ArgumentList @(
    '-NoExit', '-Command',
    "Set-Location '$root'; Write-Host 'ADMIN PANEL  ->  http://127.0.0.1:4820' -ForegroundColor Green; node $consoleArgs"
)

# --- wait until both actually answer -------------------------------------
Write-Host ''
Write-Host '  starting...' -NoNewline

function Test-Up([string]$url) {
    try { $null = Invoke-WebRequest $url -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop; return $true }
    catch {
        # A redirect or a 4xx still means something is listening and serving,
        # which is what we are waiting for. Only a refused connection means no.
        if ($_.Exception.Response) { return $true }
        return $false
    }
}

$ok = $false
foreach ($i in 1..30) {
    Start-Sleep -Seconds 1
    Write-Host '.' -NoNewline
    if ((Test-Up 'http://127.0.0.1:4310/activate') -and (Test-Up 'http://127.0.0.1:4820/login')) { $ok = $true; break }
}
Write-Host ''

if (-not $ok) {
    Write-Host ''
    Write-Host '  One of them did not start. Look at the two windows that opened —' -ForegroundColor Red
    Write-Host '  the reason is printed there.' -ForegroundColor Red
    Read-Host '  Press Enter to close'
    exit 1
}

Write-Host ''
Write-Host '  Both running.' -ForegroundColor Green
Write-Host ''
Write-Host '    Telga app      http://127.0.0.1:4310'
Write-Host '    Admin panel    http://127.0.0.1:4820'
Write-Host ''
Write-Host '  TRAINING MODE - no real money moves.' -ForegroundColor DarkGray
Write-Host '  Leave the two windows open. Closing one stops that server.' -ForegroundColor DarkGray
Write-Host ''

Start-Process 'http://127.0.0.1:4310'
Start-Process 'http://127.0.0.1:4820'

Read-Host '  Press Enter to close this window (the servers keep running)'
