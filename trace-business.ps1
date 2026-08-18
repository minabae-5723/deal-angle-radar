# DART 사업내용 스크린 v2 — 제품·사업부 중심 추출 + 원문 캐시
#  - 원문 텍스트를 data\doccache\{corp}.txt 에 캐시 → 추출 로직 튜닝 시 재페치 불필요
#  - 제품 패턴 다중 매칭으로 실제 제품명 우선(일반 문구 배제)
#  출력: data\business-desc.json  { corp_code: {name, thesis, prod, desc, fit} }
#  Usage: -TopN 20 [-Refresh]  (Refresh=원문 캐시 무시하고 재페치)
param([int]$TopN = 20, [switch]$Refresh)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot; Set-Location $root
$cfgPath = Join-Path $root 'config.json'
if (-not (Test-Path $cfgPath)) { $cfgPath = Join-Path $root '..\reverent-dashboard\config.json' }
$KEY = (Get-Content $cfgPath -Raw | ConvertFrom-Json).DART_API_KEY
$cacheDir = Join-Path $root 'data\doccache'
if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory $cacheDir -Force | Out-Null }

$theses = (Get-Content 'data\theses.json' -Raw -Encoding UTF8 | ConvertFrom-Json).theses
$cand = Get-Content 'data\thesis-candidates.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$kwByThesis = @{}
foreach ($t in $theses) {
  $kw = @()
  foreach ($n in $t.nodes) { $kw += ($n.node -split '[·/,()\s]+') }
  $kw += ($t.title -split '[·/,()\s]+')
  $kwByThesis[$t.id] = ($kw | Where-Object { $_.Length -ge 2 } | Select-Object -Unique)
}

$JUNK = '영업활동|설립되|본사는|소재하고|미래전망|신기술사업금융|보고기간말|전략운영|재무적|영업부문|해당 여부|사업목적 현황|국제적|종속기업|일반사항'

function Get-LatestRcept($corp, $listed) {
  $ty = if ($listed) { 'A' } else { 'F' }
  $u = "https://opendart.fss.or.kr/api/list.json?crtfc_key=$KEY&corp_code=$corp&bgn_de=20240101&end_de=20261231&pblntf_ty=$ty&page_count=10"
  try { $j = Invoke-RestMethod $u -TimeoutSec 20 } catch { return $null }
  if ($j.status -ne '000') { return $null }
  $rep = $j.list | Where-Object { $_.report_nm -match '사업보고서|감사보고서' } | Select-Object -First 1
  if (-not $rep) { $rep = $j.list | Select-Object -First 1 }
  return $rep.rcept_no
}

function Get-DocText($corp, $listed) {
  $cache = Join-Path $cacheDir "$corp.txt"
  if ((Test-Path $cache) -and -not $Refresh) { return (Get-Content $cache -Raw -Encoding UTF8) }
  $rcept = Get-LatestRcept $corp $listed
  Start-Sleep -Milliseconds 220
  if (-not $rcept) { return $null }
  $zip = Join-Path $env:TEMP "bd_$rcept.zip"; $ext = Join-Path $env:TEMP "bd_$rcept"
  $u = "https://opendart.fss.or.kr/api/document.xml?crtfc_key=$KEY&rcept_no=$rcept"
  try { Invoke-WebRequest $u -OutFile $zip -UseBasicParsing -TimeoutSec 40 } catch { return $null }
  Start-Sleep -Milliseconds 220
  $b = [System.IO.File]::ReadAllBytes($zip)
  if ($b.Length -lt 4 -or $b[0] -ne 0x50 -or $b[1] -ne 0x4B) { Remove-Item $zip -Force -EA SilentlyContinue; return $null }
  if (Test-Path $ext) { Remove-Item $ext -Recurse -Force }
  Expand-Archive $zip -DestinationPath $ext -Force
  $txt = ''
  Get-ChildItem $ext -Filter *.xml | Sort-Object Name | Select-Object -First 3 | ForEach-Object {
    $raw = [System.IO.File]::ReadAllBytes($_.FullName)
    try { $s = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($raw) } catch { $s = [System.Text.Encoding]::GetEncoding(949).GetString($raw) }
    $txt += ' ' + ($s -replace '<[^>]+>', ' ' -replace '\s+', ' ')
  }
  Remove-Item $zip -Force -EA SilentlyContinue; Remove-Item $ext -Recurse -Force -EA SilentlyContinue
  # 원문 캐시(앞 20k만 — 제품·사업 개요는 앞부분)
  $txt = $txt.Substring(0, [Math]::Min(20000, $txt.Length))
  [System.IO.File]::WriteAllText($cache, $txt, [System.Text.UTF8Encoding]::new($false))
  return $txt
}

