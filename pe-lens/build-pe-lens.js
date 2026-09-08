// pe-lens/build-pe-lens.js — PE Lens 풀 빌드
//
// 입력: data/funding-panel.json(41k 외감 재무) · funding-pool.json(need/fit/type) · fs2025.json(최신FY) · narrative-pool.json
//       pe-owner.json(DART 최대주주·임원·배당·자사주·증감자) · pe-market.json(시세) · pe-registry.json · pe-cases.json
//       pe-policy.json · pe-rules.json · pe-playbook.json · corpcode.json
// 출력: data/pe-lens-pool.json { meta, stats, industries, rows[] }   ← 대시보드 #pelens 탭 소스
//
// 사용: node pe-lens/build-pe-lens.js [--max 6000]
const fs = require('fs');
const path = require('path');
const L = require('./lib.js');
const { DATA_DIR, KSIC_DIV, ksicSector } = require('../funding/config.js');

const args = process.argv.slice(2);
const MAX = +(args[args.indexOf('--max') + 1] || 4500);
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return d; } };

const t0 = Date.now();
const panel = load('funding-panel.json', { rows: [], meta: { years: [] } });
const pool = load('funding-pool.json', { rows: [] });
const fs25 = load('fs2025.json', { byCorp: {} });
const narr = load('narrative-pool.json', { themes: [] });
const owner = load('pe-owner.json', { byCorp: {} });
const market = load('pe-market.json', { byCode: {} });
const registry = load('pe-registry.json', { companies: [] });
const cases = load('pe-cases.json', { cases: [] });
const policy = load('pe-policy.json', { items: [] });
const rules = load('pe-rules.json', { rules: [] });
const playbook = load('pe-playbook.json', {});
const corpmap = load('corpcode.json', { map: {} }).map;
const theses = load('pe-theses.json', { theses: [] });

const years = panel.meta.years || [];
console.log(`panel ${panel.rows.length} · pool ${pool.rows.length} · owner ${Object.keys(owner.byCorp).length} · market ${Object.keys(market.byCode).length} · registry ${registry.companies.length} · cases ${(cases.cases || []).length}`);

// ── 인덱스 ────────────────────────────────────────────────────────
const poolBy = new Map(pool.rows.map(r => [r.corp_code, r]));
const regBy = new Map(registry.companies.filter(r => r.corp_code).map(r => [r.corp_code, r]));
const narrBy = new Map();
for (const t of narr.themes) for (const l of (t.longlist || [])) { if (!l.corp) continue; const a = narrBy.get(l.corp) || []; a.push({ theme: t.title, id: t.id, node: l.node, pick: !!l.pick, elas: t.catalog && t.catalog.supply_elasticity }); narrBy.set(l.corp, a); }
const listedByName = new Map(); const listedSet = new Set();
for (const [c, v] of Object.entries(corpmap)) if (v.s) { listedByName.set(v.n, c); listedSet.add(c); }
const thesisBy = new Map((theses.theses || []).map(t => [t.corp_code, t]));

const policyCtx = {};
for (const p of policy.items) { policyCtx[p.id] = /enacted|passed/.test(p.status); policyCtx[p.id + '_weight'] = p.weight; }

