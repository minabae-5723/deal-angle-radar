// pe-lens/lib.js — PE Lens 스코어링 엔진 (순수 함수, 데이터 I/O 없음)
//
// 렌즈 4개: Owner(선행지표) → Entry(진입구조 적합) → Value-up(레버) → Exit(출구 옵션)
// 철학: 실적·밸류는 후행지표. 최대주주의 유인구조·시계(clock)가 선행지표(키움 2026-08-19).
// 스코어는 절대치가 아닌 상대순위용 prior. 근거(evidence) 문장을 항상 함께 낸다(evidence cards > composite).

const NOW = new Date();
const YEAR = NOW.getFullYear() + (NOW.getMonth() + 1) / 12;

const num = s => {
  if (s == null) return null;
  if (typeof s === 'number') return isFinite(s) ? s : null;
  const t = String(s).replace(/[,%\s원주]/g, '').replace(/^-$/, '');
  if (!t || t === '-') return null;
  const v = parseFloat(t);
  return isFinite(v) ? v : null;
};
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const last = arr => { if (!Array.isArray(arr)) return null; for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null && isFinite(arr[i])) return arr[i]; return null; };
const lastIdx = arr => { if (!Array.isArray(arr)) return -1; for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null && isFinite(arr[i])) return i; return -1; };
const median = a => { const s = a.filter(v => v != null && isFinite(v)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { const s = a.filter(v => v != null && isFinite(v)).sort((x, y) => x - y); if (!s.length) return null; return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const ym = s => { // "2021년 01월 12일" | "2022-04" | "2017.04.17" → decimal year
  if (!s) return null; const m = String(s).match(/(\d{4})\D+(\d{1,2})/); if (!m) return null;
  return +m[1] + (+m[2]) / 12;
};
const stepScore = (v, table) => { if (v == null) return null; for (const [lo, hi, s] of table) if (v >= lo && v < hi) return s; return table[table.length - 1][2]; };

// ── 최대주주 이름 분류 ────────────────────────────────────────────
const PE_RE = /사모투자|PEF|Private\s*Equity|프라이빗\s*에쿼티|에쿼티|Equity|Acquisition|유한회사|합자회사|제\s*\d+호|펀드|Fund\b|컨소시엄|Consortium|Designated Activity|Investments?\s*(Ltd|LLC|Limited|Pte|S\.?[àa]\s*r|Co)|Holdings?\s*(LLC|L\.?P|Ltd|Limited|Pte|S\.?[àa]\s*r|B\.?V)|L\.?P\.?$|\bLLC\b|Cayman|B\.?V\.?$|S\.?[àa]\.?r\.?l|Partners\b|파트너스|인베스트먼트|캐피탈|Capital\b|Bidco|Topco|Midco|SPC/i;
const GOVT_RE = /산업은행|한국정부|기획재정부|국민연금|한국전력|수출입은행|중소기업은행|기업은행|예금보험공사|국토교통부|자산관리공사|캠코|Korea Development|정책금융|한국벤처투자|대한민국|산업통상|보건복지|우정사업|한국수력|한국가스|지방자치|서울특별시|경기도|부산광역시|인천광역시/;
const CORP_RE = /주식회사|㈜|\(주\)|Co\.?,?\s*Ltd|Inc\b|Corp\b|Corporation|GmbH|\bAG\b|S\.A\.|N\.V\.|\bLtd\b|Limited|Holdings|홀딩스|지주|그룹|Group|Company|컴퍼니|Pte|Plc|\bSE\b|K\.K\.|株式会社|有限公司/i;
const PERSON_RE = /^[가-힣]{2,4}(\s*외\s*\d+\s*인)?$/;
const LATIN_RE = /^[A-Za-z0-9\s.,&'()\-]+$/;
const FAMILY_RE = /^(자|녀|장남|차남|장녀|차녀|아들|딸|배우자|처|부|모|형|제|남매|형제|자매|손|손자|손녀|사위|며느리|조카|친인척|친족|혈족|인척|특수관계인|친척)$|자녀|배우자|형제|친인척|친족|혈족|인척|손자|사위|며느리|장남|차남|장녀|차녀/;
const SELF_RE = /^(본인|최대주주\s*본인|최대주주)$|^본인/;

const OWNER_LABEL = {
  PE_CONTROL: 'PE 경영권', PE_MINORITY: 'PE 소수지분', PE_PENDING: 'PE 인수 진행', ACTIVIST_TARGET: '행동주의 타겟',
  FOUNDER: '창업주(개인)', FAMILY_2G: '오너가(2세 참여)', HOLDCO_PRIVATE: '비상장 지배회사', GROUP_SUB: '그룹 계열',
  GOVT: '정부·공공', FOREIGN_SUB: '해외 모회사', DISPERSED: '지분 분산', UNKNOWN: '미확인',
};

/**
 * DART 정기보고서(hyslr/exctv/chg) + 레지스트리로 최대주주 유형 판별.
 * ctx: { listedNames:Set<string>, listedByName:Map<name,corp_code>, registry?:rec }
 */
function classifyOwner(o, ctx = {}) {
  const ev = [];
  const out = { type: 'UNKNOWN', label: OWNER_LABEL.UNKNOWN, top_name: null, top_pct: null, group_pct: null, age: null, self_exec: null,
    family_next_gen: 0, family_execs: 0, pe_candidate: false, confidence: 'low', changes: [], evidence: ev, source: null };
  const reg = ctx.registry;
  if (reg && reg.sponsor_type && reg.sponsor_type !== 'PE_EXITED') {
    const map = { PE_CONTROL: 'PE_CONTROL', PE_MINORITY: 'PE_MINORITY', PE_PENDING: 'PE_PENDING', ACTIVIST: 'ACTIVIST_TARGET', SI_FI_MIX: 'GROUP_SUB' };
    out.type = map[reg.sponsor_type] || 'UNKNOWN'; out.label = OWNER_LABEL[out.type]; out.confidence = reg.confidence || 'medium'; out.source = 'registry';
    out.top_name = reg.vehicle || reg.sponsor; out.top_pct = reg.stake_pct ?? null; out.sponsor = reg.sponsor;
    ev.push(`레지스트리: ${reg.sponsor} ${reg.entry_date || ''} ${reg.entry_type || ''} 진입`);
  }
  if (!o) { if (out.type === 'UNKNOWN') ev.push('DART 최대주주 데이터 없음(비상장·미수집)'); return out; }

  // ── 최대주주 + 특수관계인 (보통주 기준)
  const rows = (o.hyslr || []).filter(r => r.nm && r.nm !== '계' && (!r.stock_knd || /보통/.test(r.stock_knd)));
  const total = (o.hyslr || []).find(r => r.nm === '계' && (!r.stock_knd || /보통/.test(r.stock_knd)));
  let top = rows.find(r => /최대주주|본인/.test(r.relate || '')) || rows[0];
  if (top) {
    out.top_name = top.nm; out.top_pct = num(top.trmend_posesn_stock_qota_rt) ?? num(top.bsis_posesn_stock_qota_rt);
    out.top_shares = num(top.trmend_posesn_stock_co);
    out.group_pct = total ? (num(total.trmend_posesn_stock_qota_rt) ?? num(total.bsis_posesn_stock_qota_rt)) : rows.reduce((s, r) => s + (num(r.trmend_posesn_stock_qota_rt) || 0), 0);
    out.n_related = rows.length;
    if (out.top_shares && out.top_pct) out.total_shares = Math.round(out.top_shares / (out.top_pct / 100));
  }
  // ── 임원: 최대주주 본인 생년, 가족 참여
  for (const e of (o.exctv || [])) {
    const rel = (e.mxmm_shrholdr_relate || '').trim();
    const by = num((e.birth_ym || '').slice(0, 4));
    const age = by ? NOW.getFullYear() - by : null;
    if (SELF_RE.test(rel)) { out.self_exec = { nm: e.nm, age, pos: e.ofcps }; if (age) out.age = age; }
    else if (FAMILY_RE.test(rel) && !/임원|계열/.test(rel)) { out.family_execs++; if (age && age < 55) out.family_next_gen++; out.family_names = (out.family_names || []).concat(`${e.nm}(${rel}${age ? ',' + age : ''})`); }
  }
  // ── 최대주주 변동 이력 (진입 시점 추정)
  out.changes = (o.chg || []).map(c => ({ on: c.change_on, nm: c.mxmm_shrholdr_nm, pct: num(c.qota_rt), cause: c.change_cause })).filter(c => c.on);

  if (out.type !== 'UNKNOWN') { // 레지스트리 확정 → DART 로 보강만
    if (out.top_pct != null) ev.push(`DART 최대주주 ${out.top_name} ${out.top_pct}% (특수관계인 합 ${out.group_pct ?? '—'}%)`);
    return out;
  }
  if (!top) { ev.push('최대주주 항목 없음'); return out; }
  const nm = top.nm.replace(/\s+/g, ' ').trim();
  const isPerson = PERSON_RE.test(nm) || /^[가-힣]{2,4}\s*외/.test(nm);
  const listedParent = ctx.listedByName && ctx.listedByName.get(nm.replace(/^주식회사\s*|㈜|\(주\)/g, '').trim());
  if (GOVT_RE.test(nm)) { out.type = 'GOVT'; ev.push(`최대주주 ${nm} = 정부·공공`); }
  else if (isPerson) {
    out.type = (out.age && out.age >= 58 && out.family_next_gen > 0) ? 'FAMILY_2G' : 'FOUNDER';
    ev.push(`최대주주 개인 ${nm} ${out.top_pct ?? '—'}%${out.age ? ` · ${out.age}세` : ''}${out.family_execs ? ` · 가족 임원 ${out.family_execs}명(차세대 ${out.family_next_gen})` : ''}`);
  }
  else if (PE_RE.test(nm) && !listedParent) { out.type = 'PE_CONTROL'; out.pe_candidate = true; ev.push(`최대주주명 ${nm} = 투자기구 패턴 → PE 후보(검증 필요)`); }
  else if (listedParent) { out.type = 'GROUP_SUB'; out.parent_corp = listedParent; ev.push(`최대주주 ${nm} = 상장 모회사`); }
  else if (LATIN_RE.test(nm) && CORP_RE.test(nm)) { out.type = 'FOREIGN_SUB'; ev.push(`최대주주 ${nm} = 해외 법인`); }
  else if (CORP_RE.test(nm) || /^[가-힣A-Za-z0-9·&\s]+$/.test(nm)) { out.type = 'HOLDCO_PRIVATE'; ev.push(`최대주주 ${nm} = 비상장 법인(오너 지배회사 가능)`); }
  if ((out.top_pct != null && out.top_pct < 15) && (out.group_pct == null || out.group_pct < 20) && !/PE|GOVT/.test(out.type)) { out.type = 'DISPERSED'; ev.push(`지분 분산: 최대주주 ${out.top_pct}% · 특수관계인 합 ${out.group_pct ?? '—'}%`); }
  out.label = OWNER_LABEL[out.type];
  out.confidence = out.type === 'UNKNOWN' ? 'low' : (out.pe_candidate ? 'medium' : 'high');
  out.source = 'dart';
  // PE 진입 시점: 변동이력 중 최대주주명이 현재 top 과 같은 첫 시점
  if (out.type === 'PE_CONTROL') {
    const first = out.changes.filter(c => c.nm && nm.slice(0, 6) && c.nm.replace(/\s+/g, ' ').includes(nm.slice(0, 6))).sort((a, b) => (ym(a.on) || 0) - (ym(b.on) || 0))[0];
    if (first) { out.entry_year = ym(first.on); ev.push(`최대주주 변동 ${first.on} (${first.cause}) → 진입 시점 추정`); }
  }
  return out;
}

// ── Owner clock: PE 보유기업의 시계·압력 ─────────────────────────
function ownerClock(owner, reg, fin, playbook) {
  const m = playbook.exit_pressure_model;
  const out = { hold_years: null, fund_remaining: null, recovery_ratio: null, debt_months: null, exit_pressure: null, valueup_drive: null, stage: null, predicted: null, notes: [] };
  if (!/^PE_/.test(owner.type)) return out;
  const entry = (reg && ym(reg.entry_date)) || owner.entry_year || null;
  if (entry) out.hold_years = +(YEAR - entry).toFixed(1);
  if (reg && reg.fund && reg.fund.maturity_est) out.fund_remaining = +(reg.fund.maturity_est + 0.99 - YEAR).toFixed(1);
  else if (entry) out.fund_remaining = +((entry + 8) - YEAR).toFixed(1); // 진입 후 8년을 펀드 잔존 대용
  if (reg && reg.recovery) {
    if (reg.recovery.ratio != null) out.recovery_ratio = reg.recovery.ratio;
    else if (reg.recovery.cum_krw_bn != null && reg.equity_krw_bn) out.recovery_ratio = +(reg.recovery.cum_krw_bn / reg.equity_krw_bn).toFixed(2);
  }
  if (out.recovery_ratio == null && reg && reg.status && /holding/.test(reg.status) && (!reg.recovery || !(reg.recovery.items || []).length)) out.recovery_ratio = 0;
  if (reg && reg.debt && reg.debt.maturity) { const my = ym(reg.debt.maturity); if (my) out.debt_months = Math.round((my - YEAR) * 12); }

  const hold = stepScore(out.hold_years, m.holding_years_score);
  const fund = stepScore(out.fund_remaining, m.fund_remaining_score);
  let p = 0, w = 0;
  if (hold != null) { p += 0.55 * hold; w += 0.55; }
  if (fund != null) { p += 0.35 * fund; w += 0.35; }
  if (w) p = p / w; else p = 40;
  if (out.recovery_ratio != null) { if (out.recovery_ratio >= 0.9) p -= 25; else if (out.recovery_ratio < 0.3) p += 5; }
  if (out.debt_months != null && out.debt_months <= 18) p += 10;
  if (reg && /overdue|attempt|dispute/.test(reg.stage_hint || '')) p += 10;
  if (reg && reg.status === 'failed') p = 100;
  out.exit_pressure = Math.round(clamp(p));
  out.valueup_drive = out.recovery_ratio == null ? 50 : Math.round(clamp(100 * (1 - Math.min(1, out.recovery_ratio))));
  const h = out.hold_years;
  out.stage = h == null ? 'unknown' : h < 3 ? 'early' : h < 5 ? 'mid' : h < 7 ? 'late' : 'overdue';
  if (reg && reg.stage_hint) out.stage_hint = reg.stage_hint;
  out.predicted = m.predicted_actions[out.stage] || null;
  if (out.hold_years != null) out.notes.push(`보유 ${out.hold_years}년(${out.stage})`);
  if (out.fund_remaining != null) out.notes.push(`펀드 잔존 ${out.fund_remaining}년`);
  if (out.recovery_ratio != null) out.notes.push(`회수율 ${(out.recovery_ratio * 100).toFixed(0)}%`);
  if (out.debt_months != null) out.notes.push(`인수금융 만기 ${out.debt_months}개월`);
  return out;
}

// ── 승계 압력 (개인 최대주주) ────────────────────────────────────
function successionScore(owner, mkt, listed) {
  if (!/FOUNDER|FAMILY_2G/.test(owner.type)) return null;
  const a = owner.age;
  let s = a == null ? 35 : a >= 75 ? 100 : a >= 70 ? 85 : a >= 65 ? 65 : a >= 60 ? 45 : a >= 55 ? 25 : 5;
  if (owner.top_pct != null && owner.top_pct >= 30 && owner.family_next_gen === 0) s += 10;
  if (owner.type === 'FAMILY_2G') s -= 5;                       // 승계 진행 중 → 세금 재원 딜은 있으나 매각 니즈는 낮음
  if (listed && mkt && mkt.pbr != null && mkt.pbr < 1) s += 10; // 저PBR 에서 승계 실행 유리(케이스맵 ⓗ)
  return Math.round(clamp(s));
}

// ── 카브아웃 확률 (그룹 계열) ────────────────────────────────────
function carveoutProb(owner, fin, parentFin) {
  if (owner.type !== 'GROUP_SUB') return null;
  let s = 30;
  if (parentFin) {
    if (parentFin.div2 && fin.div2 && parentFin.div2 !== fin.div2) s += 25;      // 비핵심(업종 상이)
    if (parentFin.rev && fin.rev && fin.rev / parentFin.rev < 0.05) s += 15;   // 그룹 내 소형
    if (parentFin.debt_ratio != null && parentFin.debt_ratio > 2) s += 15;      // 모회사 레버리지
    if (parentFin.nd_ebitda != null && parentFin.nd_ebitda > 4) s += 10;
  }
  if (fin.op != null && fin.op < 0) s += 10;                                    // 적자 계열 정리
  if (owner.top_pct != null && owner.top_pct >= 50) s += 5;                     // 통매각 용이
  return Math.round(clamp(s));
}

// ── 행동주의 취약성 (분산 지분 상장사) ────────────────────────────
function activistVuln(owner, fin, mkt, listed) {
  if (!listed) return null;
  let s = 0;
  if (owner.top_pct != null) s += clamp(100 - owner.top_pct * 2.5, 0, 60); else s += 20;
  if (mkt && mkt.pbr != null) s += mkt.pbr < 0.6 ? 25 : mkt.pbr < 1 ? 15 : 0;
  if (mkt && mkt.mcap && fin.net_debt != null && fin.net_debt < 0 && (-fin.net_debt / mkt.mcap) > 0.3) s += 15; // 순현금/시총 30%+
  if (owner.type === 'ACTIVIST_TARGET') s = Math.max(s, 80);
  return Math.round(clamp(s));
}

// ── Entry 구조 적합도 ─────────────────────────────────────────────
function entryScores(row, ind, policy) {
  const { owner, fin, mkt, listed, clock, pool } = row;
  const e = {};
  const oT = owner.type;
  const ebitda = fin.ebitda, em = fin.ebitda_m;
  const pos = ebitda != null && ebitda > 0;
  const headroom = pos ? (3.5 * ebitda - Math.max(0, fin.net_debt || 0)) / ebitda : null; // 추가 차입여력(EBITDA 배수)

  // P2P
  if (listed && /FOUNDER|FAMILY_2G|HOLDCO_PRIVATE|DISPERSED|ACTIVIST_TARGET/.test(oT)) {
    let s = 35;
    if (mkt && mkt.pbr != null) s += mkt.pbr < 0.6 ? 25 : mkt.pbr < 0.8 ? 18 : mkt.pbr < 1 ? 10 : mkt.pbr > 2 ? -15 : 0;
    if (oT === 'ACTIVIST_TARGET') s += 20;
    if (owner.top_pct != null) s += (owner.top_pct >= 25 && owner.top_pct <= 55) ? 10 : owner.top_pct > 70 ? -10 : 0;
    if (mkt && mkt.mcap) s += mkt.mcap < 300 ? -10 : mkt.mcap <= 8000 ? 10 : mkt.mcap >= 20000 ? -20 : 0;
    if (pos) s += 5;
    if (policy.mto) s -= 15 * (policy.mto_weight || 0.8);
    e.p2p = Math.round(clamp(s));
  }
  // LBO / 경영권 바이아웃
  if (/FOUNDER|FAMILY_2G|HOLDCO_PRIVATE|GROUP_SUB|PE_CONTROL|FOREIGN_SUB|UNKNOWN/.test(oT) && pos) {
    let s = 25 + 25 * clamp((em || 0) / 0.25, 0, 1) + 20 * clamp((headroom || 0) / 3.5, 0, 1);
    if (fin.opm_min3 != null && fin.opm_min3 > 0) s += 12;             // 3년 흑자 안정
    if (fin.rev >= 300 && fin.rev <= 5000) s += 8;                     // 인수금융 조달 가능 규모
    if (!listed) s += 10;                                              // 비공개 소싱 우위
    if (fin.nd_ebitda != null && fin.nd_ebitda > 4) s -= 20;
    e.lbo = Math.round(clamp(s));
  }
  // PIPE / Growth minority
  {
    let s = 20;
    if (pool && pool.need != null) s += 0.4 * pool.need;
    if (fin.cagr3 != null) s += 30 * clamp(fin.cagr3 / 0.3, 0, 1);
    if (pool && pool.type === 'GROWTH') s += 15;
    if (pool && pool.type === 'WC_BURN') s -= 10;
    if (fin.op_loss_yrs >= 3) s -= 15;
    if (oT === 'PE_CONTROL') s -= 15;                                  // 이미 PE 통제 → 소수지분 진입 여지 작음
    if (fin.rev != null && fin.rev >= 100) s += 5;
    e.pipe = Math.round(clamp(s));
  }
  // Carve-out
  if (oT === 'GROUP_SUB' && row.owner.carveout_prob != null) e.carve_out = row.owner.carveout_prob;
  // Secondary
  if (oT === 'PE_CONTROL' && clock && clock.exit_pressure != null) e.secondary = clock.exit_pressure;
  // Roll-up 플랫폼
  if (ind && ind.frag != null && pos) {
    let s = 10 + 30 * ind.frag + 25 * clamp((ind.targets || 0) / 30, 0, 1);
    if (ind.opm_med != null && fin.opm != null && fin.opm >= ind.opm_med) s += 20;
    if (fin.rev >= 200 && fin.rev <= 3000) s += 20; else if (fin.rev < 200) s -= 10;
    if (/PE_CONTROL/.test(oT)) s -= 10;
    e.rollup = Math.round(clamp(s));
  }
  // Mezzanine / credit
  {
    let s = 15;
    if (pool && /REFI|TIGHT/.test(pool.type)) s += 30; else if (pool && pool.type === 'DISTRESS') s += 15;
    if (fin.nd_ebitda != null && fin.nd_ebitda >= 2.5 && fin.nd_ebitda <= 6 && pos) s += 25;
    if (fin.curr_ratio != null && fin.curr_ratio < 1) s += 10;
    if (pos && em >= 0.08) s += 10;                                    // 이자 감당 가능
    if (clock && clock.debt_months != null && clock.debt_months <= 18) s += 20;
    if (fin.rev != null && fin.rev >= 300) s += 5;
    e.mezz = Math.round(clamp(s));
  }
  // Distressed
  {
    let s = 0;
    if (pool && pool.type === 'DISTRESS') s += 45;
    if (fin.impaired_equity) s += 25;
    if (fin.op_loss_yrs >= 3) s += 15;
    if (fin.debt_ratio != null && fin.debt_ratio > 3) s += 10;
    if (fin.curr_ratio != null && fin.curr_ratio < 0.7) s += 10;
    if (fin.rev != null && fin.rev >= 500) s += 5;
    if (s >= 30) e.distressed = Math.round(clamp(s));
  }
  // 승계
  if (row.owner.succession != null) e.succession = row.owner.succession;
  // 행동주의
  if (listed && row.owner.activist != null && row.owner.activist >= 40 && /DISPERSED|FOUNDER|FAMILY_2G|HOLDCO_PRIVATE|ACTIVIST_TARGET/.test(oT)) e.activist = row.owner.activist;
  return e;
}

// ── Value-up 레버 ─────────────────────────────────────────────────
function valueupScores(row, ind) {
  const { fin, owner, listed } = row;
  const v = {};
  const pos = fin.ebitda != null && fin.ebitda > 0;
  if (ind && ind.opm_med != null && fin.opm != null) { const gap = (ind.opm_med - fin.opm) * 100; v.ops = Math.round(clamp(gap * 8)); if (fin.opm < 0 && ind.opm_med > 0) v.ops = Math.max(v.ops, 60); }
  if (ind && ind.frag != null && pos) v.bolt_on = Math.round(clamp(10 + 40 * ind.frag + 25 * clamp((ind.targets || 0) / 30, 0, 1) + (ind.opm_med != null && fin.opm >= ind.opm_med ? 20 : 0)));
  if (pos) { const h = (3.5 * fin.ebitda - Math.max(0, fin.net_debt || 0)) / fin.ebitda; v.recap = Math.round(clamp(h / 3.5 * 100)); if (fin.net_debt != null && fin.net_debt < 0) v.recap = Math.min(100, v.recap + 10); }
  if (fin.ni != null && fin.ni > 0 && fin.net_debt != null && fin.net_debt < 0) v.dividend = Math.round(clamp(40 + 60 * clamp((-fin.net_debt) / Math.max(1, fin.ni) / 5, 0, 1)));
  if (owner.treasury_pct != null) v.governance = Math.round(clamp(owner.treasury_pct * 8 + (owner.n_related > 6 ? 15 : 0)));
  else if (owner.n_related > 6) v.governance = 30;
  if (fin.cagr3 != null && fin.cagr3 > 0.1 && fin.opm != null && fin.opm > 0.05) v.pricing_geo = Math.round(clamp(fin.cagr3 * 200));
  if (fin.opm != null && fin.opm < 0 && fin.rev > 500) v.carve_out_sale = 50;
  return v;
}

// ── Exit 옵션 ─────────────────────────────────────────────────────
function exitScores(row, ind, caseIdx, policy) {
  const { fin, listed, owner } = row;
  const x = {};
  if (ind) x.trade_sale_si = Math.round(clamp(20 + 15 * Math.min(4, ind.si_depth || 0) + (ind.si_depth ? 10 : 0)));
  const sboN = caseIdx && caseIdx.byDiv[fin.div2] ? caseIdx.byDiv[fin.div2] : 0;
  x.trade_sale_fi = Math.round(clamp(30 + 15 * Math.min(4, sboN) - (listed && policy.mto ? 10 : 0)));
  if (!listed) { let s = 0; if (fin.rev >= 500) s += 30; if (fin.opm >= 0.08) s += 25; if (fin.cagr3 >= 0.1) s += 25; if (fin.ni > 0) s += 10; if (owner.type === 'GROUP_SUB' && policy.dual_listing) s -= 25; x.ipo = Math.round(clamp(s)); }
  else x.block_deal = Math.round(clamp(30 + (row.mkt && row.mkt.mcap > 3000 ? 30 : 0) + (owner.top_pct != null && owner.top_pct > 50 ? 20 : 0)));
  const pos = fin.ebitda > 0;
  if (pos) { const h = (3.5 * fin.ebitda - Math.max(0, fin.net_debt || 0)) / fin.ebitda; x.recap_only = Math.round(clamp(h / 3.5 * 90 + (fin.ni > 0 ? 10 : 0))); }
  return x;
}

// ── 티켓·밸류 추정 ────────────────────────────────────────────────
function ticket(row, playbook) {
  const { fin, mkt, listed, owner } = row;
  const mult = playbook.irr_defaults.entry_ev_ebitda_by_div[fin.div2] || playbook.irr_defaults.entry_ev_ebitda_by_div.default;
  let ev = null, basis = null;
  if (listed && mkt && mkt.mcap) { ev = mkt.mcap * 1.25 + Math.max(0, fin.net_debt || 0); basis = '시총×1.25(경영권 프리미엄)+순차입'; }
  else if (fin.ebitda > 0) { ev = fin.ebitda * mult; basis = `EBITDA×${mult}x(업종 기본)`; }
  else if (fin.rev > 0) { ev = fin.rev * 0.6; basis = '매출×0.6(적자 대용)'; }
  if (ev == null) return null;
  const equity = Math.max(0, ev - Math.max(0, fin.net_debt || 0));
  const control = owner.top_pct ? equity * Math.min(1, Math.max(0.5, owner.top_pct / 100)) : equity * 0.6;
  const minority = equity * 0.2;
  let fit;
  if (minority >= 80 && minority <= 400) fit = '단독 소수지분(100~300억)';
  else if (control >= 800 && control <= 2500) fit = '컨소 슬롯(1,000~2,000억)';
  else if (control < 800 && equity >= 100) fit = '소형 경영권(단독)';
  else if (control > 2500) fit = '대형(컨소 참여만)';
  else fit = '초소형';
  return { ev: Math.round(ev), equity: Math.round(equity), control: Math.round(control), minority: Math.round(minority), mult, basis, fit };
}

// ── 규칙 DSL ─────────────────────────────────────────────────────
function getPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o); }
function evalPred(row, pred) {
  if (Array.isArray(pred) && !Array.isArray(pred[0])) {
    const [f, op, v] = pred; const x = getPath(row, f);
    switch (op) {
      case 'eq': return x === v; case 'ne': return x !== v;
      case 'gt': return x != null && x > v; case 'gte': return x != null && x >= v;
      case 'lt': return x != null && x < v; case 'lte': return x != null && x <= v;
      case 'in': return Array.isArray(v) && v.includes(x); case 'has': return Array.isArray(x) && x.includes(v);
      case 'truthy': return !!x; case 'falsy': return !x; default: return false;
    }
  }
  if (pred.and) return pred.and.every(p => evalPred(row, p));
  if (pred.or) return pred.or.some(p => evalPred(row, p));
  return false;
}
function applyRules(rules, row) {
  const hits = [];
  for (const r of rules) {
    if (r.status === 'retired') continue;
    let ok = false; try { ok = evalPred(row, r.when); } catch { ok = false; }
    if (!ok) continue;
    hits.push({ id: r.id, flag: r.effect.flag, name: r.name, status: r.status });
    if (r.status === 'active' && r.effect.target && r.effect.delta) {
      const parts = r.effect.target.split('.'); const k = parts.pop(); const obj = getPath(row, parts.join('.'));
      if (obj && obj[k] != null) obj[k] = Math.round(clamp(obj[k] + r.effect.delta));
    }
  }
  return hits;
}

module.exports = { num, clamp, last, lastIdx, median, pct, ym, YEAR, OWNER_LABEL, classifyOwner, ownerClock, successionScore, carveoutProb, activistVuln, entryScores, valueupScores, exitScores, ticket, applyRules, evalPred };
