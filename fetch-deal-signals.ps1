# =============================================================
#  DART deal-angle signal fetcher  (deal-angle-radar standalone)
#
#  Pulls last-N-days filings from DART OpenAPI list.json:
#    pblntf_ty=B (major issue reports: merger, CB/EB/BW, rights issue...)
#    pblntf_ty=D (equity ownership: 5% rule, insider, tender offer, proxy)
#  Classifies each filing into a signal category with a weight (1-5),
#  dedupes corrected re-filings, and writes a raw candidate JSON for
#  the /deal-angle screening session (Claude) to analyze.
#
#  NOTE: file must be saved as UTF-8 *with BOM* — PS 5.1 otherwise reads
#  Korean literals as cp949 garbage. Re-save with BOM after any edit.
#
#  Output: data\raw-YYYY-MM-DD.json  (dates in KST)
#  Usage :
#    powershell -ExecutionPolicy Bypass -File .\fetch-deal-signals.ps1
#    powershell ... -EndDate 20260721 -Days 3
# =============================================================
param(
    [string]$EndDate = '',   # YYYYMMDD, default = today KST
    [int]$Days = 0           # lookback days; 0 = auto (Mon/Sun->3, Sat->2, else 1)
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

# DART API key: own config.json first, fallback to reverent-dashboard's
$cfgPath = Join-Path $root 'config.json'
if (-not (Test-Path $cfgPath)) { $cfgPath = Join-Path $root '..\reverent-dashboard\config.json' }
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$KEY = $cfg.DART_API_KEY
if (-not $KEY) { Write-Host 'FATAL: DART_API_KEY missing in config.json' -ForegroundColor Red; exit 1 }

if (-not $EndDate) { $EndDate = (Get-Date).ToString('yyyyMMdd') }
$end = [datetime]::ParseExact($EndDate, 'yyyyMMdd', $null)
if ($Days -le 0) {
    switch ($end.DayOfWeek) {
        'Monday' { $Days = 3 }   # cover Fri + weekend
        'Sunday' { $Days = 2 }
        default  { $Days = 1 }
    }
}
$bgn = $end.AddDays(-$Days)
$bgn_de = $bgn.ToString('yyyyMMdd')
Write-Host ("Window: $bgn_de ~ $EndDate  (" + $Days + 'd lookback)') -ForegroundColor Green

function Fetch-List([string]$Ty) {
    $all = @(); $page = 1
    do {
        $url = "https://opendart.fss.or.kr/api/list.json?crtfc_key=$KEY&bgn_de=$bgn_de&end_de=$EndDate&pblntf_ty=$Ty&page_no=$page&page_count=100"
        $r = Invoke-RestMethod $url
        if ($r.status -eq '013') { break }          # no data
        if ($r.status -ne '000') { throw "DART error $($r.status): $($r.message)" }
        $all += $r.list
        $totalPage = [int]$r.total_page
        $page++
        Start-Sleep -Milliseconds 150
    } while ($page -le $totalPage)
    return $all
}

Write-Host 'Fetching type B (major issue reports)...' -ForegroundColor Cyan
$listB = Fetch-List 'B'
Write-Host ('  ' + $listB.Count + ' filings')
Write-Host 'Fetching type D (equity disclosures)...' -ForegroundColor Cyan
$listD = Fetch-List 'D'
Write-Host ('  ' + $listD.Count + ' filings')

# --- classification rules: first match wins (ordered) --------
$rules = @(
    @{ cat = 'TENDER';        w = 5; pat = '공개매수' },
    @{ cat = 'MERGER';        w = 5; pat = '회사합병결정|회사분할결정|분할합병|주식교환.이전결정' },
    @{ cat = 'STAKE_TRADE';   w = 5; pat = '타법인주식및출자증권양수결정|타법인주식및출자증권양도결정' },
    @{ cat = 'BIZ_TRANSFER';  w = 4; pat = '영업양수결정|영업양도결정' },
    @{ cat = 'DISTRESS';      w = 4; pat = '회생절차|파산|해산사유|부도발생|영업정지' },
    @{ cat = 'RIGHTS_ISSUE';  w = 4; pat = '유상증자결정' },
    @{ cat = 'MEZZANINE';     w = 4; pat = '전환사채권발행결정|신주인수권부사채권발행결정|교환사채권발행결정' },
    @{ cat = 'CAP_REDUC';     w = 4; pat = '감자결정' },
    @{ cat = 'BLOCK_5PCT';    w = 4; pat = '주식등의대량보유상황보고서\(일반\)' },
    @{ cat = 'PROXY';         w = 3; pat = '의결권대리행사권유' },
    @{ cat = 'BUYBACK_DISP';  w = 3; pat = '자기주식처분결정' },
    @{ cat = 'INSIDER_PLAN';  w = 3; pat = '임원ㆍ주요주주특정증권등거래계획보고서' },
    @{ cat = 'CB_TRADE';      w = 3; pat = '주권관련사채권양수결정|주권관련사채권양도결정|자기전환사채|만기전취득' },
    @{ cat = 'BUYBACK_ACQ';   w = 2; pat = '자기주식취득결정' },
    @{ cat = 'ASSET_SALE';    w = 2; pat = '유형자산양도결정|유형자산양수결정' },
    @{ cat = 'BLOCK_SHORT';   w = 1; pat = '주식등의대량보유상황보고서\(약식\)' },
    @{ cat = 'INSIDER';       w = 1; pat = '임원ㆍ주요주주특정증권등소유상황보고서' },
    @{ cat = 'TRUST';         w = 1; pat = '자기주식취득신탁' },
    @{ cat = 'FREE_ISSUE';    w = 1; pat = '무상증자결정' }
)

function Classify($item) {
    $nm = $item.report_nm
    foreach ($r in $rules) {
        if ($nm -match $r.pat) {
            return [pscustomobject]@{
                category   = $r.cat
                weight     = $r.w
                corp_name  = $item.corp_name
                corp_code  = $item.corp_code
                stock_code = $item.stock_code
                market     = $item.corp_cls    # Y=KOSPI K=KOSDAQ N=KONEX E=etc
                report_nm  = $nm
                corrected  = ($nm -match '^\[')
                rcept_no   = $item.rcept_no
                rcept_dt   = $item.rcept_dt
                url        = ('https://dart.fss.or.kr/dsaf001/main.do?rcpNo=' + $item.rcept_no)
            }
        }
    }
    return $null
}

$signals = @()
foreach ($it in ($listB + $listD)) {
    $c = Classify $it
    if ($c) { $signals += $c }
}

# --- dedupe: same corp + category -> keep latest rcept_no ----
$signals = $signals | Group-Object { $_.corp_code + '|' + $_.category } | ForEach-Object {
    $_.Group | Sort-Object rcept_no -Descending | Select-Object -First 1
}

# sort: weight desc, then KOSPI/KOSDAQ first, then rcept_no desc
$mktRank = @{ 'Y' = 0; 'K' = 1; 'N' = 2; 'E' = 3 }
$signals = $signals | Sort-Object @{e = { - $_.weight }}, @{e = { $mktRank[[string]$_.market] }}, @{e = { $_.rcept_no }; Descending = $true }

$summary = $signals | Group-Object category | Sort-Object Count -Descending | ForEach-Object {
    [pscustomobject]@{ category = $_.Name; count = $_.Count }
}

$outDir = Join-Path $root 'data'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory $outDir | Out-Null }
$outFile = Join-Path $outDir ('raw-' + $end.ToString('yyyy-MM-dd') + '.json')

$payload = [pscustomobject]@{
    generated  = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    window     = @{ bgn = $bgn_de; end = $EndDate; days = $Days }
    counts     = @{ typeB = $listB.Count; typeD = $listD.Count; classified = $signals.Count }
    summary    = $summary
    signals    = $signals
}
$json = $payload | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($outFile, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host ('Wrote ' + $outFile + '  (' + $signals.Count + ' signals)') -ForegroundColor Green
$summary | Format-Table -AutoSize
