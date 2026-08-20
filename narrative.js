// narrative.js — 네러티브 기반 딜소싱 스크리너 뷰
// data/narrative-pool.json (build-narrative.mjs 산출) 을 읽어 렌더.
// 성장률이 아니라 공급탄력성으로 정렬. 하베스트 후보(candidate)는 상단 승인대기 영역.
(function () {
  let inited = false, data = null, curTheme = null;
  let nodeFilter = null, tierFilter = null, angleFilter = null;   // 롱리스트 필터 상태 (테마 전환 시 리셋)

  const ELAS = {
    very_low: { label: "매우 낮음 ★", cls: "el-vlow" },
    low:      { label: "낮음",       cls: "el-low" },
    mid:      { label: "중간",       cls: "el-mid" },
    high:     { label: "높음(주의)", cls: "el-high" }
  };
  const ELAS_ORDER = { very_low: 0, low: 1, mid: 2, high: 3 };
  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pct = x => x == null ? "–" : (x * 100).toFixed(0) + "%";
  const money = x => x == null ? "–" : (x >= 10000 ? (x / 10000).toFixed(1) + "조" : Math.round(x) + "억");

  // ═══════════════════════════════════════════════════════════════════════
  // 전략 검토 우선순위 (SFIT) — 전략분석 agent 레이어
  //   기업분석 이전에 "어느 회사부터 붙을지"를 가르는 스크리닝 점수. 롱리스트 row 필드
  //   (rev/opm/cagr3/nd/need/type/status/listed) 의 순수함수 → 빌드 커플링 없이 항상 동기화.
  //   가중치·매핑 사전값 출처: Notion <PE 전략 케이스맵> + <Deal_Angle_Screening PHASE3> +
  //   <조달니즈 type 정의>. 절대치보다 회사 간 상대순위로 읽을 것.
  // ═══════════════════════════════════════════════════════════════════════
  const SFIT_W = { theme: 0.22, angle: 0.24, source: 0.16, ticket: 0.16, quality: 0.10, catalyst: 0.12 };
  const ELAS_SCORE = { very_low: 1.0, low: 0.7, mid: 0.4, high: 0.15 };
  // type → RVP 딜앵글 강점 매핑 (조달니즈 type 정의). GROWTH=FI최적, DISTRESS/REFI=구조조정·리파이 강점.
  const ANGLE_SCORE = { GROWTH: 1.0, DISTRESS: 0.85, REFI: 0.85, TIGHT: 0.55, WC_BURN: 0.45, SELF: 0.15 };

  function opmScore(o) { return o == null ? 0.3 : o >= 0.15 ? 1 : o >= 0.10 ? 0.8 : o >= 0.05 ? 0.55 : o >= 0 ? 0.35 : 0.15; }
  function cagrScore(c) { return c == null ? 0.4 : c >= 0.20 ? 1 : c >= 0.10 ? 0.7 : c >= 0 ? 0.4 : 0.1; }
  function ticketScore(rev) { // 매출을 규모 프록시로 — RVP 커버 구간(자체 소수지분 / 컨소 슬롯)
    if (rev == null) return 0.4;
    return rev <= 2500 ? 1.0 : rev <= 6000 ? 0.6 : 0.3;
  }
  const CATALYST_SCORE = { DISTRESS_EVENT: 1.0, IN_MOTION: 0.9, PRE_SIGNAL: 0.8, UNLISTED_BLIND: 0.55, RECENTLY_FUNDED: 0.25 };

  // 앵글A 캐시카우/승계 후보 (케이스맵 재현스크린: 비상장·고마진·순현금)
  //   listed!==true = 비상장 또는 풀 밖(이벤트 미관측) — 상장사만 제외.
  const isCashCow = r => r.listed !== true && r.opm != null && r.opm >= 0.15 && r.nd != null && r.nd < 0;

  function scoreRow(r, themeElas) {
    const fTheme = ELAS_SCORE[themeElas] ?? 0.4;
    const fAngle = r.type ? (ANGLE_SCORE[r.type] ?? 0.35) : 0.35;
    const fSource = r.listed === false ? 1.0 : r.listed === true ? 0.55 : 0.5;
    const fTicket = ticketScore(r.rev);
    const fQuality = 0.7 * opmScore(r.opm) + 0.3 * cagrScore(r.cagr3);
    const fCatalyst = r.status ? (CATALYST_SCORE[r.status] ?? 0.35) : 0.35;
    let s = 100 * (SFIT_W.theme * fTheme + SFIT_W.angle * fAngle + SFIT_W.source * fSource +
      SFIT_W.ticket * fTicket + SFIT_W.quality * fQuality + SFIT_W.catalyst * fCatalyst);
    if (isCashCow(r)) s = Math.min(100, s + 6); // 캐시카우/승계 앵글 가점
    return Math.round(s);
  }
  // 5단계 — B밴드(52~67)를 60 기준으로 B(우선)·Bm(후보)로 분할
  function tierOf(s) { return s >= 68 ? "A" : s >= 60 ? "B" : s >= 52 ? "Bm" : s >= 38 ? "C" : "D"; }
  const TIER_ORDER = ["A", "B", "Bm", "C", "D"];
  const TIER_LABEL = { A: "즉시", B: "우선", Bm: "후보", C: "관찰", D: "보류" };
  const TIER_DISP  = { A: "A", B: "B", Bm: "B⁻", C: "C", D: "D" };   // B⁻ 표기
  const TIER_RANGE = { A: "≥68", B: "60~67", Bm: "52~59", C: "38~51", D: "&lt;38" };

  // 1줄 전략 앵글 태그 — 어떤 딜 구조로 접근할지 (케이스맵 유형 매핑)
  function angleLabel(r) {
    const note = (r.note || "");
    if (/볼트온|bolt|add-?on/i.test(note)) return "볼트온 (플랫폼 add-on)";
    if (isCashCow(r)) return "캐시카우 인수 (앵글A·승계)";
    const L = r.listed;
    switch (r.type) {
      case "GROWTH":   return L === false ? "성장자금 FI·신주 소수지분" : "3자배정 성장자금";
      case "DISTRESS": return L === false ? "구조조정·리파이 크레딧" : "메자닌·리파이";
      case "REFI":     return L === false ? "롤오버 리파이·밸류업" : "메자닌·리파이";
      case "WC_BURN":  return "성장자금 (운전자본 소진 주의)";
      case "TIGHT":    return "유동성 브릿지 (소형)";
      case "SELF":     return "니즈 낮음 — 승계·밸류업 확인";
      default:         return r.inPool ? "니즈 미분류" : "재무 미확보 — 소싱 확인";
    }
  }

  window.initNarrative = async function () {
    if (inited) return;
    inited = true;
    const root = document.getElementById("narrativeRoot");
    try {
      const res = await fetch(`./data/narrative-pool.json?_=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
    } catch (e) {
      root.innerHTML = `<div class="empty"><div class="empty-ico">📐</div><h3>로딩 실패</h3><p>${esc(e.message)}</p><p>먼저 <code>node narrative/build-narrative.mjs</code> 실행 필요.</p></div>`;
      return;
    }
    curTheme = (data.themes.find(t => t.status === "approved") || data.themes[0]).id;
    render();
  };

  function render() {
    const root = document.getElementById("narrativeRoot");
    const approved = data.themes.filter(t => t.status === "approved");
    const candidates = data.themes.filter(t => t.status === "candidate");
    root.innerHTML =
      intro() +
      (candidates.length ? candidateBox(candidates) : "") +
      matrix(approved) +
      themePills(approved) +
      `<div id="themeSheet"></div>`;
    root.querySelectorAll(".nv-pill").forEach(b => b.addEventListener("click", () => { curTheme = b.dataset.id; nodeFilter = null; tierFilter = null; angleFilter = null; renderSheet(); root.querySelectorAll(".nv-pill").forEach(x => x.classList.toggle("active", x.dataset.id === curTheme)); document.getElementById("themeSheet").scrollIntoView({ behavior: "smooth", block: "start" }); }));
    renderSheet();
  }

  function intro() {
    return `<div class="nv-intro">
      <p><strong>네러티브 → transmission KPI → value chain 노드 → 외감 롱리스트</strong>. 롱리스트를 가르는 축은 성장률이 아니라 <strong>공급탄력성</strong> — 수요가 늘어도 공급이 못 따라올 때만 가격·마진으로 전이된다.</p>
      <p class="nv-dim">유니버스: 외감법인 41,409개 패널 × funding-pool 니즈 오버레이 · 회계 ${esc(data.meta.accounting_year || "")} · 포착: 자산 하베스트(PPI·insight·news) + 사용자 승인 · 재빌드: <code>node narrative/build-narrative.mjs</code></p>
    </div>`;
  }

  function candidateBox(cands) {
    return `<section class="card nv-cand"><h2 class="card-title">🌱 하베스트 후보 (승인 대기 ${cands.length})</h2>
      <p class="nv-dim">PPI 가속·insight·news 에서 포착된 신규 narrative 후보. 승인 시 정식 테마로 편입.</p>
      ${cands.map(c => `<div class="nv-cand-row"><span class="nv-cand-title">${esc(c.emoji)} ${esc(c.title)}</span>
        <span class="nv-prov">${esc(c.provenance?.source || "")} · ${esc(c.provenance?.evidence || "")}</span></div>`).join("")}
    </section>`;
  }

  function matrix(themes) {
    const sorted = [...themes].sort((a, b) => (ELAS_ORDER[a.catalog?.supply_elasticity] ?? 9) - (ELAS_ORDER[b.catalog?.supply_elasticity] ?? 9));
    const abCount = t => { let a = 0, b = 0; (t.longlist || []).forEach(r => { const tr = tierOf(scoreRow(r, t.catalog?.supply_elasticity)); if (tr === "A") a++; else if (tr === "B") b++; }); return { a, b }; };
    return `<section class="card"><h2 class="card-title">테마 카탈로그 — 공급탄력성 순</h2>
      <div class="table-wrap"><table class="nv-matrix">
      <tr><th>테마</th><th>구조/순환</th><th>공급탄력성</th><th>지속성</th><th>롱리스트</th><th>A/B급</th><th>풀(니즈)</th><th>비상장</th></tr>
      ${sorted.map(t => { const e = ELAS[t.catalog?.supply_elasticity] || {}; const ab = abCount(t); return `<tr class="nv-mrow" data-id="${t.id}">
        <td><b>${esc(t.emoji)} ${esc(t.title)}</b></td>
        <td>${esc(t.catalog?.structural || "")}</td>
        <td><span class="nv-elas ${e.cls || ""}">${esc(e.label || t.catalog?.supply_elasticity || "")}</span></td>
        <td>${esc(t.catalog?.persistence || "")}</td>
        <td>${t.stats?.total ?? 0}</td>
        <td><span class="nv-abcell"><b class="nv-gA">${ab.a}</b>/<span class="nv-gB">${ab.b}</span></span></td>
        <td>${t.stats?.inPool ?? 0}</td><td>${t.stats?.unlisted ?? 0}</td></tr>`; }).join("")}
      </table></div></section>`;
  }

  function themePills(themes) {
    return `<div class="nv-pills">` + themes.map(t =>
      `<button class="nv-pill${t.id === curTheme ? " active" : ""}" data-id="${t.id}">${esc(t.emoji)} ${esc(t.title)}</button>`).join("") + `</div>`;
  }

  function kpiGrid(t) {
    const K = t.kpi || {};
    const rows = [
      ["Catalyst", K.catalyst], ["Structural/Cyclical", K.structural], ["Demand KPI", K.demand],
      ["Supply KPI ★", K.supply], ["Pricing", K.pricing], ["CAPEX", K.capex], ["Persistence", K.persistence]
    ].filter(r => r[1]);
    if (!rows.length) return `<div class="meta">KPI 미작성 — 리서치 대기 중.</div>`;
    return `<div class="table-wrap"><table class="nv-kpi">` +
      rows.map(r => `<tr><th>${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`).join("") + `</table></div>`;
  }

  // 롱리스트에 SFIT·티어·앵글을 부착하고 우선순위로 정렬 (pick 은 상단 고정)
  function scoreLonglist(ll, themeElas) {
    const scored = (ll || []).map(r => {
      const sfit = scoreRow(r, themeElas);
      return { ...r, sfit, tier: tierOf(sfit), angleLbl: angleLabel(r), cashcow: isCashCow(r) };
    });
    scored.sort((a, b) => (b.pick - a.pick) || (b.sfit - a.sfit) || ((b.rev || 0) - (a.rev || 0)));
    return scored;
  }

  // 티어 요약바 — 각 칩 클릭 = 해당 티어만 필터 (토글). 캐시카우 칩도 필터.
  function tierSummary(scored) {
    const c = { A: 0, B: 0, Bm: 0, C: 0, D: 0 };
    scored.forEach(r => c[r.tier]++);
    const chip = (t) => `<span class="nv-tsum nv-sum${t}${tierFilter === t ? " on" : ""}" data-tier="${t}" title="${TIER_DISP[t]} ${TIER_LABEL[t]} (SFIT ${TIER_RANGE[t]}) — 클릭 필터">${TIER_DISP[t]} ${TIER_LABEL[t]} <b>${c[t]}</b></span>`;
    const cows = scored.filter(r => r.cashcow).length;
    return `<div class="nv-tierbar">${TIER_ORDER.map(chip).join("")}` +
      (cows ? `<span class="nv-tsum nv-sumcow${tierFilter === "COW" ? " on" : ""}" data-tier="COW" title="캐시카우/승계 — 클릭 필터">💰 캐시카우/승계 <b>${cows}</b></span>` : "") + `</div>`;
  }

  // 전략 앵글 요약바 — 앵글 라벨별 개수, 클릭 = 해당 앵글만 필터 (토글)
  function angleSummary(scored) {
    const c = new Map();
    scored.forEach(r => c.set(r.angleLbl, (c.get(r.angleLbl) || 0) + 1));
    const items = [...c.entries()].sort((a, b) => b[1] - a[1]);
    if (!items.length) return "";
    const chip = ([lbl, n]) => `<span class="nv-asum${angleFilter === lbl ? " on" : ""}" data-angle="${esc(lbl)}" title="이 앵글만 보기">${esc(lbl)} <b>${n}</b></span>`;
    return `<div class="nv-anglebar"><span class="nv-abar-lbl">전략 앵글</span>${items.map(chip).join("")}</div>`;
  }

  // 활성 필터 배너 (노드/티어/앵글) + 해제 버튼
  function filterBanner(shownN, totalN) {
    const parts = [];
    if (nodeFilter) parts.push(`노드 <b>${esc(nodeFilter)}</b>`);
    if (tierFilter) parts.push(`티어 <b>${tierFilter === "COW" ? "💰 캐시카우" : TIER_DISP[tierFilter]}</b>`);
    if (angleFilter) parts.push(`앵글 <b>${esc(angleFilter)}</b>`);
    if (!parts.length) return "";
    return `<div class="nv-fbanner">필터: ${parts.join(" · ")} — <b>${shownN}</b>/${totalN}개 <button class="nv-fclear" id="nvFclear">✕ 전체 보기</button></div>`;
  }

  function longlistTable(scored) {
    if (!scored || !scored.length) return `<p class="nv-dim">해당 조건의 기업 없음.</p>`;
    const badge = r => {
      if (r.need == null) return "";
      const hot = r.need >= 70 ? " nv-need-hot" : "";
      return `<span class="nv-need${hot}">${r.need}</span>`;
    };
    const st = r => r.status ? `<span class="nv-st">${esc(r.status)}</span>` : "";
    const pri = r => `<span class="nv-tier nv-g${r.tier}" title="전략 검토 우선순위 ${r.sfit}/100">${TIER_DISP[r.tier]}<em>${r.sfit}</em></span>`;
    return `<div class="table-wrap"><table class="nv-ll">
      <tr><th>우선순위</th><th>회사</th><th>노드</th><th>전략 앵글</th><th>매출</th><th>OPM</th><th>3yCAGR</th><th>상장</th><th>need</th><th>status</th><th>note</th></tr>
      ${scored.slice(0, 40).map(r => `<tr class="${r.pick ? "nv-pick" : ""}${r.cashcow ? " nv-cowrow" : ""}">
        <td>${pri(r)}${r.pick ? ' <span class="nv-star" title="pick">★</span>' : ""}</td>
        <td><b>${esc(r.name)}</b></td>
        <td class="nv-node nv-nodecell" data-node="${esc(r.node || "")}" title="이 노드만 보기">${esc(r.node || "")}</td>
        <td class="nv-angle nv-anglecell" data-angle="${esc(r.angleLbl)}" title="이 앵글만 보기">${r.cashcow ? "💰 " : ""}${esc(r.angleLbl)}</td>
        <td>${money(r.rev)}</td>
        <td>${pct(r.opm)}</td>
        <td>${pct(r.cagr3)}</td>
        <td>${r.listed === true ? "상장" : r.listed === false ? "비상장" : "–"}</td>
        <td>${badge(r)}</td>
        <td>${st(r)}</td>
        <td class="nv-note">${esc(r.note || "")}</td></tr>`).join("")}
    </table></div>${scored.length > 40 ? `<p class="nv-dim">…상위 40개 표시 (전체 ${scored.length}) · 우선순위 A→D 순 정렬</p>` : ""}`;
  }

  // 전략 스코어 방법론 (접이식) — 딜 유형·자금니즈 유형 매핑을 point-of-use 에 정리
  function methodBox() {
    return `<details class="nv-method"><summary>전략 검토 우선순위(SFIT) 산식 · 티어 기준 · 딜 앵글 매핑</summary>
      <div class="nv-method-body">
      <p class="nv-dim"><b>SFIT (0~100)</b> = 테마구조 0.22 · 딜앵글적합 0.24 · 소싱우위 0.16 · 티켓fit 0.16 · 수익품질 0.10 · 촉매 0.12. 재무 순수함수 — 회사 간 <b>상대순위</b>로 읽을 것. 출처: Notion PE 전략 케이스맵 · Deal_Angle PHASE3 · 조달니즈 type 정의.</p>
      <table class="nv-mtab">
        <tr><th>티어</th><th>SFIT</th><th>의미</th></tr>
        <tr><td><span class="nv-tier nv-gA">A</span> 즉시</td><td>≥ 68</td><td>즉시 검토 착수 — 기업분석 우선 투입</td></tr>
        <tr><td><span class="nv-tier nv-gB">B</span> 우선</td><td>60 ~ 67</td><td>우선 후보 — 다음 배치로 검토</td></tr>
        <tr><td><span class="nv-tier nv-gBm">B⁻</span> 후보</td><td>52 ~ 59</td><td>후보군 — 촉매/앵글 확인 후 승격</td></tr>
        <tr><td><span class="nv-tier nv-gC">C</span> 관찰</td><td>38 ~ 51</td><td>관찰 — 조건 변화 시 재평가</td></tr>
        <tr><td><span class="nv-tier nv-gD">D</span> 보류</td><td>&lt; 38</td><td>보류 — 현 시점 딜핏 낮음</td></tr>
      </table>
      <table class="nv-mtab">
        <tr><th>축</th><th>가르는 기준 (사전값)</th></tr>
        <tr><td>테마구조</td><td>공급탄력성 very_low ★ → 가격·마진 전이 지속 (수요↑ + 공급 비탄력)</td></tr>
        <tr><td>딜앵글적합</td><td>GROWTH(FI최적) > DISTRESS·REFI(구조조정·리파이 강점) > TIGHT·WC_BURN(주의) > SELF</td></tr>
        <tr><td>소싱우위</td><td>비상장 오너딜 = 정보비대칭·경쟁 얇음·밸류업 여지 (케이스맵 Part2) → 상장 대비 우선</td></tr>
        <tr><td>티켓fit</td><td>매출≤2,500억 = 자체 소수지분(100~300억)·컨소 슬롯(1,000~2,000억) 사정권 · 대형은 감점</td></tr>
        <tr><td>촉매</td><td>DISTRESS_EVENT·IN_MOTION·PRE_SIGNAL = 거래 계기 有 / RECENTLY_FUNDED = 촉매 소진</td></tr>
      </table>
      <p class="nv-dim"><b>💰 캐시카우/승계</b> = 비상장·OPM≥15%·순현금 (케이스맵 앵글A 재현스크린, +6 가점). <b>노드 칩·표의 노드 셀·티어 칩</b>을 클릭하면 롱리스트가 해당 조건으로 필터됩니다.</p>
      </div></details>`;
  }

  // 활성 필터 적용
  function applyFilters(scored) {
    return scored.filter(r =>
      (!nodeFilter || (r.node || "") === nodeFilter) &&
      (!tierFilter || (tierFilter === "COW" ? r.cashcow : r.tier === tierFilter)) &&
      (!angleFilter || r.angleLbl === angleFilter));
  }

  function renderSheet() {
    const t = data.themes.find(x => x.id === curTheme);
    const el = document.getElementById("themeSheet");
    if (!t) { el.innerHTML = ""; return; }
    const e = ELAS[t.catalog?.supply_elasticity] || {};
    const scored = scoreLonglist(t.longlist, t.catalog?.supply_elasticity);
    const filtered = applyFilters(scored);
    // 롱리스트에 실제 존재하는 노드별 개수 (표시용)
    const nodeRowCount = {};
    scored.forEach(r => { const n = r.node || ""; if (n) nodeRowCount[n] = (nodeRowCount[n] || 0) + 1; });
    const nodeChips = (t.nodeCounts && t.nodeCounts.length)
      ? `<h3 class="h3">Value Chain 노드 <span class="nv-dim">(클릭 = 해당 노드만 보기)</span></h3><div class="nv-nodes">${t.nodeCounts.map(n =>
          `<span class="nv-nodechip nv-nodeclick${nodeFilter === n.node ? " on" : ""}" data-node="${esc(n.node)}" title="이 노드만 보기">${esc(n.node)} <b>${nodeRowCount[n.node] ?? n.n}</b></span>`).join("")}</div>`
      : "";
    el.innerHTML = `<section class="card nv-sheet">
      <h2 class="card-title">${esc(t.emoji)} ${esc(t.title)}
        <span class="nv-elas ${e.cls || ""}">공급탄력성 ${esc(e.label || "")}</span></h2>
      <div class="nv-prov-line">📌 ${esc(t.provenance?.source || "")} · ${esc(t.provenance?.evidence || "")}</div>
      ${t.harvest_reinforce && t.harvest_reinforce.length ? `<div class="nv-reinforce">🌱 자산 재확증 ${t.harvest_reinforce.length}건 — ${t.harvest_reinforce.map(esc).join(" · ")}</div>` : ""}
      ${kpiGrid(t)}
      ${t.supply_verdict ? `<div class="nv-verdict"><b>공급탄력성 판정</b> — ${esc(t.supply_verdict)}</div>` : ""}
      ${nodeChips}
      <h3 class="h3">롱리스트 <span class="nv-dim">(우선순위 A→D 순 · ★=pick · need=funding-pool 니즈스코어)</span></h3>
      ${tierSummary(scored)}
      ${angleSummary(scored)}
      ${methodBox()}
      ${filterBanner(filtered.length, scored.length)}
      ${longlistTable(filtered)}
      ${t.whitespace ? `<div class="meta"><b>화이트스페이스</b> — ${esc(t.whitespace)}</div>` : ""}
      ${t.bolton ? `<div class="meta"><b>볼트온</b> — ${esc(t.bolton)}</div>` : ""}
      ${t.sources && t.sources.length ? `<p class="nv-dim">출처: ${t.sources.map(esc).join(" · ")}</p>` : ""}
    </section>`;
    wireFilters(el);
  }

  // 필터 상호작용 배선 — 노드칩·표 노드셀·티어칩·해제버튼
  function wireFilters(el) {
    const toggleNode = n => { nodeFilter = (nodeFilter === n ? null : n); renderSheet(); };
    const toggleTier = tKey => { tierFilter = (tierFilter === tKey ? null : tKey); renderSheet(); };
    const toggleAngle = a => { angleFilter = (angleFilter === a ? null : a); renderSheet(); };
    el.querySelectorAll(".nv-nodeclick").forEach(c => c.addEventListener("click", () => toggleNode(c.dataset.node)));
    el.querySelectorAll(".nv-nodecell").forEach(c => c.addEventListener("click", () => { if (c.dataset.node) toggleNode(c.dataset.node); }));
    el.querySelectorAll(".nv-tsum[data-tier]").forEach(c => c.addEventListener("click", () => toggleTier(c.dataset.tier)));
    el.querySelectorAll(".nv-asum[data-angle]").forEach(c => c.addEventListener("click", () => toggleAngle(c.dataset.angle)));
    el.querySelectorAll(".nv-anglecell").forEach(c => c.addEventListener("click", () => { if (c.dataset.angle) toggleAngle(c.dataset.angle); }));
    const clr = el.querySelector("#nvFclear");
    if (clr) clr.addEventListener("click", () => { nodeFilter = null; tierFilter = null; angleFilter = null; renderSheet(); });
  }
})();