function Clean-Phrase($p) {
  $p = ($p -replace '\s+', ' ').Trim()
  $p = $p -replace '^(주식회사|다음의|아래|현재)\s*', ''
  $p = $p -replace '^\d{4}년[^가-힣]*?(자로|이후|에|부터)?\s*', ''
  return $p.Trim()
}

function Extract-Product($txt) {
  if (-not $txt) { return '' }
  # 제품·사업 문장 후보: 회사/당사/지배기업 뒤 제조·생산·판매·개발이 포함된 절
  $ms = [regex]::Matches($txt, '(?:당사|회사|지배기업|연결회사)\S{0,2}\s*(.{4,70}?(?:제조|생산|판매|개발|공급)\S{0,6})')
  $cands = @()
  foreach ($m in $ms) { $cands += (Clean-Phrase $m.Groups[1].Value) }
  # "주요/주력 제품 : X"
  foreach ($m in [regex]::Matches($txt, '(?:주요|주력)\s*제품\S{0,4}\s*([가-힣A-Za-z0-9()\-, ·]{3,46})')) { $cands += (Clean-Phrase $m.Groups[1].Value) }
  # 1순위: 제품/제조 포함 + 비junk
  foreach ($p in $cands) { if ($p.Length -ge 3 -and $p.Length -le 60 -and $p -notmatch $JUNK -and $p -match '제조|생산|판매|제품|개발|소재|장비|부품') { return $p } }
  # 2순위: 비junk
  foreach ($p in $cands) { if ($p.Length -ge 3 -and $p.Length -le 60 -and $p -notmatch $JUNK) { return $p } }
  return ''
}

$out = @{}
if ((Test-Path 'data\business-desc.json') -and -not $Refresh) {
  try { $prev = Get-Content 'data\business-desc.json' -Raw -Encoding UTF8 | ConvertFrom-Json
        $prev.PSObject.Properties | ForEach-Object { $out[$_.Name] = $_.Value } } catch {}
}
foreach ($t in $theses) {
  $g = $cand.$($t.id); if (-not $g) { continue }
  $rows = @($g.rows | Select-Object -First $TopN)
  Write-Host ("== " + $t.id + " " + $t.title + " ==") -ForegroundColor Cyan
  foreach ($r in $rows) {
    if ($out.ContainsKey($r.corp_code) -and -not $Refresh) { continue }
    $txt = Get-DocText $r.corp_code $r.listed
    if (-not $txt) { Write-Host ("  " + $r.name + " : (공시없음)") -ForegroundColor DarkGray; continue }
    $prod = Extract-Product $txt
    # desc = 원문에서 사업 개요 한 문장(참고용)
    $dm = [regex]::Match($txt, '(당사|회사|지배기업)[는은][^.]{5,120}?(영위|제조|판매|개발)')
    $desc = if ($dm.Success) { (Clean-Phrase $dm.Value) } else { '' }
    $fit = $false
    foreach ($k in $kwByThesis[$t.id]) { if (($prod + ' ' + $desc) -like "*$k*") { $fit = $true; break } }
    $out[$r.corp_code] = @{ name = $r.name; thesis = $t.id; prod = $prod; desc = $desc; fit = $fit }
    Write-Host ("  " + ($(if ($fit) { '[FIT] ' } else { '      ' })) + $r.name.PadRight(16) + " : " + $prod)
  }
}
$out | ConvertTo-Json -Depth 5 | Out-File 'data\business-desc.json' -Encoding utf8
Write-Host ("`n-> data\business-desc.json (" + $out.Count + " companies)") -ForegroundColor Green
