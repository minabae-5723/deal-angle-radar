# =============================================================
#  DART majorstock (5% rule) detail fetcher  (deal-angle-radar)
#  For each corp name passed (must exist in today's raw-*.json),
#  pulls recent large-holding reports: reporter, purpose, ratio.
#  NOTE: API returns oldest-first — take the LAST entries for recent.
#  NOTE: save as UTF-8 with BOM (PS 5.1 + Korean args).
#  Usage: powershell -File .\fetch-majorstock.ps1 -Names "가비아,한독" [-RawDate 2026-07-21]
#  Output: data\majorstock-{RawDate}.json
# =============================================================
param(
    [Parameter(Mandatory = $true)][string]$Names,
    [string]$RawDate = ''
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root
$cfgPath = Join-Path $root 'config.json'
if (-not (Test-Path $cfgPath)) { $cfgPath = Join-Path $root '..\reverent-dashboard\config.json' }
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$KEY = $cfg.DART_API_KEY
if (-not $RawDate) { $RawDate = (Get-Date).ToString('yyyy-MM-dd') }
$rawPath = Join-Path $root ('data\raw-' + $RawDate + '.json')
$raw = Get-Content $rawPath -Raw -Encoding UTF8 | ConvertFrom-Json

$out = [ordered]@{}
foreach ($n in ($Names -split ',')) {
    $n = $n.Trim()
    $s = $raw.signals | Where-Object { $_.corp_name -eq $n } | Select-Object -First 1
    if (-not $s) { Write-Host ("skip (not in raw): " + $n); continue }
    $r = Invoke-RestMethod ("https://opendart.fss.or.kr/api/majorstock.json?crtfc_key=$KEY&corp_code=" + $s.corp_code)
    if ($r.status -eq '000') {
        $out[$n] = $r.list | Select-Object -Last 4 | Select-Object rcept_no, rcept_dt, repror, stkqy_irds_rt, stkrt, stkrt_irds, report_resn
    } else {
        $out[$n] = @{ error = $r.status }
    }
    Start-Sleep -Milliseconds 200
}
$outFile = Join-Path $root ('data\majorstock-' + $RawDate + '.json')
$json = $out | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($outFile, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host ('Wrote ' + $outFile)
