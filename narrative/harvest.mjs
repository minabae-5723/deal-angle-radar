// harvest.mjs — 네러티브 포착 엔진 (① 단계). 2-채널 + 증거 게이팅.
//
// 채널 A (asset_bias)   : insight-log · read-log  = "내가 읽은 것" → 확증편향 있음. 재확증에만 신뢰.
// 채널 B (asset_broad)  : weekly-report · morning-market · PPI 2×2 = 더 넓은 큐레이션/정량 신호.
// 채널 C (scout)        : narrative-scout.json = 독립 톱다운 웹리서치(권위 소스, 내 독서와 무관). 반(反)편향 핵심.
//
// 승격 게이팅: NEW 신호가 candidate 가 되려면 (a) PPI 가속 OR (b) ≥2개 서로 다른 소스 OR (c) scout 확증.
//   단일 편향채널의 빈도만으로는 candidate 안 됨 — "많이 읽은 것 ≠ 중요한 변화".
// 출력: data/narrative-harvest.json. 절대 narratives.json 자동수정 안 함. 승인은 사람이.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data");
const W2026 = "C:/Users/배미나/OneDrive - Reverent Partners Co., Ltd/Junior - 문서/General/Weekly/2026";

const SRC = [
  { key: "ppi",     channel: "broad", dir: "C:/Users/배미나/personal-dashboard/front-office/data/macro/ppi-notes", weight: 1.0 },
  { key: "weekly",  channel: "broad", dir: W2026 + "/weekly-report", weight: 1.0 },
  { key: "morning", channel: "broad", dir: W2026 + "/morning-market", weight: 0.7 },
  { key: "insight", channel: "bias",  dir: W2026 + "/insight-log", weight: 0.5 },
  { key: "readlog", channel: "bias",  dir: W2026 + "/read-log", weight: 0.5 }
];

const EMERGING = [
  { id: "power-semi", title: "전력반도체 (SiC/GaN)", emoji: "🔌", terms: ["전력반도체", "sic", "gan", "실리콘카바이드"] },
  { id: "shipbuilding", title: "조선 · 해양", emoji: "🚢", terms: ["조선", "선박", "lng운반선", "해양플랜트", "친환경선박", "암모니아추진"] },
  { id: "space-sat", title: "우주 · 위성", emoji: "🛰️", terms: ["위성", "우주", "발사체", "저궤도", "재사용로켓"] },
  { id: "nuclear-smr", title: "원자력 · SMR", emoji: "☢️", terms: ["smr", "소형모듈원자로", "원전", "원자력", "방사성폐기물"] },
  { id: "stablecoin-fintech", title: "스테이블코인 · 결제", emoji: "🪙", terms: ["스테이블코인", "stablecoin", "cbdc", "토큰증권", "sto"] },
  { id: "advanced-bio", title: "첨단바이오 (ADC/세포유전자)", emoji: "🧬", terms: ["adc", "세포유전자", "car-t", "유전자치료", "mrna"] },
  { id: "quantum", title: "양자 컴퓨팅", emoji: "⚛️", terms: ["양자", "quantum", "큐비트"] }
];

const read = p => fs.readFileSync(p, "utf8");
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
function corpusOf(dir, limit = 40) {
  if (!exists(dir)) return { text: "", n: 0 };
  const fs_ = fs.readdirSync(dir).filter(f => f.endsWith(".md")).sort().reverse().slice(0, limit);
  return { text: fs_.map(f => read(path.join(dir, f))).join("\n").toLowerCase(), n: fs_.length };
}

const reg = JSON.parse(read(path.join(DATA, "narratives.json")));
const themeKW = reg.themes.filter(t => t.status === "approved").map(t => ({
  id: t.id, title: t.title,
  kws: [...new Set((t.nodes || []).flatMap(n => n.keywords || []).concat(
    t.title.toLowerCase().replace(/[^가-힣a-z0-9 ]/g, " ").split(/\s+/)))]
    .map(s => s.toLowerCase()).filter(s => s.length >= 2)
}));

// ── 소스별 코퍼스 로드 ───────────────────────────────────────
const corpora = SRC.map(s => ({ ...s, ...corpusOf(s.dir) }));

// PPI 는 _index.json 요약을 별도 활용
let ppiItems = [];
const ppiIdx = SRC.find(s => s.key === "ppi").dir + "/_index.json";
if (exists(ppiIdx)) ppiItems = (JSON.parse(read(ppiIdx)).items || []);

function countHits(text, terms) { return terms.reduce((n, k) => n + (text.split(k).length - 1), 0); }

// ── 재확증(approved) : 채널별 히트 집계 ──────────────────────
const reinforced = {};
for (const t of themeKW) {
  const ev = [];
  for (const c of corpora) {
    if (!c.text) continue;
    const h = countHits(c.text, t.kws);
    if (h >= 3) ev.push(`${c.key}(${c.channel}): ${c.n}개 문서 키워드 ${h}회`);
  }
  // PPI 요약에서 테마 직접 언급
  for (const it of ppiItems) {
    const blob = `${it.title} ${it.theme} ${it.summary}`.toLowerCase();
    if (t.kws.some(k => blob.includes(k))) ev.push(`ppi(broad): ${it.month} "${(it.theme || it.title)}"`);
  }
  if (ev.length) reinforced[t.id] = ev;
}

