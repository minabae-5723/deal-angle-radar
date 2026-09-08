// pe-lens/fetch-market.js — 상장사 시세 스냅샷 (네이버 모바일 증권 API)
// 시총·PER·PBR·EPS·BPS·52주·배당수익률 → data/pe-market.json { meta, byCode:{stock_code:{...}} }
// 대상: pe-owner.json 에 수집된 상장사 (없으면 corpcode 상장사 전체)
// 사용: node pe-lens/fetch-market.js [--limit N] [--force] [--interval 250]
const fs = require('fs');
const path = require('path');
const { getJson, sleep } = require('../funding/lib-dart.js');
const { DATA_DIR } = require('../funding/config.js');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const LIMIT = +opt('limit', 0) || Infinity;
const INTERVAL = +opt('interval', 250);
const FORCE = args.includes('--force');
const OUT = path.join(DATA_DIR, 'pe-market.json');
const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

// "2조 9,786억" → 억원 / "18.54배" → 18.54 / "243,000" → 243000 / "N/A" → null
function num(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s || /N\/A|-/.test(s) && !/\d/.test(s)) return null;
  let m = s.match(/^(?:(-?[\d,.]+)조)?\s*(?:(-?[\d,.]+)억)?$/);
  if (m && (m[1] || m[2])) return (m[1] ? parseFloat(m[1].replace(/,/g, '')) * 10000 : 0) + (m[2] ? parseFloat(m[2].replace(/,/g, '')) : 0);
  m = s.match(/-?[\d,]+(\.\d+)?/);
  return m ? parseFloat(m[0].replace(/,/g, '')) : null;
}

async function main() {
  const owner = load(path.join(DATA_DIR, 'pe-owner.json'), { byCorp: {} });
  const corpmap = load(path.join(DATA_DIR, 'corpcode.json'), { map: {} }).map;
  const prev = load(OUT, { meta: {}, byCode: {} });
  const today = new Date().toISOString().slice(0, 10);

  let codes = Object.keys(owner.byCorp).map(c => corpmap[c] && corpmap[c].s).filter(Boolean);
  if (!codes.length) codes = Object.values(corpmap).map(v => v.s).filter(Boolean);
  const todo = codes.filter(s => FORCE || !prev.byCode[s] || prev.byCode[s].date !== today).slice(0, LIMIT);
  console.log(`codes ${codes.length} · todo ${todo.length}`);

  let done = 0, fails = 0;
  const save = () => { prev.meta = { generated: new Date().toISOString(), n: Object.keys(prev.byCode).length }; fs.writeFileSync(OUT, JSON.stringify(prev)); };
  for (const s of todo) {
    try {
      const j = await getJson(`https://m.stock.naver.com/api/stock/${s}/integration`);
      const t = {};
      for (const it of (j.totalInfos || [])) t[it.code] = it.value;
      prev.byCode[s] = {
        date: today, name: j.stockName,
        price: num(t.lastClosePrice), mcap: num(t.marketValue),           // 억원
        per: num(t.per), pbr: num(t.pbr), eps: num(t.eps), bps: num(t.bps),
        cns_per: num(t.cnsPer), hi52: num(t.highPriceOf52Weeks), lo52: num(t.lowPriceOf52Weeks),
        dy: num(t.dividendYieldRatio), dps: num(t.dividend), foreign: num(t.foreignRate),
      };
      fails = 0;
    } catch (e) {
      // 4xx(409/404) = 네이버 미등록 코드(스팩·상폐·ETF 등) → 결손 처리, 연속실패 카운트 제외
      if (/HTTP 4\d\d/.test(e.message)) { prev.byCode[s] = { date: today, nf: true }; }
      else { fails++; if (!prev.byCode[s]) prev.byCode[s] = { date: today, err: e.message }; if (fails >= 15) { console.error('연속 실패 15건 — 중단'); break; } }
    }
    done++;
    if (done % 100 === 0) { save(); console.log(`… ${done}/${todo.length}`); }
    await sleep(INTERVAL);
  }
  save();
  console.log(`done ${done} → ${OUT}`);
}
main().catch(e => { console.error(e); process.exit(1); });
