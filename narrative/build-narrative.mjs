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

const PATCH_MODE = !panelFile;
const prevPool = PATCH_MODE ? tryLoad("narrative-pool.json") : null;
const prevThemes = new Map((prevPool?.themes || []).map(t => [t.id, t]));

const MIN_REV = 300; // 억
const lastRev = r => { if (!r) return null; for (let i = r.length - 1; i >= 0; i--) if (r[i] != null && r[i] > 0) return r[i]; return null; };
const lastVal = a => { if (!a) return null; for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
const cagr = r => { const v = (r || []).filter(x => x != null && x > 0); if (v.length < 3) return null; return Math.pow(v[v.length - 1] / v[0], 1 / (v.length - 1)) - 1; };
const norm = s => (s || "").replace(/\(주\)|주식회사|㈜|\s/g, "");

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
  const cand = panel.filter(c => c.name && norm(c.name).includes(norm(q)));
  cand.sort((a, b) => (lastRev(b.rev) || 0) - (lastRev(a.rev) || 0));
  return cand[0] || null;
}

// ── 패치 모드 (funding-pool 만) ──────────────────────────────────────────────
// pool row → longlist row 변환. 패널 시계열이 없어 opm=op/rev, cagr3=풀 사전값 사용.
function enrichFromPool(p, node, isPick, pickNote) {
  return {
    name: p.name, corp: p.corp_code, ksic: p.div || null, node,
    rev: Math.round(p.rev || 0), opm: (p.op != null && p.rev) ? p.op / p.rev : (p.ebitda_m ?? null),
    cagr3: p.cagr3 ?? null, nd: p.net_debt ?? null,
    listed: p.listed, need: p.need, pri: p.priority,
    status: p.status, type: p.type, angle: p.angle_primary,
    inPool: true, pick: isPick, note: pickNote || null
  };
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
  const nq = norm(q);
  const fromPrev = (prevRows || []).find(r => r.name && norm(r.name).includes(nq));
  if (fromPrev) return { kind: "prev", row: fromPrev };
  const cand = pool.filter(p => p.name && norm(p.name).includes(nq));
  cand.sort((a, b) => (b.rev || 0) - (a.rev || 0));
  if (cand[0]) return { kind: "pool", row: cand[0] };
  return null;
}

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
    if (!c) { seen.set("MISS:" + p.name, { name: p.name + " (패널밖)", node: "pick", pick: true, note: p.note || null, rev: null, inPool: false }); continue; }
    const cur = seen.get(c.corp_code);
    if (cur) { cur.pick = true; cur.note = p.note || cur.note; }
    else seen.set(c.corp_code, enrich(c, "pick", true, p.note));
  }
  const longlist = [...seen.values()].sort((a, b) =>
    (b.pick - a.pick) || ((b.need ?? -1) - (a.need ?? -1)) || ((b.rev || 0) - (a.rev || 0)));
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
    const key = r.corp || "MISS:" + r.name;
    seen.set(key, { ...r });
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
    if (hit.kind === "prev") { hit.row.pick = true; hit.row.note = pk.note || hit.row.note; }
    else {
      const cur = seen.get(hit.row.corp_code);
      if (cur) { cur.pick = true; cur.note = pk.note || cur.note; }
      else seen.set(hit.row.corp_code, enrichFromPool(hit.row, "pick", true, pk.note));
    }
  }
  const longlist = [...seen.values()].sort((a, b) =>
    (b.pick - a.pick) || ((b.need ?? -1) - (a.need ?? -1)) || ((b.rev || 0) - (a.rev || 0)));
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
fs.writeFileSync(path.join(DATA, "narrative-pool.json"), JSON.stringify(out, null, 2), "utf8");
console.log(`narrative-pool.json written — ${outThemes.length} themes${PATCH_MODE ? " [PATCH MODE: 외감 패널 없음 — 기존 빌드 보존 + 풀 증분. 전체 반영은 패널 보유 머신에서 재실행]" : ""}`);
for (const t of outThemes) console.log(`  ${t.emoji} ${(t.title || "").padEnd(24)} longlist ${String(t.stats.total).padStart(3)} (pool ${t.stats.inPool}, 비상장 ${t.stats.unlisted}) [${t.status}]${t.community ? ` 💬${t.community.count}` : ""}`);