// 케이스 인덱스: 2자리 KSIC → 건수, deal_type → 성공률
const caseIdx = { byDiv: {}, byType: {}, bySector: {} };
const SECTOR_DIV = [[/의료기기|치과|에스테틱|미용|진단|임플란트|스캐너/, ['27']], [/제약|바이오|의약|CDMO/, ['21']], [/화장품|뷰티|K-뷰티/, ['20']], [/식품|음료|유업|F&B|식음료|프랜차이즈|외식|치킨|커피|버거|카페/, ['10', '56']], [/유통|리테일|마트|이커머스|온라인쇼핑|홈쇼핑|백화점|편의점/, ['47']], [/렌탈|렌터카|리스/, ['76']], [/카드|여신|캐피탈|금융/, ['64']], [/보험|생명|손해/, ['65']], [/시멘트|레미콘|건자재/, ['23']], [/가구|홈퍼니싱|인테리어/, ['32']], [/패션|의류|아웃도어|신발/, ['14', '15']], [/주방|생활용품|플라스틱/, ['22']], [/반도체|장비|소부장|디스플레이/, ['26', '29']], [/소프트웨어|SW|플랫폼|IT|SI|보안|게임|인터넷|모빌리티|채용/, ['62', '63']], [/케이블|방송|미디어|콘텐츠|엔터/, ['60', '59']], [/물류|택배|해운|운송|항공/, ['49', '50', '51', '52']], [/폐기물|환경|수처리|재생/, ['38', '37']], [/화학|소재|가스|필름|불소/, ['20']], [/자동차|부품|열관리/, ['30']], [/조선|기자재/, ['31']], [/건설|토건|엔지니어링/, ['41', '42']], [/교육|학원/, ['85']], [/골프|레저|여행|호텔|상조|장례/, ['91', '79', '55', '96']], [/기계|공작기계|로봇|산업재/, ['29']], [/전력|전기|에너지|발전/, ['35', '28']], [/통신|타워/, ['61']], [/제지|포장|골판지/, ['17']], [/철강|금속|비철/, ['24', '25']]];
for (const c of (cases.cases || [])) {
  const divs = new Set();
  const txt = `${c.sector || ''} ${c.ksic_hint || ''} ${c.company || ''}`;
  for (const [re, ds] of SECTOR_DIV) if (re.test(txt)) ds.forEach(d => divs.add(d));
  c._divs = [...divs];
  for (const d of divs) caseIdx.byDiv[d] = (caseIdx.byDiv[d] || 0) + 1;
  const t = caseIdx.byType[c.deal_type] = caseIdx.byType[c.deal_type] || { n: 0, success: 0, failure: 0, mixed: 0, ongoing: 0 };
  t.n++; if (t[c.outcome] != null) t[c.outcome]++;
}

// ── 산업 통계 (KSIC 5자리·3자리·2자리) ───────────────────────────
const indAgg = {};
const fin0 = new Map(); // corp → 기초 재무(패널)
for (const r of panel.rows) {
  const li = L.lastIdx(r.rev); if (li < 0) continue;
  const f = { rev: r.rev[li], op: r.op[li], opm: r.opm[li], ni: r.ni[li], ebitda: r.ebitda[li], ebitda_m: r.ebitda_m[li], net_debt: r.net_debt[li], cash: r.cash[li], debt_ratio: r.debt_ratio[li], curr_ratio: r.curr_ratio[li], roe: r.roe[li], year: years[li] || null, ind: r.ind_code };
  fin0.set(r.corp_code, f);
  if (!(f.rev > 30)) continue;
  for (const k of [r.ind_code, (r.ind_code || '').slice(0, 3), (r.ind_code || '').slice(0, 2)]) {
    if (!k) continue;
    const a = indAgg[k] = indAgg[k] || { n: 0, revs: [], opms: [], ems: [], cash_rich: [] };
    a.n++; a.revs.push(f.rev); a.opms.push(f.opm); a.ems.push(f.ebitda_m); if (f.rev >= 50 && f.rev <= 500) a.targets = (a.targets || 0) + 1;
    if (f.net_debt != null && f.net_debt < 0) a.cash_rich.push(f.rev);
  }
}
const industries = {};
for (const [k, a] of Object.entries(indAgg)) {
  const sorted = a.revs.slice().sort((x, y) => y - x); const tot = sorted.reduce((s, v) => s + v, 0);
  const top3 = sorted.slice(0, 3).reduce((s, v) => s + v, 0) / (tot || 1);
  industries[k] = { n: a.n, targets: a.targets || 0, rev_total: Math.round(tot), top3_share: +top3.toFixed(3), frag: +L.clamp(1 - top3, 0, 1).toFixed(3), opm_med: L.median(a.opms), opm_p75: L.pct(a.opms, 0.75), em_med: L.median(a.ems), cash_rich_revs: a.cash_rich.sort((x, y) => y - x).slice(0, 50) };
}
const indFor = code => industries[code] || industries[(code || '').slice(0, 3)] || industries[(code || '').slice(0, 2)] || null;
const siDepth = (code, rev) => { const i = industries[(code || '').slice(0, 3)] || industries[(code || '').slice(0, 2)]; if (!i || !rev) return 0; return i.cash_rich_revs.filter(v => v >= 5 * rev).length; };

