param([switch]$Foreground)
$ErrorActionPreference = 'Stop'
$projectRoot = 'C:\GIT\Argus\.worktrees\argus-local'
$logRoot = 'C:\GIT\Argus\docs\argus\shadow-feeder'
$listenerProbe = [System.Net.Sockets.TcpClient]::new()
try {
    $connected = $listenerProbe.ConnectAsync('127.0.0.1', 7777).Wait(1500)
    if ($connected -and $listenerProbe.Connected) {
        throw 'Argus is already listening on port 7777. Inspect its collection settings before restarting.'
    }
} catch {
    if ($_.Exception.Message -like 'Argus is already*') { throw }
} finally {
    $listenerProbe.Dispose()
}
$env:ARGUS_HOST = '127.0.0.1'
$env:ARGUS_PORT = '7777'
$env:ARGUS_AGENT = 'claude'
$env:ARGUS_DECISIONS = 'on'
$env:ARGUS_DECISIONS_H2_COLLECT = 'on'
$env:ARGUS_DECISIONS_H1_COLLECT = 'off'
$env:ARGUS_ANALYSIS = 'on'
$env:ARGUS_DECISIONS_H2_PROBE_RATE = '1'
$env:ARGUS_DECISIONS_H2_RESIDUAL_RATE = '0.5'
$env:ARGUS_DECISIONS_H2_MAX_CALLS_PER_DAY = '96'
$env:ARGUS_DECISIONS_H2_MIN_INTERVAL_MINUTES = '12'
$env:ARGUS_DECISIONS_H2_MAX_USD_PER_DAY = '10'
$env:ARGUS_DECISIONS_H2_MODEL = 'haiku'
if ($Foreground) {
    Push-Location $projectRoot
    try { & node server/dist/index.js } finally { Pop-Location }
} else {
    $process = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList 'server/dist/index.js' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput "$logRoot/server.stdout.log" -RedirectStandardError "$logRoot/server.stderr.log" -PassThru
    @{pid=$process.Id; startedAt=[DateTime]::UtcNow.ToString('o'); source=$projectRoot} | ConvertTo-Json | Set-Content "$logRoot/server-process.json"
    Write-Output "Argus launched with H2 collection; PID $($process.Id)"
}
