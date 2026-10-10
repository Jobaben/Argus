param([int]$TimeoutMinutes = 40)
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddMinutes($TimeoutMinutes)
$previous = ''
do {
    $statusText = & node docs/argus/shadow-feeder/refresh-evidence.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Evidence capture failed. Re-diagnose before retrying.' }
    $status = $statusText | ConvertFrom-Json
    $summary = "instances=$($status.instances) runs=$($status.runs) answers=$($status.answered) matches=$($status.matches) collector=$($status.watcher) verified=$($status.verified)"
    if ($summary -ne $previous) { Write-Output "$([DateTime]::UtcNow.ToString('o')) $summary"; $previous=$summary }
    if ($status.verified) { exit 0 }
    if ([DateTime]::UtcNow -lt $deadline) { Start-Sleep -Seconds 30 }
} while ([DateTime]::UtcNow -lt $deadline)
Write-Output 'Observation window ended; evidence remains pending and the Argus feeder continues.'
exit 2
