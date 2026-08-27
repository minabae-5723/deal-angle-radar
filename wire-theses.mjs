// 테제 ↔ 외감 유니버스 배선 (리스트업→스크리닝 방식)
// base = funding-panel(41k 외감 전체, 최대 recall) / 상장여부 = corpcode.map.s / need·type = funding-pool overlay
// 출력: data/thesis-candidates.json  (테제별 total + 상위 rows, 관련도·재무·need 스크리닝용)
import fs from 'fs';
const DIR = './data/';
const rd = f => JSON.parse(fs.readFileSync(DIR + f, 'utf8').replace(/^﻿/, ''));

const panel = rd('funding-panel.json').rows;
const pool = rd('funding-pool.json').rows;
const cmap = rd('corpcode.json').map;
const theses = rd('theses.json').theses;

const last = a => Array.isArray(a) ? a[a.length - 1] : a;
// 5년(가용치) CAGR — 양수 시작·끝만 (음수/영 EBITDA·OP는 null)
const cagr = a => {
  if (!Array.isArray(a) || a.length < 2) return null;
  const f = a[0], l = a[a.length - 1];
  if (f == null || l == null || f <= 0 || l <= 0) return null;
  return Math.pow(l / f, 1 / (a.length - 1)) - 1;
};
const listedOf = code => { const e = cmap[String(code)]; return !!(e && e.s && String(e.s).trim() && e.s !== 'null'); };
const needByCode = new Map();
for (const p of pool) if (p.corp_code) needByCode.set(String(p.corp_code), { need: Math.round(p.need || 0), type: p.type || '', fit: Math.round(p.fit || 0) });

// 관대한 KSIC 게이트(3자리 중심, recall 우선) + 관련도 태그용 anchors/keywords
const GATES = {
  S4:  { codes:['261','262','231','232','239','291','292'], kw:['석영','쿼츠','세정','세라믹','파츠','소모품','실리콘','정전척','재생','증착','식각'], anchors:['티씨케이','하나머티리얼즈','월덱스','비씨엔씨','코미코','보부하이테크','원익','싸이노스'] },
  AI5: { codes:['582','620','631','639'], kw:['보안','암호','관제','백신','방화벽','인증','시큐','망연계','제로트러스트','정보보호'], anchors:['지니언스','파수','모니터랩','샌즈랩','지슨','한싹','이글루','드림시큐'] },
  AI4: { codes:['582','620','631','639','261','291','292'], kw:['검사','비전','머신비전','공정','제조','예지','설비','스마트','로봇','자동화','물류'], anchors:['라온피플'] },
  H4:  { codes:['211','212','213','271','731'], kw:['동물','반려','수의','펫','진단','시약','백신'], anchors:['바이오노트','우진비앤지','대성미생물'] },
  H5:  { codes:['271','213','222','201','204'], kw:['치과','임플란트','덴탈','얼라이너','교정','레진','프린팅','보철','스캐너'], anchors:['바텍','레이','디오','덴티스','메타바이오'] },
  S1:  { codes:['201','202','203','204','261','262'], kw:['EMC','언더필','전구체','밀봉','패키징','소재','에폭시','증착'], anchors:['이포트','코파','아이켐스','나믹스'] },
  H2:  { codes:['211','212','213','204','201'], kw:['엑소좀','콜라겐','히알','HA','필러','부스터','재조합','펩타이드'], anchors:['엑소코바이오','파마리서치','휴메딕스','바이오플러스'] },
  H3:  { codes:['211','212','213','271','204'], kw:['패치','니들','경피','마이크로','CDMO','전달'], anchors:['쿼드메디슨','라파스'] },
  AI1: { codes:['582','620','631','639'], kw:['AI','인공지능','LLM','sLLM','거버넌스','언어','에이전트'], anchors:['업스테이지','스켈터','포티투마루','사이오닉'] },
  S2:  { codes:['261','262','231','291','292'], kw:['유리','기판','TGV','코어','검사','연마','후가공'], anchors:['필옵틱스','와이씨켐','기가비스','제이앤티씨'] },
  S3:  { codes:['201','202','203','204','261'], kw:['전구체','몰리브','텅스텐','정제','고순도','배선'], anchors:['레이크머티','디엔에프','후성','한솔케미'] },
  S5:  { codes:['201','204','261','262'], kw:['CMP','슬러리','세정','본딩','활성','정렬','평탄'], anchors:['솔브레인','케이씨텍','동진'] },
  AI2: { codes:['582','620','631','639'], kw:['에이전트','오케스트','SW','소프트','ERP','그룹웨어'], anchors:['인핸스','올거나이즈'] },
  AI3: { codes:['582','620','631','639','861','869'], kw:['의료','EMR','헬스','병원','진단','수가','청구'], anchors:['GC메디아이','이지케어텍','비트컴퓨터','에이아이트릭스'] },
  H1:  { codes:['271','272','282','329','204'], kw:['팁','카트리지','트랜스듀서','니들','미용','에스테틱','초음파','RF'], anchors:['원텍','비올','제이시스','클래시스'] },
};

const startsAny = (code, arr) => arr.some(c => code.startsWith(c));
const out = {};

