// pe-lens.js — 知PE知己 · PE Lens 스크리너 뷰 (Deal Angle Radar 6번째 탭, 로컬 전용)
// data/pe-lens-pool.json(빌드 산출) + pe-cases/pe-policy/pe-playbook/pe-rules/pe-theses 를 읽어 6개 서브뷰를 렌더.
// 데이터 생성은 pe-lens\build-pe-lens.js. 이 파일은 표시·상호작용만 담당 (순수 렌더, 서버 쓰기 없음 → 파이프라인은 localStorage + 스킬 반영).
(() => {
  const URLS = { pool: './data/pe-lens-pool.json', cases: './data/pe-cases.json', policy: './data/pe-policy.json', playbook: './data/pe-playbook.json', rules: './data/pe-rules.json', theses: './data/pe-theses.json' };
  let D = null, loaded = false;
  const S = { view: 'radar', q: '', owners: new Set(), entry: 'all', fit: 'all', listing: 'all', div: 'all', sort: 'attention', desc: true, limit: 80, sel: null, caseOutcome: 'all', caseType: 'all', caseMarket: 'KR', pipeFilter: 'all' };
  const LS_KEY = 'pelens.pipeline.v1';

  // ── 헬퍼 ────────────────────────────────────────────────────────
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const nn = v => v == null || !isFinite(v);
  const won = v => nn(v) ? '—' : Math.abs(v) >= 10000 ? (v / 10000).toFixed(1) + '조' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() + '억' : v.toFixed(0) + '억';
  const pct = (v, d = 0) => nn(v) ? '—' : (v * 100).toFixed(d) + '%';
  const x = v => nn(v) ? '—' : v.toFixed(1) + 'x';
  const sc = v => nn(v) ? '—' : Math.round(v);
  const bar = (v, cls = '') => nn(v) ? '<span class="pl-bar pl-bar-na"></span>' : `<span class="pl-bar ${cls} ${v >= 70 ? 'hi' : v >= 45 ? 'mid' : 'lo'}"><i style="width:${Math.max(2, Math.min(100, v))}%"></i><b>${Math.round(v)}</b></span>`;
  const OWNER_CLS = { PE_CONTROL: 'pe', PE_MINORITY: 'pem', PE_PENDING: 'pe', ACTIVIST_TARGET: 'act', FOUNDER: 'fnd', FAMILY_2G: 'fam', HOLDCO_PRIVATE: 'hold', GROUP_SUB: 'grp', GOVT: 'gov', FOREIGN_SUB: 'for', DISPERSED: 'dis', UNKNOWN: 'unk' };
  const ENTRY_LABEL = { p2p: 'P2P', lbo: '바이아웃', pipe: '소수지분', mbo: 'MBO', carve_out: '카브아웃', secondary: 'SBO', rollup: '롤업', distressed: '디스트레스', mezz: '메자닌', activist: '행동주의', succession: '승계' };
  const VU_LABEL = { ops: '경상개선', bolt_on: '볼트온', recap: '리캡', dividend: '배당', governance: '지배구조', pricing_geo: '성장', carve_out_sale: '사업부매각', capital_reduction: '유상감자', reduction_dividend: '감액배당', sale_leaseback: 'S&LB', mgmt_align: '경영진정렬' };
  const EXIT_LABEL = { trade_sale_si: 'SI 매각', trade_sale_fi: 'SBO', ipo: 'IPO', block_deal: '블록딜', recap_only: '리캡회수', partial_sale: '부분매각', cv: 'CV', dual_track: '듀얼트랙', court: '회생' };
  const OUT_LABEL = { success: '성공', failure: '실패', mixed: '혼합', ongoing: '진행' };
  const DT_LABEL = { buyout: '바이아웃', p2p: 'P2P', carve_out: '카브아웃', growth_minority: '소수지분', mezzanine: '메자닌', distressed: '디스트레스', secondary: 'SBO', rollup: '롤업', mbo: 'MBO', activist: '행동주의', pipe: 'PIPE' };
  const topN = (obj, n, lab) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, v, label: lab[k] || k }));
  const dartUrl = c => `https://dart.fss.or.kr/dsab007/main.do?option=corp&textCrpNm=${encodeURIComponent(c)}`;
  const naverUrl = s => `https://m.stock.naver.com/domestic/stock/${s}/total`;

  // ── 데이터 로드 ──────────────────────────────────────────────────
  async function load() {
    const get = async (u, d) => { try { const r = await fetch(u + '?t=' + Date.now()); if (!r.ok) return d; return await r.json(); } catch { return d; } };
    const [pool, cases, policy, playbook, rules, theses] = await Promise.all([get(URLS.pool, null), get(URLS.cases, { cases: [] }), get(URLS.policy, { items: [] }), get(URLS.playbook, {}), get(URLS.rules, { rules: [] }), get(URLS.theses, { theses: [] })]);
    if (!pool) throw new Error('pe-lens-pool.json 없음 — node pe-lens/build-pe-lens.js 를 먼저 실행');
    D = { pool, cases: cases.cases || [], policy: policy.items || [], playbook, rules: rules.rules || [], theses: theses.theses || [] };
    D.byCorp = new Map(pool.rows.map(r => [r.corp_code, r]));
    D.caseBy = new Map(D.cases.map(c => [c.id, c]));
    loaded = true;
  }

  // ── 파이프라인(localStorage) ─────────────────────────────────────
  const STAGES = ['idea', 'screening', 'contact', 'dd', 'ic', 'closed', 'dropped'];
  const STAGE_LABEL = { idea: '아이디어', screening: '스크리닝', contact: '컨택', dd: 'DD', ic: 'IC', closed: '클로징', dropped: '드롭' };
  function lsLoad() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } }
  function lsSave(a) { try { localStorage.setItem(LS_KEY, JSON.stringify(a)); } catch { } }
  function pipelineAll() {
    const local = lsLoad(); const byId = new Map();
    for (const t of D.theses) byId.set(t.id || t.corp_code, Object.assign({ src: 'file' }, t));
    for (const t of local) byId.set(t.id || t.corp_code, Object.assign(byId.get(t.id || t.corp_code) || {}, t, { src: byId.has(t.id || t.corp_code) ? 'both' : 'local' }));
    return [...byId.values()];
  }
  function pipelineAdd(row) {
    const local = lsLoad(); const id = 'T-' + row.corp_code;
    if (local.find(t => t.id === id) || D.theses.find(t => t.id === id)) { toast('이미 파이프라인에 있음'); return; }
    local.push({ id, corp_code: row.corp_code, name: row.name, stage: 'idea', created: new Date().toISOString().slice(0, 10), entry: row.entry_top && row.entry_top.id, owner_type: row.owner.type, ticket_fit: row.ticket && row.ticket.fit, note: '' });
    lsSave(local); toast(`${row.name} → 파이프라인(아이디어)`); render();
  }
  function pipelineMove(id, dir) {
    const local = lsLoad(); let t = local.find(t => t.id === id);
    if (!t) { const f = D.theses.find(t => t.id === id); if (!f) return; t = Object.assign({}, f); local.push(t); }
    const i = STAGES.indexOf(t.stage || 'idea'); const ni = Math.max(0, Math.min(STAGES.length - 1, i + dir)); t.stage = STAGES[ni]; t.updated = new Date().toISOString().slice(0, 10);
    lsSave(local); render();
  }
  function pipelineNote(id, note) { const local = lsLoad(); let t = local.find(t => t.id === id); if (!t) { const f = D.theses.find(t => t.id === id); if (!f) return; t = Object.assign({}, f); local.push(t); } t.note = note; t.updated = new Date().toISOString().slice(0, 10); lsSave(local); }
  function pipelineDrop(id) { const local = lsLoad().filter(t => t.id !== id); lsSave(local); render(); }
  let toastT = null;
  function toast(msg) { let el = document.getElementById('plToast'); if (!el) { el = document.createElement('div'); el.id = 'plToast'; el.className = 'pl-toast'; document.body.appendChild(el); } el.textContent = msg; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2200); }
  function copy(text, msg) { navigator.clipboard && navigator.clipboard.writeText(text).then(() => toast(msg || '복사됨'), () => toast('복사 실패')); }

  // ── 필터·정렬 ────────────────────────────────────────────────────
  function filtered() {
    const q = S.q.trim().toLowerCase();
    let rows = D.pool.rows.filter(r => {
      if (q && !(r.name.toLowerCase().includes(q) || (r.stock_code || '').includes(q) || (r.fin.industry || '').includes(q) || (r.owner.top_name || '').toLowerCase().includes(q) || (r.registry && r.registry.sponsor || '').toLowerCase().includes(q))) return false;
      if (S.owners.size && !S.owners.has(r.owner.type)) return false;
      if (S.entry !== 'all' && !(r.lens.entry[S.entry] >= 40)) return false;
      if (S.fit !== 'all' && !(r.ticket && r.ticket.fit === S.fit)) return false;
      if (S.listing === 'listed' && !r.listed) return false;
      if (S.listing === 'unlisted' && r.listed) return false;
      if (S.div !== 'all' && r.fin.div2 !== S.div) return false;
      return true;
    });
    const key = r => {
      switch (S.sort) {
        case 'attention': return r.attention;
        case 'owner': return r.owner_pressure;
        case 'entry': return S.entry !== 'all' ? (r.lens.entry[S.entry] || 0) : (r.entry_top ? r.entry_top.score : 0);
        case 'rev': return r.fin.rev || 0;
        case 'ebitda': return r.fin.ebitda || 0;
        case 'opm': return r.fin.opm == null ? -9 : r.fin.opm;
        case 'equity': return r.ticket ? r.ticket.equity : 0;
        case 'pbr': return r.mkt && r.mkt.pbr != null ? r.mkt.pbr : 99;
        case 'age': return r.owner.age || 0;
        default: return r.attention;
      }
    };
    rows.sort((a, b) => (S.desc ? key(b) - key(a) : key(a) - key(b)) || a.name.localeCompare(b.name));
    return rows;
  }

  // ── 렌더: 골격 ───────────────────────────────────────────────────
  function render() {
    const root = document.getElementById('pelensRoot'); if (!root || !D) return;
    const st = D.pool.stats, m = D.pool.meta;
    const counts = { radar: st.n, owners: (st.by_owner.PE_CONTROL || 0) + (st.by_owner.PE_MINORITY || 0) + (st.by_owner.PE_PENDING || 0), cases: D.cases.length, policy: D.policy.length, playbook: (D.playbook.entry || []).length, pipeline: pipelineAll().length };
    const tabs = [['radar', '🔭 레이더'], ['owners', '⏱ PE 보유기업 시계'], ['cases', '📚 케이스·규칙'], ['policy', '🏛 정책 레이더'], ['playbook', '📖 플레이북'], ['pipeline', '🗂 파이프라인']];
    root.innerHTML = `
      <div class="pl-head">
        <div class="pl-title"><span class="pl-kanji">知PE知己</span><div><h2>PE Lens 스크리너</h2><p>최대주주의 유인구조가 선행지표 · Entry → Value-up → Exit 렌즈로 41k 외감 패널을 읽는다. 스코어는 상대순위용 prior, 근거 카드가 판단의 단위.</p></div></div>
        <div class="pl-meta">빌드 ${esc((m.generated || '').slice(0, 16).replace('T', ' '))} · DART 오너 ${st.owner_coverage}사 · 시세 ${esc((m.market_generated || '—').slice(0, 10))} · 규칙 ${m.rules_active}개 활성 · 케이스 ${D.cases.length}건</div>
      </div>
      <nav class="pl-subnav">${tabs.map(([k, l]) => `<button class="pl-tab ${S.view === k ? 'on' : ''}" data-v="${k}">${l}<em>${counts[k]}</em></button>`).join('')}</nav>
      <div id="plBody"></div>`;
    root.querySelectorAll('.pl-tab').forEach(b => b.onclick = () => { S.view = b.dataset.v; S.sel = null; render(); });
    const body = root.querySelector('#plBody');
    ({ radar: renderRadar, owners: renderOwners, cases: renderCases, policy: renderPolicy, playbook: renderPlaybook, pipeline: renderPipeline })[S.view](body);
    renderDrawer();
  }

  // ── 레이더 ───────────────────────────────────────────────────────
  function renderRadar(body) {
    const st = D.pool.stats; const rows = filtered();
    const ownerTypes = Object.entries(st.by_owner).filter(([k]) => k !== 'UNKNOWN').sort((a, b) => b[1] - a[1]);
    const divs = Object.entries(D.pool.industries || {}).sort((a, b) => b[1].n - a[1].n);
    const kpi = [
      ['유니버스', st.n.toLocaleString(), `상장 ${st.listed.toLocaleString()} · 비상장 ${(st.n - st.listed).toLocaleString()}`],
      ['PE 경영권 보유', st.pe_control, `exit 압력 70+ · ${st.exit_pressure_high}사`],
      ['승계 압력 65+', st.succession_high, '창업주 고령 · 차세대 부재'],
      ['카브아웃 후보', st.carveout_high, '그룹 계열 · 비핵심·모회사 레버리지'],
      ['DART 오너 판독', st.owner_coverage, `미판독 ${(st.by_owner.UNKNOWN || 0).toLocaleString()} (비상장 대부분)`],
      ['규칙 히트', Object.values(st.rule_hits).reduce((a, b) => a + b, 0).toLocaleString(), `${Object.keys(st.rule_hits).length}개 규칙 발동`],
    ];
    body.innerHTML = `
      <div class="pl-kpis">${kpi.map(([l, v, s]) => `<div class="pl-kpi"><div class="pl-kpi-l">${l}</div><div class="pl-kpi-v">${v}</div><div class="pl-kpi-s">${s}</div></div>`).join('')}</div>
      <div class="pl-filters">
        <input class="pl-search" id="plQ" placeholder="기업명 · 종목코드 · 업종 · 최대주주 · 스폰서" value="${esc(S.q)}">
        <div class="pl-chips" id="plOwnerChips"><span class="pl-flab">오너</span>${ownerTypes.map(([k, n]) => `<button class="pl-chip oc-${OWNER_CLS[k]} ${S.owners.has(k) ? 'on' : ''}" data-o="${k}">${esc(D.pool.meta.owner_labels[k] || k)}<em>${n}</em></button>`).join('')}</div>
        <div class="pl-row">
          <label>진입구조 <select id="plEntry"><option value="all">전체</option>${Object.entries(ENTRY_LABEL).map(([k, l]) => `<option value="${k}" ${S.entry === k ? 'selected' : ''}>${l} (${st.by_entry_top[k] || 0})</option>`).join('')}</select></label>
          <label>티켓 <select id="plFit"><option value="all">전체</option>${['단독 소수지분(100~300억)', '소형 경영권(단독)', '컨소 슬롯(1,000~2,000억)', '대형(컨소 참여만)', '초소형'].map(f => `<option ${S.fit === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
          <label>상장 <select id="plListing"><option value="all" ${S.listing === 'all' ? 'selected' : ''}>전체</option><option value="listed" ${S.listing === 'listed' ? 'selected' : ''}>상장</option><option value="unlisted" ${S.listing === 'unlisted' ? 'selected' : ''}>비상장</option></select></label>
          <label>업종 <select id="plDiv"><option value="all">전체</option>${divs.map(([k, v]) => `<option value="${k}" ${S.div === k ? 'selected' : ''}>${k} ${esc(v.name || '')} (${v.n})</option>`).join('')}</select></label>
          <label>정렬 <select id="plSort">${[['attention', '주목도'], ['owner', '오너 압력'], ['entry', '진입구조 점수'], ['rev', '매출'], ['ebitda', 'EBITDA'], ['opm', 'OPM'], ['equity', '지분가치'], ['pbr', 'PBR'], ['age', '오너 연령']].map(([k, l]) => `<option value="${k}" ${S.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <span class="pl-count">${rows.length.toLocaleString()}사</span>
          ${(S.q || S.owners.size || S.entry !== 'all' || S.fit !== 'all' || S.listing !== 'all' || S.div !== 'all') ? '<button class="pl-clear" id="plClear">✕ 필터 해제</button>' : ''}
        </div>
      </div>
      <div class="pl-tablewrap"><table class="pl-table">
        <thead><tr><th class="tl">기업</th><th class="tl">오너 렌즈 <span class="pl-th-sub">유형 · 압력</span></th><th class="tl">진입 구조 <span class="pl-th-sub">적합 top2</span></th><th class="tl">밸류업 레버</th><th class="tl">출구</th><th>티켓 <span class="pl-th-sub">지분가치</span></th><th>매출</th><th>OPM</th><th>ND/EBITDA</th><th>주목도</th></tr></thead>
        <tbody>${rows.slice(0, S.limit).map(rowHtml).join('')}</tbody></table>
        ${rows.length > S.limit ? `<button class="pl-more" id="plMore">더 보기 (${rows.length - S.limit}사 남음)</button>` : ''}
      </div>
      <details class="pl-method"><summary>읽는 법 · 스코어 정의</summary>
        <div class="pl-method-body">
          <p><b>오너 렌즈</b>가 선행지표다. PE 경영권 기업은 <b>exit 압력</b>(보유연차 0.55 + 펀드잔존 0.35 + 회수율·인수금융 만기 조정)과 <b>밸류업 유인</b>(1−회수율). 개인 오너는 <b>승계 압력</b>(연령·차세대 임원 부재·지분·저PBR). 그룹 계열은 <b>카브아웃 확률</b>(비핵심·소형·모회사 레버리지). 분산 지분은 <b>행동주의 취약성</b>.</p>
          <p><b>진입 구조</b> 11종 적합도(0~100)는 오너 유형 × 재무(EBITDA 마진·차입여력·안정성) × 시세(PBR·시총) × 정책(의무공개매수 역풍)으로 산출. <b>밸류업 레버</b>는 업종 중위 대비 마진 갭(경상개선), 파편화·타겟 수(볼트온), 3.5x 대비 차입여력(리캡), 순현금·이익(배당), 자사주·특수관계인 수(지배구조). <b>출구</b>는 업종 내 순현금 대형사 수(SI), 케이스 라이브러리 내 동종 거래 수(SBO), 규모·수익성(IPO), 차입여력(리캡회수).</p>
          <p><b>주목도</b> = 0.45·진입 최고점 + 0.35·오너 압력 + 0.2·밸류업 상위2 평균 − 데이터 결손 감점. 규칙(R1~R17)은 케이스에서 추출한 선행지표로 해당 스코어를 가감하고 플래그를 단다. <b>티켓</b>: 상장=시총×1.25+순차입, 비상장=EBITDA×업종배수. 자금 전제는 RVP 케이스맵(단독 100~300억 소수지분 / 컨소 1,000~2,000억).</p>
          <p>규율: 억지 앵글 금지("딜 앵글 없다"도 결론). 스코어는 순위용, 판단은 근거 카드로. 사후 가설은 규칙 증거에서 제외(cycle-tracker와 동일).</p>
        </div></details>`;
    const q = body.querySelector('#plQ'); q.oninput = () => { S.q = q.value; S.limit = 80; refreshTable(); };
    body.querySelectorAll('#plOwnerChips .pl-chip').forEach(b => b.onclick = () => { const k = b.dataset.o; S.owners.has(k) ? S.owners.delete(k) : S.owners.add(k); render(); });
    body.querySelector('#plEntry').onchange = e => { S.entry = e.target.value; if (S.entry !== 'all') S.sort = 'entry'; render(); };
    body.querySelector('#plFit').onchange = e => { S.fit = e.target.value === '전체' ? 'all' : e.target.value; render(); };
    body.querySelector('#plListing').onchange = e => { S.listing = e.target.value; render(); };
    body.querySelector('#plDiv').onchange = e => { S.div = e.target.value; render(); };
    body.querySelector('#plSort').onchange = e => { S.sort = e.target.value; render(); };
    const cl = body.querySelector('#plClear'); if (cl) cl.onclick = () => { Object.assign(S, { q: '', owners: new Set(), entry: 'all', fit: 'all', listing: 'all', div: 'all', sort: 'attention' }); render(); };
    const more = body.querySelector('#plMore'); if (more) more.onclick = () => { S.limit += 120; render(); };
    body.querySelectorAll('tr[data-c]').forEach(tr => tr.onclick = () => { S.sel = tr.dataset.c; renderDrawer(); });
    function refreshTable() { const rows = filtered(); const tb = body.querySelector('tbody'); tb.innerHTML = rows.slice(0, S.limit).map(rowHtml).join(''); body.querySelector('.pl-count').textContent = rows.length.toLocaleString() + '사'; tb.querySelectorAll('tr[data-c]').forEach(tr => tr.onclick = () => { S.sel = tr.dataset.c; renderDrawer(); }); }
  }
  function ownerCell(r) {
    const o = r.owner; const cls = OWNER_CLS[o.type] || 'unk';
    let sub = '';
    if (o.type === 'PE_CONTROL' || o.type === 'PE_MINORITY' || o.type === 'PE_PENDING') sub = `${esc(o.sponsor || o.top_name || '')}${o.hold_years != null ? ` · ${o.hold_years}y` : ''}${o.recovery_ratio != null ? ` · 회수 ${Math.round(o.recovery_ratio * 100)}%` : ''}`;
    else if (o.type === 'FOUNDER' || o.type === 'FAMILY_2G') sub = `${esc(o.top_name || '')}${o.top_pct != null ? ` ${o.top_pct}%` : ''}${o.age ? ` · ${o.age}세` : ''}${o.family_next_gen ? ` · 2세 ${o.family_next_gen}` : ''}`;
    else if (o.type === 'UNKNOWN') sub = r.listed ? 'DART 미수집' : '비상장 · 사업보고서 없음';
    else sub = `${esc(o.top_name || '')}${o.top_pct != null ? ` ${o.top_pct}%` : ''}`;
    return `<div class="pl-oc"><span class="pl-otag oc-${cls}">${esc(o.label || o.type)}</span>${r.owner_pressure ? bar(r.owner_pressure, 'thin') : ''}<div class="pl-sub">${sub}</div></div>`;
  }
  function rowHtml(r) {
    const e = topN(r.lens.entry, 2, ENTRY_LABEL), v = topN(r.lens.valueup, 2, VU_LABEL), xo = topN(r.lens.exit, 1, EXIT_LABEL);
    const flags = (r.rule_hits || []).filter(h => h.status === 'active').slice(0, 2).map(h => `<span class="pl-flag" title="${esc(h.name)}">${esc(h.flag)}</span>`).join('');
    return `<tr data-c="${r.corp_code}" class="${S.sel === r.corp_code ? 'sel' : ''}">
      <td class="tl"><div class="pl-nm">${esc(r.name)} ${r.listed ? `<span class="pl-b b-listed">${esc(r.stock_code || '상장')}</span>` : '<span class="pl-b b-unlisted">비상장</span>'}</div><div class="pl-sub">${esc(r.fin.industry || '')}${r.narratives && r.narratives.length ? ` · <span class="pl-narr" title="${esc(r.narratives.map(n => n.theme).join(', '))}">📐${r.narratives.length}</span>` : ''}${flags}</div></td>
      <td class="tl">${ownerCell(r)}</td>
      <td class="tl">${e.map(t => `<span class="pl-sc"><span>${t.label}</span>${bar(t.v, 'thin')}</span>`).join('')}</td>
      <td class="tl">${v.map(t => `<span class="pl-sc"><span>${t.label}</span>${bar(t.v, 'thin')}</span>`).join('')}</td>
      <td class="tl">${xo.map(t => `<span class="pl-sc"><span>${t.label}</span>${bar(t.v, 'thin')}</span>`).join('')}</td>
      <td>${r.ticket ? `<div>${won(r.ticket.equity)}</div><div class="pl-sub">${esc(r.ticket.fit)}</div>` : '—'}</td>
      <td>${won(r.fin.rev)}<div class="pl-sub">${r.fin.year || ''}</div></td>
      <td class="${r.fin.opm < 0 ? 'neg' : ''}">${pct(r.fin.opm, 1)}</td>
      <td>${r.fin.nd_ebitda == null ? (r.fin.net_debt < 0 ? '<span class="pos">순현금</span>' : '—') : x(r.fin.nd_ebitda)}</td>
      <td>${bar(r.attention)}</td></tr>`;
  }

  // ── 드로어(상세) ─────────────────────────────────────────────────
  function renderDrawer() {
    let dw = document.getElementById('plDrawer');
    if (!S.sel) { if (dw) dw.remove(); document.body.classList.remove('pl-drawer-open'); return; }
    const r = D.byCorp.get(S.sel); if (!r) return;
    if (!dw) { dw = document.createElement('aside'); dw.id = 'plDrawer'; dw.className = 'pl-drawer'; document.body.appendChild(dw); }
    document.body.classList.add('pl-drawer-open');
    const o = r.owner, c = r.clock || {}, f = r.fin, reg = r.registry, m = r.mkt;
    const tl = pipelineAll().find(t => t.corp_code === r.corp_code);
    const clockHtml = /^PE_/.test(o.type) ? (() => {
      const entry = reg && reg.entry_date ? reg.entry_date : (o.entry_year ? String(Math.floor(o.entry_year)) : null);
      const start = entry ? parseFloat(entry.slice(0, 4)) + (parseInt(entry.slice(5, 7) || '6') || 6) / 12 : null;
      const now = new Date().getFullYear() + (new Date().getMonth() + 1) / 12;
      const end = reg && reg.fund && reg.fund.maturity_est ? reg.fund.maturity_est + 1 : (start ? start + 8 : null);
      const debtY = reg && reg.debt && reg.debt.maturity ? parseFloat(reg.debt.maturity.slice(0, 4)) + (parseInt(reg.debt.maturity.slice(5, 7) || '6') || 6) / 12 : null;
      const pos = v => start && end ? Math.max(0, Math.min(100, (v - start) / (end - start) * 100)) : 0;
      const items = (reg && reg.recovery && reg.recovery.items || []).filter(i => /^\d{4}/.test(i.date || ''));
      return `<div class="pl-card"><h4>⏱ 오너 시계 <span class="pl-sub">exit 압력 ${sc(c.exit_pressure)} · 밸류업 유인 ${sc(c.valueup_drive)}</span></h4>
        ${start ? `<div class="pl-tl"><div class="pl-tl-track"><i class="pl-tl-now" style="left:${pos(now)}%" title="현재"></i>${debtY ? `<i class="pl-tl-debt" style="left:${pos(debtY)}%" title="인수금융 만기 ${reg.debt.maturity}"></i>` : ''}${items.map(i => `<i class="pl-tl-ev ${esc(i.type)}" style="left:${pos(parseFloat(i.date.slice(0, 4)) + (parseInt(i.date.slice(5, 7) || '6') || 6) / 12)}%" title="${esc(i.date)} ${esc(i.type)} ${i.krw_bn ? won(i.krw_bn) : ''} ${esc(i.note || '')}"></i>`).join('')}</div><div class="pl-tl-lab"><span>진입 ${esc(entry)}</span><span>현재 ${c.hold_years != null ? c.hold_years + 'y' : ''}</span><span>펀드 만기 ~${end ? Math.round(end - 1) : '?'}</span></div></div>` : ''}
        <div class="pl-kv">${(c.notes || []).map(n => `<span>${esc(n)}</span>`).join('')}</div>
        ${c.recovery_ratio != null ? `<div class="pl-rec"><span>회수율</span><div class="pl-recbar"><i style="width:${Math.min(100, c.recovery_ratio * 100)}%"></i></div><b>${Math.round(c.recovery_ratio * 100)}%</b></div>` : ''}
        ${c.predicted ? `<p class="pl-pred">단계 <b>${esc(c.stage)}</b>${reg && reg.stage_hint ? ` (${esc(reg.stage_hint)})` : ''} → 예상 행동: <b>${esc(c.predicted)}</b></p>` : ''}
        ${items.length ? `<table class="pl-mini"><tr><th>일자</th><th>유형</th><th>금액</th><th>비고</th></tr>${items.map(i => `<tr><td>${esc(i.date)}</td><td>${esc(i.type)}</td><td>${i.krw_bn ? won(i.krw_bn) : '—'}</td><td>${esc(i.note || '')}</td></tr>`).join('')}</table>` : ''}
        ${reg && reg.debt ? `<p class="pl-sub">인수금융: ${reg.debt.acq_fin_krw_bn ? won(reg.debt.acq_fin_krw_bn) : ''} ${reg.debt.senior_rate ? `선순위 ${reg.debt.senior_rate}%` : ''} ${reg.debt.maturity ? `만기 ${esc(reg.debt.maturity)}` : ''} ${esc(reg.debt.note || '')}</p>` : ''}
        ${reg && reg.notes ? `<p class="pl-note">${esc(reg.notes)}</p>` : ''}</div>`;
    })() : '';
    const ownerHtml = `<div class="pl-card"><h4>👤 오너 렌즈 <span class="pl-otag oc-${OWNER_CLS[o.type]}">${esc(o.label)}</span> <span class="pl-sub">${esc(o.confidence)} · ${esc(o.source || '—')}</span></h4>
      <div class="pl-kv">${o.top_name ? `<span>최대주주 <b>${esc(o.top_name)}</b> ${o.top_pct != null ? o.top_pct + '%' : ''}</span>` : ''}${o.group_pct != null ? `<span>특수관계인 합 ${o.group_pct}% (${o.n_related || '—'}인)</span>` : ''}${o.age ? `<span>본인 ${o.age}세${o.self_exec ? ` · ${esc(o.self_exec.pos || '')}` : ''}</span>` : ''}${o.family_execs ? `<span>가족 임원 ${o.family_execs}명 · 차세대 ${o.family_next_gen}</span>` : ''}${o.payout_ratio != null ? `<span>배당성향 ${Math.round(o.payout_ratio * 100)}%${o.cash_div != null ? ` (${won(o.cash_div)})` : ''}</span>` : ''}${o.treasury_pct != null ? `<span>자사주 ${o.treasury_pct}%</span>` : ''}${o.n_capital_reductions ? `<span>유상감자 ${o.n_capital_reductions}회</span>` : ''}${o.n_3rd_party ? `<span>3자배정 ${o.n_3rd_party}회</span>` : ''}</div>
      ${o.family_names && o.family_names.length ? `<p class="pl-sub">가족: ${esc(o.family_names.join(', '))}</p>` : ''}
      <div class="pl-scores">${[['승계 압력', o.succession], ['카브아웃 확률', o.carveout_prob], ['행동주의 취약', o.activist], ['exit 압력', c.exit_pressure], ['밸류업 유인', o.type === 'PE_CONTROL' ? c.valueup_drive : null]].filter(([, v]) => v != null).map(([l, v]) => `<div class="pl-scrow"><span>${l}</span>${bar(v)}</div>`).join('')}</div>
      ${o.changes && o.changes.length ? `<details class="pl-det"><summary>최대주주 변동 ${o.changes.length}건</summary><table class="pl-mini">${o.changes.map(ch => `<tr><td>${esc(ch.on)}</td><td>${esc(ch.nm)}</td><td>${ch.pct != null ? ch.pct + '%' : ''}</td><td>${esc(ch.cause)}</td></tr>`).join('')}</table></details>` : ''}
      ${o.capital_events && o.capital_events.length ? `<details class="pl-det"><summary>자본 이벤트 ${o.capital_events.length}건 (감자·3자배정·전환)</summary><table class="pl-mini">${o.capital_events.map(ev => `<tr><td>${esc(ev.on)}</td><td>${esc(ev.type)}</td><td>${ev.qty != null ? ev.qty.toLocaleString() + '주' : ''}</td></tr>`).join('')}</table></details>` : ''}</div>`;
    const lensHtml = (title, obj, lab, pb) => { const ent = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]); if (!ent.length) return ''; return `<div class="pl-card"><h4>${title}</h4><div class="pl-scores">${ent.map(([k, v]) => { const p = (pb || []).find(q => q.id === k); return `<div class="pl-scrow" title="${p ? esc((p.flow || p.signal || p.note || '') + (p.house_fit ? ' · ' + p.house_fit : '')) : ''}"><span>${lab[k] || k}</span>${bar(v)}</div>`; }).join('')}</div></div>`; };
    const finHtml = `<div class="pl-card"><h4>📊 재무 <span class="pl-sub">${f.year || ''}${f.fs25 ? ' · DART 실측' : ' · 패널'} · 억원</span></h4>
      <div class="pl-fin">${[['매출', won(f.rev)], ['영업이익', won(f.op)], ['OPM', pct(f.opm, 1)], ['EBITDA', won(f.ebitda)], ['EBITDA 마진', pct(f.ebitda_m, 1)], ['순이익', won(f.ni)], ['순차입', f.net_debt == null ? '—' : (f.net_debt < 0 ? '순현금 ' + won(-f.net_debt) : won(f.net_debt))], ['ND/EBITDA', x(f.nd_ebitda)], ['부채비율', pct(f.debt_ratio)], ['유동비율', pct(f.curr_ratio)], ['3Y CAGR', pct(f.cagr3, 1)], ['ROE', pct(f.roe, 1)]].map(([l, v]) => `<div><span>${l}</span><b>${v}</b></div>`).join('')}</div>
      ${f.series ? `<div class="pl-spark">${['rev', 'ebitda', 'net_debt'].map(k => `<div><span>${{ rev: '매출', ebitda: 'EBITDA', net_debt: '순차입' }[k]}</span>${spark(f.series[k], k === 'net_debt')}</div>`).join('')}</div>` : ''}
      ${m ? `<div class="pl-kv"><span>시총 <b>${won(m.mcap)}</b></span><span>PBR ${m.pbr ?? '—'}</span><span>PER ${m.per ?? '—'}</span><span>주가 ${m.price ? m.price.toLocaleString() : '—'}</span>${m.hi52 && m.lo52 ? `<span>52주 ${m.lo52.toLocaleString()}~${m.hi52.toLocaleString()}</span>` : ''}${reg && reg.entry_price && m.price ? `<span>PE 진입가 대비 <b class="${m.price >= reg.entry_price ? 'pos' : 'neg'}">${((m.price / reg.entry_price - 1) * 100).toFixed(0)}%</b></span>` : ''}</div>` : ''}
      ${r.ind ? `<p class="pl-sub">업종 ${esc(f.industry || '')}: ${r.ind.n}사 · 상위3사 ${pct(r.ind.top3_share)} · 파편화 ${pct(r.ind.frag)} · OPM 중위 ${pct(r.ind.opm_med, 1)} · 볼트온 타겟(50~500억) ${r.ind.targets || 0}사 · SI 후보(순현금·5배 규모) ${r.ind.si_depth || 0}사</p>` : ''}
      ${r.pool ? `<p class="pl-sub">자금소요: NEED ${sc(r.pool.need)} · FIT ${sc(r.pool.fit)} · ${esc(r.pool.type || '')} · ${esc(r.pool.status || '')}${r.pool.gap_12m ? ` · 12M 갭 ${won(r.pool.gap_12m)}` : ''}</p>` : ''}</div>`;
    const ticketHtml = r.ticket ? `<div class="pl-card"><h4>🎯 티켓 <span class="pl-sub">${esc(r.ticket.basis)}</span></h4><div class="pl-fin">${[['EV', won(r.ticket.ev)], ['지분가치', won(r.ticket.equity)], ['경영권 티켓', won(r.ticket.control)], ['20% 소수지분', won(r.ticket.minority)]].map(([l, v]) => `<div><span>${l}</span><b>${v}</b></div>`).join('')}</div><p class="pl-fit">${esc(r.ticket.fit)}</p></div>` : '';
    const irrHtml = f.ebitda > 0 ? `<div class="pl-card"><h4>🧮 LBO 스케치 <span class="pl-sub">간이 MOIC·IRR (EBITDA ${won(f.ebitda)} 기준)</span></h4>
      <div class="pl-irr" id="plIrr">${[['진입 EV/EBITDA', 'mi', r.ticket ? r.ticket.mult : 7, 0.5], ['레버리지 (x EBITDA)', 'lev', Math.min(3.5, Math.max(0, 3.5)), 0.5], ['EBITDA 성장률 %', 'g', Math.round(Math.max(-10, Math.min(15, (f.cagr3 || 0.05) * 100))), 1], ['출구 EV/EBITDA', 'mo', r.ticket ? r.ticket.mult : 7, 0.5], ['보유 년', 'T', 5, 1], ['선순위 금리 %', 'rt', 6, 0.5]].map(([l, k, v, st]) => `<label>${l}<input type="number" step="${st}" data-k="${k}" value="${v}"></label>`).join('')}</div>
      <div class="pl-irr-out" id="plIrrOut"></div><p class="pl-sub">부채는 FCF(EBITDA×45% − 이자)로 상환, 순차입 ${f.net_debt > 0 ? won(f.net_debt) + ' 승계' : '없음'}. 한국은 push-down 불가 → 실제 상환은 배당·감자 경로. 방향성 확인용.</p></div>` : '';
    const rulesHtml = (r.rule_hits || []).length ? `<div class="pl-card"><h4>📏 규칙 히트</h4>${r.rule_hits.map(h => `<div class="pl-rule ${h.status}"><b>${esc(h.flag)}</b> <span>${esc(h.id)} ${esc(h.name)}</span>${h.status === 'proposed' ? '<em>제안</em>' : ''}</div>`).join('')}</div>` : '';
    const casesHtml = (r.analog_cases || []).length ? `<div class="pl-card"><h4>📚 유사 케이스</h4>${r.analog_cases.map(a => `<button class="pl-case-chip out-${a.outcome}" data-case="${a.id}">${esc(a.company)} <em>${esc(a.sponsor || '')} · ${DT_LABEL[a.deal_type] || a.deal_type} · ${OUT_LABEL[a.outcome] || a.outcome}</em></button>`).join('')}</div>` : '';
    const narrHtml = (r.narratives || []).length ? `<div class="pl-card"><h4>📐 네러티브</h4>${r.narratives.map(n => `<span class="pl-chip on-soft">${esc(n.theme)} · ${esc(n.node)}${n.pick ? ' ★' : ''}</span>`).join(' ')}</div>` : '';
    const prompt = `/pe-lens thesis ${r.name}${r.stock_code ? ' (' + r.stock_code + ')' : ''} corp_code=${r.corp_code} — 오너 ${o.label}${o.top_name ? '(' + o.top_name + (o.top_pct != null ? ' ' + o.top_pct + '%' : '') + ')' : ''}, 진입 1순위 ${r.entry_top ? ENTRY_LABEL[r.entry_top.id] + ' ' + r.entry_top.score : '—'}, 티켓 ${r.ticket ? r.ticket.fit : '—'}. Entry/Value-up/Exit 시나리오 + 반증조건 + 정책 + 유사케이스 대조로 IC 프리메모 작성`;
    dw.innerHTML = `<div class="pl-dw-head"><div><h3>${esc(r.name)} ${r.listed ? `<span class="pl-b b-listed">${esc(r.stock_code)}</span>` : '<span class="pl-b b-unlisted">비상장</span>'}</h3><div class="pl-sub">${esc(f.industry || '')} · ${esc(f.sector || '')} · <a href="${dartUrl(r.name)}" target="_blank" rel="noopener">DART</a>${r.stock_code ? ` · <a href="${naverUrl(r.stock_code)}" target="_blank" rel="noopener">네이버</a>` : ''} · 주목도 <b>${r.attention}</b></div></div><div class="pl-dw-btns"><button id="plPipe" class="pl-btn" ${tl ? 'disabled' : ''}>${tl ? `파이프라인: ${STAGE_LABEL[tl.stage] || tl.stage}` : '＋ 파이프라인'}</button><button id="plPrompt" class="pl-btn gold">📝 thesis 프롬프트</button><button id="plClose" class="pl-x">✕</button></div></div>
      <ul class="pl-why">${(r.why || []).map(w => `<li>${esc(w)}</li>`).join('')}</ul>
      ${clockHtml}${ownerHtml}${lensHtml('🚪 진입 구조 적합', r.lens.entry, ENTRY_LABEL, D.playbook.entry)}${lensHtml('🛠 밸류업 레버', r.lens.valueup, VU_LABEL, D.playbook.value_up)}${lensHtml('🏁 출구 옵션', r.lens.exit, EXIT_LABEL, D.playbook.exit)}${ticketHtml}${irrHtml}${rulesHtml}${casesHtml}${narrHtml}${finHtml}`;
    dw.querySelector('#plClose').onclick = () => { S.sel = null; renderDrawer(); document.querySelectorAll('tr.sel').forEach(t => t.classList.remove('sel')); };
    dw.querySelector('#plPrompt').onclick = () => copy(prompt, 'thesis 프롬프트 복사됨 → Claude 세션에 붙여넣기');
    const pb = dw.querySelector('#plPipe'); if (pb && !pb.disabled) pb.onclick = () => pipelineAdd(r);
    dw.querySelectorAll('.pl-case-chip').forEach(b => b.onclick = () => { S.view = 'cases'; S.caseFocus = b.dataset.case; S.caseMarket = 'all'; S.sel = null; render(); setTimeout(() => { const el = document.getElementById('case-' + b.dataset.case); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('focus'); } }, 50); });
    const irr = dw.querySelector('#plIrr'); if (irr) { const calc = () => { const g = {}; irr.querySelectorAll('input').forEach(i => g[i.dataset.k] = parseFloat(i.value) || 0); dw.querySelector('#plIrrOut').innerHTML = irrOut(f.ebitda, Math.max(0, f.net_debt || 0), g); }; irr.querySelectorAll('input').forEach(i => i.oninput = calc); calc(); }
    dw.scrollTop = 0;
  }
  function irrOut(ebitda, nd, g) {
    const run = (mo) => { const ev0 = ebitda * g.mi; const debt0 = Math.min(g.lev * ebitda, ev0 * 0.65); const eq0 = ev0 - debt0 + 0; let debt = debt0 + nd, e = ebitda; for (let y = 0; y < g.T; y++) { e = e * (1 + g.g / 100); const fcf = Math.max(0, e * 0.45 - debt * g.rt / 100); debt = Math.max(0, debt - fcf); } const evT = e * mo; const eqT = evT - debt; const moic = eq0 > 0 ? eqT / eq0 : null; const irr = moic && moic > 0 && g.T > 0 ? Math.pow(moic, 1 / g.T) - 1 : null; return { ev0, debt0, eq0, evT, debt, eqT, moic, irr, e }; };
    const base = run(g.mo), lo = run(Math.max(1, g.mo - 1)), hi = run(g.mo + 1);
    const cell = (l, r) => `<div><span>${l}</span><b class="${r.irr == null ? '' : r.irr >= 0.2 ? 'pos' : r.irr < 0.1 ? 'neg' : ''}">${r.moic == null ? '—' : r.moic.toFixed(2) + 'x'}</b><i>${r.irr == null ? '—' : (r.irr * 100).toFixed(1) + '%'}</i></div>`;
    return `<div class="pl-fin"><div><span>진입 EV</span><b>${won(base.ev0)}</b></div><div><span>인수금융</span><b>${won(base.debt0)}</b></div><div><span>자기자본</span><b>${won(base.eq0)}</b></div><div><span>출구 EV</span><b>${won(base.evT)}</b></div><div><span>잔여 부채</span><b>${won(base.debt)}</b></div><div><span>출구 지분가치</span><b>${won(base.eqT)}</b></div></div><div class="pl-irr-sens">${cell('출구 −1x', lo)}${cell('기본', base)}${cell('출구 +1x', hi)}</div>`;
  }
  function spark(vals, zero) {
    const pts = (vals || []).map((v, i) => ({ v, i })).filter(p => !nn(p.v)); if (pts.length < 2) return '<i class="pl-sub">—</i>';
    const W = 120, H = 28, P = 2; let lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v)); if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); } if (hi === lo) hi = lo + 1;
    const xs = i => P + i / (vals.length - 1) * (W - 2 * P), ys = v => H - P - (v - lo) / (hi - lo) * (H - 2 * P);
    const d = pts.map((p, k) => `${k ? 'L' : 'M'}${xs(p.i).toFixed(1)},${ys(p.v).toFixed(1)}`).join(' ');
    return `<svg class="pl-sparksvg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${zero && lo < 0 ? `<line x1="${P}" x2="${W - P}" y1="${ys(0).toFixed(1)}" y2="${ys(0).toFixed(1)}" class="z"/>` : ''}<path d="${d}"/><circle cx="${xs(pts[pts.length - 1].i).toFixed(1)}" cy="${ys(pts[pts.length - 1].v).toFixed(1)}" r="2"/></svg><em>${won(pts[pts.length - 1].v)}</em>`;
  }

  // ── PE 보유기업 시계 ─────────────────────────────────────────────
  function renderOwners(body) {
    const pe = D.pool.rows.filter(r => /^PE_/.test(r.owner.type)).sort((a, b) => (b.clock.exit_pressure || 0) - (a.clock.exit_pressure || 0));
    const cand = pe.filter(r => r.owner.pe_candidate && !r.registry);
    const reg = pe.filter(r => !r.owner.pe_candidate || r.registry);
    const card = r => { const o = r.owner, c = r.clock, g = r.registry; return `<div class="pl-ocard stage-${esc(c.stage || 'unknown')}" data-c="${r.corp_code}">
      <div class="pl-ocard-head"><div><b>${esc(r.name)}</b> ${r.listed ? `<span class="pl-b b-listed">${esc(r.stock_code)}</span>` : '<span class="pl-b b-unlisted">비상장</span>'}<div class="pl-sub">${esc(o.sponsor || o.top_name || '')}${g ? ` · ${esc(g.entry_type || '')} ${esc(g.entry_date || '')}` : ''}${g && g.ev_krw_bn ? ` · EV ${won(g.ev_krw_bn)}` : ''}</div></div><div class="pl-ocard-stage">${esc(c.stage || '?')}${g && g.stage_hint ? `<em>${esc(g.stage_hint)}</em>` : ''}</div></div>
      <div class="pl-scores"><div class="pl-scrow"><span>exit 압력</span>${bar(c.exit_pressure)}</div><div class="pl-scrow"><span>밸류업 유인</span>${bar(c.valueup_drive)}</div>${c.recovery_ratio != null ? `<div class="pl-scrow"><span>회수율</span>${bar(Math.min(100, c.recovery_ratio * 100), 'rec')}</div>` : ''}</div>
      <div class="pl-kv">${(c.notes || []).map(n => `<span>${esc(n)}</span>`).join('')}${r.mkt && g && g.entry_price ? `<span>진입가 대비 <b class="${r.mkt.price >= g.entry_price ? 'pos' : 'neg'}">${((r.mkt.price / g.entry_price - 1) * 100).toFixed(0)}%</b></span>` : ''}${o.payout_ratio != null ? `<span>배당성향 ${Math.round(o.payout_ratio * 100)}%</span>` : ''}</div>
      ${c.predicted ? `<p class="pl-pred">→ ${esc(c.predicted)}</p>` : ''}
      <div class="pl-flags">${(r.rule_hits || []).map(h => `<span class="pl-flag ${h.status}" title="${esc(h.name)}">${esc(h.flag)}</span>`).join('')}</div></div>`; };
    const byStage = {}; for (const r of reg) byStage[r.clock.stage || 'unknown'] = (byStage[r.clock.stage || 'unknown'] || 0) + 1;
    body.innerHTML = `<div class="pl-intro"><b>PE가 최대주주인 기업의 시계.</b> 보유연차·펀드 잔존만기·회수율·인수금융 만기로 exit 압력을 읽고, 단계별 전형 행동(초기 경상개선·볼트온 → 중기 리캡·배당 → 후기 매각·듀얼트랙 → 만기초과 SBO·CV)을 예측한다. 회수율이 낮을수록 밸류업·주주환원에 적극적(휴젤 0% vs 클래시스 89%).
      <div class="pl-kv">${Object.entries(byStage).map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('')}<span>레지스트리 ${reg.length} · DART 패턴 후보 ${cand.length}</span></div></div>
      <div class="pl-ogrid">${reg.map(card).join('')}</div>
      ${cand.length ? `<h3 class="pl-h3">DART 최대주주명 패턴으로 잡힌 PE 후보 <span class="pl-sub">레지스트리 미수록 → /pe-lens verify 로 스폰서·진입일·펀드 확인 후 pe-registry.json 에 추가</span></h3><div class="pl-ogrid">${cand.map(card).join('')}</div>` : ''}`;
    body.querySelectorAll('.pl-ocard').forEach(el => el.onclick = () => { S.sel = el.dataset.c; renderDrawer(); });
  }

  // ── 케이스·규칙 ──────────────────────────────────────────────────
  function renderCases(body) {
    const st = D.pool.stats;
    let cs = D.cases.filter(c => (S.caseMarket === 'all' || c.market === S.caseMarket) && (S.caseOutcome === 'all' || c.outcome === S.caseOutcome) && (S.caseType === 'all' || c.deal_type === S.caseType));
    const types = Object.keys(st.case_types || {}); const outs = ['success', 'mixed', 'ongoing', 'failure'];
    const matrix = `<table class="pl-matrix"><tr><th>딜 유형 \\ 결과</th>${outs.map(o => `<th class="out-${o}">${OUT_LABEL[o]}</th>`).join('')}<th>n</th><th>성공률*</th></tr>${types.map(t => { const c = st.case_types[t]; const done = c.success + c.failure + c.mixed; const sr = done ? c.success / done : null; return `<tr><td class="tl"><button class="pl-link" data-t="${t}">${DT_LABEL[t] || t}</button></td>${outs.map(o => `<td class="${c[o] ? 'has out-' + o : ''}">${c[o] || ''}</td>`).join('')}<td>${c.n}</td><td>${sr == null ? '—' : `<span class="pl-sr ${sr >= 0.6 ? 'hi' : sr >= 0.4 ? 'mid' : 'lo'}">${Math.round(sr * 100)}%</span>`}</td></tr>`; }).join('')}</table><p class="pl-sub">* 성공/(성공+실패+혼합). 진행 중 제외. 표본이 작아 방향성만 — 케이스가 쌓일수록 prior 가 교정된다.</p>`;
    const caseCard = c => { const e = c.entry || {}, xx = c.exit || {}; return `<article class="pl-case out-${c.outcome} ${S.caseFocus === c.id ? 'focus' : ''}" id="case-${esc(c.id)}">
      <header><div><b>${esc(c.company)}</b> <span class="pl-sub">${esc(c.sponsor)}${(c.co_investors || []).length ? ' + ' + esc(c.co_investors.join(', ')) : ''}</span></div><div class="pl-case-tags"><span class="pl-b">${DT_LABEL[c.deal_type] || c.deal_type}</span><span class="pl-b">${esc(c.size_bucket || '')}</span><span class="pl-b out-${c.outcome}">${OUT_LABEL[c.outcome] || c.outcome}</span>${c.market === 'global' ? '<span class="pl-b">글로벌</span>' : ''}<span class="pl-b conf-${c.confidence}">${esc(c.confidence)}</span></div></header>
      <div class="pl-case-line"><span>${esc(e.date || '?')} 진입${e.ev_krw_bn ? ` · EV ${won(e.ev_krw_bn)}` : e.equity_krw_bn ? ` · Eq ${won(e.equity_krw_bn)}` : ''}${e.ev_ebitda ? ` · ${e.ev_ebitda}x` : ''}${e.premium_pct ? ` · 프리미엄 ${e.premium_pct}%` : ''} · 매도 ${esc(e.seller_type || '')}</span><span>→</span><span>${esc(xx.status || '')}${xx.date ? ' ' + esc(xx.date) : ''}${xx.route ? ' · ' + (EXIT_LABEL[xx.route] || esc(xx.route)) : ''}${xx.buyer ? ' · ' + esc(xx.buyer) : ''}${xx.ev_krw_bn ? ' · ' + won(xx.ev_krw_bn) : ''}${xx.moic ? ` · <b>${xx.moic}x</b>` : ''}${xx.irr_pct ? ` · IRR ${xx.irr_pct}%` : ''}${xx.holding_years != null ? ` · ${xx.holding_years}y` : ''}</span></div>
      <p class="pl-case-th">${esc(e.thesis || '')}${e.structure ? ` <span class="pl-sub">| ${esc(e.structure)}</span>` : ''}</p>
      <div class="pl-case-cols">
        <div><h5>밸류업</h5>${(c.value_up && c.value_up.levers || []).map(l => `<span class="pl-chip on-soft">${VU_LABEL[l] || l}</span>`).join(' ')}<ul>${(c.value_up && c.value_up.actions || []).slice(0, 5).map(a => `<li><em>${esc(a.date)}</em> ${esc(a.action)}</li>`).join('')}</ul></div>
        <div><h5>선행지표</h5><ul>${(c.leading_indicators || []).map(s => `<li>${esc(s)}</li>`).join('')}</ul><h5>정책</h5><ul>${(c.policy_factors || []).map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>
        <div><h5 class="pos">성공 요인</h5><ul>${(c.success_factors || []).map(s => `<li>${esc(s)}</li>`).join('')}</ul><h5 class="neg">실패 요인</h5><ul>${(c.failure_factors || []).map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>
      </div>
      <div class="pl-lessons">${(c.lessons || []).map(l => `<div>💡 ${esc(l)}</div>`).join('')}</div>
      <footer>${(c.sources || []).map(s => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>` : `<span>${esc(s.title)}</span>`).join(' · ')}</footer></article>`; };
    const rulesTable = `<table class="pl-rules"><tr><th>#</th><th class="tl">규칙 (선행지표 → 효과)</th><th>상태</th><th>지지</th><th>반증</th><th>강도</th><th>히트</th></tr>${(st.rules_eval || []).map(r => `<tr class="${r.status}"><td>${r.id}</td><td class="tl"><b>${esc(r.flag)}</b> ${esc(r.name)}<div class="pl-sub">${esc(r.statement)}</div><div class="pl-sub">→ ${esc(r.target || '')} ${r.delta > 0 ? '+' : ''}${r.delta || 0} · 출처 ${esc(r.origin)}</div></td><td><span class="pl-b st-${r.status}">${r.status}</span></td><td class="tl">${r.supports.map(s => `<button class="pl-link out-${s.outcome}" data-case="${s.id}">${esc(s.company)}</button>`).join(', ')}</td><td class="tl">${r.contradicts.map(s => `<button class="pl-link out-${s.outcome}" data-case="${s.id}">${esc(s.company)}</button>`).join(', ')}</td><td>${r.strength == null ? '—' : Math.round(r.strength * 100) + '%'}</td><td>${st.rule_hits[r.id] || 0}</td></tr>`).join('')}</table>`;
    body.innerHTML = `<div class="pl-intro"><b>케이스 라이브러리가 규칙을 만들고, 규칙이 스코어를 교정한다.</b> 국내 PE 딜의 성공·실패·혼합 사례를 구조화해 선행지표(오너 행동·리캡 시점·배당 패턴·부채 만기·펀드 빈티지)를 추출하고, 규칙(R1~R17)으로 승격한다. 승격·강등은 제안만, 확정은 사람이.</div>
      <div class="pl-twocol"><div>${matrix}</div><div class="pl-caseflt">
        <div class="pl-chips"><span class="pl-flab">시장</span>${[['KR', '국내'], ['global', '글로벌'], ['all', '전체']].map(([k, l]) => `<button class="pl-chip ${S.caseMarket === k ? 'on' : ''}" data-m="${k}">${l}</button>`).join('')}</div>
        <div class="pl-chips"><span class="pl-flab">결과</span>${[['all', '전체'], ...outs.map(o => [o, OUT_LABEL[o]])].map(([k, l]) => `<button class="pl-chip out-${k} ${S.caseOutcome === k ? 'on' : ''}" data-o="${k}">${l}<em>${k === 'all' ? D.cases.length : (st.case_by_outcome[k] || 0)}</em></button>`).join('')}</div>
        <div class="pl-chips"><span class="pl-flab">유형</span>${[['all', '전체'], ...types.map(t => [t, DT_LABEL[t] || t])].map(([k, l]) => `<button class="pl-chip ${S.caseType === k ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>
        <p class="pl-sub">${cs.length}건 표시 · 케이스 추가는 <code>/pe-lens case &lt;기업&gt;</code> (딜 뉴스·deal-weekly 브리프에서 구조화 적재)</p></div></div>
      <div class="pl-cases">${cs.map(caseCard).join('')}</div>
      <h3 class="pl-h3">규칙 베이스 <span class="pl-sub">active = 스코어 반영 · proposed = 관찰 · 강도 = 지지/(지지+반증)</span></h3>${rulesTable}`;
    body.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { S.caseMarket = b.dataset.m; render(); });
    body.querySelectorAll('[data-o]').forEach(b => b.onclick = () => { S.caseOutcome = b.dataset.o; render(); });
    body.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { S.caseType = b.dataset.t; render(); });
    body.querySelectorAll('[data-case]').forEach(b => b.onclick = () => { S.caseFocus = b.dataset.case; S.caseMarket = 'all'; S.caseOutcome = 'all'; S.caseType = 'all'; render(); setTimeout(() => { const el = document.getElementById('case-' + b.dataset.case); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 50); });
  }

  // ── 정책 레이더 ──────────────────────────────────────────────────
  function renderPolicy(body) {
    const items = D.policy.slice().sort((a, b) => (b.weight || 0) - (a.weight || 0));
    const ST = { enacted: '시행', passed: '통과·시행대기', pending: '입법중', discussion: '논의', macro: '환경' };
    const strategies = [...new Set(items.flatMap(p => Object.keys(p.affects || {})))];
    const heat = `<table class="pl-matrix pl-pheat"><tr><th class="tl">정책 \\ 전략</th>${strategies.map(s => `<th>${ENTRY_LABEL[s] || EXIT_LABEL[s] || VU_LABEL[s] || s}</th>`).join('')}</tr>${items.map(p => `<tr><td class="tl">${esc(p.title.split(' (')[0])}</td>${strategies.map(s => { const v = (p.affects || {})[s]; return `<td class="${v > 0 ? 'tail' : v < 0 ? 'head' : ''}">${v > 0 ? '▲' : v < 0 ? '▼' : ''}</td>`; }).join('')}</tr>`).join('')}</table>`;
    body.innerHTML = `<div class="pl-intro"><b>정책은 항상 렌즈의 일부.</b> 의무공개매수·자사주 소각·세제·성장펀드·상법·규제 시한이 진입구조와 출구 경로의 순풍(▲)·역풍(▼)을 바꾼다. 스코어링은 시행·통과 항목만 반영(weight), 논의 단계는 표시만.</div>
      ${heat}
      <div class="pl-pgrid">${items.map(p => `<article class="pl-pol st-${esc(p.status)}"><header><span class="pl-b st-${esc(p.status)}">${ST[p.status] || p.status}</span><b>${esc(p.title)}</b><span class="pl-sub">${esc(p.date || '')}${p.effective_est ? ` → 시행 ${esc(p.effective_est)}` : ''} · 가중 ${p.weight}</span></header>
        <p>${esc(p.summary)}</p>
        <div class="pl-affects">${Object.entries(p.affects || {}).filter(([, v]) => v).map(([k, v]) => `<span class="pl-chip ${v > 0 ? 'tail' : 'head'}">${v > 0 ? '▲' : '▼'} ${ENTRY_LABEL[k] || EXIT_LABEL[k] || VU_LABEL[k] || k}</span>`).join('')}</div>
        <p class="pl-screen">스크린 효과: ${esc(p.screen_effect || '')}</p>
        <footer>${(p.sources || []).map(s => s.u ? `<a href="${esc(s.u)}" target="_blank" rel="noopener">${esc(s.t)}</a>` : `<span>${esc(s.t)}</span>`).join(' · ')}</footer></article>`).join('')}</div>`;
  }

  // ── 플레이북 ─────────────────────────────────────────────────────
  function renderPlaybook(body) {
    const pb = D.playbook; const st = D.pool.stats;
    const col = (title, arr, kind) => `<section class="pl-pbcol"><h3>${title}</h3>${(arr || []).map(p => `<details class="pl-pb"><summary><b>${esc(p.name)}</b>${kind === 'entry' && st.by_entry_top[p.id] ? `<em>1순위 ${st.by_entry_top[p.id]}사</em>` : ''}${p.house_fit ? `<span class="pl-sub">${esc(p.house_fit)}</span>` : ''}</summary>
      ${p.flow ? `<p><b>흐름</b> ${esc(p.flow)}</p>` : ''}${p.signal ? `<p><b>신호</b> ${esc(p.signal)}</p>` : ''}${p.pros ? `<p class="pos"><b>장점</b> ${esc(p.pros)}</p>` : ''}${p.cons ? `<p class="neg"><b>단점</b> ${esc(p.cons)}</p>` : ''}${p.effect ? `<p><b>효과</b> ${esc(p.effect)}</p>` : ''}${p.note ? `<p>${esc(p.note)}</p>` : ''}${p.leverage_bench ? `<p class="pl-sub">${esc(p.leverage_bench)}</p>` : ''}
      ${(p.kr_cases || (p.kr ? [p.kr] : [])).length ? `<p class="pl-sub">국내: ${esc((p.kr_cases || [p.kr]).join(' · '))}</p>` : ''}${kind === 'entry' ? `<button class="pl-btn small" data-e="${p.id}">이 구조로 레이더 필터</button>` : ''}</details>`).join('')}</section>`;
    body.innerHTML = `<div class="pl-intro"><b>${esc(pb.philosophy || '')}</b><div class="pl-sub">${esc(pb.source || '')} · v${esc(pb.version || '')}</div></div>
      <div class="pl-pbgrid">${col('🚪 Entry', pb.entry, 'entry')}${col('🛠 Value-up', pb.value_up, 'vu')}${col('🏁 Exit', pb.exit, 'exit')}</div>
      <div class="pl-card"><h4>exit 압력 모델</h4><p>${esc(pb.exit_pressure_model && pb.exit_pressure_model.note || '')}</p><p class="pl-sub">${esc(pb.exit_pressure_model && pb.exit_pressure_model.recovery_adjust || '')}</p><div class="pl-kv">${Object.entries(pb.exit_pressure_model && pb.exit_pressure_model.predicted_actions || {}).map(([k, v]) => `<span><b>${k}</b> ${esc(v)}</span>`).join('')}</div></div>`;
    body.querySelectorAll('[data-e]').forEach(b => b.onclick = () => { S.view = 'radar'; S.entry = b.dataset.e; S.sort = 'entry'; render(); });
  }

  // ── 파이프라인 ───────────────────────────────────────────────────
  function renderPipeline(body) {
    const all = pipelineAll();
    const cols = STAGES.map(s => `<div class="pl-kcol"><h4>${STAGE_LABEL[s]} <em>${all.filter(t => (t.stage || 'idea') === s).length}</em></h4>${all.filter(t => (t.stage || 'idea') === s).map(t => { const r = D.byCorp.get(t.corp_code); return `<div class="pl-kcard" data-id="${esc(t.id)}"><div class="pl-kcard-head"><b data-c="${esc(t.corp_code)}" class="pl-link">${esc(t.name)}</b><span class="pl-sub">${esc(t.created || '')}${t.src === 'local' ? ' · 로컬' : t.src === 'both' ? ' · 로컬수정' : ''}</span></div><div class="pl-sub">${esc(ENTRY_LABEL[t.entry] || t.entry || '')} · ${esc(D.pool.meta.owner_labels[t.owner_type] || t.owner_type || '')} · ${esc(t.ticket_fit || '')}${r ? ` · 주목도 ${r.attention}` : ''}</div>${t.thesis ? `<p class="pl-kth">${esc(t.thesis)}</p>` : ''}<textarea class="pl-knote" placeholder="메모 (반증조건·다음 액션)">${esc(t.note || '')}</textarea><div class="pl-kbtns"><button data-mv="-1">◀</button><button data-mv="1">▶</button><button data-del="1" title="로컬 항목 삭제">🗑</button></div></div>`; }).join('')}</div>`).join('');
    body.innerHTML = `<div class="pl-intro"><b>딜 파이프라인.</b> 레이더·시계에서 "＋ 파이프라인"으로 담은 후보를 단계별로 관리한다. 브라우저 로컬 저장 + <code>data/pe-theses.json</code>(스킬이 기록) 병합. 로컬 변경은 <b>내보내기</b>로 복사해 <code>/pe-lens sync</code> 에 붙이면 파일·배포본에 반영된다.
      <div class="pl-kbtns"><button class="pl-btn" id="plExport">📋 로컬 변경 내보내기 (${lsLoad().length})</button><button class="pl-btn" id="plClearLocal">로컬 초기화</button></div></div>
      <div class="pl-kanban">${cols}</div>`;
    body.querySelectorAll('.pl-kcard').forEach(card => { const id = card.dataset.id; card.querySelectorAll('[data-mv]').forEach(b => b.onclick = () => pipelineMove(id, +b.dataset.mv)); const del = card.querySelector('[data-del]'); if (del) del.onclick = () => { if (confirm('로컬 항목을 삭제할까요? (파일 항목은 스킬로 관리)')) pipelineDrop(id); }; const ta = card.querySelector('.pl-knote'); ta.onchange = () => pipelineNote(id, ta.value); const nm = card.querySelector('[data-c]'); nm.onclick = () => { S.sel = nm.dataset.c; renderDrawer(); }; });
    body.querySelector('#plExport').onclick = () => copy(JSON.stringify({ exported: new Date().toISOString(), theses: lsLoad() }, null, 1), '로컬 파이프라인 JSON 복사됨 → /pe-lens sync 에 붙이기');
    body.querySelector('#plClearLocal').onclick = () => { if (confirm('로컬 파이프라인을 모두 지울까요?')) { lsSave([]); render(); } };
  }

  // ── 진입점 ───────────────────────────────────────────────────────
  window.initPeLens = async function () {
    const root = document.getElementById('pelensRoot'); if (!root) return;
    if (loaded) { render(); return; }
    root.innerHTML = '<div class="empty"><div class="empty-ico">🔭</div><h3>PE Lens 로딩 중…</h3><p>pe-lens-pool.json (외감 41k × DART 오너 × 시세) 을 읽고 있습니다.</p></div>';
    try { await load(); render(); }
    catch (e) { root.innerHTML = `<div class="empty"><div class="empty-ico">⚠️</div><h3>PE Lens 데이터 없음</h3><p>${esc(e.message)}</p><p class="pl-sub">순서: node pe-lens/fetch-owner.js → node pe-lens/fetch-market.js → node pe-lens/build-pe-lens.js</p></div>`; }
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.sel) { S.sel = null; renderDrawer(); } });
})();
