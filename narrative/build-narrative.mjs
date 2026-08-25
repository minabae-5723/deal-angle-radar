// build-narrative.mjs — 네러티브 레지스트리 → 롱리스트 생성
// narratives.json(정의) × funding-panel(외감 유니버스) × funding-pool(니즈 오버레이)
//   → data/narrative-pool.json (대시보드가 읽는 산출물)
// 마스터파일/풀이 갱신되면 재실행만 하면 재무·니즈가 자동 refresh 됨.
//
// 패치 모드: funding-panel.json(외감 41,409 패널, 로컬 전용)이 없는 환경에서는
//   기존 narrative-pool.json 의 빌드 결과를 보존한 채 funding-pool(1,443사)만으로
//   신규 테마·신규 노드를 증분 매칭한다. 외감 전체 반영은 패널 보유 머신에서 재실행.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data");
const load = f => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
const tryLoad = f => { try { return load(f); } catch { return null; } };

const reg = load("narratives.json");
const harvest = tryLoad("narrative-harvest.json");
const community = tryLoad("community.json");   // comments-harvest.mjs 산출 (giscus Discussions)
const panelFile = tryLoad("funding-panel.json");
const poolRaw = load("funding-pool.json");
const pool = poolRaw.rows || poolRaw;
const poolByCode = new Map(pool.map(p => [p.corp_code, p]));

// fs2025.json — DART 2025 감사보고서 파싱 결과(2,227사, funding-pool 1,443사의 상위집합).
// 매출·영업이익뿐 아니라 부채비율·순차입금·EBITDA 까지 있어 롱리스트 재무 공백을 크게 줄인다.
// funding-pool 은 '자금니즈 진단'(need/status/type)이 붙어 있고 fs2025 는 '재무 원본'이므로,
// 니즈는 pool 에서, 재무 수치는 fs2025 에서 가져오는 2단 오버레이로 쓴다.
const fs2025 = tryLoad("fs2025.json");
const fsByCode = new Map();
const fsByName = new Map();
for (const [code, v] of Object.entries((fs2025 && fs2025.byCorp) || {})) {
  if (!v || v.status === "NOT_FOUND" || v.rev == null) continue;
  fsByCode.set(code, v);
  const k = (v.name || "").replace(/\(주\)|주식회사|㈜|\s/g, "");
  if (k && !fsByName.has(k)) fsByName.set(k, { ...v, corp_code: code });
}

const PATCH_MODE = !panelFile;
const prevPool = PATCH_MODE ? tryLoad("narrative-pool.json") : null;
const prevThemes = new Map((prevPool?.themes || []).map(t => [t.id, t]));