// ── 회사별 재무 (fs2025 우선 → 패널) ─────────────────────────────
function finFor(corp, pr) {
  let base = fin0.get(corp); if (!base) { const pr0 = panelByName.get((corpmap[corp] || {}).n); if (pr0) base = fin0.get(pr0.corp_code); } base = base || {};
  const f25 = fs25.byCorp && fs25.byCorp[corp];
  const f = Object.assign({}, base);
  const f25ok = f25 && f25.rev != null && f25.op != null && (f25.ebitda != null || f25.ni != null) && !(f25.op > f25.rev) && !(base.rev && f25.rev < 0.5 * base.rev);
  if (f25ok) { for (const k of ['rev', 'op', 'ni', 'ebitda', 'net_debt', 'cash']) if (f25[k] != null) f[k] = f25[k]; f.year = f25.year || 2025; if (f.rev) { f.opm = f.op != null ? f.op / f.rev : f.opm; f.ebitda_m = f.ebitda != null ? f.ebitda / f.rev : f.ebitda_m; } f.fs25 = true; }
  if (pr) { for (const k of ['cagr3', 'op_loss_yrs', 'impaired_equity', 'debt_ratio', 'curr_ratio']) if (pr[k] != null && f[k] == null) f[k] = pr[k]; if (f.cagr3 == null) f.cagr3 = pr.cagr3; }
  const row = panelBy.get(corp) || (panelByName.get((corpmap[corp] || {}).n) || null);
  if (row) {
    const li = L.lastIdx(row.rev);
    if (f.cagr3 == null && li >= 3 && row.rev[li - 3] > 0 && row.rev[li] > 0) f.cagr3 = +(Math.pow(row.rev[li] / row.rev[li - 3], 1 / 3) - 1).toFixed(3);
    const ops = row.opm.slice(Math.max(0, li - 2), li + 1).filter(v => v != null); f.opm_min3 = ops.length ? Math.min(...ops) : null;
    const eb = row.ebitda.slice(Math.max(0, li - 2), li + 1).filter(v => v != null); f.ebitda_trend = eb.length >= 2 ? Math.sign(eb[eb.length - 1] - eb[0]) : null;
    if (f.op_loss_yrs == null) f.op_loss_yrs = row.op.filter(v => v != null && v < 0).length;
    f.series = { rev: row.rev, ebitda: row.ebitda, net_debt: row.net_debt, opm: row.opm };
  }
  f.nd_ebitda = f.ebitda > 0 && f.net_debt != null ? +(f.net_debt / f.ebitda).toFixed(1) : null;
  f.div2 = (f.ind || '').slice(0, 2); f.div3 = (f.ind || '').slice(0, 3);
  f.industry = KSIC_DIV[f.div2] || null; f.sector = ksicSector ? ksicSector(f.div2) : null;
  return f;
}
const panelBy = new Map(panel.rows.map(r => [r.corp_code, r]));
const panelByName = new Map(); { const cnt = {}; for (const r of panel.rows) cnt[r.name] = (cnt[r.name] || 0) + 1; for (const r of panel.rows) if (cnt[r.name] === 1) panelByName.set(r.name, r); }

// ── DART 파생: 배당성향·자사주·자본이벤트 ────────────────────────
function dartDerived(o, ownerCls) {
  const d = {};
  if (!o) return d;
  const findAlot = re => (o.alot || []).find(r => re.test(r.se || ''));
  const cashDiv = findAlot(/현금배당금총액/); const ni = findAlot(/\(연결\)당기순이익|당기순이익/); const payout = findAlot(/현금배당성향/);
  if (cashDiv) { d.cash_div = L.num(cashDiv.thstrm) != null ? L.num(cashDiv.thstrm) / 100 : null; d.cash_div_prev = L.num(cashDiv.frmtrm) != null ? L.num(cashDiv.frmtrm) / 100 : null; } // 백만원→억원
  if (ni) d.ni_alot = L.num(ni.thstrm) != null ? L.num(ni.thstrm) / 100 : null;
  if (payout) d.payout_ratio = L.num(payout.thstrm) != null ? L.num(payout.thstrm) / 100 : null;
  if (d.payout_ratio == null && d.cash_div != null && d.ni_alot) d.payout_ratio = +(d.cash_div / Math.abs(d.ni_alot)).toFixed(2);
  const tre = (o.tesstk || []).filter(r => /보통/.test(r.stock_knd || '') && !/계/.test(r.acqs_mth1 || '') && L.num(r.trmend_qy) != null);
  const treShares = tre.reduce((s, r) => s + (L.num(r.trmend_qy) || 0), 0);
  if (treShares && ownerCls.total_shares) d.treasury_pct = +(100 * treShares / ownerCls.total_shares).toFixed(2);
  const ev = [];
  for (const r of (o.irds || [])) { const s = r.isu_dcrs_stle || ''; if (/감자|제3자|제 3자|3자배정|전환|교환|신주인수권|공개매수|합병/.test(s)) ev.push({ on: r.isu_dcrs_de, type: s, qty: L.num(r.isu_dcrs_qy) }); }
  d.capital_events = ev.slice(-12);
  d.n_capital_reductions = ev.filter(e => /유상감자/.test(e.type)).length;
  d.n_3rd_party = ev.filter(e => /3자|제3자/.test(e.type)).length;
  return d;
}

