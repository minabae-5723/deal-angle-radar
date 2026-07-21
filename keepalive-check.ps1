# Deal Angle Radar server health check (scheduled task: DealAngleRadar-KeepAlive, every 5min).
# If localhost:8878 is down, kill only THIS repo's serve.ps1 zombies and restart hidden.
$url = "http://localhost:8878/index.html"
try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { exit 0 }
} catch {}
# server dead — kill zombies (match this repo's serve.ps1 only, not other dashboards')
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*deal-angle-radar*serve.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
# $PSScriptRoot avoids a hardcoded Korean-path literal (cp949 mangling risk in PS 5.1)
$serve = Join-Path $PSScriptRoot 'serve.ps1'
Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$serve`"" -WindowStyle Hidden