for (const t of theses) {
  const g = GATES[t.id];
  if (!g) continue;
  const rows = [];
  for (const c of panel) {
    const ind = String(c.ind_code || '');
    const clean = (c.name || '').replace(/\(주\)|주식회사/g, '').trim();
    const hay = `${c.name || ''} ${c.ind_name || ''}`;
    const anchor = g.anchors.some(a => clean === a || (a.length >= 3 && clean.startsWith(a)));
    const codeHit = ind && startsAny(ind, g.codes);
    const kwHit = g.kw.some(k => hay.includes(k));
    if (!(anchor || codeHit || kwHit)) continue;
    const revNow = Math.round(last(c.rev) || 0);
    if (revNow < 100) continue;   // 매출 100억 미만 제외 (전 tier 공통)
    const nd = needByCode.get(String(c.corp_code)) || {};
    const revCagr = cagr(c.rev), opCagr = cagr(c.op), ebCagr = cagr(c.ebitda);
    const opmNow = last(c.opm);
    // 우량 축: 매출 성장 + 흑자 (+ 이익 성장 보너스)
    let qScore = 0;
    if (revCagr != null) qScore += Math.max(0, Math.min(1, revCagr / 0.20)) * 0.45;
    if (opmNow != null) qScore += Math.max(0, Math.min(1, opmNow / 0.15)) * 0.35;
    if (ebCagr != null) qScore += Math.max(0, Math.min(1, ebCagr / 0.20)) * 0.20;
    const quality = revCagr != null && revCagr >= 0.10 && opmNow != null && opmNow >= 0.05;
    rows.push({
      name: c.name, corp_code: c.corp_code, listed: listedOf(c.corp_code), ind_code: ind,
      rev: revNow, opm: opmNow, debt: last(c.debt_ratio),
      revCagr, opCagr, ebCagr, quality, qScore: Math.round(qScore * 100),
      need: nd.need ?? null, type: nd.type || '',
      rel: anchor ? 'anchor' : kwHit ? 'kw' : 'base'
    });
  }
  const relRank = { anchor: 0, kw: 1, base: 2 };
  const blend = r => Math.max(r.qScore || 0, r.need || 0);  // 우량 or 조달니즈 둘 중 강한 축
  rows.sort((a, b) =>
    relRank[a.rel] - relRank[b.rel] ||
    (blend(b) - blend(a)) ||
    (b.rev - a.rev));
  out[t.id] = {
    title: t.title, total: rows.length,
    unlisted: rows.filter(r => !r.listed).length,
    anchors: rows.filter(r => r.rel === 'anchor').length,
    withNeed: rows.filter(r => r.need != null).length,
    quality: rows.filter(r => r.quality).length,
    rows: rows.slice(0, 80)
  };
  console.log(`${t.id.padEnd(4)} ${String(rows.length).padStart(4)}개 (비상장 ${out[t.id].unlisted} · 앵커 ${out[t.id].anchors} · need보유 ${out[t.id].withNeed}) — ${t.title}`);
}

// DART 사업내용 스크린 병합 (trace-business.ps1 산출물) — 오탐 필터·진짜 벤더 확인
let biz = {}, bizN = 0;
try { biz = rd('business-desc.json'); } catch (e) {}
for (const id in out) {
  for (const r of out[id].rows) {
    const b = biz[r.corp_code];
    if (b) { r.biz = b.desc; r.bizFit = !!b.fit; r.screened = true; bizN++; }
  }
}
console.log('사업내용 병합: ' + bizN + '행');

// LLM 큐레이션 병합 — 제품·앵글·onThesis. 테제별 스코프(curate-assign.json)로 코드겹침 오적용 방지
let cur = {}, curN = 0, assign = {};
try { assign = rd('curate-assign.json'); } catch (e) {}
try {
  for (const f of fs.readdirSync(DIR + 'curated-parts')) {
    if (f.endsWith('.json')) Object.assign(cur, rd('curated-parts/' + f));
  }
} catch (e) {}
for (const id in out) {
  const assigned = new Set(((assign[id] && assign[id].companies) || []).map(c => String(c.corp_code)));
  for (const r of out[id].rows) {
    const cc = cur[r.corp_code];
    if (cc && assigned.has(String(r.corp_code))) {
      r.curProduct = cc.product; r.curAngle = cc.angle; r.onThesis = cc.onThesis; r.curated = true; curN++;
    }
  }
  // 확정(onThesis) 우선 → 미큐레이션 → 오프테제 순
  const rank = r => r.curated ? (r.onThesis ? 0 : 2) : 1;
  const blend = r => Math.max(r.qScore || 0, r.need || 0);
  out[id].rows.sort((a, b) => rank(a) - rank(b) || (blend(b) - blend(a)));
  out[id].onThesis = out[id].rows.filter(r => r.curated && r.onThesis).length;
}
console.log('큐레이션 병합: ' + curN + '행');

fs.writeFileSync(DIR + 'thesis-candidates.json', JSON.stringify(out));
console.log('\n→ data/thesis-candidates.json 저장 (' + Object.keys(out).length + '개 테제)');
