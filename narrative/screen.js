// screen.js — 즉석 조회 헬퍼 (build-narrative.mjs 의 로직을 CLI 로)
//   node screen.js --names "성림첨단산업,노바텍"   회사 직접 조회(니즈 오버레이 포함)
//   node screen.js <theme-node.json>              {theme, nodes:[{node,keywords,ksic,exclude}]} 노드 조회
const path = require("path");
const DATA = path.join(__dirname, "..", "data");
const panel = require(path.join(DATA, "funding-panel.json")).rows;
const poolRaw = require(path.join(DATA, "funding-pool.json"));
const pool = poolRaw.rows || poolRaw;
const poolByCode = new Map(pool.map(p => [p.corp_code, p]));

const lastRev = r => { if (!r) return null; for (let i = r.length - 1; i >= 0; i--) if (r[i] != null && r[i] > 0) return r[i]; return null; };
const lastVal = a => { if (!a) return null; for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
const cagr = r => { const v = (r || []).filter(x => x != null && x > 0); if (v.length < 3) return null; return Math.pow(v[v.length - 1] / v[0], 1 / (v.length - 1)) - 1; };
const norm = s => (s || "").replace(/\(주\)|주식회사|㈜|\s/g, "");
const MIN_REV = 300;
const fmtPct = x => x == null ? "  -  " : (x * 100).toFixed(0).padStart(4) + "%";

function enrich(c) {
  const p = poolByCode.get(c.corp_code);
  return { name: c.name, ksic: c.ind_code, rev: Math.round(lastRev(c.rev) || 0), opm: lastVal(c.opm), cagr3: cagr(c.rev),
    listed: p ? p.listed : null, need: p ? p.need : null, pri: p ? p.priority : null, status: p ? p.status : null, type: p ? p.type : null, inPool: !!p };
}
function matchNode(node) {
  const kw = (node.keywords || []).map(s => s.toLowerCase()), ksic = node.ksic || [], exc = (node.exclude || []).map(s => s.toLowerCase());
  const seen = new Set(), out = [];
  for (const c of panel) {
    if (!c.name) continue;
    const nm = c.name.toLowerCase(), code = String(c.ind_code || "");
    if (!(kw.some(k => nm.includes(k)) || ksic.some(k => code.startsWith(k)))) continue;
    if (exc.some(e => nm.includes(e))) continue;
    const rev = lastRev(c.rev); if (!rev || rev < MIN_REV) continue;
    if (seen.has(c.corp_code)) continue; seen.add(c.corp_code); out.push(enrich(c));
  }
  return out;
}
function lookupNames(names) {
  return names.map(q => {
    const cand = panel.filter(c => c.name && norm(c.name).includes(norm(q)));
    cand.sort((a, b) => (lastRev(b.rev) || 0) - (lastRev(a.rev) || 0));
    return cand[0] ? { q, ...enrich(cand[0]) } : { q, name: "(패널에 없음)", rev: null };
  });
}
function row(r) {
  return [r.name, r.rev, fmtPct(r.opm), fmtPct(r.cagr3), r.listed === true ? "상장" : r.listed === false ? "비상장" : "?", r.need ?? "-", r.type || "-", r.status || "-"].join(" | ");
}

const arg = process.argv[2];
if (arg === "--names") {
  console.log("회사 | 매출(억) | OPM | 3yCAGR | 상장 | need | type | status");
  for (const r of lookupNames(process.argv[3].split(",").map(s => s.trim()))) console.log(r.rev ? row(r) : `${r.q} | ${r.name}`);
} else if (arg) {
  const th = require(path.resolve(arg));
  console.log("THEME:", th.theme);
  for (const node of th.nodes) {
    let rows = matchNode(node).sort((a, b) => (b.need ?? -1) - (a.need ?? -1) || b.rev - a.rev);
    console.log(`\n[${node.node}] ${rows.length}개`);
    console.log("회사 | 매출(억) | OPM | 3yCAGR | 상장 | need | type | status");
    for (const r of rows.slice(0, node.limit || 25)) console.log(row(r));
  }
} else {
  console.log("usage: node screen.js --names \"A,B\"  |  node screen.js <theme.json>");
}
module.exports = { matchNode, lookupNames };