// ── 신규 후보(EMERGING) : 증거 게이팅 ────────────────────────
const candMap = new Map();
for (const e of EMERGING) {
  const perSource = [];
  let ppiAccel = false;
  for (const c of corpora) {
    if (!c.text) continue;
    const h = countHits(c.text, e.terms);
    if (h > 0) perSource.push({ key: c.key, channel: c.channel, hits: h });
  }
  for (const it of ppiItems) {
    const blob = `${it.title} ${it.theme} ${it.summary}`.toLowerCase();
    if (e.terms.some(t => blob.includes(t))) { ppiAccel = true; perSource.push({ key: "ppi", channel: "broad", hits: 1, note: it.theme }); }
  }
  const distinctSources = new Set(perSource.map(p => p.key)).size;
  const broadHit = perSource.some(p => p.channel === "broad");
  // 게이팅: PPI 가속 OR ≥2 소스 OR broad 채널 포함
  const gated = ppiAccel || distinctSources >= 2 || broadHit;
  if (!perSource.length) continue;
  candMap.set(e.id, {
    id: e.id, title: e.title, emoji: e.emoji,
    score: perSource.reduce((n, p) => n + p.hits, 0),
    sources: perSource.map(p => `${p.key}:${p.hits}`),
    channels: [...new Set(perSource.map(p => p.channel))],
    distinctSources, ppiAccel,
    gate: gated ? "eligible" : "weak_single_channel",
    scout_verdict: null, scout_evidence: null
  });
}

// ── 채널 C: scout(독립 톱다운) 병합 ──────────────────────────
let scout = null;
if (exists(path.join(DATA, "narrative-scout.json"))) scout = JSON.parse(read(path.join(DATA, "narrative-scout.json")));
if (scout && Array.isArray(scout.candidates)) {
  for (const s of scout.candidates) {
    const cur = candMap.get(s.id) || { id: s.id, title: s.title, emoji: s.emoji || "🌱", score: 0, sources: [], channels: [], distinctSources: 0, ppiAccel: false, gate: "scout_only" };
    cur.scout_verdict = s.verdict || null;       // promote | hold | drop
    cur.scout_evidence = s.evidence || null;
    cur.supply_elasticity = s.supply_elasticity || null;
    cur.blindspot = !!s.blindspot;               // 자산엔 없는데 외부근거 강함
    if (!cur.channels.includes("scout")) cur.channels.push("scout");
    if (cur.gate !== "eligible" && (s.verdict === "promote")) cur.gate = "eligible";
    candMap.set(s.id, cur);
  }
}

function statusOf(c) {
  // scout 판정이 최우선(독립 톱다운 근거)
  if (c.scout_verdict === "drop") return "dropped";     // 대시보드 미노출
  if (c.scout_verdict === "hold") return "watch";
  if (c.scout_verdict === "promote") return "candidate";
  // scout 없으면 로컬 게이트
  return c.gate === "eligible" ? "candidate" : "watch";
}
const candidates = [...candMap.values()]
  .map(c => ({ ...c, status: statusOf(c) }))
  .sort((a, b) => (a.status === "candidate" ? 0 : 1) - (b.status === "candidate" ? 0 : 1)
    || (b.scout_verdict === "promote") - (a.scout_verdict === "promote") || b.score - a.score);

const out = {
  generated: reg.meta.generated,
  note: "2-채널+증거게이팅 포착. reinforced=approved 재확증. candidates=승격 대상(PPI가속/≥2소스/scout promote). watch=단일 편향채널만(승격 보류). scout=독립 톱다운(narrative-scout.json). 자동으로 narratives.json 반영 안 함.",
  channels: { bias: ["insight", "readlog"], broad: ["ppi", "weekly", "morning"], scout: exists(path.join(DATA, "narrative-scout.json")) },
  reinforced, candidates,
  scout_blindspots: scout?.blindspots || []
};
fs.writeFileSync(path.join(DATA, "narrative-harvest.json"), JSON.stringify(out, null, 2), "utf8");

console.log("narrative-harvest.json written  (scout.json:", !!scout, ")");
console.log("\n[재확증] approved ← 자산:");
for (const [id, ev] of Object.entries(reinforced)) console.log(`  · ${id.padEnd(18)} ${ev.length}건`);
console.log("\n[후보] 승격 대상 (게이팅 통과):");
for (const c of candidates.filter(c => c.status === "candidate")) console.log(`  🌱 ${c.emoji} ${c.title.padEnd(22)} score ${String(c.score).padStart(3)} · ${c.channels.join("+")} · gate ${c.gate}${c.scout_verdict ? " · scout:" + c.scout_verdict : ""}`);
console.log("\n[watch] 보류(hold/단일채널):");
for (const c of candidates.filter(c => c.status === "watch")) console.log(`  · ${c.emoji} ${c.title.padEnd(22)} ${c.scout_verdict ? "scout:hold" : "채널 " + c.channels.join("+")}`);
console.log("\n[dropped] scout drop — 제외:");
for (const c of candidates.filter(c => c.status === "dropped")) console.log(`  ✗ ${c.emoji} ${c.title.padEnd(22)} ${c.scout_evidence || ""}`);