// ── 유니버스 구성 ─────────────────────────────────────────────────
const universe = new Set();
for (const c of Object.keys(owner.byCorp)) universe.add(c);
for (const r of registry.companies) if (r.corp_code) universe.add(r.corp_code);
for (const r of pool.rows) universe.add(r.corp_code);
for (const c of narrBy.keys()) universe.add(c);
for (const c of listedSet) if (fin0.has(c)) universe.add(c);
for (const [c, f] of fin0) if (f.rev >= 200 && f.year >= 2023 && (f.ebitda > 0 || f.rev >= 1000)) universe.add(c);
console.log(`universe ${universe.size}`);

const rows = [];
for (const corp of universe) {
  const cm = corpmap[corp]; const name = (cm && cm.n) || (regBy.get(corp) || {}).name || (poolBy.get(corp) || {}).name;
  if (!name) continue;
  const listed = !!(cm && cm.s) || !!(poolBy.get(corp) || {}).listed;
  const stock = cm && cm.s;
  const pr = poolBy.get(corp) || null;
  const fin = finFor(corp, pr);
  if (fin.rev == null && !regBy.get(corp)) continue;
  const reg = regBy.get(corp) || null;
  const o = owner.byCorp[corp];
  const ownerCls = L.classifyOwner(o && !o.err ? o : null, { listedByName, registry: reg });
  Object.assign(ownerCls, dartDerived(o && !o.err ? o : null, ownerCls));
  const mkt = stock && market.byCode[stock] && market.byCode[stock].mcap ? market.byCode[stock] : null;
  const ind = indFor(fin.ind);
  if (ind) ind.si_depth = siDepth(fin.ind, fin.rev);
  const parentFin = ownerCls.parent_corp ? finFor(ownerCls.parent_corp, poolBy.get(ownerCls.parent_corp)) : null;
  ownerCls.succession = L.successionScore(ownerCls, mkt, listed);
  ownerCls.carveout_prob = L.carveoutProb(ownerCls, fin, parentFin);
  ownerCls.activist = L.activistVuln(ownerCls, fin, mkt, listed);
  const clock = L.ownerClock(ownerCls, reg, fin, playbook);
  Object.assign(ownerCls, { hold_years: clock.hold_years, fund_remaining: clock.fund_remaining, recovery_ratio: clock.recovery_ratio, debt_months: clock.debt_months, exit_pressure: clock.exit_pressure, valueup_drive: clock.valueup_drive, stage: clock.stage });

  const row = { corp_code: corp, name, stock_code: stock || null, listed, fin, mkt: mkt ? { mcap: mkt.mcap, pbr: mkt.pbr, per: mkt.per, price: mkt.price, dy: mkt.dy, hi52: mkt.hi52, lo52: mkt.lo52, date: mkt.date } : null,
    owner: ownerCls, clock, pool: pr ? { need: pr.need, fit: pr.fit, type: pr.type, status: pr.status, angle_primary: pr.angle_primary, gap_12m: pr.gap_12m } : null,
    narratives: narrBy.get(corp) || [], registry: reg ? { sponsor: reg.sponsor, sponsor_type: reg.sponsor_type, entry_date: reg.entry_date, entry_type: reg.entry_type, ev_krw_bn: reg.ev_krw_bn, equity_krw_bn: reg.equity_krw_bn, stake_pct: reg.stake_pct, fund: reg.fund, debt: reg.debt, recovery: reg.recovery, status: reg.status, stage_hint: reg.stage_hint, notes: reg.notes, confidence: reg.confidence } : null,
    policy: policyCtx, lens: {} };
  row.lens.entry = L.entryScores(row, ind, policyCtx);
  row.lens.valueup = L.valueupScores(row, ind);
  row.lens.exit = L.exitScores(row, ind, caseIdx, policyCtx);
  row.ticket = L.ticket(row, playbook);
  row.rule_hits = L.applyRules(rules.rules, row);
  row.ind = ind ? { n: ind.n, targets: ind.targets, frag: ind.frag, opm_med: ind.opm_med, si_depth: ind.si_depth, top3_share: ind.top3_share } : null;

  // 주목도(attention): 진입구조 최고점 + 오너 압력 + 밸류업 여지. 데이터 결손 감점.
  const eVals = Object.values(row.lens.entry); const eMax = eVals.length ? Math.max(...eVals) : 0;
  const eTop = Object.entries(row.lens.entry).sort((a, b) => b[1] - a[1])[0];
  const ownerP = Math.max(clock.exit_pressure || 0, ownerCls.succession || 0, ownerCls.carveout_prob || 0, ownerCls.activist || 0, ownerCls.type === 'PE_CONTROL' ? clock.valueup_drive || 0 : 0);
  const vVals = Object.values(row.lens.valueup).sort((a, b) => b - a); const vTop2 = vVals.length ? (vVals[0] + (vVals[1] || vVals[0])) / 2 : 0;
  let att = 0.45 * eMax + 0.35 * ownerP + 0.2 * vTop2;
  if (ownerCls.type === 'UNKNOWN') att -= 12;
  if (fin.year && fin.year < 2023) att -= 10;
  if (fin.rev != null && fin.rev < 100) att -= 10;
  if (row.narratives.length) att += 5;
  if (thesisBy.has(corp)) att += 5;
  row.attention = Math.round(L.clamp(att));
  row.entry_top = eTop ? { id: eTop[0], score: eTop[1] } : null;
  row.owner_pressure = Math.round(ownerP);
  // 케이스 유사도: 같은 2자리 업종 + 진입구조 일치
  row.analog_cases = (cases.cases || []).filter(c => (c._divs || []).includes(fin.div2)).map(c => ({ id: c.id, company: c.company, sponsor: c.sponsor, deal_type: c.deal_type, outcome: c.outcome, match: (eTop && c.deal_type === ({ lbo: 'buyout', p2p: 'p2p', pipe: 'growth_minority', carve_out: 'carve_out', secondary: 'secondary', rollup: 'rollup', mezz: 'mezzanine', distressed: 'distressed', activist: 'activist', succession: 'mbo' })[eTop[0]]) ? 2 : 1 })).sort((a, b) => b.match - a.match).slice(0, 4);
  // 근거 요약
  const why = [];
  why.push(...ownerCls.evidence.slice(0, 2));
  if (clock.notes.length) why.push(clock.notes.join(' · ') + (clock.predicted ? ` → 예상: ${clock.predicted}` : ''));
  if (eTop) why.push(`진입구조 1순위 ${eTop[0]} ${eTop[1]}점`);
  if (ind && ind.frag != null) why.push(`업종 파편화 ${(ind.frag * 100).toFixed(0)}% (상위3사 ${(ind.top3_share * 100).toFixed(0)}%) · 업종 OPM 중위 ${ind.opm_med != null ? (ind.opm_med * 100).toFixed(1) + '%' : '—'}`);
  if (ownerCls.payout_ratio != null) why.push(`배당성향 ${(ownerCls.payout_ratio * 100).toFixed(0)}%`);
  if (ownerCls.treasury_pct != null) why.push(`자사주 ${ownerCls.treasury_pct}% (2027-09 소각의무)`);
  row.why = why;
  delete row.policy;
  rows.push(row);
}

