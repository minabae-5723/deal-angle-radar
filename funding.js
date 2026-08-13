// funding.js — 자금소요 스크리너 뷰 (Deal Angle Radar 의 두 번째 섹션)
// data/funding-pool.json 을 읽어 필터·정렬 가능한 테이블로 렌더링한다.
// 데이터 생성은 funding\build.ps1 (node 파이프라인). 이 파일은 표시만 담당.

(() => {
  const POOL_URL = './data/funding-pool.json';
  let DATA = null;
  let loaded = false;
  let expanded = new Set();

  const F = {
    q: '', types: new Set(), listing: 'all', sector: 'all',
    status: 'all', revMin: 0, revMax: Infinity,
    angle: 'all', stance: 'all',
    sort: 'priority', desc: true, limit: 120,
  };

  // ── 표기 헬퍼 ─────────────────────────────────────────────
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const nn = v => (v == null || !isFinite(v));
  // 억원 → 규모별 표기
  const won = v => nn(v) ? '—' : (Math.abs(v) >= 10000 ? (v / 10000).toFixed(1) + '조'
    : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(0));
  // 단위까지 붙인 표기. won() 이 이미 '조' 로 바꾼 경우 '억' 을 덧붙이면 '1.2조억' 이 된다.
  const wonU = v => nn(v) ? '—' : (Math.abs(v) >= 10000 ? (v / 10000).toFixed(1) + '조' : won(v) + '억');
  const signed = v => nn(v) ? '—' : (v < 0 ? '−' : '+') + wonU(Math.abs(v));
  const pct = (v, d = 0) => nn(v) ? '—' : (v * 100).toFixed(d) + '%';
  const mult = v => nn(v) ? '—' : v.toFixed(1) + 'x';
  const sgn = v => nn(v) ? '' : (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

  const TYPE_COLOR = {
    DISTRESS: 'tt-red', REFI: 'tt-orange', WC_BURN: 'tt-purple',
    GROWTH: 'tt-green', TIGHT: 'tt-blue', SELF: 'tt-gray',
  };
  const STATUS_META = {
    PRE_SIGNAL:      { label: '선행 타겟',   cls: 'st-gold',  tip: '상장사인데 조달 공시가 없다 — 니즈 대비 미조달' },
    IN_MOTION:       { label: '조달 진행',   cls: 'st-blue',  tip: '6~18개월 내 조달 이력 — 반복 조달 중' },
    RECENTLY_FUNDED: { label: '조달 완료',   cls: 'st-gray',  tip: '최근 6개월 조달 실행 — 지표 개선이 조달 결과일 수 있음' },
    DISTRESS_EVENT:  { label: '부실 신호',   cls: 'st-red',   tip: '부실 공시 또는 감사보고서 경고' },
    UNLISTED_BLIND:  { label: '비상장 사각', cls: 'st-slate', tip: '비상장은 주요사항보고 의무가 없어 조달 공시 부재가 정보가 아님' },
    NO_FILINGS:      { label: '공시 없음',   cls: 'st-gray',  tip: 'DART 공시 0건 — 상장폐지·등록말소·corp_code 불일치 의심. 재무 갱신 불가' },
    ERROR:           { label: '조회 실패',   cls: 'st-gray',  tip: 'DART 조회 오류' },
  };

  // ── 스파크라인 ────────────────────────────────────────────
  function spark(vals, years, opts = {}) {
    const pts = vals.map((v, i) => ({ v, i })).filter(p => !nn(p.v));
    if (pts.length < 2) return '<span class="muted">—</span>';
    const W = 108, H = 26, PAD = 2;
    const xs = i => PAD + (i / (vals.length - 1)) * (W - 2 * PAD);
    let lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v));
    if (opts.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (hi === lo) { hi = lo + 1; }
    const ys = v => H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD);
    const d = pts.map((p, k) => `${k ? 'L' : 'M'}${xs(p.i).toFixed(1)},${ys(p.v).toFixed(1)}`).join(' ');
    const zeroLine = (opts.zero && lo < 0 && hi > 0)
      ? `<line x1="${PAD}" y1="${ys(0).toFixed(1)}" x2="${W - PAD}" y2="${ys(0).toFixed(1)}" class="spark-zero"/>` : '';
    const last = pts[pts.length - 1];
    const title = years ? years.map((y, i) => `${y}: ${nn(vals[i]) ? '—' : won(vals[i])}`).join('\n') : '';
    return `<svg class="spark ${opts.cls || ''}" viewBox="0 0 ${W} ${H}"><title>${esc(title)}</title>`
      + zeroLine + `<path d="${d}"/>`
      + `<circle cx="${xs(last.i).toFixed(1)}" cy="${ys(last.v).toFixed(1)}" r="2.1"/></svg>`;
  }

  // ── 필터·정렬 ─────────────────────────────────────────────
  function filtered() {
    const q = F.q.trim().toLowerCase();
    let rows = DATA.rows.filter(r => {
      if (q && !(r.name.toLowerCase().includes(q) || (r.industry || '').toLowerCase().includes(q)
        || (r.stock_code || '').includes(q) || (r.corp_code || '').includes(q))) return false;
      if (F.types.size && !F.types.has(r.type)) return false;
      if (F.listing === 'listed' && !r.listed) return false;
      if (F.listing === 'unlisted' && r.listed) return false;
      if (F.sector !== 'all' && r.sector !== F.sector) return false;
      if (F.status !== 'all' && (r.status || 'NONE') !== F.status) return false;
      if (r.rev < F.revMin || r.rev > F.revMax) return false;
      // 앵글·stance 필터는 함께 걸릴 때 '그 앵글이 그 stance 인' 회사만 남긴다
      const tags = r.angle_tags || [];
      if (F.angle !== 'all' || F.stance !== 'all') {
        const hit = tags.some(a => (F.angle === 'all' || a.code === F.angle)
          && (F.stance === 'all' || a.stance === F.stance));
        if (!hit) return false;
      }
      return true;
    });
    const k = F.sort;
    rows.sort((a, b) => {
      const av = a[k], bv = b[k];
      if (nn(av) && nn(bv)) return 0;
      if (nn(av)) return 1;
      if (nn(bv)) return -1;
      if (typeof av === 'string') return F.desc ? bv.localeCompare(av) : av.localeCompare(bv);
      return F.desc ? bv - av : av - bv;
    });
    return rows;
  }

  // ── 렌더 ──────────────────────────────────────────────────
  const COLS = [
    { k: 'priority',   h: 'PRI',      w: 46, fmt: r => `<b class="pri">${r.priority}</b>` },
    { k: 'name',       h: '회사',     w: 200, fmt: r => nameCell(r), align: 'left' },
    { k: 'type',       h: '성격',     w: 78, fmt: r => typeCell(r) },
    { k: 'angle_primary', h: '앵글',  w: 84, fmt: r => angleCell(r) },
    { k: 'status',     h: '상태',     w: 82, fmt: r => statusCell(r) },
    { k: 'rev',        h: '매출',     w: 62, fmt: r => won(r.rev) },
    { k: 'cagr3',      h: '3Y성장',   w: 58, fmt: r => `<span class="${sgn(r.cagr3)}">${pct(r.cagr3)}</span>` },
    { k: 'ebitda_m',   h: 'EBITDA%',  w: 62, fmt: r => `<span class="${sgn(r.ebitda_m)}">${pct(r.ebitda_m, 1)}</span>` },
    { k: 'nd_ebitda',  h: 'ND/EB',    w: 56, fmt: r => `<span class="${r.nd_ebitda >= 5 ? 'neg' : ''}">${mult(r.nd_ebitda)}</span>` },
    { k: 'debt_ratio', h: '부채비율', w: 62, fmt: r => r.impaired_equity ? '<span class="neg">자본잠식</span>' : pct(r.debt_ratio) },
    { k: 'draw_3y',    h: '3Y조달',   w: 62, fmt: r => `<span class="${sgn(r.draw_3y)}">${won(r.draw_3y)}</span>` },
    // 실측 브리지가 있으면 3년 누적을 보여준다. 1년만 보면 현금 많은 회사가 0 으로 숨는다.
    { k: 'gap_view',   h: '부족액',   w: 70, fmt: r => nn(r.gap_view) ? '<span class="muted">—</span>'
        : `<b class="${r.gap_view > 0 ? 'neg' : ''}">${won(r.gap_view)}</b>`
          + (r.gap_3y != null ? '<span class="gy">3Y</span>' : '<span class="gy gy1">1Y</span>') },
    { k: 'need',       h: 'NEED',     w: 50, fmt: r => bar(r.need, 'need') },
    { k: 'fit',        h: 'FIT',      w: 50, fmt: r => bar(r.fit, 'fit') },
  ];

  const bar = (v, cls) => nn(v) ? '—'
    : `<span class="scorebar ${cls}"><i style="width:${Math.min(100, v)}%"></i><em>${Math.round(v)}</em></span>`;

  function nameCell(r) {
    return `<div class="nm">${esc(r.name)}`
      + (r.fs ? ` <span class="badge-fs" title="${r.fs.year}년 실측 재무 반영 · ${r.fs.basis === 'CFS' ? '연결' : r.fs.basis === 'OFS' ? '별도' : '기준 미기록'} · ${r.fs.source === 'api' ? 'DART API' : '감사보고서'}${r.fs.ts_extended ? ' · 시계열 확장' : ' · 수준지표만(시계열은 패널 기준)'}">${String(r.fs.year).slice(2)}`
        + (r.fs.basis === 'CFS' ? '연' : r.fs.basis === 'OFS' ? '별' : '')
        + (r.fs.ts_extended ? '' : '˚') + '</span>' : '')
      + '</div>'
      + `<div class="nm-sub">${r.listed ? `<span class="badge b-listed">상장 ${esc(r.stock_code)}</span>`
        : '<span class="badge b-unlisted">비상장</span>'} ${esc(r.industry || r.sector || '')}</div>`;
  }
  function typeCell(r) {
    const t = DATA.meta.types[r.type];
    return `<span class="tt ${TYPE_COLOR[r.type] || ''}" title="${esc(t ? t.desc : '')}">${esc(t ? t.label : r.type)}</span>`;
  }
  const STANCE_CLS = { positive: 'st-pos', negative: 'st-neg', neutral: 'st-neu' };
  const STANCE_MARK = { positive: '＋', negative: '−', neutral: '?' };
  function angleCell(r) {
    const tags = r.angle_tags || [];
    if (!tags.length) return '<span class="muted">—</span>';
    // 앵글 필터가 걸려 있으면 그 앵글을 보여준다. primary 를 고집하면
    // "성장 positive" 로 걸러놓고 칩에는 "부실·리파이낸싱−" 이 뜨는 혼란이 생긴다.
    const a = (F.angle !== 'all' && tags.find(x => x.code === F.angle)) || tags[0];
    const meta = (DATA.meta.angles || {})[a.code] || { label: a.code, desc: '' };
    const others = tags.filter(x => x !== a);
    const extra = others.length ? `<span class="amore" title="${esc(others.map(x => ((DATA.meta.angles || {})[x.code] || {}).label + '(' + x.stance + ')').join(' · '))}">+${others.length}</span>` : '';
    return `<span class="al ${STANCE_CLS[a.stance]}" title="${esc(a.why)}">${esc(meta.label)}`
      + `<em>${STANCE_MARK[a.stance]}</em></span>${extra}`;
  }
  function statusCell(r) {
    if (!r.status) return '<span class="muted">—</span>';
    const m = STATUS_META[r.status] || { label: r.status, cls: 'st-gray', tip: '' };
    return `<span class="stt ${m.cls}" title="${esc(m.tip)}">${esc(m.label)}</span>`;
  }

  function detail(r) {
    const years = DATA.meta.years;
    const s = r.series || {};
    const kv = (label, val, tip) =>
      `<div class="kv"${tip ? ` title="${esc(tip)}"` : ''}><span>${esc(label)}</span><b>${val}</b></div>`;
    const angles = (r.angles || []).map(a => `<span class="angle">${esc(a)}</span>`).join('');
    const STANCE = { positive: ['긍정', 'st-pos'], negative: ['부정', 'st-neg'], neutral: ['판단보류', 'st-neu'] };
    const angleLayer = (r.angle_tags || []).length
      ? (r.angle_tags || []).map(a => {
        const meta = (DATA.meta.angles || {})[a.code] || { label: a.code, desc: '' };
        const [sl, sc] = STANCE[a.stance] || STANCE.neutral;
        return `<div class="alrow"><span class="al ${sc}" title="${esc(meta.desc)}">${esc(meta.label)}`
          + `<em>${sl}</em></span><span class="alwhy">${esc(a.why)}</span></div>`;
      }).join('')
      : '<div class="muted">해당 앵글 없음</div>';
    const drivers = (r.drivers || []).map(d => `<li>${esc(d)}</li>`).join('') || '<li class="muted">해당 없음</li>';
    const ev = (r.events_24m || []).slice(0, 6).map(e =>
      `<li><span class="evd">${esc(e.date)}</span> <span class="evc">${esc(e.cat)}</span> ` +
      `<a href="https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${esc(e.rcept_no)}" target="_blank" rel="noopener">${esc(e.report_nm)}</a></li>`).join('');
    const dartSearch = `https://dart.fss.or.kr/dsab007/main.do?option=corp&textCrpNm=${encodeURIComponent(r.name)}`;

    return `<div class="detail">
      <div class="det-grid">
        <div class="det-box">
          <h4>조달 진단 <span class="hint">${r.gap_basis === 'measured_cashbridge'
            ? `${r.fs.year}년 실측 캐시브리지` : '현금흐름 항등식 역산'}</span></h4>
          ${r.gap_basis === 'measured_cashbridge' ? `
            <div class="bridge">
              <div class="brow"><span>기초현금</span><b>${wonU(r.bridge.begin_cash)}</b></div>
              ${[['OCF (실측)', r.bridge.ocf], ['Capex (실측)', -r.bridge.capex],
                 ...(r.bridge.lease_repay ? [['리스부채 상환 (IFRS16)', -r.bridge.lease_repay]] : []),
                 [`단기부채 상환(${Math.round((1 - r.bridge.rollover) * 100)}%)`, -r.bridge.st_repay]]
                .map(([l, v]) => `<div class="brow"><span>${esc(l)}</span><b class="${v < 0 ? 'neg' : 'pos'}">${signed(v)}</b></div>`).join('')}
              <div class="brow tot"><span>= 1년 후 사전현금</span><b class="${r.bridge.pre_fin < r.bridge.min_cash ? 'neg' : 'pos'}">${wonU(r.bridge.pre_fin)}</b></div>
              <div class="brow"><span>목표 최소현금 (매출 3%)</span><b>${wonU(r.bridge.min_cash)}</b></div>
              <table class="btab"><tr><th>연차</th><th>OCF</th><th>사전현금</th><th>부족액</th></tr>
                ${r.bridge.years.map(y => `<tr><td>${y.y}년</td><td>${won(y.ocf)}</td>` +
                  `<td class="${y.pre_fin < r.bridge.min_cash ? 'neg' : ''}">${won(y.pre_fin)}</td>` +
                  `<td class="${y.gap > 0 ? 'neg' : ''}">${won(y.gap)}</td></tr>`).join('')}</table>
              <div class="brow tot"><span>⇒ ${r.bridge.horizon}년 누적 부족액</span><b class="${r.gap_3y > 0 ? 'neg' : 'pos'}">${wonU(r.gap_3y)}</b></div>
              ${(r.bridge.sensitivity || []).length ? `<div class="sens"><span>미차환율 민감도</span>${
                r.bridge.sensitivity.map(s => `<b class="${s.nonroll === r.bridge.nonroll ? 'on' : ''}">${Math.round(s.nonroll * 100)}% → ${wonU(s.gap_cum)}</b>`).join('')
              }</div>` : ''}
            </div>
            <div class="det-note">성장률 ${pct(r.bridge.growth)} (과거 3Y CAGR ${pct(r.bridge.growth_raw)} × 감쇠 ${r.bridge.growth_shrink})
              · 미차환율 ${pct(r.bridge.nonroll)} (산업 기준)
              · 목표최소현금 ${pct(r.bridge.min_cash_pct, 1)} (${r.bridge.min_cash_basis === 'company_history' ? '자사 이력 하한' : '산업 밴드'})
              · 부족분은 조달했다고 보고 이월</div>
            <div class="det-sub">참고 — 순부채 증분 기반 진단 (${DATA.meta.years[DATA.meta.years.length - 1]}년까지)</div>
          ` : ''}
          ${kv('3년 실현 조달흡수 (ΔNetDebt)', won(r.draw_3y) + '억', '지난 3년간 순부채 증가액 = 실제로 흡수한 외부자금(관측값)')}
          ${kv('같은 기간 EBITDA 합', won(r.ebitda_sum3) + '억')}
          ${kv('외부의존도 (조달/EBITDA합)', nn(r.dep_ratio) ? '—' : r.dep_ratio.toFixed(2) + 'x', '1을 넘으면 벌어들인 것보다 더 많이 빌려 성장')}
          ${kv('매출 1원 성장당 순부채', nn(r.nd_per_rev) ? '—' : r.nd_per_rev.toFixed(2) + '원', '운전자본·capex 집약도. 0.5 넘으면 성장이 곧 현금소진')}
          ${kv('연평균 자금소요 (역산)', won(r.uses_avg3) + '억', 'uses = ΔNetDebt + OCF코어. 투자+운전자본+배당 합계')}
          ${kv('OCF 코어 (EBITDA−이자−세금)', won(r.ocf_core) + '억')}
          ${r.gap_basis === 'measured_cashbridge' ? '' : kv('향후 12개월 부족액 추정',
            r.gap_note ? '<span class="muted">추정 부적합</span>'
              : `<span class="${r.gap_12m > 0 ? 'neg' : ''}">${wonU(r.gap_12m)}</span>` +
                (nn(r.gap_pct_rev) ? '' : ` <span class="muted">(매출의 ${pct(r.gap_pct_rev)})</span>`),
            '연평균 자금소요를 성장률로 스케일 → OCF·여유현금 차감')}
          ${r.gap_note ? `<div class="det-note">⚠ ${esc(r.gap_note)}</div>` : ''}
          ${nn(r.nd_rev) ? '' : kv('순부채/매출', r.nd_rev.toFixed(1) + '배')}
          ${r.runway_m == null ? '' : kv('현금 런웨이', r.runway_m + '개월', 'OCF코어 적자 기준')}
        </div>
        <div class="det-box">
          <h4>재무 추이 <span class="hint">${years[0]}~${r.latest_year}${r.fs
            ? ` · ${r.fs.year} 실측 ${r.fs.basis === 'CFS' ? '연결' : r.fs.basis === 'OFS' ? '별도' : ''}(${r.fs.source === 'api' ? 'DART API' : '감사보고서'})` : ''}</span></h4>
          ${r.fs ? `<div class="basisrow">
            <span class="bch ${r.fs.basis === 'CFS' ? 'on' : ''}">수준지표 = ${r.fs.basis === 'CFS' ? '연결' : r.fs.basis === 'OFS' ? '별도' : '?'}</span>
            <span class="bch ${r.fs.ts_extended ? 'on' : 'off'}">시계열 = ${r.fs.ts_extended ? `${r.fs.year}까지 실측 확장` : `패널 기준(${DATA.meta.years[DATA.meta.years.length - 1]}까지)`}</span>
          </div>` : ''}
          ${r.fs ? `<div class="fsbox">
            ${[['OCF', r.fs.ocf], ['Capex', r.fs.capex], ['배당', r.fs.dividend], ['리스상환', r.fs.lease_repay],
               ['지분투자', r.fs.equity_inv], ['총차입금', r.fs.gross_debt],
               ['단기차입', r.fs.borrowings_st], ['이자비용', r.fs.interest]]
              .filter(([, v]) => v != null)
              .map(([l, v]) => `<div class="kv"><span>${l}</span><b class="${v < 0 ? 'neg' : ''}">${wonU(v)}</b></div>`).join('')}
            ${r.fs.ebitda_source === 'unavailable' ? '<div class="det-note neg">⚠ 감가상각비 미검출 — EBITDA·마진·ND/EBITDA 를 산출하지 않음(영업이익으로 대체하면 자본집약·리스 사업에서 판정이 뒤집힘)</div>' : ''}
            ${r.fs.identity_ok === false ? '<div class="det-note neg">⚠ 재무제표 검산 불일치</div>' : ''}
            ${r.fs.dep_suspect ? `<div class="det-note">⚠ 감가상각비 일부만 포착된 듯 (매출의 ${pct(r.fs.dep_pct_rev, 2)}) — EBITDA 과소평가 가능</div>` : ''}
          </div>
          ${r.fs.cf_direct ? `
          <div class="det-sub">현금흐름표 직접 분해 <span class="hint">EBITDA 경유 없음</span></div>
          <div class="cfdirect">
            <div class="brow"><span>ΔNetDebt (재무상태표 당기−전기)</span><b class="${r.fs.d_net_debt_measured > 0 ? 'neg' : 'pos'}">${signed(r.fs.d_net_debt_measured)}</b></div>
            <div class="brow"><span>uses = (−투자CF) + 배당 + 리스상환</span><b>${wonU(r.fs.uses_direct)}</b></div>
            <div class="brow"><span>− OCF (실측)</span><b class="${r.fs.ocf < 0 ? 'neg' : 'pos'}">${signed(r.fs.ocf)}</b></div>
            ${r.fs.equity_issue ? `<div class="brow"><span>− 유상증자</span><b class="pos">${wonU(r.fs.equity_issue)}</b></div>` : ''}
            <div class="brow"><span>잔차 (항등식 미설명분)</span><b>${signed(r.fs.residual)} <span class="muted">(매출의 ${pct(r.fs.residual_pct, 1)})</span></b></div>
            ${r.fs.residual_basis === 'core' && r.fs.noncash_debt != null
              ? `<div class="brow"><span>− 비현금 부채변동 <span class="muted">(리스 신규인식·환율환산)</span></span><b>${signed(r.fs.noncash_debt)}</b></div>` : ''}
            <div class="brow tot ${r.fs.residual_high ? 'bad' : ''}"><span>= 설명 안 되는 나머지</span>
              <b class="${r.fs.residual_high ? 'neg' : 'pos'}">${signed(r.fs.residual_eff)}
              <span class="muted">(매출의 ${pct(r.fs.residual_eff_pct, 1)})</span></b></div>
            ${r.fs.residual_basis && r.fs.residual_basis.startsWith('raw(')
              ? '<div class="det-note">비현금 부채변동 보정을 적용하면 잔차가 오히려 커져 무효 처리했습니다 — 재무섹션 계정 분류가 부정확할 수 있습니다</div>' : ''}
          </div>
          ${r.fs.fin ? `
          <div class="det-sub">재무활동 항목별 분해 <span class="hint">${r.fs.fin_verified ? '검증 통과' : '⚠ 미검증 — 잔차 보정에 쓰지 않음'}</span></div>
          <div class="cfdirect">
            ${[['차입 유입', r.fs.fin.debt_in], ['차입 상환', r.fs.fin.debt_out], ['차입 순증감(단일항목)', r.fs.fin.debt_net_item],
               ['유상증자', r.fs.fin.equity_in], ['배당', r.fs.fin.dividend], ['리스부채 상환', r.fs.fin.lease_out],
               ['자기주식', r.fs.fin.treasury], ['기타 재무항목', r.fs.fin.other_sum]]
              .filter(([, v]) => v != null && v !== 0)
              .map(([l, v]) => `<div class="brow"><span>${l}</span><b class="${v < 0 ? 'neg' : 'pos'}">${signed(v)}</b></div>`).join('')}
            <div class="brow tot"><span>⇒ 현금 차입순증</span><b class="${r.fs.fin.debt_net_cash < 0 ? 'neg' : 'pos'}">${signed(r.fs.fin.debt_net_cash)}</b></div>
            <div class="brow ${r.fs.fin_fit_ok === false ? 'bad' : ''}"><span>[검증] 항목합계 vs 보고 재무CF</span>
              <b class="${r.fs.fin_fit_ok === false ? 'neg' : 'pos'}">${wonU(r.fs.fin.sum)} vs ${wonU(r.fs.fin.reported)} (차 ${signed(r.fs.fin.fit_gap)})</b></div>
            <div class="brow ${r.fs.cf_balance_ok === false ? 'bad' : ''}"><span>[검증] 기말−기초 = 영업+투자+재무+환율</span>
              <b class="${r.fs.cf_balance_ok === false ? 'neg' : 'pos'}">차 ${signed(r.fs.cf_balance_gap)}</b></div>
          </div>
          ${(r.fs.fin.unclassified || []).length ? `<div class="det-note">미분류 재무항목: ${esc(r.fs.fin.unclassified.slice(0, 6).join(' · '))}</div>` : ''}
          ` : ''}
          ${r.fs.residual_high
            ? '<div class="det-note neg">⚠ 잔차가 매출의 3%를 초과 — SBC·이연법인세·일회성·환율효과 등으로 항등식이 설명하지 못하는 자금 이동이 크다. <b>이 회사는 현금흐름표를 직접 분해해야 한다.</b></div>'
            : '<div class="det-note">잔차 3% 이내 — 항등식이 실제 현금 이동을 잘 설명한다</div>'}
          ` : ''}` : ''}
          ${r.fs_basis_note ? `<div class="det-note">⚠ ${esc(r.fs_basis_note)} → ${DATA.meta.years[DATA.meta.years.length - 1]}년 기준 유지</div>` : ''}
          <div class="sparkrow"><span>매출</span>${spark(s.rev, years)}<b>${wonU(r.rev)}</b></div>
          <div class="sparkrow"><span>EBITDA</span>${spark(s.ebitda, years, { zero: true, cls: 'sp-eb' })}<b>${wonU(r.ebitda)}</b></div>
          <div class="sparkrow"><span>순부채</span>${spark(s.net_debt, years, { zero: true, cls: 'sp-nd' })}<b>${wonU(r.net_debt)}</b></div>
          <div class="sparkrow"><span>현금</span>${spark(s.cash, years, { cls: 'sp-cash' })}<b>${wonU(r.cash)}</b></div>
          <div class="det-mini">
            ${kv('영업이익', won(r.op) + '억')}${kv('순이익', won(r.ni) + '억')}
            ${kv('ROE', pct(r.roe, 1))}${kv('유동비율', pct(r.curr_ratio))}
            ${kv('현금/매출', pct(r.cash_rev, 1))}${kv('영업적자', r.op_loss_yrs + '/3년')}
          </div>
        </div>
        <div class="det-box">
          <h4>판정 근거</h4>
          <ul class="drivers">${drivers}</ul>
          <div class="det-sub">앵글 (정성 · 5분류)</div>
          <div class="anglelayer">${angleLayer}</div>
          <div class="det-sub">9앵글 프레임워크 매핑</div>
          <div class="angles">${angles || '<span class="muted">—</span>'}</div>
          <div class="det-sub">NEED 구성</div>
          <div class="fbars">
            ${['F1','F2','F3','F4'].map((f, i) => {
              const nm = ['레버리지','내부창출','외부의존성장','유동성'][i];
              const v = (r.f || {})[f];
              return `<div class="fbar"><span>${nm}</span><i style="width:${nn(v) ? 0 : v * 100}%"></i><em>${nn(v) ? '—' : Math.round(v * 100)}</em></div>`;
            }).join('')}
          </div>
          ${r.status ? `<div class="det-note">${esc(statusNote(r))}</div>` : ''}
          <div class="det-links">
            <a href="${dartSearch}" target="_blank" rel="noopener">DART 공시 전체 ↗</a>
            ${r.stock_code ? `<a href="https://finance.naver.com/item/main.naver?code=${esc(r.stock_code)}" target="_blank" rel="noopener">네이버 금융 ↗</a>` : ''}
          </div>
        </div>
      </div>
      ${ev ? `<div class="det-box wide"><h4>DART 공시 이력 <span class="hint">최근 24개월 (정기보고서 제외)</span></h4><ul class="evlist">${ev}</ul></div>` : ''}
    </div>`;
  }
  const statusNote = r => {
    const m = STATUS_META[r.status];
    return m ? m.label + ' — ' + m.tip : '';
  };

  function render() {
    const rows = filtered();
    const shown = rows.slice(0, F.limit);
    const m = DATA.meta, st = DATA.stats;
    const stale = m.staleness_months;

    const typeChips = Object.keys(m.types).filter(t => t !== 'SELF').map(t => {
      const n = DATA.rows.filter(r => r.type === t).length;
      return `<button class="chip ${F.types.has(t) ? 'on' : ''} ${TYPE_COLOR[t]}" data-type="${t}" title="${esc(m.types[t].desc)}">`
        + `${esc(m.types[t].label)} <em>${n}</em></button>`;
    }).join('');

    const sectors = [...new Set(DATA.rows.map(r => r.sector))].sort();
    const statuses = [...new Set(DATA.rows.map(r => r.status).filter(Boolean))];

    document.getElementById('fundingRoot').innerHTML = `
      <h1 class="doc-title">💰 자금소요 스크리너 <span class="subtitle">Funding-Need Bottom-up Screener</span></h1>
      <div class="meta">
        재무 패널 <b>${m.universe.deduped.toLocaleString()}</b>개사 → 게이트 통과 <b>${m.universe.passed.toLocaleString()}</b> →
        니즈 보유 <b>${m.universe.need_pool.toLocaleString()}</b> → 보드 적재 <b>${m.universe.top_n.toLocaleString()}</b>
        (상장 ${st.top_split.상장} / 비상장 ${st.top_split.비상장})
        · 회계 기준연도 <b>${m.latest_year}</b>
        ${m.fs2025 && m.fs2025.merged ? `<span class="okmark">· ✅ ${m.fs2025.year}년 실측 반영 <b>${DATA.rows.filter(r => r.fs).length}</b>건 (실측 캐시브리지 ${DATA.rows.filter(r => r.gap_basis === 'measured_cashbridge').length}건)</span>`
          : stale > 15 ? `<span class="warn">· ⚠ 재무 데이터 ${stale}개월 경과 — 최신 이벤트는 DART 오버레이로 보정</span>` : ''}
        ${m.fs2025 && m.fs2025.basis_mismatch_skipped ? `<span class="muted">· 연결/별도 기준 불일치로 미반영 ${m.fs2025.basis_mismatch_skipped}건</span>` : ''}
        ${m.has_events
          ? `<br>DART 공시 오버레이: <b>${(m.events_applied || 0).toLocaleString()}</b>건 적용 (${(m.events_generated || '').slice(0, 10)})`
          : '<br><span class="warn">DART 공시 오버레이 미적용 — 상태 라벨(선행 타겟·조달 완료)이 비어 있음</span>'}
        ${m.events_failed ? `<span class="warn"> · 조회 실패 ${m.events_failed.toLocaleString()}건 (DART IP 스로틀). <code>build.ps1</code> 재실행 시 실패분만 증분 갱신됨</span>` : ''}
      </div>

      <details class="method">
        <summary>방법론 — 왜 순부채 증분이 "조달 니즈"를 잡아내는가</summary>
        <div class="method-body">
          <p><b>순부채 증분은 그 해 실제로 흡수한 외부자금</b>이다. 이걸 축으로 자금소요를 역산한다.
          단 <b>"관측값"이 아니라 실측 기반 근사치</b>로 읽어야 한다 —
          아래 항등식은 SBC·이연법인세 변동·일회성(소송·구조조정·자산매각)·환율효과를 담지 못한다.</p>
          <p><b>2단 구조</b><br>
          ① <b>CF 직접 분해</b> (실측 재무가 있을 때) — EBITDA 를 경유하지 않는다.
          <code>ΔNetDebt = Δ총차입금 − Δ현금성자산</code> 은 재무상태표 당기·전기에서 직접,
          <code>uses = (−투자CF) + 배당 + 리스상환</code> 은 현금흐름표에서 직접 뽑는다.
          그리고 <code>잔차 = ΔNetDebt − (uses − OCF − 유상증자)</code> 를 계산해
          <b>항등식으로 설명 안 되는 금액을 명시</b>한다. 잔차가 매출의 3%를 넘으면
          <span class="tt tt-red">잔차 과다</span> 로 표시하고, 그 회사는 CF 계산서를 직접 봐야 한다.<br>
          ② <b>순부채 역산</b> (실측 재무가 없을 때) — 마스터파일 패널의 순부채·EBITDA 계열로
          <code>uses = ΔNetDebt + OCF코어</code> 를 역산한다. EBITDA 를 거치는 근사 단계가 하나 더 붙으므로
          ①보다 신뢰도가 낮다. 데이터 출처는 KISVALUE 패널이며 DART 실측과는 무관하다.</p>
          <p><b>부족액 — 3년 캐시브리지</b><br>
          <span class="gy">3Y</span> DART 에서 ${m.fs2025 ? m.fs2025.year : 2025}년 재무제표를 직접 받아
          <code>기초현금 + OCF − Capex − 배당 − 리스상환 − 단기차입금×미차환율 = 사전현금</code> 을 3년간 굴린다.
          사전현금이 목표최소현금에 못 미치는 만큼이 그 해 부족액이고, 부족분은 조달했다고 보고 이월한다.
          투영에는 <b>경상 지출만</b> 쓴다 — 투자CF 순액에는 지분투자·자산매각 같은 일회성이 섞여 런레이트로 부적절하다.<br>
          <span class="gy gy1">1Y</span> 실측 재무가 없는 회사는 순부채 역산으로 1년 부족액만 추정한다.</p>
          <p><b>파라미터를 정밀한 척하지 않는다</b><br>
          · <b>목표최소현금</b>: 단일 '매출 3%' 는 근거가 없다. 그 회사가 실제로 버텨온
          <b>현금/매출 비율의 하한(revealed requirement)</b> 을 쓰고, 이력이 얇을 때만 산업 밴드
          (제조 4% · 유통 1.5% · 건설·IT 5% · 숙박음식 2% …)를 쓴다. 상세 패널에 어느 쪽을 썼는지 표시된다.<br>
          · <b>단기차입금 미차환율</b>: 산업별로 다르게 잡는다 (건설·부동산 15% · 운수·숙박 12% · 제조 10% · 도소매 8%).
          이 하나가 결과를 크게 흔들기 때문에 <b>0% / 10% / 20% 민감도</b>를 상세 패널에 함께 싣는다.<br>
          · <b>성장률</b>: 과거 3년 CAGR 을 그대로 투영하면 평균회귀를 무시한다 → <b>0 쪽으로 50% 감쇠</b>
          후 −5%~+15% 로 캡. 셀사이드 컨센서스는 쓰지 않는다(낙관 편향).</p>
          <ul>
            <li><b>NEED</b> = 레버리지(32%) + 내부창출 부족(27%) + 외부의존 성장(22%) + 유동성(19%)</li>
            <li><b>FIT</b> = PE 투자 적합도 (규모·성장·수익성·흑자 지속). 좀비·자본잠식은 감점</li>
            <li><b>PRI</b> = NEED 45% + FIT 25% + <b>조달채널 제약도 30%</b> — 비상장 중소형에서
              "은행·PE 외 대안이 없다"는 것 자체가 PE 협상력의 원천이라 비중을 높였다</li>
          </ul>
          <p class="caveat" style="margin-top:6px"><b>가중치는 판단 기반 사전값(prior)이다.</b>
          딜 성사 데이터로 적합(fit)시킨 값이 아니다. 랭킹의 상대 순서를 참고하되 절대 점수를 신뢰하지 말 것.
          튜닝은 <code>score-funding.js</code> 최상단 <code>P</code> 한 곳에서 한다.</p>
          <p><b>앵글 레이어 (5분류) — 스코어와 독립된 정성 판단</b><br>
          현금흐름 형태가 "돈이 어디로 새는가"라면 앵글은 "왜 조달하는가"다. positive/negative 는
          앵글 안에서 갈린다 — 성장 앵글도 실행리스크가 크면 negative, 부실 앵글도 시황 저점이면 positive.</p>
          <ul>
            <li><b>성장</b> — 신사업·확장 capex. 매출은 늘지만 마진이 훼손되면
              <b>기존사업 하락을 외형성장으로 마스킹</b>하는 것일 수 있어 negative 로 잡는다</li>
            <li><b>부실·리파이낸싱</b> — 구조적 하락(영업적자 지속·역성장·자본잠식)이면 negative,
              매출 회복 + 마진 반등이면 시황 저점 진입으로 positive</li>
            <li><b>이벤트</b> — 상속·증여·분쟁·분할. <b>주주 레벨 사건이라 ΔNetDebt 로는 원리상 포착 불가.</b>
              DART 지배구조·재편 공시로 <b>병렬 필터</b>를 돌린다 (대주주 연령은 DART 에 없어 수동 확인 필요)</li>
            <li><b>리캡</b> — 배당 recap·대주주 현금화·PE secondary. 사업 자금 니즈가 아니다.
              OCF 대비 배당 과다 + 순부채 증가 패턴으로 탐지</li>
            <li><b>규제자본</b> — 증권 NCR·보험 RBC·은행 BIS. <b>현재 금융·보험이 게이트로 제외돼 비활성</b>
              (활성화하려면 <code>P.EXCLUDE_DIV</code> 에서 64·65·66 을 빼고 별도 자본적정성 모델을 붙여야 한다)</li>
          </ul>
          <p class="caveat"><b>알려진 한계</b><br>
          ⓐ <b>항등식 누락 항목</b> — SBC·대손충당금 등 EBITDA 내 비현금(EBITDA가 현금창출력을 과대 표시),
          법인세 납부 타이밍 vs 세금비용 괴리(이연법인세 변동 큰 회사), 일회성(소송합의금·구조조정비·자산매각),
          종속·관계기업 투자, 환율효과. → <b>잔차로 정량화해 표시</b>하되 잔차가 크면 CF 직접 검토가 필요하다.<br>
          ⓑ 유상증자로 조달하면 순부채가 줄어 '자립'처럼 보인다 → DART 오버레이의 <b>조달 완료</b> 라벨로 걸러낸다.<br>
          ⓒ 순부채 역산 기준일 때 이자비용은 순부채×5.5% 근사(과소추정). 실측 기준에서는 실제 이자비용을 쓴다.<br>
          ⓓ 실측 미반영 회사는 회계 기준연도가 ${m.latest_year}년.<br>
          ⓔ <b>승계·증여는 원리상 이 방법론으로 포착 불가</b> — 자금 니즈가 주주 레벨이지 회사 레벨이 아니다.
          회사 순부채가 안 움직여도 대주주가 상속세 재원으로 지분 매각·회사 유증을 추진할 수 있다.
          이벤트 앵글의 병렬 필터로 다루고, 대주주 연령·지분율·가업승계 여부는 수동 확인해야 한다.<br>
          ⓕ 마스터파일 순부채는 금융자산까지 차감한 흔적이 있어 실측(차입금−현금성자산)과 정의가 달라,
          순부채 증분 계열은 ${m.latest_year}년까지만 계산한다.</p>
        </div>
      </details>

      <div class="fcontrols">
        <div class="frow">
          <input id="fq" class="fsearch" type="search" placeholder="회사명 · 산업 · 종목코드 검색" value="${esc(F.q)}" />
          <div class="fseg" id="fListing">
            ${[['all', '전체'], ['unlisted', `비상장 ${st.top_split.비상장}`], ['listed', `상장 ${st.top_split.상장}`]]
              .map(([v, l]) => `<button class="${F.listing === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}
          </div>
          <select id="fSector"><option value="all">전체 섹터</option>
            ${sectors.map(s => `<option value="${esc(s)}" ${F.sector === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
          <select id="fStatus"><option value="all">전체 상태</option>
            ${statuses.map(s => `<option value="${esc(s)}" ${F.status === s ? 'selected' : ''}>${esc((STATUS_META[s] || {}).label || s)}</option>`).join('')}</select>
          <select id="fRev">
            ${[['0|Infinity', '매출 전체'], ['300|1000', '300~1,000억'], ['1000|3000', '1,000~3,000억'],
               ['3000|10000', '3,000~1조'], ['10000|Infinity', '1조 이상']]
              .map(([v, l]) => { const [a, b] = v.split('|');
                const on = F.revMin === Number(a) && String(F.revMax) === b;
                return `<option value="${v}" ${on ? 'selected' : ''}>${l}</option>`; }).join('')}
          </select>
        </div>
        <div class="frow">
          <span class="controls-label">성격</span>
          <div class="chips" id="fTypes">${typeChips}</div>
          <a class="dl" href="./data/funding-pool.csv" download>CSV ↓</a>
        </div>
        <div class="frow">
          <span class="controls-label">앵글</span>
          <select id="fAngle"><option value="all">전체 앵글</option>
            ${Object.entries(m.angles || {}).map(([code, a]) => {
              const n = DATA.rows.filter(r => (r.angle_tags || []).some(x => x.code === code)).length;
              return n ? `<option value="${code}" ${F.angle === code ? 'selected' : ''}>${esc(a.label)} (${n})</option>` : '';
            }).join('')}</select>
          <div class="fseg" id="fStance">
            ${[['all', '전체'], ['positive', '＋ 긍정'], ['negative', '− 부정'], ['neutral', '? 보류']]
              .map(([v, l]) => `<button class="${F.stance === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}
          </div>
          <span class="hintr">앵글·stance는 스코어와 독립된 정성 판단 — positive/negative는 앵글 안에서 갈립니다</span>
        </div>
      </div>

      <div class="fcount">${rows.length.toLocaleString()}건 일치 · ${shown.length}건 표시
        ${rows.length > shown.length ? `<button class="more" id="fMore">더 보기 (+${Math.min(200, rows.length - shown.length)})</button>` : ''}
        <span class="hintr">행을 클릭하면 진단 상세가 열립니다</span></div>

      <div class="table-wrap ftable-wrap">
        <table class="ftable">
          <thead><tr>${COLS.map(c =>
            `<th data-k="${c.k}" style="min-width:${c.w}px" class="${F.sort === c.k ? 'sorted' : ''} ${c.align === 'left' ? 'tl' : ''}">${c.h}${F.sort === c.k ? (F.desc ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead>
          <tbody>${shown.map((r, i) => {
            const key = r.corp_code || r.name;
            const open = expanded.has(key);
            return `<tr class="frow-r ${open ? 'open' : ''}" data-key="${esc(key)}">`
              + COLS.map(c => `<td class="${c.align === 'left' ? 'tl' : ''}">${c.fmt(r)}</td>`).join('') + '</tr>'
              + (open ? `<tr class="fdet"><td colspan="${COLS.length}">${detail(r)}</td></tr>` : '');
          }).join('')}</tbody>
        </table>
      </div>
      ${rows.length === 0 ? '<div class="empty"><h3>조건에 맞는 회사가 없습니다</h3></div>' : ''}
    `;
    wire();
  }

  function wire() {
    const root = document.getElementById('fundingRoot');
    const q = root.querySelector('#fq');
    if (q) {
      let t;
      q.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => { F.q = q.value; F.limit = 120; render(); document.getElementById('fq').focus(); }, 220);
      });
    }
    root.querySelector('#fListing')?.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      F.listing = b.dataset.v; F.limit = 120; render();
    });
    root.querySelector('#fSector')?.addEventListener('change', e => { F.sector = e.target.value; F.limit = 120; render(); });
    root.querySelector('#fStatus')?.addEventListener('change', e => { F.status = e.target.value; F.limit = 120; render(); });
    root.querySelector('#fRev')?.addEventListener('change', e => {
      const [a, b] = e.target.value.split('|');
      F.revMin = Number(a); F.revMax = b === 'Infinity' ? Infinity : Number(b);
      F.limit = 120; render();
    });
    root.querySelector('#fAngle')?.addEventListener('change', e => { F.angle = e.target.value; F.limit = 120; render(); });
    root.querySelector('#fStance')?.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      F.stance = b.dataset.v; F.limit = 120; render();
    });
    root.querySelector('#fTypes')?.addEventListener('click', e => {
      const b = e.target.closest('.chip'); if (!b) return;
      const t = b.dataset.type;
      F.types.has(t) ? F.types.delete(t) : F.types.add(t);
      F.limit = 120; render();
    });
    root.querySelector('#fMore')?.addEventListener('click', () => { F.limit += 200; render(); });
    root.querySelectorAll('.ftable thead th').forEach(th => th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (F.sort === k) F.desc = !F.desc; else { F.sort = k; F.desc = true; }
      render();
    }));
    root.querySelectorAll('.frow-r').forEach(tr => tr.addEventListener('click', ev => {
      if (ev.target.closest('a')) return;
      const key = tr.dataset.key;
      expanded.has(key) ? expanded.delete(key) : expanded.add(key);
      render();
    }));
  }

  window.initFunding = async function initFunding() {
    if (loaded) return;
    try {
      const res = await fetch(`${POOL_URL}?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      DATA = await res.json();
      loaded = true;
      render();
    } catch (err) {
      document.getElementById('fundingRoot').innerHTML =
        `<div class="empty"><div class="empty-ico">💰</div><h3>자금소요 데이터가 없습니다</h3>
         <p>${esc(err.message)}</p>
         <p><code>powershell -ExecutionPolicy Bypass -File .\\funding\\build.ps1</code> 로 생성하세요.</p></div>`;
    }
  };

  // app.js 는 이 파일보다 먼저 실행되므로 #funding 해시로 진입했을 때 initFunding 을 못 잡는다.
  // 뷰가 이미 열려 있으면 스스로 초기화한다.
  const v = document.getElementById('view-funding');
  if (v && !v.hidden) window.initFunding();
})();
