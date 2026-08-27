// narrative.js — 네러티브 기반 딜소싱 스크리너 뷰
// data/narrative-pool.json (build-narrative.mjs 산출) 을 읽어 렌더.
// 성장률이 아니라 공급탄력성으로 정렬. 하베스트 후보(candidate)는 상단 승인대기 영역.
(function () {
  let inited = false,data = null,curTheme = null;
  let nodeFilter = null,tierFilter = null,angleFilter = null; // 롱리스트 필터 상태 (테마 전환 시 리셋)
  // 목록 모드 — 정성 게이트를 통과한 회사만 보는 것이 기본. 'all' 은 기계 매칭 전체.
  //   watch(통과) / hold(확인 필요) / drop(제외, 사유와 함께) / all(전체)
  let listMode = "watch";   // 사용자가 고른 모드 (유지)
  let curMode = "watch";    // 이번 렌더에 실제로 적용되는 모드 (조사 전 Thesis 면 all 로 대체)
  // 재무 필터 (숫자) — 매출≥억 · OPM≥% · CAGR≥% · 부채비율 범위(%) · ND/EBITDA 범위(배). null=미적용
  let fMinRev = null,fMinOpm = null,fMinCagr = null;
  let fDebtMin = null,fDebtMax = null,fNdeMin = null,fNdeMax = null;
  function resetFinFilters() { fMinRev = fMinOpm = fMinCagr = fDebtMin = fDebtMax = fNdeMin = fNdeMax = null; }

  // ── Work·Hold·Drop 칸반 보드 상태 ─────────────────────────────────────────
  //   공유 기준값: data/board-state.json (repo 커밋 — 전원에게 보임)
  //   로컬 오버레이: localStorage dar_board_overrides (커밋 전 이 브라우저만)
  //   GitHub 토큰(dar_gh_token, contents write)이 있으면 이동 즉시 gh-pages 에 커밋 → 전원 공유
  const STAGES = [
    { key: "work", label: "Work", ko: "진행", ico: "🔨" },
    { key: "hold", label: "Hold", ko: "보류", ico: "⏸️" },
    { key: "drop", label: "Drop", ko: "중단", ico: "🗑️" }
  ];
  let boardBase = { stages: {} };     // 공유 기준값 (Supabase 또는 board-state.json)
  let boardSha = null;                // (GitHub 폴백) contents API 커밋용 sha
  let boardOverrides = {};            // 로컬 미확정 변경 (낙관적 업데이트)
  let boardMsg = "";                  // 저장 상태 표시줄
  let boardThemes = [];               // 폴링 재렌더용 approved 목록 참조
  let press = null;                   // data/press-screen.json — 전문지 맵 + 스크리닝 프로토콜
  let ideas = [];                     // 외부 제안 목록 (Supabase thesis_ideas)
  // 화면이 길어져서 보드만 고정으로 두고 나머지는 클릭해서 펴는 방식.
  // 어떤 걸 펴 뒀는지는 브라우저에 남긴다 — 새로고침마다 다시 여는 건 번거롭다.
  let panes = { cand: false, idea: false, press: false, sheet: false };
  try { panes = Object.assign(panes, JSON.parse(lsGet("dar_nv_panes") || "{}")); } catch (e) { }
  const PANE_LABEL = { cand: "🌱 승인 대기 보드", idea: "💡 Thesis 제안", press: "📰 전문지 스크리닝", sheet: "📄 테마 시트" };
  const PANE_BOX = { cand: "nvCand", idea: "nvIdea", press: "nvPress", sheet: "themeSheet" };
  function savePanes() { lsSet("dar_nv_panes", JSON.stringify(panes)); }
  function applyPanes() {
    Object.keys(PANE_LABEL).forEach((k) => {
      const box = document.getElementById(PANE_BOX[k]);
      if (box) box.hidden = !panes[k];
      const btn = document.querySelector('.nv-jump [data-pane="' + k + '"]');
      if (btn) { btn.classList.toggle("on", !!panes[k]); btn.textContent = (panes[k] ? "▾ " : "▸ ") + PANE_LABEL[k]; }
    });
  }
  function openPane(k) { if (!panes[k]) { panes[k] = true; savePanes(); applyPanes(); } }
  let sb = null;                      // Supabase 설정 {url, anonKey} — 있으면 공유 store
  let dragging = false, pollTimer = null;
  // localStorage 는 브라우저 정책(사이트 데이터 차단)에서 접근 자체가 예외를 던질 수 있음 — 항상 가드
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  try { boardOverrides = JSON.parse(lsGet("dar_board_overrides") || "{}") || {}; } catch (e) { boardOverrides = {}; }

  function stageOf(id) {
    if (boardOverrides[id]) return boardOverrides[id];
    if (boardBase.stages && boardBase.stages[id]) return boardBase.stages[id];
    return "work"; // 기본: 진행
  }
  function ghToken() { return (lsGet("dar_gh_token") || "").trim(); }
  // 로그인이 없는 구조라 '내 댓글' 판별은 브라우저별 임의 식별자로 한다.
  // 이 값은 이 브라우저에만 있고, 댓글과 함께 저장돼 삭제 버튼 노출 여부를 정한다.
  function clientId() {
    let v = lsGet("dar_client_id");
    if (!v) {
      v = "c" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      lsSet("dar_client_id", v);
    }
    return v;
  }

  // ── Supabase 공유 store (권장 경로) — anon 키로 브라우저에서 직접 read/write ──
  function sbHeaders() { return { apikey: sb.anonKey, Authorization: "Bearer " + sb.anonKey, "Content-Type": "application/json" }; }
  async function sbLoad() {
    const r = await fetch(sb.url + "/rest/v1/board_state?select=theme_id,stage", { headers: sbHeaders(), cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const rows = await r.json();
    const stages = {};
    rows.forEach((x) => { if (x.theme_id && x.stage) stages[x.theme_id] = x.stage; });
    boardBase.stages = stages;
  }
  async function sbUpsert(id, stage) {
    const r = await fetch(sb.url + "/rest/v1/board_state?on_conflict=theme_id", {
      method: "POST",
      headers: Object.assign(sbHeaders(), { Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify([{ theme_id: id, stage: stage, updated_at: new Date().toISOString() }])
    });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 140));
  }
  // ── Thesis 제안 (Supabase, 로그인 불필요 — 외부 참여자의 집단지성 투입구) ──
  //   thesis_ideas: 누구나 아이디어를 넣고, 본인 API 키가 있으면 전문지 프로토콜로 초안까지 만든다.
  //   초안 생성 토큰은 제안자 본인 키로 결제된다(운영자 키를 공유하지 않는 것이 설계 의도).
  async function sbIdeas() {
    const r = await fetch(sb.url + "/rest/v1/thesis_ideas?select=id,title,body,author,sector,draft,status,created_at&order=created_at.desc&limit=60", { headers: sbHeaders(), cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  // 제안 카드 삭제 — 잘못 올라간 제안·중복을 본 사람이 바로 정리한다(누구나).
  async function sbDeleteIdea(id) {
    const r = await fetch(sb.url + "/rest/v1/thesis_ideas?id=eq." + encodeURIComponent(id) + "&select=id", {
      method: "DELETE", headers: Object.assign(sbHeaders(), { Prefer: "return=representation" })
    });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 140));
    let gone = [];
    try { gone = await r.json(); } catch (e) { gone = []; }
    if (!gone.length) { const e2 = new Error("NO_DELETE_POLICY"); e2.noPolicy = true; throw e2; }
  }
  async function sbPostIdea(row) {
    const r = await fetch(sb.url + "/rest/v1/thesis_ideas", {
      method: "POST", headers: Object.assign(sbHeaders(), { Prefer: "return=minimal" }),
      body: JSON.stringify([row])
    });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 140));
  }

  // ── 테마별 댓글 (Supabase, 실시간 자동 반영) ──────────────────────────────
  // client_id 컬럼은 나중에 추가됐다 — 아직 없는 DB 에서도 댓글이 죽지 않도록 두 번 시도한다.
  let cmtHasClientId = true;
  async function sbComments(themeId) {
    const cols = cmtHasClientId ? "id,author,body,created_at,client_id" : "id,author,body,created_at";
    const r = await fetch(sb.url + "/rest/v1/comments?theme_id=eq." + encodeURIComponent(themeId) + "&select=" + cols + "&order=created_at.asc", { headers: sbHeaders(), cache: "no-store" });
    if (!r.ok) {
      if (cmtHasClientId && (r.status === 400 || r.status === 404)) { cmtHasClientId = false; return sbComments(themeId); }
      throw new Error("HTTP " + r.status);
    }
    return r.json();
  }
  async function sbPostComment(themeId, author, body) {
    const row = { theme_id: themeId, author: author, body: body };
    if (cmtHasClientId) row.client_id = clientId();
    const r = await fetch(sb.url + "/rest/v1/comments", {
      method: "POST", headers: Object.assign(sbHeaders(), { Prefer: "return=minimal" }),
      body: JSON.stringify([row])
    });
    if (!r.ok) {
      if (cmtHasClientId && r.status === 400) { cmtHasClientId = false; return sbPostComment(themeId, author, body); }
      throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 140));
    }
  }
  // 삭제는 본인 것만 — UI 가 내 client_id 인 댓글에만 버튼을 띄운다.
  // 삭제 — 삭제 정책(RLS)이 없으면 PostgREST 는 오류가 아니라 '0행 삭제'로 조용히 성공한다.
  // 그래서 지운 행을 되돌려받아(return=representation) 실제로 지워졌는지 확인한다.
  async function sbDeleteComment(id) {
    const r = await fetch(sb.url + "/rest/v1/comments?id=eq." + encodeURIComponent(id) + "&select=id", {
      method: "DELETE", headers: Object.assign(sbHeaders(), { Prefer: "return=representation" })
    });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 140));
    let gone = [];
    try { gone = await r.json(); } catch (e) { gone = []; }
    if (!gone.length) { const e2 = new Error("NO_DELETE_POLICY"); e2.noPolicy = true; throw e2; }
  }

  const ELAS = {
    very_low: { label: "매우 낮음 ★", cls: "el-vlow" },
    low: { label: "낮음", cls: "el-low" },
    mid: { label: "중간", cls: "el-mid" },
    high: { label: "높음(주의)", cls: "el-high" }
  };
  const ELAS_ORDER = { very_low: 0, low: 1, mid: 2, high: 3 };
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pct = (x) => x == null ? "–" : (x * 100).toFixed(0) + "%";
  const money = (x) => x == null ? "–" : x >= 10000 ? (x / 10000).toFixed(1) + "조" : Math.round(x) + "억";

  // ═══════════════════════════════════════════════════════════════════════
  // 전략 검토 우선순위 (SFIT) — 전략분석 agent 레이어
  //   기업분석 이전에 "어느 회사부터 붙을지"를 가르는 스크리닝 점수. 롱리스트 row 필드
  //   (rev/opm/cagr3/nd/need/type/status/listed) 의 순수함수 → 빌드 커플링 없이 항상 동기화.
  //   가중치·매핑 사전값 출처: Notion <PE 전략 케이스맵> + <Deal_Angle_Screening PHASE3> +
  //   <조달니즈 type 정의>. 절대치보다 회사 간 상대순위로 읽을 것.
  // ═══════════════════════════════════════════════════════════════════════
  // 가중치 개편 (2026-08-25): Thesis 적합도(theme)와 기업의 질(quality)을 올리고 지불자(payer)는 제거.
  //   지불자는 Thesis 단위 속성이라 같은 Thesis 안 모든 기업에 같은 점수가 붙어 변별력이 없었다.
  const SFIT_W = { theme: 0.26, angle: 0.20, source: 0.12, ticket: 0.12, quality: 0.18, catalyst: 0.12 };
  const ELAS_SCORE = { very_low: 1.0, low: 0.7, mid: 0.4, high: 0.15 };
  // type → RVP 딜앵글 강점 매핑 (조달니즈 type 정의). GROWTH=FI최적, DISTRESS/REFI=구조조정·리파이 강점.
  const ANGLE_SCORE = { GROWTH: 1.0, DISTRESS: 0.85, REFI: 0.85, TIGHT: 0.55, WC_BURN: 0.45, SELF: 0.15 };

  // 수익성은 절대 기준을 쓰지 않는다 — 조선 기자재 5%와 소프트웨어 20%를 같은 자로 재면 안 된다.
  // 같은 업종(표준산업분류 2자리) 중위값 대비 상대평가. 업종 중위값은 빌드가 계산해 meta 에 넣는다.
  function opmRelScore(opm, ksic) {
    if (opm == null) return 0.35;
    const med = (data && data.meta && data.meta.opm_median) || {};
    const base = med[String(ksic || "").slice(0, 2)];
    const ref = (base == null ? med._all : base);
    if (ref == null) return 0.5;
    const gap = opm - ref;                       // 업종 중위 대비 몇 %p 위인가
    if (gap >= 0.10) return 1;
    if (gap >= 0.05) return 0.85;
    if (gap >= 0.02) return 0.7;
    if (gap >= -0.02) return 0.5;                 // 업종 평균 수준
    if (gap >= -0.05) return 0.3;
    return 0.15;
  }
  function roeScore(roe) {// 업종 무관 비교가 되는 자본 효율 지표 (있을 때만 가점 요소로)
    if (roe == null) return null;
    return roe >= 0.20 ? 1 : roe >= 0.12 ? 0.8 : roe >= 0.05 ? 0.55 : roe >= 0 ? 0.35 : 0.15;
  }
  function cagrScore(c) {return c == null ? 0.4 : c >= 0.20 ? 1 : c >= 0.10 ? 0.7 : c >= 0 ? 0.4 : 0.1;}
  function ticketScore(rev) {// 매출을 규모 프록시로 — RVP 커버 구간(자체 소수지분 / 컨소 슬롯)
    if (rev == null) return 0.4;
    return rev <= 1000 ? 1.0 : rev <= 3000 ? 0.6 : 0.3;
  }
  const CATALYST_SCORE = { DISTRESS_EVENT: 1.0, IN_MOTION: 0.9, PRE_SIGNAL: 0.8, UNLISTED_BLIND: 0.55, RECENTLY_FUNDED: 0.25 };
  // status(촉매) 를 한국어로 — "지금 이 회사가 거래될 계기가 있는가"
  const STATUS_KO = {
    DISTRESS_EVENT: "위기·급매", IN_MOTION: "거래 진행중", PRE_SIGNAL: "사전 신호",
    UNLISTED_BLIND: "비상장 잠복", RECENTLY_FUNDED: "최근 투자유치"
  };
  const statusKo = (s) => s ? (STATUS_KO[s] || s) : "";

  // (2026-08-25) payerScore 제거 — 지불자는 Thesis 단위 속성이라 같은 Thesis 안에서 변별력이 없었다.
  //   지불자 정보는 렌즈 칩(catalog.payer)으로 계속 보여준다.

  // 앵글A 캐시카우/승계 후보 (케이스맵 재현스크린: 비상장·고마진·순현금)
  //   listed!==true = 비상장 또는 풀 밖(이벤트 미관측) — 상장사만 제외.
  const isCashCow = (r) => r.listed !== true && r.opm != null && r.opm >= 0.15 && r.nd != null && r.nd < 0;

  function scoreRow(r, themeElas, themePayer) {var _ELAS_SCORE$themeElas, _ANGLE_SCORE$r$type, _CATALYST_SCORE$r$sta;
    const fTheme = (_ELAS_SCORE$themeElas = ELAS_SCORE[themeElas]) !== null && _ELAS_SCORE$themeElas !== void 0 ? _ELAS_SCORE$themeElas : 0.4;
    const fAngle = r.type ? (_ANGLE_SCORE$r$type = ANGLE_SCORE[r.type]) !== null && _ANGLE_SCORE$r$type !== void 0 ? _ANGLE_SCORE$r$type : 0.35 : 0.35;
    const fSource = r.listed === false ? 1.0 : r.listed === true ? 0.55 : 0.5;
    const fTicket = ticketScore(r.rev);
    // 질 = 업종 대비 수익성 + 성장 + (ROE 있으면) 자본효율. ROE 없으면 앞 둘로만 계산.
    const fRoe = roeScore(r.roe);
    const fQuality = fRoe == null
      ? 0.6 * opmRelScore(r.opm, r.ksic) + 0.4 * cagrScore(r.cagr3)
      : 0.45 * opmRelScore(r.opm, r.ksic) + 0.3 * cagrScore(r.cagr3) + 0.25 * fRoe;
    const fCatalyst = r.status ? (_CATALYST_SCORE$r$sta = CATALYST_SCORE[r.status]) !== null && _CATALYST_SCORE$r$sta !== void 0 ? _CATALYST_SCORE$r$sta : 0.35 : 0.35;
    let s = 100 * (SFIT_W.theme * fTheme + SFIT_W.angle * fAngle + SFIT_W.source * fSource +
    SFIT_W.ticket * fTicket + SFIT_W.quality * fQuality + SFIT_W.catalyst * fCatalyst);
    if (isCashCow(r)) s = Math.min(100, s + 6); // 캐시카우(질) 가점
    return Math.round(s);
  }
  // 5단계 — B밴드(52~67)를 60 기준으로 B(우선)·Bm(후보)로 분할
  function tierOf(s) {return s >= 68 ? "A" : s >= 60 ? "B" : s >= 52 ? "Bm" : s >= 38 ? "C" : "D";}
  const TIER_ORDER = ["A", "B", "Bm", "C", "D"];
  const TIER_LABEL = { A: "즉시", B: "우선", Bm: "후보", C: "관찰", D: "보류" };
  const TIER_DISP = { A: "A", B: "B", Bm: "B⁻", C: "C", D: "D" }; // B⁻ 표기
  const TIER_RANGE = { A: "≥68", B: "60~67", Bm: "52~59", C: "38~51", D: "&lt;38" };

  // 1줄 전략 앵글 태그 — 어떤 딜 구조로 접근할지 (케이스맵 유형 매핑)
  //   단순화(2026-08-24): 재무지표·사업구조로 확실히 판정되는 앵글만. P2P(상폐)·승계·카브아웃은
  //   지분·사업구조를 상세히 뜯어봐야 알 수 있어 자동 앵글에서 제외(정보는 note 컬럼에 그대로 남음).
  //   허용 앵글: 볼트온 / 구주·세컨더리 / 성장자금 / 메자닌·리파이 / 유동성 브릿지.
  function angleLabel(r) {
    const note = r.note || "";
    if (/볼트온|bolt|add-?on/i.test(note)) return "볼트온";
    if (/구주|세컨더리/.test(note)) return "구주·세컨더리";       // FI 지분 인수 — note 명시된 경우만
    switch (r.type) {
      case "GROWTH": return "성장자금";
      case "WC_BURN": return "성장자금";
      case "DISTRESS": return "메자닌·리파이";
      case "REFI": return "메자닌·리파이";
      case "TIGHT": return "유동성 브릿지";
      case "SELF": return "니즈 낮음";
      default: return r.inPool ? "니즈 미분류" : "재무 미확보";
    }
  }

  window.initNarrative = async function () {
    if (inited) return;
    inited = true;
    const root = document.getElementById("narrativeRoot");
    // 다운로드 진행률 표시 — '무한 로딩중' 대신 어디서 멈추는지 보이게 (수신 KB 실시간 + 45초 타임아웃 + 재시도)
    const prog = (msg) => { root.innerHTML = `<div class="empty"><div class="empty-ico">📐</div><h3>데이터 로딩</h3><p>${msg}</p></div>`; };
    const fail = (msg) => { root.innerHTML = `<div class="empty"><div class="empty-ico">📐</div><h3>로딩 실패</h3><p>${esc(msg)}</p><p><button class="nv-retry" onclick="(function(){window.initNarrative.__retry()})()">다시 시도</button></p><p class="nv-dim">반복되면 네트워크(공유기·보안SW·회선)가 대용량 응답을 끊는 것 — <a href="./diag.html">진단 페이지</a>로 확인.</p></div>`; };
    window.initNarrative.__retry = () => { inited = false; window.initNarrative(); };
    try {
      prog("narrative-pool.json 요청 중…");
      const ctrl = ("AbortController" in window) ? new AbortController() : null;
      const killer = ctrl ? setTimeout(() => ctrl.abort(), 45000) : null;
      const res = await fetch("./data/narrative-pool.json", { cache: "default", signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) throw new Error("HTTP " + res.status);
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const chunks = []; let got = 0;
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          chunks.push(r.value); got += r.value.length;
          prog("수신 중… " + Math.round(got / 1024) + "KB");
        }
        if (killer) clearTimeout(killer);
        const buf = new Uint8Array(got); let off = 0;
        for (const c of chunks) { buf.set(c, off); off += c.length; }
        data = JSON.parse(new TextDecoder("utf-8").decode(buf).replace(/^﻿/, ""));
      } else {
        data = await res.json();
        if (killer) clearTimeout(killer);
      }
    } catch (e) {
      fail(e && e.name === "AbortError" ? "45초 내 응답이 완료되지 않아 중단 (네트워크 구간 문제)" : (e && e.message || String(e)));
      return;
    }
    // 보드 상태 — Supabase(공유 store) 우선, 없으면 board-state.json (전부 work 기본). 실패해도 뷰는 뜬다.
    try {
      const bres = await fetch(`./data/board-state.json?_=${Date.now()}`, { cache: "no-store" });
      if (bres.ok) { const bj = await bres.json(); boardBase = bj; if (!boardBase.stages) boardBase.stages = {}; }
    } catch (e) { /* 기본값 유지 */ }
    try {
      const pres = await fetch("./data/press-screen.json", { cache: "default" });
      if (pres.ok) press = await pres.json();
    } catch (e) { /* 전문지 모듈 없이도 화면은 뜬다 */ }
    try {
      const cres = await fetch(`./data/site-config.json?_=${Date.now()}`, { cache: "no-store" });
      if (cres.ok) { const cj = await cres.json(); if (cj.supabase && cj.supabase.url && cj.supabase.anonKey) sb = cj.supabase; }
    } catch (e) { /* site-config 없음 — 파일/토큰 폴백 */ }
    if (sb) { try { await sbLoad(); } catch (e) { boardMsg = "Supabase 조회 실패: " + (e.message || e) + " — 파일 기준값 사용"; } }
    if (sb) { try { ideas = await sbIdeas(); } catch (e) { ideas = []; } }
    curTheme = (data.themes.find((t) => t.status === "approved") || data.themes[0]).id;
    render();
    // Supabase 모드: 보드가 보일 때만 주기적으로 공유 상태를 당겨와 보드 카드만 갱신 (near-realtime)
    if (sb && !pollTimer) {
      pollTimer = setInterval(async () => {
        const view = document.getElementById("view-narrative");
        if (!view || view.hidden || dragging) return;
        const before = JSON.stringify(boardBase.stages);
        try { await sbLoad(); } catch (e) { return; }
        if (JSON.stringify(boardBase.stages) !== before) refreshBoard();
        if (curTheme) hydrateComments(curTheme);   // 현재 Thesis 댓글도 실시간 갱신
        try { const fresh = await sbIdeas(); if (JSON.stringify(fresh) !== JSON.stringify(ideas)) { ideas = fresh; renderIdeaList(); } } catch (e) { }
      }, 12000);
    }
  };

  // 보드 카드 영역만 다시 그림 (테마 시트·giscus 는 건드리지 않음 — 폴링 갱신용)
  function refreshBoard() {
    const root = document.getElementById("narrativeRoot");
    const card = root && root.querySelector(".nv-board-card");
    if (!card) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = boardBox(boardThemes);
    const fresh = tmp.firstElementChild;
    if (fresh) { card.replaceWith(fresh); wireBoard(root, boardThemes); }
  }

  function render() {
    const root = document.getElementById("narrativeRoot");
    const approved = data.themes.filter((t) => t.status === "approved");
    boardThemes = approved;
    const candidates = data.themes.filter((t) => t.status === "candidate");
    root.innerHTML =
    intro() +
    boardBox(approved) +
    candidateBox(candidates) +
    ideaBox() +
    pressBox() +
    `<details class="nv-matrix-details"><summary>📊 상세 카탈로그 — 렌즈 비교 테이블 (공급탄력성·해자·딜윈도우·지불자)</summary>${matrix(approved)}</details>` +
    `<div id="themeSheet" hidden></div>`;
    wireBoard(root, approved);
    wireIdea(root);
    renderSheet();
    // 승인 대기(관찰) Thesis 도 클릭하면 시트를 볼 수 있게 — 근거·롱리스트를 보고 승격 판단
    root.querySelectorAll(".nv-candclick").forEach((c) => c.addEventListener("click", () => {
      curTheme = c.dataset.id; nodeFilter = null; tierFilter = null; angleFilter = null; resetFinFilters();
      renderSheet(); openPane("sheet");
      document.getElementById("themeSheet").scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    root.querySelectorAll(".nv-jump [data-pane]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.pane;
      panes[k] = !panes[k]; savePanes(); applyPanes();
      if (panes[k]) {
        const box = document.getElementById(PANE_BOX[k]);
        if (box) box.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }));
    applyPanes();
  }

  // ── 📰 전문지 기반 스크리닝 모듈 ───────────────────────────────────────────
  //   개별 기업이 아니라 전문지에서 반복되는 구조 변화를 먼저 잡는다는 원칙을 화면에 고정한다.
  //   여기 있는 승격 기준·배제 규칙·증거 등급이 Thesis를 올릴지 말지의 기준이고,
  //   전문지 맵은 그 근거를 어디서 가져오는지의 목록이다. (data/press-screen.json)
  function pressBox() {
    if (!press) return "";
    const p = press;
    const srcRow = (x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a>` +
      (x.focus ? ` <span class="nv-dim">— ${esc(x.focus)}</span>` : "") +
      (x.use ? `<div class="nv-psrc-use">${esc(x.use)}</div>` : "") + `</li>`;
    const grpHTML = (g) => `<div class="nv-pgrp">
        <div class="nv-pgrp-head">${esc(g.g)}</div>
        ${g.signal ? `<div class="nv-psignal"><b>잡아낼 신호</b> ${esc(g.signal)}</div>` : ""}
        <ul class="nv-psrcs">${(g.sources || []).map(srcRow).join("")}</ul>
      </div>`;
    const layerHTML = (L) => `<details class="nv-player"><summary>${esc(L.title)} <span class="nv-dim">${L.groups.reduce((n, g) => n + g.sources.length, 0)}개 소스</span></summary>
        ${L.groups.map(grpHTML).join("")}</details>`;
    return `<section class="card nv-press" id="nvPress" hidden>
      <h2 class="card-title">📰 전문지 기반 Thesis 스크리닝</h2>
      <p class="nv-dim">${esc(p.meta.purpose)}</p>
      <div class="nv-pgrid">
        <div class="nv-pcol">
          <h3>Thesis로 올리는 기준</h3>
          <ol class="nv-pcrit">${p.promotion.map((c) => `<li><b>${esc(c.title)}</b> <span class="nv-ptag${c.base === "신규" ? " nv-ptag-new" : ""}">${esc(c.base)}</span><div>${esc(c.body)}</div>${c.note ? `<div class="nv-dim">${esc(c.note)}</div>` : ""}</li>`).join("")}</ol>
          <h3>올리지 않는 것</h3>
          <ul class="nv-bl">${p.exclusion.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
          <p class="nv-dim">${esc(p.exclusion_note)}</p>
        </div>
        <div class="nv-pcol">
          <h3>근거 등급</h3>
          <table class="nv-ptier">${p.evidence_tiers.map((t) => `<tr><th>${esc(t.tier)}</th><td>${esc(t.what)}<div class="nv-dim">${esc(t.use)}</div></td></tr>`).join("")}</table>
          <p class="nv-dim">${esc(p.evidence_rule)}</p>
          <h3>판정</h3>
          <div class="nv-pstates">${p.states.map((x) => `<span class="nv-pstate"><b>${esc(x.k)}</b> ${esc(x.d)}</span>`).join("")}</div>
          <h3>후보를 적는 법</h3>
          <ul class="nv-bl">${p.longlist_rules.fields.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
          <div class="nv-pstates">${p.longlist_rules.status.map((x) => `<span class="nv-pstate"><b>${esc(x.k)}</b> ${esc(x.d)}</span>`).join("")}</div>
        </div>
      </div>
      <details class="nv-pmore"><summary>재무·딜앵글 사용 원칙, 운용 루틴, 발견 트리거</summary>
        <p><b>재무</b> ${esc(p.finance_rule)}</p>
        <p><b>딜 앵글</b> ${esc(p.deal_angle_rule)}</p>
        <table class="nv-proutine">${p.routine.map((r) => `<tr><th>${esc(r.freq)}</th><td>${esc(r.what)} <span class="nv-dim">${esc(r.src)}</span></td></tr>`).join("")}</table>
        <ol class="nv-bl">${p.triggers.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>
        <p class="nv-dim">${esc(p.trigger_rule)}</p>
      </details>
      <h3 class="nv-pmaphead">전문지 맵 <span class="nv-dim">— 근거를 가져오는 곳. 해외는 산업 트렌드, 국내는 개별 기업.</span></h3>
      ${p.layers.map(layerHTML).join("")}
    </section>`;
  }

  // ── 💡 Thesis 제안 (집단지성 투입구) ─────────────────────────────────────────
  //   외부 참여자가 로그인 없이 아이디어를 넣는다. 본인 API 키가 있으면 위 전문지 프로토콜로
  //   초안(인과사슬·공급탄력성·왜 지금·후보군·반증)까지 생성해 함께 올린다 — 토큰은 제안자 부담.
  function ideaBox() {
    const on = !!sb;
    return `<section class="card nv-idea" id="nvIdea" hidden>
      <h2 class="card-title">💡 Thesis 제안 <span class="nv-dim">— 누구나</span></h2>
      <p class="nv-dim">${on ?
        "로그인 없이 바로 등록됩니다. 등록된 제안은 전원에게 실시간으로 보이고, 검토 후 테마 보드의 Thesis로 승격됩니다." :
        "Supabase 설정 후 활성화됩니다 (data/site-config.json)."}</p>
      ${on ? `<form id="nvIdeaForm" class="nv-ideaform">
        <div class="nv-idea-row">
          <input id="nvIdeaAuthor" placeholder="이름" maxlength="40">
          <input id="nvIdeaSector" placeholder="섹터·분야 (선택)" maxlength="40">
        </div>
        <input id="nvIdeaTitle" placeholder="한 줄 명제 — 어떤 수요 변화와 공급 제약인가" maxlength="120">
        <textarea id="nvIdeaBody" rows="3" placeholder="근거를 적어주세요. 어떤 전문지·공시·기관 자료에서 봤는지, 어떤 회사가 떠오르는지."></textarea>
        <div class="nv-idea-btns">
          <button id="nvIdeaSubmit" type="submit">제안 등록</button>
          <button id="nvIdeaDraft" type="button" title="본인 API 키로 전문지 프로토콜을 돌려 Thesis 초안을 만듭니다 (토큰 비용은 본인 키에 부과)">🤖 내 키로 초안까지 만들기</button>
          <span id="nvIdeaMsg" class="nv-dim"></span>
        </div>
      </form>
      <p class="nv-dim nv-idea-note">등록하면 위 <b>🌱 승인 대기 보드</b>의 '구성원 제안'에 실시간으로 올라갑니다. 검토를 거쳐 Thesis 보드로 승격됩니다.</p>` : ""}
    </section>`;
  }

  function renderIdeaList() {
    const el = document.getElementById("nvIdeaList");
    const n = document.getElementById("nvCandIdeaN");
    if (n) n.textContent = String(ideas.length);
    if (!el) return;
    if (!ideas.length) { el.className = "nv-idealist nv-dim"; el.innerHTML = "아직 제안이 없습니다 — 아래 'Thesis 제안'에서 첫 제안을 넣어보세요."; return; }
    el.className = "nv-idealist";
    el.innerHTML = ideas.map((i) => `<div class="nv-ideacard">
      <div class="nv-ideahead"><b>${esc(i.title || "(제목 없음)")}</b> <span class="nv-vd nv-vd-hold">승인 대기</span>
        <span class="nv-ideameta"><span class="nv-dim">${esc(i.author || "익명")}${i.sector ? " · " + esc(i.sector) : ""} · ${esc((i.created_at || "").slice(0, 10))}</span>
        ${i.id != null ? `<button class="nv-idea-del" data-id="${esc(i.id)}" title="이 제안 삭제">🗑</button>` : ""}</span></div>
      ${i.body ? `<div class="nv-ideabody">${esc(i.body)}</div>` : ""}
      ${i.draft ? `<details class="nv-ideadraft"><summary>🤖 Thesis 초안 보기</summary><div>${esc(i.draft)}</div></details>` : ""}
    </div>`).join("");
    // 목록을 다시 그릴 때마다 새로 붙는다 (12초 폴링 갱신 포함)
    el.querySelectorAll(".nv-idea-del").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("이 제안을 삭제할까요? (누구나 삭제할 수 있습니다)")) return;
      b.disabled = true;
      try { await sbDeleteIdea(b.dataset.id); ideas = await sbIdeas(); renderIdeaList(); }
      catch (e) {
        b.disabled = false;
        alert(e.noPolicy || /401|403/.test(String(e.message || e))
          ? "삭제가 데이터베이스에서 막혀 있습니다 (삭제 정책 없음).\n\nSupabase → SQL Editor 에서 아래를 한 번 실행해 주세요:\n\ncreate policy \"i anon delete\" on thesis_ideas for delete to anon using (true);"
          : "삭제 실패: " + (e.message || e));
      }
    }));
  }

  // 제안자 본인 키로 돌리는 초안 프롬프트 — 화면의 프로토콜을 그대로 규칙으로 넘긴다.
  function draftPrompt(title, body, sector) {
    const p = press || {};
    const rules = [
      "당신은 국내 소형 PE(운용 2,000억원 수준)의 딜소싱 리서치 파트너다.",
      "개별 기업을 먼저 고르지 말고, 산업 전문지·공식기관·규제 자료에서 반복되는 구조 변화로 Thesis를 세운다.",
      "선호 대상은 소형 상장사와 비상장 외감법인이다. 대형 상장사·대형 PE 보유자산은 밸류 기준점으로만 쓴다.",
      "", "[Thesis로 올리는 기준]",
      ...(p.promotion || []).map((c) => `${c.n}. ${c.title} — ${c.body}`),
      "", "[올리지 않는 것]", ...(p.exclusion || []).map((x) => "- " + x),
      "", "[근거 등급]", ...(p.evidence_tiers || []).map((t) => `${t.tier}: ${t.what} (${t.use})`),
      p.evidence_rule || "",
      "", "[작성 규칙]",
      "한국어로 쓴다. 문어체로 쓰되 업계 약어는 처음 나올 때 풀어 쓴다.",
      "모든 외부 사실에 매체명과 발행일을 붙인다. 웹검색으로 확인되지 않은 수치는 '확인 필요'라고 적고 지어내지 않는다.",
      "'유망'·'성장 기대' 같은 표현은 근거 없이 쓰지 않는다."
    ].join("\n");
    const ask = `아래 제안을 위 기준으로 검토해 Thesis 초안을 만들어라. 웹검색으로 최근 사실을 확인하고 근거를 붙일 것.

제안자 입력
- 한 줄 명제: ${title}
- 섹터: ${sector || "(미지정)"}
- 근거·설명: ${body || "(없음)"}

다음 형식으로만 답한다.
1) 판정: 승인 / 강화 / 관찰 / 보류 중 하나 + 한 줄 이유
2) 한 줄 명제 (다시 쓴 것)
3) 인과 사슬: 촉매 → 수요 변화 → 공급 병목 → 가격·마진 또는 반복매출 → 국내 중소형 후보군
4) 왜 지금인가: 전문지·공식기관에서 확인된 사실 2~4개 (매체명·날짜 포함)
5) 공급이 얼마나 못 늘어나나: very_low / low / mid / high 중 하나 + 근거
6) 우리 거래 단위에 맞는가: 기업 규모·구조·볼트온 가능성
7) 후보 3개 이상: 회사명 / 상장 여부 / 어느 병목을 맡는지 / 전문지 신호(매체·날짜) / 직전 매출·영업이익(확인 안 되면 '확인 필요') / 상태(EVENT·RESEARCH·WATCH)
8) 어떻게 틀릴 수 있나: 반증 조건과 바로 확인할 원문
9) 모니터링 소스와 다음 확인 시점`;
    return { system: rules, user: ask };
  }

  // 테이블 미생성은 흔한 초기 상태 — 원인을 바로 알 수 있게 안내한다.
  function ideaErr(err) {
    const m = String((err && err.message) || err);
    if (/404|42P01|does not exist|thesis_ideas/i.test(m))
      return "thesis_ideas 테이블이 아직 없습니다 — Supabase SQL Editor에서 site-config.json 의 _sql_ideas 를 한 번 실행해 주세요.";
    return "실패: " + m;
  }

  function wireIdea(root) {
    const form = root.querySelector("#nvIdeaForm");
    if (!form) return;
    renderIdeaList();
    const msg = (t) => { const m = root.querySelector("#nvIdeaMsg"); if (m) m.textContent = t; };
    const vals = () => ({
      author: (root.querySelector("#nvIdeaAuthor").value || "").trim(),
      sector: (root.querySelector("#nvIdeaSector").value || "").trim(),
      title: (root.querySelector("#nvIdeaTitle").value || "").trim(),
      body: (root.querySelector("#nvIdeaBody").value || "").trim()
    });
    async function save(draft) {
      const v = vals();
      if (!v.title) { msg("한 줄 명제를 입력해 주세요."); return false; }
      await sbPostIdea({ title: v.title, body: v.body, author: v.author || "익명", sector: v.sector || null, draft: draft || null, status: "new" });
      root.querySelector("#nvIdeaTitle").value = "";
      root.querySelector("#nvIdeaBody").value = "";
      try { ideas = await sbIdeas(); renderIdeaList(); } catch (e) { }
      return true;
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      msg("등록 중…");
      try { if (await save(null)) { msg("승인 대기 보드에 등록됐습니다."); openPane("cand"); } }
      catch (err) { msg(ideaErr(err)); }
    });
    root.querySelector("#nvIdeaDraft").addEventListener("click", async () => {
      const chat = window.darChat;
      if (!chat) { msg("리서치 챗이 로드되지 않았습니다."); return; }
      if (!chat.hasKey()) { msg("먼저 오른쪽 아래 💬에서 본인 API 키를 넣어주세요 — 초안 생성 비용은 본인 키에 부과됩니다."); chat.openSettings(); return; }
      const v = vals();
      if (!v.title) { msg("한 줄 명제를 먼저 입력해 주세요."); return; }
      msg("초안 생성 중… (모델·웹검색 사용, 1~3분)");
      try {
        const pr = draftPrompt(v.title, v.body, v.sector);
        const out = await chat.callOnce(pr.system, pr.user);
        if (await save(out)) { msg("초안과 함께 승인 대기 보드에 등록됐습니다."); openPane("cand"); }
      } catch (err) { msg(ideaErr(err)); }
    });
  }

  // ── Work·Hold·Drop 보드 렌더 ──────────────────────────────────────────────
  function boardBox(themes) {
    const token = ghToken();
    const pending = Object.keys(boardOverrides).length;
    const shareLabel = sb ? "🔗 실시간 공유 ON" : (token ? "🔗 공유 저장 ON" : "⚙ 공유 저장 설정");
    const shareDesc = sb
      ? "카드를 옮기면 자동으로 전원에게 공유되고, 다른 사람의 이동도 몇 초 내 반영됩니다."
      : (token ? "이동은 자동으로 repo에 커밋되어 전원에게 공유됩니다."
        : "지금은 이 브라우저에만 저장 — <b>공유 저장 설정</b>에 GitHub 토큰을 넣으면 팀 전체 공유.");
    const cardHTML = (t) => {
      const e = ELAS[t.catalog && t.catalog.supply_elasticity] || {};
      let a = 0; (t.longlist || []).forEach((r) => { if (tierOf(scoreRow(r, t.catalog && t.catalog.supply_elasticity, t.catalog && t.catalog.payer)) === "A") a++; });
      const comm = t.community && t.community.count ? ` · 💬${t.community.count}` : "";
      const st = stageOf(t.id);
      const btns = STAGES.filter((s) => s.key !== st).map((s) =>
        `<button class="nv-bmove" data-id="${t.id}" data-to="${s.key}" title="${s.label}(${s.ko})로 이동">${s.ico}</button>`).join("");
      return `<div class="nv-bcard${t.id === curTheme ? " active" : ""}${boardOverrides[t.id] ? " nv-bdirty" : ""}" draggable="true" data-id="${t.id}">
        <div class="nv-bcard-title">${esc(t.emoji)} ${esc(t.title)}</div>
        <div class="nv-bcard-meta"><span class="nv-elas ${e.cls || ""}">${esc(e.label || "")}</span> A급 ${a} · 롱리스트 ${t.stats && t.stats.total || 0}${comm}</div>
        <div class="nv-bcard-btns">${btns}</div>
      </div>`;
    };
    // 상위 축(group) 순서 — meta.groups 정의 순, 그 외는 뒤에
    const gOrder = (data.meta.groups || []).map((g) => g.id);
    const gRank = (t) => { const id = t.group && t.group.id; const i = gOrder.indexOf(id); return i < 0 ? 999 : i; };
    const colHTML = (s) => {
      const list = themes.filter((t) => stageOf(t.id) === s.key);
      // 상위 축별로 묶어 소제목 + 카드
      const groups = [];
      const byId = {};
      list.slice().sort((a, b) => gRank(a) - gRank(b)).forEach((t) => {
        const gid = (t.group && t.group.id) || "misc";
        if (!byId[gid]) { byId[gid] = { g: t.group || { title: "기타", emoji: "•" }, items: [] }; groups.push(byId[gid]); }
        byId[gid].items.push(t);
      });
      const body = groups.map((grp) =>
        `<div class="nv-bgroup"><div class="nv-bgroup-head">${esc(grp.g.emoji || "")} ${esc(grp.g.title || "")} <span class="nv-dim">${grp.items.length}</span></div>${grp.items.map(cardHTML).join("")}</div>`
      ).join("");
      return `<div class="nv-bcol nv-bcol-${s.key}" data-stage="${s.key}">
        <div class="nv-bcol-head">${s.ico} ${s.label} <span class="nv-dim">${s.ko}</span> <b>${list.length}</b></div>
        ${body || `<div class="nv-bempty">비어 있음 — 카드를 끌어다 놓으세요</div>`}
      </div>`;
    };
    return `<section class="card nv-board-card" id="nvBoard">
      <h2 class="card-title">테마 보드 — Work · Hold · Drop
        <span class="nv-board-tools">
          ${pending ? `<span class="nv-bpend">저장 중 ${pending}건</span>` : ""}
          ${sb ? `<span class="nv-bshare-on">${shareLabel}</span>` : `<button id="nvBoardShare" title="이동 내역을 repo(data/board-state.json)에 커밋해 전원 공유">${shareLabel}</button>`}
        </span></h2>
      <p class="nv-dim">카드 = <b>하위 Thesis</b>, 굵은 소제목 = <b>상위 축</b>. 드래그·이동 버튼으로 진행→보류→중단 분류. 카드 클릭 = 아래 테마 시트. ${shareDesc} 세분화 원칙·사고기록은 <code>THESIS-LOG.md</code>.</p>
      ${boardMsg ? `<div class="nv-bmsg">${esc(boardMsg)}</div>` : ""}
      <div class="nv-board">${STAGES.map(colHTML).join("")}</div>
    </section>`;
  }

  function wireBoard(root, themes) {
    // 카드 클릭 → 테마 시트
    root.querySelectorAll(".nv-bcard").forEach((c) => {
      c.addEventListener("click", (ev) => {
        if (ev.target.closest(".nv-bmove")) return;
        curTheme = c.dataset.id; nodeFilter = null; tierFilter = null; angleFilter = null; resetFinFilters();
        renderSheet();
        openPane("sheet");   // 카드를 눌렀다면 시트를 보려는 것 — 접혀 있으면 펴 준다
        root.querySelectorAll(".nv-bcard").forEach((x) => x.classList.toggle("active", x.dataset.id === curTheme));
        document.getElementById("themeSheet").scrollIntoView({ behavior: "smooth", block: "start" });
      });
      c.addEventListener("dragstart", (ev) => { dragging = true; ev.dataTransfer.setData("text/plain", c.dataset.id); ev.dataTransfer.effectAllowed = "move"; c.classList.add("dragging"); });
      c.addEventListener("dragend", () => { dragging = false; c.classList.remove("dragging"); });
    });
    // 이동 버튼
    root.querySelectorAll(".nv-bmove").forEach((b) => b.addEventListener("click", () => moveTheme(b.dataset.id, b.dataset.to)));
    // 컬럼 드롭존
    root.querySelectorAll(".nv-bcol").forEach((col) => {
      col.addEventListener("dragover", (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = "move"; col.classList.add("dragover"); });
      col.addEventListener("dragleave", () => col.classList.remove("dragover"));
      col.addEventListener("drop", (ev) => {
        ev.preventDefault(); col.classList.remove("dragover");
        const id = ev.dataTransfer.getData("text/plain");
        if (id) moveTheme(id, col.dataset.stage);
      });
    });
    // 공유 저장 설정/상태
    const shareBtn = root.querySelector("#nvBoardShare");
    if (shareBtn) shareBtn.addEventListener("click", () => {
      const cur = ghToken();
      const t = prompt("GitHub Personal Access Token (이 repo Contents: Read/Write 권한)\n입력하면 카드 이동이 data/board-state.json 커밋으로 전원에게 공유됩니다.\n이 브라우저(localStorage)에만 저장 — 비우고 확인하면 해제.", cur);
      if (t === null) return;
      lsSet("dar_gh_token", t.trim());
      boardMsg = t.trim() ? "공유 저장 ON — 다음 이동부터 자동 커밋" : "공유 저장 해제 (이 브라우저에만 저장)";
      render();
      if (t.trim() && Object.keys(boardOverrides).length) commitBoardState();
    });
  }

  function moveTheme(id, stage) {
    if (stageOf(id) === stage) return;
    // Supabase 공유 모드 — 낙관적 업데이트 후 upsert, 성공 시 기준값에 반영
    if (sb) {
      boardOverrides[id] = stage;   // 확정 전까지 로컬 우선 표시
      boardMsg = "저장 중…"; render();
      sbUpsert(id, stage).then(() => {
        boardBase.stages[id] = stage; delete boardOverrides[id];
        boardMsg = "✅ 공유됨 (" + new Date().toLocaleTimeString("ko-KR") + ")"; render();
      }).catch((e) => {
        boardMsg = "❌ 저장 실패: " + (e && e.message || e) + " — 이 브라우저엔 반영됨"; render();
      });
      return;
    }
    // 폴백: localStorage + (선택) GitHub 토큰 커밋
    if ((boardBase.stages[id] || "work") === stage) delete boardOverrides[id];
    else boardOverrides[id] = stage;
    lsSet("dar_board_overrides", JSON.stringify(boardOverrides));
    boardMsg = "";
    render();
    if (ghToken()) commitBoardState();
  }

  // 이동 내역을 gh-pages 의 data/board-state.json 에 커밋 (GitHub contents API)
  //   주의: 코드 배포 전 gh-pages 를 pull 해 보드 커밋을 승계할 것.
  let commitTimer = null;
  function commitBoardState() {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(doCommit, 1200); // 연속 이동 디바운스
  }
  async function doCommit() {
    const token = ghToken(); if (!token) return;
    const API = "https://api.github.com/repos/minabae-5723/deal-angle-radar/contents/data/board-state.json";
    const H = { "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json" };
    try {
      boardMsg = "커밋 중…"; render();
      const cur = await fetch(API + "?ref=gh-pages", { headers: H });
      if (cur.ok) { const j = await cur.json(); boardSha = j.sha; }
      else if (cur.status !== 404) throw new Error("조회 HTTP " + cur.status);
      const merged = {}; const bs = boardBase.stages || {};
      Object.keys(bs).forEach((k) => { merged[k] = bs[k]; });
      Object.keys(boardOverrides).forEach((k) => { merged[k] = boardOverrides[k]; });
      const body = { message: "보드: 테마 스테이지 이동 (웹 UI)", branch: "gh-pages",
        content: btoa(unescape(encodeURIComponent(JSON.stringify({ version: 1, updated: new Date().toISOString().slice(0, 10), stages: merged }, null, 2)))) };
      if (boardSha) body.sha = boardSha;
      const put = await fetch(API, { method: "PUT", headers: H, body: JSON.stringify(body) });
      if (!put.ok) { const t = await put.text(); throw new Error("커밋 HTTP " + put.status + (put.status === 401 || put.status === 403 ? " — 토큰 권한(Contents write) 확인" : "") + " " + t.slice(0, 120)); }
      const pj = await put.json(); boardSha = pj.content && pj.content.sha;
      boardBase.stages = merged; boardOverrides = {};
      lsSet("dar_board_overrides", "{}");
      boardMsg = "✅ 공유 저장됨 (" + new Date().toLocaleTimeString("ko-KR") + ") — 1~2분 후 전원에게 반영";
    } catch (e) {
      boardMsg = "❌ 공유 저장 실패: " + (e && e.message || e) + " — 변경은 이 브라우저에 보관됨";
    }
    render();
  }

  function intro() {
    return `<div class="nv-intro">
      <p><strong>네러티브 → transmission KPI → value chain 노드 → 외감 롱리스트</strong>. Thesis는 3문으로 생성·검증한다 — <strong>① 수요의 확실성</strong>(지불자·백로그·규제일정·인구) × <strong>② 공급·경쟁의 봉쇄</strong>(3년 복제 테스트: 퀄·면허·총량·노하우·설치기반) × <strong>③ 딜 윈도우</strong>(왜 지금 거래되는가: 승계·FI만기·밸류리셋·제도화 캘린더·그룹재편·저평가 P2P).</p>
      <div class="nv-jump">
        <button type="button" data-pane="cand">▸ 🌱 승인 대기 보드</button>
        <button type="button" data-pane="idea">▸ 💡 Thesis 제안</button>
        <button type="button" data-pane="press">▸ 📰 전문지 스크리닝</button>
        <button type="button" data-pane="sheet">▸ 📄 테마 시트</button>
        <span class="nv-dim nv-jump-hint">클릭해서 펼치기 · 테마 보드는 항상 표시</span>
      </div>
      <p class="nv-dim">유니버스: 외감법인 41,409개 패널 × funding-pool 니즈 오버레이 · 재무: funding-pool 수록사는 <b>최신 DART 감사보고서(2025 다수)</b> 반영(매출 옆 '25/'24 = 기준연도), 그 외 패널사는 직전 빌드(2024) · 포착: 자산 하베스트 + 사용자 승인 · 공통 킬 필터: 中 3~5년 복제 가능성 · 재빌드: <code>node narrative/build-narrative.mjs</code>${data.meta.build_mode && data.meta.build_mode.startsWith("patch") ? ` · <b>패치 빌드</b>(패널 전체 2025 갱신은 패널 머신에서)` : ""}</p>
    </div>`;
  }

  // 승인 대기(하베스트·스카우트·전문지 스캔 후보) — 판정과 그 근거를 함께 보여준다.
  // 숨겨두면 다시 잊히므로, 무엇이 확인되면 올릴지(승격 조건)까지 화면에 남긴다.
  const VERDICT = {
    promote: { ko: "승격 추천", cls: "nv-vd-go" },
    hold: { ko: "보류 — 조건 확인 필요", cls: "nv-vd-hold" },
    drop: { ko: "현 시점 제외 — 재검토 트리거 있음", cls: "nv-vd-drop" }
  };
  function candidateBox(cands) {
    const order = { promote: 0, hold: 1, drop: 2 };
    const sorted = [...cands].sort((a, b) => (order[a.harvest_verdict] || 1) - (order[b.harvest_verdict] || 1));
    return `<section class="card nv-cand" id="nvCand" hidden>
      <h2 class="card-title">🌱 승인 대기 보드 <span class="nv-dim">등록 ${sorted.length}건 · 제안 <span id="nvCandIdeaN">0</span>건</span></h2>
      <div class="nv-flow">
        <span class="nv-flow-step">제안·포착</span><span class="nv-flow-arrow">→</span>
        <span class="nv-flow-step on">승인 대기 <span class="nv-dim">근거·반증·승격 조건 정리</span></span><span class="nv-flow-arrow">→</span>
        <span class="nv-flow-step nv-flow-todo">검토 단계 <span class="nv-dim">설계 예정</span></span><span class="nv-flow-arrow">→</span>
        <span class="nv-flow-step">Thesis 보드</span>
      </div>
      <h3 class="nv-candh">포착된 후보 <span class="nv-dim">— 하베스트·스카우트·전문지 스캔. 클릭하면 근거·롱리스트 시트가 열린다</span></h3>
      <div class="nv-candscroll">${sorted.length ? sorted.map(candRow).join("") : `<p class="nv-dim">등록된 후보가 없습니다.</p>`}</div>
      <h3 class="nv-candh">구성원 제안 <span class="nv-dim">— 실시간. 아래 '💡 Thesis 제안'에서 등록하면 여기로 들어온다</span></h3>
      <div id="nvIdeaList" class="nv-idealist nv-candscroll"></div>
    </section>`;
  }

  // 포착 후보 한 줄 — 판정·공급탄력성·축·보류 근거·승격 조건을 함께 보여준다.
  function candRow(c) {
    const VERDICT = {
      promote: { ko: "승격 추천", cls: "nv-vd-go" },
      hold: { ko: "보류 — 조건 확인 필요", cls: "nv-vd-hold" },
      drop: { ko: "현 시점 제외 — 재검토 트리거 있음", cls: "nv-vd-drop" }
    };
    const v = VERDICT[c.harvest_verdict] || null;
    const e = ELAS[c.catalog && c.catalog.supply_elasticity] || {};
    const why = (c.provenance && c.provenance.evidence) || "";
    return `<div class="nv-cand-row nv-candclick" data-id="${esc(c.id)}" title="클릭 = 이 Thesis 시트 열기">
      <div class="nv-cand-head">
        <span class="nv-cand-title">${esc(c.emoji || "")} ${esc(c.title)}</span>
        ${v ? `<span class="nv-vd ${v.cls}">${v.ko}</span>` : ""}
        ${e.label ? `<span class="nv-elas ${e.cls || ""}">공급 ${esc(e.label)}</span>` : ""}
        ${c.group ? `<span class="nv-axis-tag">${esc(c.group.emoji || "")} ${esc(c.group.title || "")}</span>` : ""}
      </div>
      ${why ? `<div class="nv-cand-why">${esc(why)}</div>` : ""}
      ${(c.screen && c.screen.length) ? `<div class="nv-cand-gate"><b>승격 조건</b> ${esc(c.screen[0])}</div>` : ""}
    </div>`;
  }

  function matrix(themes) {
    const sorted = [...themes].sort((a, b) => {var _ELAS_ORDER$a$catalog, _a$catalog, _ELAS_ORDER$b$catalog, _b$catalog;return ((_ELAS_ORDER$a$catalog = ELAS_ORDER[(_a$catalog = a.catalog) === null || _a$catalog === void 0 ? void 0 : _a$catalog.supply_elasticity]) !== null && _ELAS_ORDER$a$catalog !== void 0 ? _ELAS_ORDER$a$catalog : 9) - ((_ELAS_ORDER$b$catalog = ELAS_ORDER[(_b$catalog = b.catalog) === null || _b$catalog === void 0 ? void 0 : _b$catalog.supply_elasticity]) !== null && _ELAS_ORDER$b$catalog !== void 0 ? _ELAS_ORDER$b$catalog : 9);});
    const abCount = (t) => {let a = 0,b = 0;(t.longlist || []).forEach((r) => {var _t$catalog, _t$catalog2;const tr = tierOf(scoreRow(r, (_t$catalog = t.catalog) === null || _t$catalog === void 0 ? void 0 : _t$catalog.supply_elasticity, (_t$catalog2 = t.catalog) === null || _t$catalog2 === void 0 ? void 0 : _t$catalog2.payer));if (tr === "A") a++;else if (tr === "B") b++;});return { a, b };};
    return `<section class="card"><h2 class="card-title">테마 카탈로그 — 공급탄력성 순 <span class="nv-dim">(${sorted.length}개 테마)</span></h2>
      <div class="table-wrap"><table class="nv-matrix">
      <tr><th>테마</th><th>구조/순환</th><th>공급탄력성</th><th>해자 (3년 복제 테스트)</th><th>딜 윈도우 (왜 지금)</th><th>지불자</th><th>지속성</th><th>롱리스트</th><th>A/B급</th><th>풀(니즈)</th><th>비상장</th><th>💬</th></tr>
      ${sorted.map((t) => {var _t$catalog3, _t$catalog4, _t$catalog5, _t$catalog6, _t$catalog7, _t$catalog8, _t$catalog9, _t$stats$total, _t$stats, _t$stats$inPool, _t$stats2, _t$stats$unlisted, _t$stats3, _t$community;const e = ELAS[(_t$catalog3 = t.catalog) === null || _t$catalog3 === void 0 ? void 0 : _t$catalog3.supply_elasticity] || {};const ab = abCount(t);return `<tr class="nv-mrow" data-id="${t.id}">
        <td><b>${esc(t.emoji)} ${esc(t.title)}</b></td>
        <td>${esc(((_t$catalog4 = t.catalog) === null || _t$catalog4 === void 0 ? void 0 : _t$catalog4.structural) || "")}</td>
        <td><span class="nv-elas ${e.cls || ""}">${esc(e.label || ((_t$catalog5 = t.catalog) === null || _t$catalog5 === void 0 ? void 0 : _t$catalog5.supply_elasticity) || "")}</span></td>
        <td class="nv-lens">${esc(((_t$catalog6 = t.catalog) === null || _t$catalog6 === void 0 ? void 0 : _t$catalog6.moat) || "")}</td>
        <td class="nv-lens">${esc(((_t$catalog7 = t.catalog) === null || _t$catalog7 === void 0 ? void 0 : _t$catalog7.deal_window) || "")}</td>
        <td class="nv-payer">${esc(((_t$catalog8 = t.catalog) === null || _t$catalog8 === void 0 ? void 0 : _t$catalog8.payer) || "")}</td>
        <td>${esc(((_t$catalog9 = t.catalog) === null || _t$catalog9 === void 0 ? void 0 : _t$catalog9.persistence) || "")}</td>
        <td>${(_t$stats$total = (_t$stats = t.stats) === null || _t$stats === void 0 ? void 0 : _t$stats.total) !== null && _t$stats$total !== void 0 ? _t$stats$total : 0}</td>
        <td><span class="nv-abcell"><b class="nv-gA">${ab.a}</b>/<span class="nv-gB">${ab.b}</span></span></td>
        <td>${(_t$stats$inPool = (_t$stats2 = t.stats) === null || _t$stats2 === void 0 ? void 0 : _t$stats2.inPool) !== null && _t$stats$inPool !== void 0 ? _t$stats$inPool : 0}</td><td>${(_t$stats$unlisted = (_t$stats3 = t.stats) === null || _t$stats3 === void 0 ? void 0 : _t$stats3.unlisted) !== null && _t$stats$unlisted !== void 0 ? _t$stats$unlisted : 0}</td>
        <td>${(_t$community = t.community) !== null && _t$community !== void 0 && _t$community.count ? `<b class="nv-commct">${t.community.count}</b>` : ""}</td></tr>`;}).join("")}
      </table></div></section>`;
  }

  function themePills(themes) {
    return `<div class="nv-pills">` + themes.map((t) =>
    `<button class="nv-pill${t.id === curTheme ? " active" : ""}" data-id="${t.id}">${esc(t.emoji)} ${esc(t.title)}</button>`).join("") + `</div>`;
  }

  // KPI 값은 문자열 또는 불렛 배열. 배열이면 한 줄에 하나씩 — 길게 이어진 문장은 눈으로 훑기 어렵다.
  function textBlock(v) {
    if (v == null) return "";
    if (Array.isArray(v)) return `<ul class="nv-bl">` + v.map((x) => `<li>${esc(x)}</li>`).join("") + `</ul>`;
    return esc(v);
  }
  function kpiGrid(t) {
    const K = t.kpi || {};
    // 라벨을 한국어로 — 영문 지표명이 한 번 더 번역을 요구했다.
    const rows = [
    ["왜 지금인가", K.catalyst], ["구조인가 사이클인가", K.structural], ["수요 근거", K.demand],
    ["공급 병목 ★", K.supply], ["가격·마진", K.pricing], ["설비투자", K.capex], ["얼마나 갈까", K.persistence]].
    filter((r) => r[1]);
    if (!rows.length) return `<div class="meta">아직 정리 전 — 리서치 대기 중.</div>`;
    return `<div class="table-wrap"><table class="nv-kpi">` +
    rows.map((r) => `<tr><th>${esc(r[0])}</th><td>${textBlock(r[1])}</td></tr>`).join("") + `</table></div>`;
  }

  // 롱리스트에 SFIT·티어·앵글을 부착하고 우선순위로 정렬 (pick 은 상단 고정)
  // 구분(kind) 우선순위 — 직접 소싱 대상(비상장·상장타겟)이 최상단, 밸류 기준용 상장벤치마크는 그 아래,
  // 소싱 지시서(발굴리드)는 실명 아래. kind 없는 정량 매칭 행은 후순위지만 목록에서 빼지 않는다.
  const KIND_RANK = { "비상장타겟": 6, "상장타겟": 6, "검증필요": 5, "PE보유": 4, "상장벤치마크": 3, "발굴리드": 2 };
  const kindRank = (r) => KIND_RANK[r.kind] || (r.pick ? 2 : 0);

  function scoreLonglist(ll, themeElas, themePayer) {
    const scored = (ll || []).map((r) => {
      const sfit = scoreRow(r, themeElas, themePayer);
      return { ...r, sfit, tier: tierOf(sfit), angleLbl: angleLabel(r), cashcow: isCashCow(r) };
    });
    // 정렬 우선순위: 벤치마크 역추적으로 특정된 소싱 대상 → 그 다음 정량 매칭 잔여(제외 아님, 후순위).
    scored.sort((a, b) => kindRank(b) - kindRank(a) || b.sfit - a.sfit || (b.rev || 0) - (a.rev || 0));
    return scored;
  }

  // 티어 요약바 — 각 칩 클릭 = 해당 티어만 필터 (토글). 캐시카우 칩도 필터.
  function tierSummary(scored) {
    const c = { A: 0, B: 0, Bm: 0, C: 0, D: 0 };
    scored.forEach((r) => c[r.tier]++);
    const chip = (t) => `<span class="nv-tsum nv-sum${t}${tierFilter === t ? " on" : ""}" data-tier="${t}" title="${TIER_LABEL[t]} — 클릭하면 이 등급만 보기">${TIER_LABEL[t]} <b>${c[t]}</b></span>`;
    const cows = scored.filter((r) => r.cashcow).length;
    return `<div class="nv-tierbar"><span class="nv-abar-lbl">우선순위</span>${TIER_ORDER.map(chip).join("")}` + (
    cows ? `<span class="nv-tsum nv-sumcow${tierFilter === "COW" ? " on" : ""}" data-tier="COW" title="비상장·고마진·순현금 우량 후보 — 클릭 필터">💰 캐시카우 <b>${cows}</b></span>` : "") + `</div>`;
  }

  // 전략 앵글 요약바 — 앵글 라벨별 개수, 클릭 = 해당 앵글만 필터 (토글)
  function angleSummary(scored) {
    const c = new Map();
    scored.forEach((r) => c.set(r.angleLbl, (c.get(r.angleLbl) || 0) + 1));
    const items = [...c.entries()].sort((a, b) => b[1] - a[1]);
    if (!items.length) return "";
    const chip = ([lbl, n]) => `<span class="nv-asum${angleFilter === lbl ? " on" : ""}" data-angle="${esc(lbl)}" title="이 앵글만 보기">${esc(lbl)} <b>${n}</b></span>`;
    return `<div class="nv-anglebar"><span class="nv-abar-lbl">전략 앵글</span>${items.map(chip).join("")}</div>`;
  }

  // 활성 필터 배너 (노드/티어/앵글) + 해제 버튼
  function filterBanner(shownN, totalN) {
    const parts = [];
    if (nodeFilter) parts.push(`노드 <b>${esc(nodeFilter)}</b>`);
    if (tierFilter) parts.push(`등급 <b>${tierFilter === "COW" ? "💰 캐시카우" : TIER_LABEL[tierFilter]}</b>`);
    if (angleFilter) parts.push(`앵글 <b>${esc(angleFilter)}</b>`);
    if (fMinRev != null) parts.push(`매출 ≥ <b>${fMinRev}억</b>`);
    if (fMinOpm != null) parts.push(`OPM ≥ <b>${fMinOpm}%</b>`);
    if (fMinCagr != null) parts.push(`CAGR ≥ <b>${fMinCagr}%</b>`);
    if (fDebtMin != null || fDebtMax != null) parts.push(`부채비율 <b>${fDebtMin != null ? fDebtMin : ""}~${fDebtMax != null ? fDebtMax : ""}%</b>`);
    if (fNdeMin != null || fNdeMax != null) parts.push(`ND/EBITDA <b>${fNdeMin != null ? fNdeMin : ""}~${fNdeMax != null ? fNdeMax : ""}x</b>`);
    if (!parts.length) return "";
    return `<div class="nv-fbanner">필터: ${parts.join(" · ")} — <b>${shownN}</b>/${totalN}개 <button class="nv-fclear" id="nvFclear">✕ 전체 보기</button></div>`;
  }

  function longlistTable(scored) {
    if (!scored || !scored.length) return `<p class="nv-dim">해당 조건의 기업 없음.</p>`;
    // 우선순위 = 등급 한국어 라벨만(점수 숨김). 색으로 등급 구분.
    const pri = (r) => `<span class="nv-tier nv-g${r.tier}" title="검토 우선순위">${TIER_LABEL[r.tier]}</span>`;
    const st = (r) => r.status ? `<span class="nv-st">${esc(statusKo(r.status))}</span>` : "";
    const KIND = {
      "상장벤치마크": { cls: "k-bench", t: "밸류 기준·협력사 역추적 출발점 (직접 매수 대상 아님)" },
      "비상장타겟": { cls: "k-target", t: "직접 소싱 대상 (비상장)" },
      "상장타겟": { cls: "k-ltarget", t: "직접 검토 대상이지만 상장 — 공개매수·블록·구주 경로" },
      "검증필요": { cls: "k-verify", t: "접촉 전 재무·지분 DART 확인 필요" },
      "PE보유": { cls: "k-pe", t: "PE 보유 — 선례·경쟁 신호" },
      "발굴리드": { cls: "k-lead", t: "회사가 아니라 소싱 지시서" }
    };
    const kindBadge = (r) => r.kind && KIND[r.kind] ? ` <span class="nv-kind ${KIND[r.kind].cls}" title="${KIND[r.kind].t}">${r.kind}</span>` : "";
    const debt = (r) => r.debt_ratio == null ? "–" : (r.debt_ratio * 100).toFixed(0) + "%";
    const nde = (r) => r.nd_ebitda == null ? "–" : (r.nd_ebitda < 0 ? "순현금" : r.nd_ebitda.toFixed(1) + "x");
    return `<div class="table-wrap"><table class="nv-ll">
      <tr><th>우선순위</th><th>회사</th><th>노드</th><th>전략 앵글</th><th>매출</th><th>영업이익률</th><th>ROE</th><th>3yCAGR</th><th>부채비율</th><th>ND/EBITDA</th><th>상장</th><th>거래 계기</th><th>note</th></tr>
      ${scored.slice(0, 40).map((r) => `<tr class="${r.pick ? "nv-pick" : ""}${r.cashcow ? " nv-cowrow" : ""}">
        <td>${pri(r)}${r.pick ? ' <span class="nv-star" title="pick">★</span>' : ""}</td>
        <td><b>${esc(r.name)}</b>${kindBadge(r)}${r.cashcow ? ` <span class="nv-cowbadge" title="캐시카우: 비상장·고마진(OPM≥15%)·순현금 — 회사의 질 신호. 승계 여부는 지분구조 확인 필요">💰</span>` : ""}${r.rev == null && !r.kind ? ` <span class="nv-leadtag" title="재무 미매칭 — 소싱 지시서/발굴 대상 (풀 빌드 시 재무 채워짐)">발굴</span>` : ""}</td>
        <td class="nv-node nv-nodecell" data-node="${esc(r.node || "")}" title="이 노드만 보기">${esc(r.node || "")}</td>
        <td class="nv-angle nv-anglecell" data-angle="${esc(r.angleLbl)}" title="이 앵글만 보기">${esc(r.angleLbl)}</td>
        <td class="nv-rev" title="${r.year ? r.year + "년 재무 기준" : "직전 패널(2024) 기준"}">${money(r.rev)}${r.year ? `<sup class="nv-yr">'${String(r.year).slice(2)}</sup>` : ""}</td>
        <td>${pct(r.opm)}</td>
        <td>${r.roe == null ? "–" : (r.roe * 100).toFixed(0) + "%"}</td>
        <td>${pct(r.cagr3)}</td>
        <td title="부채비율(총부채/자본)">${debt(r)}</td>
        <td title="순부채/EBITDA — 낮을수록 안전, 음수=순현금">${nde(r)}</td>
        <td>${r.listed === true ? "상장" : r.listed === false ? "비상장" : "–"}</td>
        <td>${st(r)}</td>
        <td class="nv-note">${r.wl && r.wl !== "pass" && r.wl_reason ? `<span class="nv-wlreason">${esc(r.wl_reason)}</span>` : ""}${r.biz ? `<span class="nv-biz">${esc(r.biz)}</span>` : ""}${esc(r.note || "")}</td></tr>`).join("")}
    </table></div>${scored.length > 40 ? `<p class="nv-dim">…상위 40개 표시 (전체 ${scored.length}) · 구분(소싱 대상 우선) → 우선순위순 정렬</p>` : ""}`;
  }

  // 전략 앵글 설명 (접이식) — 각 앵글 라벨이 어떤 딜 구조인지 한 줄. 사용자가 보고 추가/조정 결정.
  function angleGlossary() {
    const rows = [
      ["성장자금", "성장 중인 회사에 신주(유상증자)로 자금 투입 — 돈이 회사로 들어가 성장에 쓰임 (GROWTH·WC_BURN)"],
      ["구주·세컨더리", "기존 재무적투자자(VC/PE) 보유 지분을 사오는 것 — 회사가 아닌 기존 주주에게 돈이 감 (note에 구주·세컨더리 명시된 경우)"],
      ["메자닌·리파이", "전환사채·신주인수권 등 메자닌 또는 차입 재조정 — 레버리지 부담·리파이 니즈 (DISTRESS·REFI)"],
      ["볼트온", "이미 보유한 플랫폼에 붙이는 추가 인수 (규모·시너지)"],
      ["유동성 브릿지", "단기 유동성 급한 소형사에 브릿지 자금 (TIGHT)"],
      ["니즈 낮음 / 재무 미확보", "당장 자금니즈 없음, 또는 풀에 재무가 없어 실체 확인 먼저"]
    ];
    return `<details class="nv-method"><summary>전략 앵글이 무슨 뜻인가요? (딜 구조 설명)</summary>
      <div class="nv-method-body"><table class="nv-mtab">
      <tr><th>전략 앵글</th><th>어떤 딜 구조인가</th></tr>
      ${rows.map((r) => `<tr><td style="white-space:nowrap"><b>${r[0]}</b></td><td>${r[1]}</td></tr>`).join("")}
      </table>
      <p class="nv-dim">재무지표·자금니즈로 <b>확실히 판정되는 앵글만</b> 표시합니다. P2P(상장폐지)·승계·카브아웃 등은 지분·사업구조를 상세히 봐야 알 수 있어 앵글에서 빼고 note에만 남겼습니다.</p>
      </div></details>`;
  }

  // 우선순위·용어 안내 (접이식·쉬운 말) — 점수·산식은 숨기고 '무슨 뜻인지'만
  function methodBox() {
    return `<details class="nv-method"><summary>우선순위·용어가 무슨 뜻인가요?</summary>
      <div class="nv-method-body">
      <p class="nv-dim"><b>우선순위</b> — "어느 회사부터 붙을지"를 재무·딜 적합도로 자동 정렬한 등급입니다. 절대 점수가 아니라 <b>회사 간 상대 순위</b>로 보세요.</p>
      <table class="nv-mtab">
        <tr><td><span class="nv-tier nv-gA">즉시</span></td><td>바로 검토 착수 — 기업분석 우선 투입</td></tr>
        <tr><td><span class="nv-tier nv-gB">우선</span></td><td>우선 후보 — 다음 배치로 검토</td></tr>
        <tr><td><span class="nv-tier nv-gBm">후보</span></td><td>후보군 — 계기·앵글 확인 후 승격</td></tr>
        <tr><td><span class="nv-tier nv-gC">관찰</span></td><td>관찰 — 조건 변하면 재평가</td></tr>
        <tr><td><span class="nv-tier nv-gD">보류</span></td><td>현 시점 딜 적합도 낮음</td></tr>
      </table>
      <table class="nv-mtab">
        <tr><th>거래 계기 (지금 왜 거래되나)</th><th>뜻</th></tr>
        <tr><td>위기·급매</td><td>재무 스트레스로 급하게 나온 매물</td></tr>
        <tr><td>거래 진행중</td><td>매각·투자 절차가 이미 진행 중</td></tr>
        <tr><td>사전 신호</td><td>거래로 이어질 초기 신호 포착</td></tr>
        <tr><td>비상장 잠복</td><td>비상장이라 아직 시장에 안 드러난 상태</td></tr>
        <tr><td>최근 투자유치</td><td>최근 자금을 받아 당장 니즈는 낮음</td></tr>
      </table>
      <p class="nv-dim"><b>💰 캐시카우</b> = 비상장·고마진(OPM≥15%)·순현금 — <b>회사의 질</b> 신호(현금 잘 벌고 빚 없는 비상장사). 승계 딜인지는 주주구성·지분율을 따로 확인해야 압니다. <b>전략 앵글</b>은 이 질 신호와 별개로 '어떤 딜 구조로 접근할지'만 표시합니다. 노드·앵글·등급 칩을 클릭하면 그 조건만 필터됩니다.</p>
      </div></details>`;
  }

  // 활성 필터 적용 (노드/등급/앵글 + 재무 숫자)
  // 정성 게이트 판정(wl)에 따른 1차 분류. 아직 조사되지 않은 행(wl 없음)은 'all' 에서만 보인다.
  function modeFilter(r) {
    if (curMode === "all") return true;
    if (curMode === "watch") return r.wl === "pass";
    if (curMode === "hold") return r.wl === "hold" || r.wl === "thin";
    if (curMode === "drop") return r.wl === "front" || r.wl === "size" || r.wl === "group";
    return true;
  }
  // 아직 정성 조사를 하지 않은 Thesis 는 워치리스트가 비어 있다 — 그럴 땐 전체 매칭으로 대체한다.
  // 사용자가 고른 모드(listMode)는 그대로 두고 이번 렌더에만 적용한다(다른 Thesis 로 가면 원래 모드 복귀).
  function syncMode(scored) {
    curMode = (!scored.some((r) => r.wl === "pass") && listMode !== "all") ? "all" : listMode;
  }
  function applyFilters(scored) {
    return scored.filter(modeFilter).filter((r) =>
    (!nodeFilter || (r.node || "") === nodeFilter) &&
    (!tierFilter || (tierFilter === "COW" ? r.cashcow : r.tier === tierFilter)) &&
    (!angleFilter || r.angleLbl === angleFilter) &&
    (fMinRev == null || (r.rev != null && r.rev >= fMinRev)) &&
    (fMinOpm == null || (r.opm != null && r.opm * 100 >= fMinOpm)) &&
    (fMinCagr == null || (r.cagr3 != null && r.cagr3 * 100 >= fMinCagr)) &&
    (fDebtMin == null || (r.debt_ratio != null && r.debt_ratio * 100 >= fDebtMin)) &&
    (fDebtMax == null || (r.debt_ratio != null && r.debt_ratio * 100 <= fDebtMax)) &&
    (fNdeMin == null || (r.nd_ebitda != null && r.nd_ebitda >= fNdeMin)) &&
    (fNdeMax == null || (r.nd_ebitda != null && r.nd_ebitda <= fNdeMax)));
  }

  // 목록 모드 바 — 워치리스트가 기본. 기계 매칭 전체는 토글로 연다.
  //   워치리스트 = 사업모델·전방산업을 확인해 이 Thesis 에 질적으로 맞는다고 판정된 회사만.
  function modeBar(t, scored) {
    const n = (f) => scored.filter(f).length;
    const cW = n((r) => r.wl === "pass");
    const cH = n((r) => r.wl === "hold" || r.wl === "thin");
    const cD = n((r) => r.wl === "front" || r.wl === "size" || r.wl === "group");
    const cA = scored.length;
    const done = n((r) => !!r.wl);
    const btn = (k, ico, label, cnt, title) =>
      `<button class="nv-mode${curMode === k ? " on" : ""}${(k !== "all" && !cnt) ? " nv-mode-off" : ""}" data-mode="${k}"${(k !== "all" && !cnt) ? " disabled" : ""} title="${title}">${ico} ${label} <b>${cnt}</b></button>`;
    return `<div class="nv-modebar"><span class="nv-abar-lbl">선별</span>
      ${btn("watch", "🎯", "워치리스트", cW, "사업모델·전방산업 확인 결과 이 Thesis 에 맞는 회사")}
      ${btn("hold", "❓", "확인 필요", cH, "업종코드가 안 맞거나 사업내용이 불명 — DART 사업의 내용 확인 대상")}
      ${btn("drop", "🚫", "제외", cD, "정성 게이트에서 걸러진 회사 — 사유를 함께 표시")}
      ${btn("all", "📋", "전체 매칭", cA, "키워드·업종코드로 기계 매칭된 원본 목록")}
      <span class="nv-dim nv-modehint">${done ? `조사 완료 ${done}/${cA}사` : "이 Thesis 는 아직 정성 조사 전 — '전체 매칭'만 있습니다"}</span>
    </div>`;
  }

  // 재무 필터 바 — 숫자 입력. 값 있는 행에만 적용(없는 행은 해당 조건 활성 시 제외).
  function finFilterBar() {
    const inp = (id, ph, val) => `<input class="nv-finp" id="${id}" type="number" placeholder="${ph}" value="${val == null ? "" : val}" />`;
    return `<div class="nv-finbar">
      <span class="nv-finbar-lbl">재무 필터</span>
      ${inp("fRev", "매출 ≥ 억", fMinRev)}
      ${inp("fOpm", "OPM ≥ %", fMinOpm)}
      ${inp("fCagr", "3yCAGR ≥ %", fMinCagr)}
      <span class="nv-frange">부채비율 ${inp("fDebtMin", "min %", fDebtMin)}~${inp("fDebtMax", "max %", fDebtMax)}</span>
      <span class="nv-frange">ND/EBITDA ${inp("fNdeMin", "min x", fNdeMin)}~${inp("fNdeMax", "max x", fNdeMax)}</span>
      <button class="nv-finclear" id="nvFinClear">✕ 해제</button>
      <span class="nv-dim nv-finnote">숫자 입력 후 Enter — 값이 있는 기업에만 적용(재무 미매칭 기업은 제외). 부채비율·ND/EBITDA는 min~max 범위.</span>
    </div>`;
  }

  function renderSheet() {var _t$catalog0, _t$catalog1, _t$catalog10, _t$provenance, _t$provenance2;
    const t = data.themes.find((x) => x.id === curTheme);
    const el = document.getElementById("themeSheet");
    if (!t) {el.innerHTML = "";return;}
    const e = ELAS[(_t$catalog0 = t.catalog) === null || _t$catalog0 === void 0 ? void 0 : _t$catalog0.supply_elasticity] || {};
    const scored = scoreLonglist(t.longlist, (_t$catalog1 = t.catalog) === null || _t$catalog1 === void 0 ? void 0 : _t$catalog1.supply_elasticity, (_t$catalog10 = t.catalog) === null || _t$catalog10 === void 0 ? void 0 : _t$catalog10.payer);
    // 아직 정성 조사를 하지 않은 Thesis 는 워치리스트가 비어 있다 — 그럴 땐 전체 매칭을 보여준다.
    // (빈 화면을 보여주는 것보다 '아직 조사 전'이라고 말하고 원본을 보여주는 편이 정직하다)
    syncMode(scored);
    const filtered = applyFilters(scored);
    // 롱리스트에 실제 존재하는 노드별 개수 (표시용)
    const nodeRowCount = {};
    scored.forEach((r) => {const n = r.node || "";if (n) nodeRowCount[n] = (nodeRowCount[n] || 0) + 1;});
    const nodeChips = t.nodeCounts && t.nodeCounts.length ?
    `<h3 class="h3">Value Chain 노드 <span class="nv-dim">(클릭 = 해당 노드만 보기)</span></h3><div class="nv-nodes">${t.nodeCounts.map((n) => {var _nodeRowCount$n$node;return (
        `<span class="nv-nodechip nv-nodeclick${nodeFilter === n.node ? " on" : ""}" data-node="${esc(n.node)}" title="이 노드만 보기">${esc(n.node)} <b>${(_nodeRowCount$n$node = nodeRowCount[n.node]) !== null && _nodeRowCount$n$node !== void 0 ? _nodeRowCount$n$node : n.n}</b></span>`);}).join("")}</div>` :
    "";
    el.innerHTML = `<section class="card nv-sheet">
      <h2 class="card-title">${t.group ? `<span class="nv-axis-tag">${esc(t.group.emoji || "")} ${esc(t.group.title || "")}</span> ` : ""}${esc(t.emoji)} ${esc(t.title)}
        <span class="nv-elas ${e.cls || ""}">공급탄력성 ${esc(e.label || "")}</span></h2>
      <div class="nv-prov-line">📌 ${esc(((_t$provenance = t.provenance) === null || _t$provenance === void 0 ? void 0 : _t$provenance.source) || "")} · ${esc(((_t$provenance2 = t.provenance) === null || _t$provenance2 === void 0 ? void 0 : _t$provenance2.evidence) || "")}</div>
      ${lensChips(t)}
      ${t.harvest_reinforce && t.harvest_reinforce.length ? `<details class="nv-reinforce"><summary>🌱 우리 리서치 자산에서 이 Thesis가 다시 확인된 근거 ${t.harvest_reinforce.length}건</summary><ul class="nv-bl">${t.harvest_reinforce.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}
      ${kpiGrid(t)}
      ${t.supply_verdict ? `<div class="nv-verdict"><b>공급이 얼마나 못 늘어나나</b>${Array.isArray(t.supply_verdict) ? "" : " — "}${textBlock(t.supply_verdict)}</div>` : ""}
      ${t.falsify && t.falsify.length ? `<div class="nv-falsify"><b>어떻게 틀릴 수 있나</b> <span class="nv-dim">— 이게 관측되면 Thesis를 내린다</span>${textBlock(t.falsify)}</div>` : ""}
      ${screenList(t)}
      ${commentsSection(t.id)}
      ${nodeChips}
      <h3 class="h3">기업 목록 <span class="nv-dim">(우선순위순 · ★=주목 기업)</span></h3>
      ${modeBar(t, scored)}
      ${scored.length && !scored.some((r) => r.rev != null) ? `<div class="nv-leadnote">🔎 이 Thesis는 아직 <b>재무 매칭된 기업이 없습니다</b> — 항목은 소싱 지시서/발굴 리드입니다. 관련 상장·우량사는 우리 4만개 외감 유니버스엔 있으나, 배포본이 '자금니즈 풀'로 한정돼 재무가 안 붙은 상태(로컬 풀 빌드 시 채워짐).</div>` : ""}
      ${tierSummary(scored)}
      ${angleSummary(scored)}
      ${angleGlossary()}
      ${methodBox()}
      ${finFilterBar()}
      <div id="nvLLTable">${filterBanner(filtered.length, scored.length)}${longlistTable(filtered)}</div>
      ${t.whitespace ? `<div class="meta"><b>화이트스페이스</b> — ${esc(t.whitespace)}</div>` : ""}
      ${t.bolton ? `<div class="meta"><b>볼트온</b> — ${esc(t.bolton)}</div>` : ""}
      ${t.sources && t.sources.length ? `<p class="nv-dim">출처: ${t.sources.map(esc).join(" · ")}</p>` : ""}
    </section>`;
    wireFilters(el);
    wireComments(el, t.id);
    hydrateComments(t.id);
  }

  // Thesis 3문 렌즈 칩 — ②해자(3년 복제 테스트) · ③딜 윈도우 · ①지불자
  function lensChips(t) {
    const c = t.catalog || {};
    const chip = (ico, lbl, val, cls) => val ? `<span class="nv-lchip ${cls || ""}"><em>${ico} ${lbl}</em>${esc(val)}</span>` : "";
    const row = chip("🧱", "해자", c.moat) + chip("🪟", "딜 윈도우", c.deal_window) + chip("💳", "지불자", c.payer, /국가|보험/.test(c.payer || "") ? "nv-lchip-payer" : "");
    return row ? `<div class="nv-lensrow">${row}</div>` : "";
  }

  // 테마별 스크리닝 체크리스트 (레지스트리 screen[])
  function screenList(t) {
    if (!t.screen || !t.screen.length) return "";
    return `<div class="nv-screen"><b>스크리닝 체크</b><ul>${t.screen.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`;
  }

  // 커뮤니티 시그널 — comments-harvest.mjs 가 수집한 giscus Discussions 요약.
  // 댓글은 Thesis 검토 로직의 입력 — /deal-angle 세션이 리뷰 후 KPI·스크린·롱리스트에 반영.
  function communityBox(t) {
    const c = t.community;
    if (!c || !c.count) return "";
    const recent = (c.recent || []).slice(0, 5).map((m) =>
    `<div class="nv-comm-row"><span class="nv-comm-author">${esc(m.author)}</span><span class="nv-comm-date">${esc((m.date || "").slice(0, 10))}</span><div class="nv-comm-body">${esc(m.body)}</div></div>`).join("");
    return `<div class="nv-community"><b>💬 커뮤니티 시그널 ${c.count}건</b> <span class="nv-dim">— 검토 큐에 편입됨 (Thesis 반박·보강·신규 리드 환영)</span>
      ${recent}${c.url ? `<a class="nv-comm-link" href="${esc(c.url)}" target="_blank" rel="noopener">전체 스레드 →</a>` : ""}</div>`;
  }

  // 재무 필터만 바뀔 때: 표 영역(#nvLLTable)만 다시 그림 — 전체 시트 재렌더(giscus 재마운트) 회피
  function refreshLLTable() {
    const t = data.themes.find((x) => x.id === curTheme);
    const wrap = document.getElementById("nvLLTable");
    if (!t || !wrap) return;
    const scored = scoreLonglist(t.longlist, t.catalog && t.catalog.supply_elasticity, t.catalog && t.catalog.payer);
    syncMode(scored);
    const filtered = applyFilters(scored);
    wrap.innerHTML = filterBanner(filtered.length, scored.length) + longlistTable(filtered);
    wireTableFilters(wrap);
  }

  // 표 내부 상호작용(노드셀·앵글셀·전체보기 버튼)만 배선
  function wireTableFilters(scope) {
    const toggleNode = (n) => { nodeFilter = nodeFilter === n ? null : n; renderSheet(); };
    const toggleAngle = (a) => { angleFilter = angleFilter === a ? null : a; renderSheet(); };
    scope.querySelectorAll(".nv-nodecell").forEach((c) => c.addEventListener("click", () => { if (c.dataset.node) toggleNode(c.dataset.node); }));
    scope.querySelectorAll(".nv-anglecell").forEach((c) => c.addEventListener("click", () => { if (c.dataset.angle) toggleAngle(c.dataset.angle); }));
    const clr = scope.querySelector("#nvFclear");
    if (clr) clr.addEventListener("click", () => { nodeFilter = null; tierFilter = null; angleFilter = null; renderSheet(); });
  }

  // ── 테마 댓글 UI (밸류체인 노드 위, 실시간) ──────────────────────────────
  function commentsSection(themeId) {
    if (!sb) return `<div class="nv-cmt"><h3 class="h3">💬 이 Thesis 토론</h3><p class="nv-dim">실시간 댓글은 Supabase 설정 시 활성화됩니다.</p></div>`;
    const author = (lsGet("dar_comment_author") || "");
    return `<div class="nv-cmt" data-theme="${esc(themeId)}">
      <h3 class="h3">💬 이 Thesis 토론 <span class="nv-dim">실시간 · 로그인 불필요</span></h3>
      <div id="nvCmtList" class="nv-cmt-list nv-dim">불러오는 중…</div>
      <form id="nvCmtForm" class="nv-cmt-form">
        <input id="nvCmtAuthor" class="nv-cmt-author" placeholder="이름" value="${esc(author)}" maxlength="40" />
        <textarea id="nvCmtBody" class="nv-cmt-body" rows="2" placeholder="이 Thesis에 대한 의견·반박·리드 제보… (Enter 등록, Shift+Enter 줄바꿈)"></textarea>
        <button type="submit" class="nv-cmt-send">등록</button>
      </form>
    </div>`;
  }
  function renderCmtList(el, rows) {
    if (!rows || !rows.length) { el.className = "nv-cmt-list nv-dim"; el.innerHTML = "아직 댓글이 없습니다 — 첫 의견을 남겨보세요."; return; }
    el.className = "nv-cmt-list";
    // 삭제는 누구나(사내 공유 도구 — 잘못 올린 글·중복을 본 사람이 바로 정리할 수 있게).
    el.innerHTML = rows.map((m) =>
      `<div class="nv-cmt-item"><span class="nv-cmt-name">${esc(m.author || "익명")}</span><span class="nv-cmt-time">${esc((m.created_at || "").slice(0, 16).replace("T", " "))}</span>` +
      (m.id != null ? `<button class="nv-cmt-del" data-id="${esc(m.id)}" title="이 댓글 삭제">🗑</button>` : "") +
      `<div class="nv-cmt-text">${esc(m.body || "")}</div></div>`).join("");
    // 삭제 버튼은 목록을 다시 그릴 때마다 새로 붙는다 (폴링 갱신 포함)
    el.querySelectorAll(".nv-cmt-del").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("이 댓글을 삭제할까요? (누구나 삭제할 수 있습니다)")) return;
      b.disabled = true;
      try { await sbDeleteComment(b.dataset.id); await hydrateComments(curTheme); }
      catch (e) {
        b.disabled = false;
        alert(e.noPolicy || /401|403/.test(String(e.message || e))
          ? "삭제가 데이터베이스에서 막혀 있습니다 (삭제 정책 없음).\n\nSupabase → SQL Editor 에서 아래를 한 번 실행해 주세요:\n\ncreate policy \"c anon delete\" on comments for delete to anon using (true);"
          : "삭제 실패: " + (e.message || e));
      }
    }));
  }
  async function hydrateComments(themeId) {
    if (!sb) return;
    const list = document.getElementById("nvCmtList");
    if (!list) return;
    try { renderCmtList(list, await sbComments(themeId)); }
    catch (e) { list.className = "nv-cmt-list nv-dim"; list.innerHTML = "댓글 로드 실패: " + esc(e.message || e); }
  }
  function wireComments(el, themeId) {
    if (!sb) return;
    const form = el.querySelector("#nvCmtForm");
    if (!form) return;
    const body = el.querySelector("#nvCmtBody"), auth = el.querySelector("#nvCmtAuthor");
    const submit = async () => {
      const b = (body.value || "").trim(); if (!b) return;
      const a = (auth.value || "").trim() || "익명";
      lsSet("dar_comment_author", a);
      body.value = ""; body.disabled = true;
      try { await sbPostComment(themeId, a, b); await hydrateComments(themeId); }
      catch (e) { alert("등록 실패: " + (e.message || e)); }
      body.disabled = false; body.focus();
    };
    form.addEventListener("submit", (ev) => { ev.preventDefault(); submit(); });
    body.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); submit(); } });
  }

  // 필터 상호작용 배선 — 노드칩·표 노드셀·티어칩·해제버튼
  function wireFilters(el) {
    const toggleNode = (n) => {nodeFilter = nodeFilter === n ? null : n;renderSheet();};
    const toggleTier = (tKey) => {tierFilter = tierFilter === tKey ? null : tKey;renderSheet();};
    const toggleAngle = (a) => {angleFilter = angleFilter === a ? null : a;renderSheet();};
    el.querySelectorAll(".nv-nodeclick").forEach((c) => c.addEventListener("click", () => toggleNode(c.dataset.node)));
    el.querySelectorAll(".nv-nodecell").forEach((c) => c.addEventListener("click", () => {if (c.dataset.node) toggleNode(c.dataset.node);}));
    el.querySelectorAll(".nv-mode[data-mode]").forEach((b) => b.addEventListener("click", () => {
      listMode = b.dataset.mode;
      el.querySelectorAll(".nv-mode[data-mode]").forEach((x) => x.classList.toggle("on", x.dataset.mode === listMode));
      refreshLLTable();
    }));
    el.querySelectorAll(".nv-tsum[data-tier]").forEach((c) => c.addEventListener("click", () => toggleTier(c.dataset.tier)));
    el.querySelectorAll(".nv-asum[data-angle]").forEach((c) => c.addEventListener("click", () => toggleAngle(c.dataset.angle)));
    el.querySelectorAll(".nv-anglecell").forEach((c) => c.addEventListener("click", () => {if (c.dataset.angle) toggleAngle(c.dataset.angle);}));
    const clr = el.querySelector("#nvFclear");
    if (clr) clr.addEventListener("click", () => {nodeFilter = null;tierFilter = null;angleFilter = null;renderSheet();});
    // 재무 필터 입력 — Enter 또는 blur 시 반영 (값 없으면 해제)
    const numOrNull = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
    const bind = (id, setter) => {
      const inp = el.querySelector("#" + id);
      if (!inp) return;
      const apply = () => { setter(numOrNull(inp.value)); refreshLLTable(); };
      inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") apply(); });
      inp.addEventListener("change", apply);
    };
    bind("fRev", (v) => fMinRev = v);
    bind("fOpm", (v) => fMinOpm = v);
    bind("fCagr", (v) => fMinCagr = v);
    bind("fDebtMin", (v) => fDebtMin = v);
    bind("fDebtMax", (v) => fDebtMax = v);
    bind("fNdeMin", (v) => fNdeMin = v);
    bind("fNdeMax", (v) => fNdeMax = v);
    const finClr = el.querySelector("#nvFinClear");
    if (finClr) finClr.addEventListener("click", () => { resetFinFilters(); renderSheet(); }); // 해제는 finbar 재렌더 필요 → 전체
  }
})();
