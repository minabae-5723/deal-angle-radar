// pe-lens/fetch-owner.js — Owner Lens 원자료 수집 (DART 정기보고서 주요정보 API)
//
// 대상: 상장사(corpcode.map 의 s != null) ∩ funding-panel(재무 있음) + pe-registry 수록 기업
// API : hyslrSttus(최대주주·특수관계인) · exctvSttus(임원 생년·최대주주 관계) · hyslrChgSttus(최대주주 변동)
//       alotMatter(배당) · tesstkAcqsDspsSttus(자기주식) · irdsSttus(증자·감자)
// 출력: data/pe-owner.json  { meta, byCorp:{ corp_code: {y, hyslr[], exctv[], chg[], alot[], tesstk[], irds[], err} } }
//
// 규율(reference_dart_api_throttle): 동시성 1 · 호출간격 ≥ INTERVAL ms · 연속실패 20건이면 중단 ·
// 증분(이미 받은 corp 스킵) · 50건마다 저장 · 실패 회차가 기존 데이터를 덮어쓰지 않음.
//
// 사용:  node pe-lens/fetch-owner.js [--year 2025] [--limit N] [--only registry|pool|all] [--force] [--interval 600]
const fs = require('fs');
const path = require('path');
const { getJson, sleep } = require('../funding/lib-dart.js');
const { DATA_DIR, dartKey } = require('../funding/config.js');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.includes('--' + k);
const YEAR = +opt('year', 2025);
const LIMIT = +opt('limit', 0) || Infinity;
const ONLY = opt('only', 'all');
const INTERVAL = +opt('interval', 600);
const FORCE = flag('force');

const OUT = path.join(DATA_DIR, 'pe-owner.json');
const APIS = ['hyslrSttus', 'exctvSttus', 'hyslrChgSttus', 'alotMatter', 'tesstkAcqsDspsSttus', 'irdsSttus'];
const KEYMAP = { hyslrSttus: 'hyslr', exctvSttus: 'exctv', hyslrChgSttus: 'chg', alotMatter: 'alot', tesstkAcqsDspsSttus: 'tesstk', irdsSttus: 'irds' };

function loadJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }

// 응답 슬림화: main_career 등 장문 제거, 숫자 문자열은 그대로(빌드에서 파싱)
function slim(api, list) {
  if (!Array.isArray(list)) return [];
  return list.map(r => {
    const o = {};
    for (const [k, v] of Object.entries(r)) {
      if (['rcept_no', 'corp_cls', 'corp_code', 'corp_name', 'stlm_dt', 'main_career'].includes(k)) continue;
      o[k] = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v;
    }
    return o;
  });
}

async function fetchOne(key, corp, year) {
  const out = { y: year, at: new Date().toISOString() };
  for (const api of APIS) {
    const url = `https://opendart.fss.or.kr/api/${api}.json?crtfc_key=${key}&corp_code=${corp}&bsns_year=${year}&reprt_code=11011`;
    const j = await getJson(url);
    if (j.status === '000') out[KEYMAP[api]] = slim(api, j.list);
    else if (j.status === '013') out[KEYMAP[api]] = [];               // 조회 결과 없음
    else if (j.status === '020' || j.status === '800' || j.status === '900') throw new Error(`DART ${j.status} ${j.message}`); // 한도·서버·키
    else out[KEYMAP[api]] = [];
    await sleep(INTERVAL);
  }
  return out;
}

async function main() {
  const key = dartKey();
  const corpmap = loadJson(path.join(DATA_DIR, 'corpcode.json'), { map: {} }).map;
  const panel = loadJson(path.join(DATA_DIR, 'funding-panel.json'), { rows: [] });
  const pool = loadJson(path.join(DATA_DIR, 'funding-pool.json'), { rows: [] });
  const narr = loadJson(path.join(DATA_DIR, 'narrative-pool.json'), { themes: [] });
  const registry = loadJson(path.join(DATA_DIR, 'pe-registry.json'), { companies: [] });
  const prev = loadJson(OUT, { meta: {}, byCorp: {} });

  const panelRev = new Map();
  for (const r of panel.rows) {
    const rev = (r.rev || []).filter(v => v != null).pop();
    panelRev.set(r.corp_code, rev == null ? 0 : rev);
  }
  // 우선순위: registry → pool 상장 → narrative 상장 → 나머지 상장(매출 내림차순)
  const order = [];
  const seen = new Set();
  const push = (c, why) => { if (c && !seen.has(c) && corpmap[c]) { seen.add(c); order.push({ c, why }); } };
  for (const r of registry.companies) push(r.corp_code, 'registry');
  if (ONLY !== 'registry') {
    for (const r of pool.rows) if (r.listed || r.stock_code) push(r.corp_code, 'pool');
    for (const t of narr.themes) for (const l of (t.longlist || [])) if (corpmap[l.corp] && corpmap[l.corp].s) push(l.corp, 'narrative');
    if (ONLY === 'all') {
      const listed = Object.entries(corpmap).filter(([c, v]) => v.s && panelRev.has(c))
        .sort((a, b) => panelRev.get(b[0]) - panelRev.get(a[0]));
      for (const [c] of listed) push(c, 'listed');
    }
  }
  const todo = order.filter(o => FORCE || !prev.byCorp[o.c] || prev.byCorp[o.c].err || prev.byCorp[o.c].y < YEAR).slice(0, LIMIT);
  console.log(`universe ${order.length} · cached ${order.length - todo.length} · todo ${todo.length} · year ${YEAR} · interval ${INTERVAL}ms`);

  let fails = 0, done = 0;
  const save = () => {
    prev.meta = { generated: new Date().toISOString(), year: YEAR, universe: order.length, cached: Object.keys(prev.byCorp).length, apis: APIS };
    fs.writeFileSync(OUT, JSON.stringify(prev));
  };
  for (const { c, why } of todo) {
    try {
      let r = await fetchOne(key, c, YEAR);
      // 사업보고서 미제출(결산기 상이·신규상장) → 전년도 폴백
      if (!r.hyslr.length && !r.exctv.length) { r = await fetchOne(key, c, YEAR - 1); r.fallback = true; }
      r.why = why;
      prev.byCorp[c] = r;
      fails = 0;
    } catch (e) {
      fails++;
      if (!prev.byCorp[c]) prev.byCorp[c] = { y: YEAR, err: e.message, at: new Date().toISOString(), why };
      console.error(`✗ ${c} ${corpmap[c].n}: ${e.message}`);
      if (fails >= 20) { console.error('연속 실패 20건 — 스로틀/차단 의심, 중단'); break; }
      await sleep(5000);
    }
    done++;
    if (done % 50 === 0) { save(); console.log(`… ${done}/${todo.length}`); }
  }
  save();
  console.log(`done ${done} · total cached ${Object.keys(prev.byCorp).length} → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