rows.sort((a, b) => b.attention - a.attention);
const keep = rows.filter((r, i) => (i < MAX && (r.listed || r.pool || r.narratives.length || r.attention >= 45 || r.owner.type !== 'UNKNOWN')) || r.owner.type.startsWith('PE_') || r.registry || r.listed);
// 슬림화: series 는 상위 1500 + PE + 상장만 유지
keep.forEach((r, i) => { if (i > 500 && !r.registry && !r.owner.type.startsWith('PE_')) delete r.fin.series; delete r.owner.evidence; if (r.owner.family_names) r.owner.family_names = r.owner.family_names.slice(0, 4); if (r.owner.changes && r.owner.changes.length > 6) r.owner.changes = r.owner.changes.slice(-6); if (r.owner.capital_events && r.owner.capital_events.length > 8) r.owner.capital_events = r.owner.capital_events.slice(-8); });

const stats = {
  n: keep.length, listed: keep.filter(r => r.listed).length,
  by_owner: {}, by_entry_top: {}, pe_control: keep.filter(r => r.owner.type === 'PE_CONTROL').length,
  exit_pressure_high: keep.filter(r => (r.clock.exit_pressure || 0) >= 70).length,
  succession_high: keep.filter(r => (r.owner.succession || 0) >= 65).length,
  carveout_high: keep.filter(r => (r.owner.carveout_prob || 0) >= 60).length,
  owner_coverage: keep.filter(r => r.owner.source === 'dart').length,
  rule_hits: {}, case_types: caseIdx.byType,
  rules_eval: rules.rules.map(r => { const cs = id => (cases.cases || []).find(c => c.id === id); const sup = (r.evidence.supports || []).map(cs).filter(Boolean); const con = (r.evidence.contradicts || []).map(cs).filter(Boolean); return { id: r.id, name: r.name, statement: r.statement, status: r.status, origin: r.origin, flag: r.effect.flag, target: r.effect.target, delta: r.effect.delta, supports: sup.map(c => ({ id: c.id, company: c.company, outcome: c.outcome })), contradicts: con.map(c => ({ id: c.id, company: c.company, outcome: c.outcome })), strength: sup.length + con.length ? +(sup.length / (sup.length + con.length)).toFixed(2) : null }; }),
  case_by_outcome: (cases.cases || []).reduce((a, c) => { a[c.outcome] = (a[c.outcome] || 0) + 1; return a; }, {}),
};
for (const r of keep) { stats.by_owner[r.owner.type] = (stats.by_owner[r.owner.type] || 0) + 1; if (r.entry_top) stats.by_entry_top[r.entry_top.id] = (stats.by_entry_top[r.entry_top.id] || 0) + 1; for (const h of r.rule_hits) stats.rule_hits[h.id] = (stats.rule_hits[h.id] || 0) + 1; }

