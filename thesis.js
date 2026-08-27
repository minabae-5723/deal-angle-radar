// Thesis 보드 (thesis-first) — data/theses.json + data/thesis-candidates.json
// 탑다운 신규 네러티브 Thesis → 클릭 시 바텀업(외감 후보) 드릴다운.
(function () {
  let loaded = false;
  let THESES = null,CAND = null;
  let filter = { pillar: 'all', tier: 'all' };

  const PILLARS = { '반도체': '#4ea1ff', 'AI SW': '#a978ff', '헬스케어': '#38d39f' };
  const TIER_LABEL = { 1: '즉시 실행 (롤업·승계)', 2: '성장자금·세컨더리', 3: '관찰·구조적' };
  const esc = (s) => String(s !== null && s !== void 0 ? s : '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const won = (n) => n >= 10000 ? (n / 10000).toFixed(1) + '조' : Math.round(n) + '억';
  const pct = (x) => x == null ? '—' : (x * 100).toFixed(0) + '%';

  window.initThesis = async function () {
    const root = document.getElementById('thesisRoot');
    if (loaded) {render();return;}
    root.innerHTML = '<div class="empty"><div class="empty-ico">🧭</div><h3>로딩 중…</h3></div>';
    try {
      const [t, c] = await Promise.all([
      fetch('./data/theses.json?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()),
      fetch('./data/thesis-candidates.json?_=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok ? r.json() : {}).catch(() => ({}))]
      );
      THESES = t;CAND = c || {};loaded = true;
      render();
    } catch (e) {
      root.innerHTML = `<div class="empty"><h3>로딩 실패</h3><p>${esc(e.message)}</p></div>`;
    }
  };

  function render() {
    const root = document.getElementById('thesisRoot');
    const list = THESES.theses.filter((x) =>
    (filter.pillar === 'all' || x.pillar === filter.pillar) && (
    filter.tier === 'all' || String(x.tier) === filter.tier));
    const pills = (p) => `<button class="th-pill${filter.pillar === p ? ' on' : ''}" data-f="pillar" data-v="${p}">${p === 'all' ? '전체 pillar' : p}</button>`;
    const tpills = (t) => `<button class="th-pill${filter.tier === t ? ' on' : ''}" data-f="tier" data-v="${t}">${t === 'all' ? '전체 tier' : 'Tier ' + t}</button>`;

    let html = `
      <div class="th-intro">
        <div class="th-intro-pat"><b>메타패턴</b> — ${esc(THESES.meta.meta_pattern)}</div>
        <div class="th-filters">
          ${['all', '반도체', 'AI SW', '헬스케어'].map(pills).join('')}
          <span class="th-sep"></span>
          ${['all', '1', '2', '3'].map(tpills).join('')}
        </div>
      </div>`;

    for (const tier of [1, 2, 3]) {
      const group = list.filter((x) => x.tier === tier);
      if (!group.length) continue;
      html += `<div class="th-tier-head"><span class="th-tier-badge t${tier}">Tier ${tier}</span> ${TIER_LABEL[tier]} <span class="th-count">${group.length}</span></div>`;
      html += '<div class="th-grid">' + group.map(card).join('') + '</div>';
    }
    root.innerHTML = html;

    root.querySelectorAll('.th-pill').forEach((b) => b.onclick = () => {
      filter[b.dataset.f] = b.dataset.v;render();
    });
    root.querySelectorAll('.th-card').forEach((c) => c.querySelector('.th-card-top').onclick = () => {
      c.classList.toggle('open');
    });
  }

  function card(t) {
    const col = PILLARS[t.pillar] || '#888';
    const nodes = (t.nodes || []).map((n) => {
      const L = (n.listed || []).map((x) => `<span class="th-co listed">${esc(x)}</span>`).join('');
      const U = n.unlisted ? `<span class="th-co unlisted">◆ ${esc(n.unlisted)}</span>` : '';
      return `<div class="th-node"><div class="th-node-name">${esc(n.node)}</div><div class="th-node-cos">${L}${U}</div></div>`;
    }).join('');
    const sig = (t.signals || []).map((s) => `<li>${esc(s)}</li>`).join('');
    const cand = candBlock(t.id);

    return `<div class="th-card" style="--pcol:${col}">
      <div class="th-card-top">
        <div class="th-card-head">
          <span class="th-badge" style="background:${col}">${esc(t.pillar)}</span>
          <span class="th-id">${esc(t.id)}</span>
          <span class="th-angle">${esc(t.angle)}</span>
        </div>
        <h3 class="th-title">${esc(t.title)}</h3>
        <div class="th-why">${esc(t.why)}</div>
      </div>
      <div class="th-detail">
        <div class="th-sec-label">밸류체인 노드 <span class="th-hint">(◆ = 비상장 타깃)</span></div>
        ${nodes}
        <div class="th-sec-label">잡아낼 신호</div>
        <ul class="th-sig">${sig}</ul>
        ${cand}
      </div>
    </div>`;
  }

  const TYPE_KO = { DISTRESS: '구조조정', REFI: '롤오버', WC_BURN: '운전자본', GROWTH: '성장자금', TIGHT: '유동성', SELF: '자립' };
  function catOf(r) {
    if (r.listed) return { k: '상장 벤치마크', c: 'bench' };
    if (r.quality || r.bizFit) return { k: '비상장 타깃', c: 'target' };
    if (r.screened) return { k: '검증 필요', c: 'verify' };
    return { k: '리스트업', c: 'lead' };
  }
  // DART 원문 → 제품·사업 한 줄로 압축 (일반 문구는 걸러 공란)
  const PROD_JUNK = /영업활동|설립되었|본사는|소재하고|미래전망|신기술사업금융|보고기간말|전략운영|재무적인|영업부문|해당 여부|사업목적/;
  function productOf(biz) {
    if (!biz) return '';
    const m = biz.match(/(?:당사|회사|지배기업|연결회사)[는은]?\s*(.+?)\s*등?\s*(?:을|를|의)?\s*(?:제조|생산|판매|개발|공급|제공|영위)/);
    if (!m) return '';
    let p = m[1].replace(/\(이하[^)]*\)/g, '').
    replace(/^(주식회사|국내에서만|다음의|아래|현재|보고기간말\s*현재)\s*/, '').
    replace(/^\d{4}년[^가-힣]*?(?:자로|이후|에)?\s*/, '').trim();
    if (!p || p.length < 2 || p.length > 46 || PROD_JUNK.test(p)) return '';
    return p;
  }
  // 딜 앵글 = 우량/고성장(thesis 수혜) + 조달니즈(딜앵글) + Thesis적합
  function angleOf(r) {
    const a = [];
    if (r.quality) a.push(`우량 · 매출CAGR ${r.revCagr != null ? (r.revCagr >= 0 ? '+' : '') + Math.round(r.revCagr * 100) + '%' : '—'} · OPM ${pct(r.opm)}`);else
    if (r.revCagr != null && r.revCagr >= 0.15) a.push(`고성장 · 매출CAGR +${Math.round(r.revCagr * 100)}%`);
    const tl = TYPE_KO[r.type];
    if (r.need != null && r.need >= 40 && tl) a.push(`${tl}형 조달니즈 ${r.need}`);
    if (r.bizFit) a.push('Thesis 적합');
    return a.length ? a.join('   ·   ') : '재무·지분 확인 필요';
  }
  function candBlock(id) {
    const c = CAND[id];
    if (!c || !c.rows || !c.rows.length) return `<div class="th-sec-label">타깃·리드 풀</div><div class="th-cand-empty">배선 데이터 없음.</div>`;
    const leads = c.rows.map((r) => {
      const off = r.curated && r.onThesis === false;
      const cat = off ? { k: '오프Thesis', c: 'off' } : catOf(r);
      const prod = r.curProduct || productOf(r.biz);
      const angle = r.curAngle || angleOf(r);
      const fin = [`매출 ${won(r.rev)}`];
      if (r.revCagr != null) fin.push(`CAGR ${r.revCagr >= 0 ? '+' : ''}${Math.round(r.revCagr * 100)}%`);
      if (r.opm != null) fin.push(`OPM ${pct(r.opm)}`);
      if (r.need != null) fin.push(`<b class="th-need">need ${r.need}</b>${r.type ? '(' + (TYPE_KO[r.type] || r.type) + ')' : ''}`);
      return `<div class="th-lead cat-${cat.c}${off ? ' off' : ''}" data-listed="${r.listed ? 1 : 0}" data-need="${r.need == null ? 0 : 1}" data-q="${r.quality ? 1 : 0}" data-off="${off ? 1 : 0}">
        <div class="th-lead-head">
          <span class="th-cat ${cat.c}">${cat.k}</span>
          <span class="th-lead-name">${esc((r.name || '').replace(/\(주\)/g, ''))}</span>
          ${r.curated && !off ? '<span class="th-star">★큐레이션</span>' : ''}
          <span class="th-lead-fin">${fin.join(' · ')}</span>
        </div>
        ${prod ? `<div class="th-lead-prod"><span class="th-lbl">제품</span>${esc(prod)}</div>` : ''}
        <div class="th-lead-angle"><span class="th-lbl angle">앵글</span>${esc(angle)}</div>
      </div>`;
    }).join('');
    return `<div class="th-sec-label">타깃·리드 풀 <span class="th-hint">외감 ${c.total}개 · 비상장 ${c.unlisted} · 우량 ${c.quality || 0} · 조달니즈 ${c.withNeed || 0} · ★큐레이션 확정 ${c.onThesis || 0}</span></div>
      <div class="th-screen" data-id="${id}">
        <label class="ax-q"><input type="checkbox" class="th-flt" data-k="q"> 우량만</label>
        <label class="ax-need"><input type="checkbox" class="th-flt" data-k="need"> 조달니즈만</label>
        <label><input type="checkbox" class="th-flt" data-k="unl"> 비상장만</label>
        <label><input type="checkbox" class="th-flt" data-k="off" checked> 오프Thesis 숨기기</label>
        <span class="th-hint">🔎 상위 20 DART 사업내용 LLM 큐레이션(제품·앵글·오탐필터)</span>
      </div>
      <div class="th-leads">${leads}</div>`;
  }

  // 필터 (우량 / 조달니즈 / 비상장 / 오프Thesis)
  function applyFlt(box) {
    const pool = box.parentElement.querySelector('.th-leads');
    const q = box.querySelector('[data-k="q"]').checked;
    const need = box.querySelector('[data-k="need"]').checked;
    const unl = box.querySelector('[data-k="unl"]').checked;
    const hideOff = box.querySelector('[data-k="off"]').checked;
    pool.querySelectorAll('.th-lead').forEach((el) => {
      const ok = (!q || el.dataset.q === '1') && (!need || el.dataset.need === '1') && (
      !unl || el.dataset.listed === '0') && (!hideOff || el.dataset.off === '0');
      el.style.display = ok ? '' : 'none';
    });
  }
  document.addEventListener('change', (e) => {
    const flt = e.target.closest('.th-flt');if (!flt) return;
    applyFlt(flt.closest('.th-screen'));
  });
  // 카드 펼칠 때 기본 필터(오프Thesis 숨김) 적용
  document.addEventListener('click', (e) => {
    const top = e.target.closest('.th-card-top');if (!top) return;
    const card = top.closest('.th-card');
    setTimeout(() => {const box = card.querySelector('.th-screen');if (box) applyFlt(box);}, 0);
  });
})();