const MIN_REV = 300; // 억
const lastRev = r => { if (!r) return null; for (let i = r.length - 1; i >= 0; i--) if (r[i] != null && r[i] > 0) return r[i]; return null; };
const lastVal = a => { if (!a) return null; for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
const cagr = r => { const v = (r || []).filter(x => x != null && x > 0); if (v.length < 3) return null; return Math.pow(v[v.length - 1] / v[0], 1 / (v.length - 1)) - 1; };
const norm = s => (s || "").replace(/\(주\)|주식회사|㈜|\s/g, "");
// 약칭·영문 표기 별칭 — DART 등록명과 통용명이 다른 경우만 최소한으로 둔다.
const PICK_ALIAS = {
  "SNT다이내믹스": "에스엔티다이내믹스", "SNT모티브": "에스엔티모티브",
  "KGETS": "케이지이티에스", "ISC": "아이에스씨", "KCTC": "케이씨티씨",
  "HPSP": "에이치피에스피", "LSK글로벌PS": "엘에스케이글로벌파마서비스",
};
// pick 매칭은 '정확 일치'만 허용한다. 부분 문자열 매칭은 케이프→케이프라이드,
// 미소→미소찬 처럼 엉뚱한 회사에 실명 note 를 붙여 롱리스트를 오염시킨다. (2026-08-24)
const pickKeys = (q) => { const n = norm(q); const a = PICK_ALIAS[n] || PICK_ALIAS[q]; return a ? [n, norm(a)] : [n]; };
const sameCo = (name, q) => { const n = norm(name); return pickKeys(q).some(k => n === k); };

// ── 풀 모드 (외감 패널) ──────────────────────────────────────────────────────
const panel = panelFile ? panelFile.rows : [];

function enrich(c, node, isPick, pickNote) {
  const p = poolByCode.get(c.corp_code);
  return {
    name: c.name, corp: c.corp_code, ksic: c.ind_code, node,
    rev: Math.round(lastRev(c.rev) || 0), opm: lastVal(c.opm), cagr3: cagr(c.rev), nd: lastVal(c.net_debt),
    listed: p ? p.listed : null, need: p ? p.need : null, pri: p ? p.priority : null,
    status: p ? p.status : null, type: p ? p.type : null, angle: p ? p.angle_primary : null,
    inPool: !!p, pick: isPick, note: pickNote || null
  };
}

function matchNode(node) {
  const kw = (node.keywords || []).map(s => s.toLowerCase());
  const ksic = node.ksic || [];
  const exc = (node.exclude || []).map(s => s.toLowerCase());
  const out = [];
  for (const c of panel) {
    if (!c.name) continue;
    const nm = c.name.toLowerCase(), code = String(c.ind_code || "");
    if (!(kw.some(k => nm.includes(k)) || ksic.some(k => code.startsWith(k)))) continue;
    if (exc.some(e => nm.includes(e))) continue;
    const rev = lastRev(c.rev);
    if (!rev || rev < MIN_REV) continue;
    out.push(c);
  }
  return out;
}

function resolvePick(q) {
  const cand = panel.filter(c => c.name && sameCo(c.name, q));
  cand.sort((a, b) => (lastRev(b.rev) || 0) - (lastRev(a.rev) || 0));
  return cand[0] || null;
}

// ── 패치 모드 (funding-pool 만) ──────────────────────────────────────────────
// pool row → longlist row 변환. 패널 시계열이 없어 opm=op/rev, cagr3=풀 사전값 사용.
function enrichFromPool(p, node, isPick, pickNote) {
  return {
    name: p.name, corp: p.corp_code, ksic: p.div || null, node,
    rev: Math.round(p.rev || 0), opm: (p.op != null && p.rev) ? p.op / p.rev : (p.ebitda_m ?? null),
    cagr3: p.cagr3 ?? null, nd: p.net_debt ?? null, year: p.latest_year ?? null,
    listed: p.listed, need: p.need, pri: p.priority,
    status: p.status, type: p.type, angle: p.angle_primary,
    inPool: true, pick: isPick, note: pickNote || null
  };
}

// funding-pool 은 가장 최신 재무(2025 감사보고서 다수 포함). 롱리스트 행에 corp_code 로
// 매칭되는 pool 재무를 덮어써 2025 를 반영한다 (패널 2024 시계열보다 우선).
function overlayPoolFinancials(row) {
  const p = row.corp && poolByCode.get(row.corp);
  if (!p) return row;
  if (p.rev != null) row.rev = Math.round(p.rev);
  const opm = (p.op != null && p.rev) ? p.op / p.rev : (p.ebitda_m ?? null);
  if (opm != null) row.opm = opm;
  if (p.cagr3 != null) row.cagr3 = p.cagr3;
  if (p.net_debt != null) row.nd = p.net_debt;
  if (p.debt_ratio != null) row.debt_ratio = p.debt_ratio;   // 부채비율 (배수, ×100=%)
  if (p.nd_ebitda != null) row.nd_ebitda = p.nd_ebitda;      // 순부채/EBITDA (배수)
  if (p.latest_year != null) row.year = p.latest_year;
  return row;
}

// 2025 감사보고서 재무를 덮어쓴다. pool 오버레이 다음에 호출 — pool 은 니즈 진단 값(need/status)이
// 붙어 있지만 재무는 fs2025 가 더 넓고(2,227사) 부채비율·순차입금·EBITDA 까지 포함한다.
function overlayFs2025(row) {
  const f = row.corp && fsByCode.get(row.corp);
  if (!f) return row;
  if (f.rev != null) row.rev = Math.round(f.rev);
  if (f.op != null && f.rev) row.opm = f.op / f.rev;
  else if (f.ebitda_m != null) row.opm = f.ebitda_m;
  if (f.net_debt != null) row.nd = f.net_debt;
  if (f.debt_ratio != null) row.debt_ratio = f.debt_ratio;
  if (f.net_debt != null && f.ebitda) row.nd_ebitda = f.net_debt / f.ebitda;
  if (f.listed != null && row.listed == null) row.listed = f.listed;
  if (f.year != null) row.year = f.year;
  // 전년 매출이 있으면 1년 성장률이라도 채운다(3y CAGR 없는 행의 공백 방지).
  if (row.cagr3 == null && f.prev && f.prev.rev > 0 && f.rev > 0) row.cagr3 = f.rev / f.prev.rev - 1;
  return row;
}

// fs2025 에만 있는 실명 pick → 재무가 붙은 행으로 생성 (기존에는 '(패널밖)' 무재무 행이었다)
function rowFromFs(f, node, note) {
  const row = {
    name: f.name, corp: f.corp_code, ksic: null, node,
    rev: Math.round(f.rev || 0), opm: (f.op != null && f.rev) ? f.op / f.rev : (f.ebitda_m ?? null),
    cagr3: (f.prev && f.prev.rev > 0 && f.rev > 0) ? (f.rev / f.prev.rev - 1) : null,
    nd: f.net_debt ?? null, year: f.year ?? null, listed: f.listed ?? null,
    need: null, pri: null, status: null, type: null, angle: null,
    inPool: false, pick: true, note: note || null
  };
  if (f.debt_ratio != null) row.debt_ratio = f.debt_ratio;
  if (f.net_debt != null && f.ebitda) row.nd_ebitda = f.net_debt / f.ebitda;
  return row;
}

function matchNodePool(node) {
  const kw = (node.keywords || []).map(s => s.toLowerCase());
  const exc = (node.exclude || []).map(s => s.toLowerCase());
  const out = [];
  if (!kw.length) return out;
  for (const p of pool) {
    if (!p.name) continue;
    const nm = p.name.toLowerCase();
    if (!kw.some(k => nm.includes(k))) continue;
    if (exc.some(e => nm.includes(e))) continue;
    if (!p.rev || p.rev < MIN_REV) continue;
    out.push(p);
  }
  return out;
}

function resolvePickPatch(q, prevRows) {
  // 재무가 붙은 기존 행이 있으면 그것이 최우선. 재무 없는 '(패널밖)' 자리표시자는
  // pool·fs2025 에서 실제 재무를 찾아 대체한다(자리표시자는 호출부가 제거).
  const fromPrev = (prevRows || []).find(r => r.name && sameCo(r.name.replace(" (패널밖)", ""), q));
  if (fromPrev && fromPrev.rev != null) return { kind: "prev", row: fromPrev };
  const stale = fromPrev || null;
  const cand = pool.filter(p => p.name && sameCo(p.name, q));
  cand.sort((a, b) => (b.rev || 0) - (a.rev || 0));
  if (cand[0]) return { kind: "pool", row: cand[0], stale };
  // funding-pool(니즈 진단 1,443사)에 없어도 2025 감사보고서(2,227사)에는 있을 수 있다.
  for (const k of pickKeys(q)) { const f = fsByName.get(k); if (f) return { kind: "fs", row: f, stale }; }
  return fromPrev ? { kind: "prev", row: fromPrev } : null;
}

// 우선순위 랭크 — 벤치마크 역추적으로 특정된 소싱 대상이 상단, 정량 매칭 잔여는 후순위(제외하지 않음).
// 비상장타겟(직접 소싱) > 검증필요(재무·지분 확인) > PE보유(선례·경쟁) > 상장벤치마크(밸류 기준, 직접 매수 아님)
// > 발굴리드(작업 지시서) > 노드 키워드·업종 매칭만 걸린 잔여 행.
const KIND_RANK = { "비상장타겟": 5, "상장타겟": 5, "검증필요": 4, "PE보유": 3, "상장벤치마크": 2, "발굴리드": 1 };
const rank = (r) => KIND_RANK[r.kind] || (r.pick ? 1 : 0);

// ── 테마 빌드 ────────────────────────────────────────────────────────────────
function buildFull(t) {
  const seen = new Map();
  const pickNames = new Set((t.picks || []).map(p => norm(p.name)));
  for (const node of (t.nodes || [])) {
    for (const c of matchNode(node)) {
      if (seen.has(c.corp_code)) continue;
      seen.set(c.corp_code, enrich(c, node.node, pickNames.has(norm(c.name))));
    }
  }
  for (const p of (t.picks || [])) {
    const c = resolvePick(p.name);
    if (!c) {
      let f = null; for (const k of pickKeys(p.name)) { f = fsByName.get(k); if (f) break; }
      if (f) { seen.set(f.corp_code, rowFromFs(f, "pick", p.note)); continue; }
      seen.set("MISS:" + p.name, { name: p.name + " (패널밖)", node: "pick", pick: true, note: p.note || null, rev: null, inPool: false }); continue;
    }
    const cur = seen.get(c.corp_code);
    if (cur) { cur.pick = true; cur.note = p.note || cur.note; }
    else seen.set(c.corp_code, enrich(c, "pick", true, p.note));
  }
  for (const r of seen.values()) { overlayPoolFinancials(r); overlayFs2025(r); }
  // pick 의 구분(kind: 상장벤치마크/비상장타겟/검증필요/PE보유/발굴리드)을 롱리스트 행에 부착
  { const pk = new Map((t.picks || []).map(p => [norm(p.name), p.kind]).filter(x => x[1]));
    for (const r of seen.values()) {
      const k = pk.get(norm((r.name || "").replace(" (패널밖)", ""))); if (k) r.kind = k;
      // 직접 소싱 대상인데 상장이 확인되면 '상장타겟'으로 자동 교정 — 접근 경로가 다르다(공개매수·블록·구주).
      if (r.kind === "비상장타겟" && r.listed === true) r.kind = "상장타겟";
    } }
  const longlist = [...seen.values()].sort((a, b) =>
    (rank(b) - rank(a)) || ((b.need ?? -1) - (a.need ?? -1)) || ((b.rev || 0) - (a.rev || 0)));
  const nodeCounts = (t.nodes || []).map(n => ({ node: n.node, n: matchNode(n).length }));
  return { longlist, nodeCounts };
}

function buildPatch(t) {
  const prev = prevThemes.get(t.id);
  const seen = new Map();
  const curNodes = new Set((t.nodes || []).map(n => n.node));
  for (const r of (prev?.longlist || [])) {
    // 레지스트리에서 삭제·개명된 노드의 행은 승계하지 않음 (노드 정리가 곧 롱리스트 정리)
    if (r.node && r.node !== "pick" && !curNodes.has(r.node)) continue;
    // '(패널밖)' 자리표시자는 승계하지 않는다 — 재무가 없는 빈 행이고, 여전히 미해결이면
    // 아래 pick 루프가 다시 만든다. 승계하면 ① 재무를 찾아도 중복으로 남고
    // ② 레지스트리에서 빠진 실명이 영구히 잔류한다. (2026-08-25)
    if ((r.name || "").includes("(패널밖)")) continue;
    // 키워드 정리(exclude 보강·오탐 제거)가 승계 행에도 반영되도록 — 노드 exclude 와
    // 테마별 exclude_names 를 승계 시점에 다시 적용한다. 키워드를 지워도 이미 매칭된 행은
    // 그대로 남기 때문에, 정리가 배포본에 전파되지 않는 문제가 있었다. (2026-08-25)
    { const nm = (r.name || "").toLowerCase();
      const exc = (t.nodes || []).flatMap(n => (n.exclude || []).map(e => e.toLowerCase()));
      if (exc.some(e => nm.includes(e))) continue;
      const dropN = (t.exclude_names || []).map(norm);
      if (dropN.includes(norm(r.name))) continue; }
    const key = r.corp || "MISS:" + r.name;
    // pick·note·kind 는 매 빌드마다 레지스트리에서 다시 붙인다(과거 오탐 잔류 방지).
    seen.set(key, { ...r, pick: false, note: null, kind: undefined });
  }
  const pickNames = new Set((t.picks || []).map(p => norm(p.name)));
  // 신규 노드·키워드의 풀 매칭만 증분 (외감 전체는 패널 머신에서)
  for (const node of (t.nodes || [])) {
    for (const p of matchNodePool(node)) {
      if (seen.has(p.corp_code)) continue;
      seen.set(p.corp_code, enrichFromPool(p, node.node, pickNames.has(norm(p.name))));
    }
  }
  const prevRows = [...seen.values()];
  for (const pk of (t.picks || [])) {
    const hit = resolvePickPatch(pk.name, prevRows);
    if (!hit) {
      const key = "MISS:" + pk.name;
      if (!seen.has(key)) seen.set(key, { name: pk.name + " (패널밖)", node: "pick", pick: true, note: pk.note || null, rev: null, inPool: false });
      continue;
    }
    // 재무 없는 자리표시자를 실제 재무 행으로 교체하는 경우 원래 행 제거
    if (hit.stale) seen.delete(hit.stale.corp || "MISS:" + hit.stale.name);
    if (hit.kind === "prev") { hit.row.pick = true; hit.row.note = pk.note || hit.row.note; }
    else if (hit.kind === "fs") {
      const cur = seen.get(hit.row.corp_code);
      if (cur) { cur.pick = true; cur.note = pk.note || cur.note; }
      else seen.set(hit.row.corp_code, rowFromFs(hit.row, "pick", pk.note));
    }
    else {
      const cur = seen.get(hit.row.corp_code);
      if (cur) { cur.pick = true; cur.note = pk.note || cur.note; }
      else seen.set(hit.row.corp_code, enrichFromPool(hit.row, "pick", true, pk.note));
    }
  }
  for (const r of seen.values()) { overlayPoolFinancials(r); overlayFs2025(r); }
  // pick 의 구분(kind: 상장벤치마크/비상장타겟/검증필요/PE보유/발굴리드)을 롱리스트 행에 부착
  { const pk = new Map((t.picks || []).map(p => [norm(p.name), p.kind]).filter(x => x[1]));
    for (const r of seen.values()) {
      const k = pk.get(norm((r.name || "").replace(" (패널밖)", ""))); if (k) r.kind = k;
      // 직접 소싱 대상인데 상장이 확인되면 '상장타겟'으로 자동 교정 — 접근 경로가 다르다(공개매수·블록·구주).
      if (r.kind === "비상장타겟" && r.listed === true) r.kind = "상장타겟";
    } }
  const longlist = [...seen.values()].sort((a, b) =>
    (rank(b) - rank(a)) || ((b.need ?? -1) - (a.need ?? -1)) || ((b.rev || 0) - (a.rev || 0)));
  // nodeCounts: 이전 빌드 값 유지 + 신규 노드는 풀 매칭 수로 대체
  const prevCounts = new Map((prev?.nodeCounts || []).map(n => [n.node, n.n]));
  const nodeCounts = (t.nodes || []).map(n => ({ node: n.node, n: prevCounts.get(n.node) ?? matchNodePool(n).length }));
  return { longlist, nodeCounts };
}

const outThemes = reg.themes.map(t => {
  const { longlist, nodeCounts } = PATCH_MODE ? buildPatch(t) : buildFull(t);
  const comm = community?.byTheme?.[t.id] || null;
  return { ...t, longlist, nodeCounts,
    harvest_reinforce: harvest ? (harvest.reinforced?.[t.id] || []) : [],
    community: comm,
    stats: {
      total: longlist.length,
      inPool: longlist.filter(r => r.inPool).length,
      unlisted: longlist.filter(r => r.listed === false).length
    } };
});

// 하베스트 후보(미테마화 신규 시그널)를 candidate 로 편입 — 대시보드 후보영역에 노출
if (harvest && harvest.candidates) {
  for (const c of harvest.candidates) {
    if (c.status !== "candidate") continue;             // watch(단일 편향채널)는 편입 안 함
    if (reg.themes.some(t => t.id === c.id)) continue;  // 이미 정식 테마면 스킵
    const ch = (c.channels || []).join("+");
    const ev = c.scout_verdict
      ? `scout ${c.scout_verdict}${c.blindspot ? "·블라인드스팟" : ""} · ${c.scout_evidence || ""} [채널 ${ch}]`
      : `자산 하베스트 score ${c.score} · 채널 ${ch} · gate ${c.gate} — 승인 대기`;
    outThemes.push({
      id: c.id, title: c.title, emoji: c.emoji, status: "candidate",
      provenance: { source: "harvest", captured: reg.meta.generated, evidence: ev },
      catalog: {}, kpi: {}, longlist: [], nodeCounts: [], harvest_reinforce: [],
      community: community?.byTheme?.[c.id] || null,
      stats: { total: 0, inPool: 0, unlisted: 0 }
    });
  }
}

const out = {
  meta: { ...reg.meta, built: reg.meta.generated, themes: outThemes.length,
    approved: outThemes.filter(t => t.status === "approved").length,
    candidates: outThemes.filter(t => t.status === "candidate").length,
    build_mode: PATCH_MODE ? "patch (funding-pool only — 외감 패널 미보유 환경)" : "full",
    community_synced: community?.meta?.synced || null },
  themes: outThemes
};
// 배포 전송량 절감을 위해 무들여쓰기(minified)로 기록 — 1MB급 파일이라 ~35% 절약
fs.writeFileSync(path.join(DATA, "narrative-pool.json"), JSON.stringify(out), "utf8");
console.log(`narrative-pool.json written — ${outThemes.length} themes${PATCH_MODE ? " [PATCH MODE: 외감 패널 없음 — 기존 빌드 보존 + 풀 증분. 전체 반영은 패널 보유 머신에서 재실행]" : ""}`);
for (const t of outThemes) console.log(`  ${t.emoji} ${(t.title || "").padEnd(24)} longlist ${String(t.stats.total).padStart(3)} (pool ${t.stats.inPool}, 비상장 ${t.stats.unlisted}) [${t.status}]${t.community ? ` 💬${t.community.count}` : ""}`);
