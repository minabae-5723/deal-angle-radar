// build-narrative.mjs — 네러티브 레지스트리 → 롱리스트 생성
// narratives.json(정의) × funding-panel(외감 유니버스) × funding-pool(니즈 오버레이)
//   → data/narrative-pool.json (대시보드가 읽는 산출물)
// 마스터파일/풀이 갱신되면 재실행만 하면 재무·니즈가 자동 refresh 됨.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data");
const load = f => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));

const reg = load("narratives.json");
let harvest = null;
try { harvest = load("narrative-harvest.json"); } catch { /* harvest 미실행 시 스킵 */ }
const panel = load("funding-panel.json").rows;
const poolRaw = load("funding-pool.json");
const pool = poolRaw.rows || poolRaw;
const poolByCode = new Map(pool.map(p => [p.corp_code, p]));

const MIN_REV = 300; // 억
const lastRev = r => { if (!r) return null; for (let i = r.length - 1; i >= 0; i--) if (r[i] != null && r[i] > 0) return r[i]; return null; };
const lastVal = a => { if (!a) return null; for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
const cagr = r => { const v = (r || []).filter(x => x != null && x > 0); if (v.length < 3) return null; return Math.pow(v[v.length - 1] / v[0], 1 / (v.length - 1)) - 1; };
const norm = s => (s || "").replace(/\(주\)|주식회사|㈜|\s/g, "");

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

const outThemes = reg.themes.map(t => {
  const seen = new Map(); // corp_code -> row
  const pickNames = new Set((t.picks || []).map(p => norm(p.name)));
  // 1) 노드 매칭
  for (const node of (t.nodes || [])) {
    for (const c of matchNode(node)) {
      if (seen.has(c.corp_code)) continue;
      const isPick = pickNames.has(norm(c.name));
      seen.set(c.corp_code, enrich(c, node.node, isPick));
    }
  }
  // 2) picks 명시 조회 (노드 매칭에서 누락된 것 보강 + note 부착)
  for (const p of (t.picks || [])) {
    const c = resolvePick(p.name);
    if (!c) { seen.set("MISS:" + p.name, { name: p.name + " (패널밖)", node: "pick", pick: true, note: p.note || null, rev: null, inPool: false }); continue; }
    const cur = seen.get(c.corp_code);
    if (cur) { cur.pick = true; cur.note = p.note || cur.note; }
    else seen.set(c.corp_code, enrich(c, "pick", true, p.note));
  }
  // 정렬: pick 우선 → need desc → 매출 desc
  const longlist = [...seen.values()].sort((a, b) =>
    (b.pick - a.pick) || ((b.need ?? -1) - (a.need ?? -1)) || ((b.rev || 0) - (a.rev || 0)));
  const nodeCounts = (t.nodes || []).map(n => ({ node: n.node, n: matchNode(n).length }));
  return { ...t, longlist, nodeCounts,
    harvest_reinforce: harvest ? (harvest.reinforced?.[t.id] || []) : [],
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
      stats: { total: 0, inPool: 0, unlisted: 0 }
    });
  }
}

const out = {
  meta: { ...reg.meta, built: reg.meta.generated, themes: outThemes.length,
    approved: outThemes.filter(t => t.status === "approved").length,
    candidates: outThemes.filter(t => t.status === "candidate").length },
  themes: outThemes
};
fs.writeFileSync(path.join(DATA, "narrative-pool.json"), JSON.stringify(out, null, 2), "utf8");
console.log(`narrative-pool.json written — ${outThemes.length} themes`);
for (const t of outThemes) console.log(`  ${t.emoji} ${t.title.padEnd(24)} longlist ${String(t.stats.total).padStart(3)} (pool ${t.stats.inPool}, 비상장 ${t.stats.unlisted}) [${t.status}]`);
