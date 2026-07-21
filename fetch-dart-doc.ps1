# =============================================================
#  DART original filing text extractor  (deal-angle-radar)
#
#  Downloads the full original filing (document.xml API, zip),
#  strips XML tags, and writes plain text for Claude to read.
#  Universal fallback when a typed detail API is unavailable —
#  works for any rcept_no (merger terms, CB conditions, 5% report
#  purpose-of-holding, counterparty names, etc).
#
#  NOTE: save as UTF-8 with BOM (PS 5.1 + Korean literals).
#
#  Output: data\docs\{rcept_no}.txt
#  Usage : powershell -ExecutionPolicy Bypass -File .\fetch-dart-doc.ps1 -RceptNo 20260720000333
# =============================================================
param(
    [Parameter(Mandatory = $true)][string]$RceptNo
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

$cfgPath = Join-Path $root 'config.json'
if (-not (Test-Path $cfgPath)) { $cfgPath = Join-Path $root '..\reverent-dashboard\config.json' }
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$KEY = $cfg.DART_API_KEY
if (-not $KEY) { Write-Host 'FATAL: DART_API_KEY missing in config.json' -ForegroundColor Red; exit 1 }

$docDir = Join-Path $root 'data\docs'
if (-not (Test-Path $docDir)) { New-Item -ItemType Directory $docDir -Force | Out-Null }

$zipPath = Join-Path $env:TEMP ('dart_' + $RceptNo + '.zip')
$extDir  = Join-Path $env:TEMP ('dart_' + $RceptNo)
$url = "https://opendart.fss.or.kr/api/document.xml?crtfc_key=$KEY&rcept_no=$RceptNo"
Invoke-WebRequest $url -OutFile $zipPath -UseBasicParsing

# API returns an error XML (not zip) on bad key/rcept_no — detect by magic bytes
$bytes = [System.IO.File]::ReadAllBytes($zipPath)
if ($bytes.Length -lt 4 -or $bytes[0] -ne 0x50 -or $bytes[1] -ne 0x4B) {
    Write-Host ('DART error: ' + [System.Text.Encoding]::UTF8.GetString($bytes)) -ForegroundColor Red
    exit 1
}

if (Test-Path $extDir) { Remove-Item $extDir -Recurse -Force }
Expand-Archive $zipPath -DestinationPath $extDir -Force

$out = New-Object System.Text.StringBuilder
Get-ChildItem $extDir -Filter *.xml | Sort-Object Name | ForEach-Object {
    # encoding varies by filing (UTF-8 vs EUC-KR) — try strict UTF-8, fallback cp949
    $raw = [System.IO.File]::ReadAllBytes($_.FullName)
    try {
        $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
        $txt = $strictUtf8.GetString($raw)
    } catch {
        $txt = [System.Text.Encoding]::GetEncoding(949).GetString($raw)
    }
    # strip tags, collapse whitespace, keep line structure around table cells
    $txt = $txt -replace '</(TD|TH|TR|P|TABLE|TITLE|SUBTITLE)>', "`n"
    $txt = $txt -replace '<[^>]+>', ' '
    $txt = $txt -replace '&cr;|&nbsp;|&amp;', ' '
    $lines = $txt -split "`n" | ForEach-Object { ($_ -replace '\s+', ' ').Trim() } | Where-Object { $_ -ne '' }
    [void]$out.AppendLine(($lines -join "`n"))
}

$outFile = Join-Path $docDir ($RceptNo + '.txt')
[System.IO.File]::WriteAllText($outFile, $out.ToString(), [System.Text.UTF8Encoding]::new($false))
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Remove-Item $extDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ('Wrote ' + $outFile) -ForegroundColor Green