const out = { meta: { generated: new Date().toISOString(), panel_years: years, fs2025: !!fs25.meta, owner_generated: owner.meta && owner.meta.generated, market_generated: market.meta && market.meta.generated, owner_labels: L.OWNER_LABEL, playbook_version: playbook.version, policy_updated: policy.meta && policy.meta.updated, rules_active: rules.rules.filter(r => r.status === 'active').length, cases: (cases.cases || []).length }, stats, industries: Object.fromEntries(Object.entries(industries).filter(([k]) => k.length === 2).map(([k, v]) => [k, { name: KSIC_DIV[k], n: v.n, frag: v.frag, opm_med: v.opm_med, top3_share: v.top3_share }])), rows: keep };
const rnd = (k, v) => typeof v === 'number' && isFinite(v) ? (Math.abs(v) >= 100 ? Math.round(v) : Math.abs(v) >= 1 ? +v.toFixed(1) : +v.toFixed(3)) : v;
fs.writeFileSync(path.join(DATA_DIR, 'pe-lens-pool.json'), JSON.stringify(out, rnd));
console.log(`rows ${keep.length} (listed ${stats.listed}) · PE_CONTROL ${stats.pe_control} · owner via DART ${stats.owner_coverage} · by_owner ${JSON.stringify(stats.by_owner)} · ${((Date.now() - t0) / 1000).toFixed(1)}s → data/pe-lens-pool.json ${(fs.statSync(path.join(DATA_DIR, 'pe-lens-pool.json')).size / 1e6).toFixed(1)}MB`);
