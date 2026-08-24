// narrative.js — 네러티브 기반 딜소싱 스크리너 뷰
// data/narrative-pool.json (build-narrative.mjs 산출) 을 읽어 렌더.
// 성장률이 아니라 공급탄력성으로 정렬. 하베스트 후보(candidate)는 상단 승인대기 영역.
(function () {
  let inited = false,data = null,curTheme = null;
  let nodeFilter = null,tierFilter = null,angleFilter = null; // 롱리스트 필터 상태 (테마 전환 시 리셋)

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
  const SFIT_W = { theme: 0.20, angle: 0.22, source: 0.15, ticket: 0.15, quality: 0.10, catalyst: 0.12, payer: 0.06 };
  const ELAS_SCORE = { very_low: 1.0, low: 0.7, mid: 0.4, high: 0.15 };
  // type → RVP 딜앵글 강점 매핑 (조달니즈 type 정의). GROWTH=FI최적, DISTRESS/REFI=구조조정·리파이 강점.
  const ANGLE_SCORE = { GROWTH: 1.0, DISTRESS: 0.85, REFI: 0.85, TIGHT: 0.55, WC_BURN: 0.45, SELF: 0.15 };

  function opmScore(o) {return o == null ? 0.3 : o >= 0.15 ? 1 : o >= 0.10 ? 0.8 : o >= 0.05 ? 0.55 : o >= 0 ? 0.35 : 0.15;}
  function cagrScore(c) {return c == null ? 0.4 : c >= 0.20 ? 1 : c >= 0.10 ? 0.7 : c >= 0 ? 0.4 : 0.1;}
  function ticketScore(rev) {// 매출을 규모 프록시로 — RVP 커버 구간(자체 소수지분 / 컨소 슬롯)
    if (rev == null) return 0.4;
    return rev <= 2500 ? 1.0 : rev <= 6000 ? 0.6 : 0.3;
  }
  const CATALYST_SCORE = { DISTRESS_EVENT: 1.0, IN_MOTION: 0.9, PRE_SIGNAL: 0.8, UNLISTED_BLIND: 0.55, RECENTLY_FUNDED: 0.25 };
  // status(촉매) 를 한국어로 — "지금 이 회사가 거래될 계기가 있는가"
  const STATUS_KO = {
    DISTRESS_EVENT: "위기·급매", IN_MOTION: "거래 진행중", PRE_SIGNAL: "사전 신호",
    UNLISTED_BLIND: "비상장 잠복", RECENTLY_FUNDED: "최근 투자유치"
  };
  const statusKo = (s) => s ? (STATUS_KO[s] || s) : "";

  // 지불자 렌즈 (테제 생성 3문 中 ①수요 확실성) — 수가·환급·방위비·의무보험 매출은 경기 무관 채권
  function payerScore(payer) {
    const s = payer || "";
    if (s.includes("국가")) return 1.0;
    if (s.includes("보험")) return 0.9;
    if (s.includes("혼합")) return 0.65;
    return 0.5;
  }

  // 앵글A 캐시카우/승계 후보 (케이스맵 재현스크린: 비상장·고마진·순현금)
  //   listed!==true = 비상장 또는 풀 밖(이벤트 미관측) — 상장사만 제외.
  const isCashCow = (r) => r.listed !== true && r.opm != null && r.opm >= 0.15 && r.nd != null && r.nd < 0;

  function scoreRow(r, themeElas, themePayer) {var _ELAS_SCORE$themeElas, _ANGLE_SCORE$r$type, _CATALYST_SCORE$r$sta;
    const fTheme = (_ELAS_SCORE$themeElas = ELAS_SCORE[themeElas]) !== null && _ELAS_SCORE$themeElas !== void 0 ? _ELAS_SCORE$themeElas : 0.4;
    const fAngle = r.type ? (_ANGLE_SCORE$r$type = ANGLE_SCORE[r.type]) !== null && _ANGLE_SCORE$r$type !== void 0 ? _ANGLE_SCORE$r$type : 0.35 : 0.35;
    const fSource = r.listed === false ? 1.0 : r.listed === true ? 0.55 : 0.5;
    const fTicket = ticketScore(r.rev);
    const fQuality = 0.7 * opmScore(r.opm) + 0.3 * cagrScore(r.cagr3);
    const fCatalyst = r.status ? (_CATALYST_SCORE$r$sta = CATALYST_SCORE[r.status]) !== null && _CATALYST_SCORE$r$sta !== void 0 ? _CATALYST_SCORE$r$sta : 0.35 : 0.35;
    let s = 100 * (SFIT_W.theme * fTheme + SFIT_W.angle * fAngle + SFIT_W.source * fSource +
    SFIT_W.ticket * fTicket + SFIT_W.quality * fQuality + SFIT_W.catalyst * fCatalyst + SFIT_W.payer * payerScore(themePayer));
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
  function angleLabel(r) {
    const note = r.note || "";
    if (/볼트온|bolt|add-?on/i.test(note)) return "볼트온 (플랫폼 add-on)";
    // 딜 윈도우 감지 — 노트에 명시된 거래 계기가 재무 유형보다 우선 (테제 생성 3문 中 ③)
    if (/공개매수|P2P|상폐/i.test(note)) return "P2P 공개매수 각도";
    if (/구주|세컨더리|다운라운드/.test(note)) return "FI 구주·세컨더리";
    if (/승계|세대교체|오너 6|오너 7/.test(note)) return "승계 딜 (오너·2세)";
    if (/카브아웃|carve/i.test(note)) return "카브아웃";
    if (/공동투자|co-?invest|소수지분/i.test(note)) return "앵커 공동투자·소수지분";
    if (/워치|모니터링|발굴/.test(note) && r.rev == null) return "워치·발굴 리드";
    // 캐시카우(비상장·고마진·순현금)는 회사의 '질' 신호이지 딜 구조가 아니므로 앵글 라벨에서 제외 —
    //   회사명 옆 💰 배지로 별도 표시. 딜 구조는 아래 자금니즈 type 으로만 판정.
    const L = r.listed;
    switch (r.type) {
      case "GROWTH":return L === false ? "성장자금 FI·신주 소수지분" : "3자배정 성장자금";
      case "DISTRESS":return L === false ? "구조조정·리파이 크레딧" : "메자닌·리파이";
      case "REFI":return L === false ? "롤오버 리파이·밸류업" : "메자닌·리파이";
      case "WC_BURN":return "성장자금 (운전자본 소진 주의)";
      case "TIGHT":return "유동성 브릿지 (소형)";
      case "SELF":return "니즈 낮음 — 승계·밸류업 확인";
      default:return r.inPool ? "니즈 미분류" : "재무 미확보 — 소싱 확인";
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
      const cres = await fetch(`./data/site-config.json?_=${Date.now()}`, { cache: "no-store" });
      if (cres.ok) { const cj = await cres.json(); if (cj.supabase && cj.supabase.url && cj.supabase.anonKey) sb = cj.supabase; }
    } catch (e) { /* site-config 없음 — 파일/토큰 폴백 */ }
    if (sb) { try { await sbLoad(); } catch (e) { boardMsg = "Supabase 조회 실패: " + (e.message || e) + " — 파일 기준값 사용"; } }
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
    intro() + (
    candidates.length ? candidateBox(candidates) : "") +
    boardBox(approved) +
    `<details class="nv-matrix-details"><summary>📊 상세 카탈로그 — 렌즈 비교 테이블 (공급탄력성·해자·딜윈도우·지불자)</summary>${matrix(approved)}</details>` +
    `<div id="themeSheet"></div>`;
    wireBoard(root, approved);
    renderSheet();
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
    return `<section class="card nv-board-card">
      <h2 class="card-title">테마 보드 — Work · Hold · Drop
        <span class="nv-board-tools">
          ${pending ? `<span class="nv-bpend">저장 중 ${pending}건</span>` : ""}
          ${sb ? `<span class="nv-bshare-on">${shareLabel}</span>` : `<button id="nvBoardShare" title="이동 내역을 repo(data/board-state.json)에 커밋해 전원 공유">${shareLabel}</button>`}
        </span></h2>
      <p class="nv-dim">카드 = <b>하위 테제</b>, 굵은 소제목 = <b>상위 축</b>. 드래그·이동 버튼으로 진행→보류→중단 분류. 카드 클릭 = 아래 테마 시트. ${shareDesc} 세분화 원칙·사고기록은 <code>THESIS-LOG.md</code>.</p>
      ${boardMsg ? `<div class="nv-bmsg">${esc(boardMsg)}</div>` : ""}
      <div class="nv-board">${STAGES.map(colHTML).join("")}</div>
    </section>`;
  }

  function wireBoard(root, themes) {
    // 카드 클릭 → 테마 시트
    root.querySelectorAll(".nv-bcard").forEach((c) => {
      c.addEventListener("click", (ev) => {
        if (ev.target.closest(".nv-bmove")) return;
        curTheme = c.dataset.id; nodeFilter = null; tierFilter = null; angleFilter = null;
        renderSheet();
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
      <p><strong>네러티브 → transmission KPI → value chain 노드 → 외감 롱리스트</strong>. 테제는 3문으로 생성·검증한다 — <strong>① 수요의 확실성</strong>(지불자·백로그·규제일정·인구) × <strong>② 공급·경쟁의 봉쇄</strong>(3년 복제 테스트: 퀄·면허·총량·노하우·설치기반) × <strong>③ 딜 윈도우</strong>(왜 지금 거래되는가: 승계·FI만기·밸류리셋·제도화 캘린더·그룹재편·저평가 P2P).</p>
      <p class="nv-dim">유니버스: 외감법인 41,409개 패널 × funding-pool 니즈 오버레이 · 재무: funding-pool 수록사는 <b>최신 DART 감사보고서(2025 다수)</b> 반영(매출 옆 '25/'24 = 기준연도), 그 외 패널사는 직전 빌드(2024) · 포착: 자산 하베스트 + 사용자 승인 · 공통 킬 필터: 中 3~5년 복제 가능성 · 재빌드: <code>node narrative/build-narrative.mjs</code>${data.meta.build_mode && data.meta.build_mode.startsWith("patch") ? ` · <b>패치 빌드</b>(패널 전체 2025 갱신은 패널 머신에서)` : ""}</p>
    </div>`;
  }

  function candidateBox(cands) {
    return `<section class="card nv-cand"><h2 class="card-title">🌱 하베스트 후보 (승인 대기 ${cands.length})</h2>
      <p class="nv-dim">PPI 가속·insight·news 에서 포착된 신규 narrative 후보. 승인 시 정식 테마로 편입.</p>
      ${cands.map((c) => {var _c$provenance, _c$provenance2;return `<div class="nv-cand-row"><span class="nv-cand-title">${esc(c.emoji)} ${esc(c.title)}</span>
        <span class="nv-prov">${esc(((_c$provenance = c.provenance) === null || _c$provenance === void 0 ? void 0 : _c$provenance.source) || "")} · ${esc(((_c$provenance2 = c.provenance) === null || _c$provenance2 === void 0 ? void 0 : _c$provenance2.evidence) || "")}</span></div>`;}).join("")}
    </section>`;
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

  function kpiGrid(t) {
    const K = t.kpi || {};
    const rows = [
    ["Catalyst", K.catalyst], ["Structural/Cyclical", K.structural], ["Demand KPI", K.demand],
    ["Supply KPI ★", K.supply], ["Pricing", K.pricing], ["CAPEX", K.capex], ["Persistence", K.persistence]].
    filter((r) => r[1]);
    if (!rows.length) return `<div class="meta">KPI 미작성 — 리서치 대기 중.</div>`;
    return `<div class="table-wrap"><table class="nv-kpi">` +
    rows.map((r) => `<tr><th>${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`).join("") + `</table></div>`;
  }

  // 롱리스트에 SFIT·티어·앵글을 부착하고 우선순위로 정렬 (pick 은 상단 고정)
  function scoreLonglist(ll, themeElas, themePayer) {
    const scored = (ll || []).map((r) => {
      const sfit = scoreRow(r, themeElas, themePayer);
      return { ...r, sfit, tier: tierOf(sfit), angleLbl: angleLabel(r), cashcow: isCashCow(r) };
    });
    scored.sort((a, b) => b.pick - a.pick || b.sfit - a.sfit || (b.rev || 0) - (a.rev || 0));
    return scored;
  }

  // 티어 요약바 — 각 칩 클릭 = 해당 티어만 필터 (토글). 캐시카우 칩도 필터.
  function tierSummary(scored) {
    const c = { A: 0, B: 0, Bm: 0, C: 0, D: 0 };
    scored.forEach((r) => c[r.tier]++);
    const chip = (t) => `<span class="nv-tsum nv-sum${t}${tierFilter === t ? " on" : ""}" data-tier="${t}" title="${TIER_LABEL[t]} — 클릭하면 이 등급만 보기">${TIER_LABEL[t]} <b>${c[t]}</b></span>`;
    const cows = scored.filter((r) => r.cashcow).length;
    return `<div class="nv-tierbar">${TIER_ORDER.map(chip).join("")}` + (
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
    if (!parts.length) return "";
    return `<div class="nv-fbanner">필터: ${parts.join(" · ")} — <b>${shownN}</b>/${totalN}개 <button class="nv-fclear" id="nvFclear">✕ 전체 보기</button></div>`;
  }

  function longlistTable(scored) {
    if (!scored || !scored.length) return `<p class="nv-dim">해당 조건의 기업 없음.</p>`;
    // 우선순위 = 등급 한국어 라벨만(점수 숨김). 색으로 등급 구분.
    const pri = (r) => `<span class="nv-tier nv-g${r.tier}" title="검토 우선순위">${TIER_LABEL[r.tier]}</span>`;
    const st = (r) => r.status ? `<span class="nv-st">${esc(statusKo(r.status))}</span>` : "";
    return `<div class="table-wrap"><table class="nv-ll">
      <tr><th>우선순위</th><th>회사</th><th>노드</th><th>전략 앵글</th><th>매출</th><th>OPM</th><th>3yCAGR</th><th>상장</th><th>거래 계기</th><th>note</th></tr>
      ${scored.slice(0, 40).map((r) => `<tr class="${r.pick ? "nv-pick" : ""}${r.cashcow ? " nv-cowrow" : ""}">
        <td>${pri(r)}${r.pick ? ' <span class="nv-star" title="pick">★</span>' : ""}</td>
        <td><b>${esc(r.name)}</b>${r.cashcow ? ` <span class="nv-cowbadge" title="캐시카우: 비상장·고마진(OPM≥15%)·순현금 — 회사의 질 신호. 승계 여부는 지분구조 확인 필요">💰</span>` : ""}</td>
        <td class="nv-node nv-nodecell" data-node="${esc(r.node || "")}" title="이 노드만 보기">${esc(r.node || "")}</td>
        <td class="nv-angle nv-anglecell" data-angle="${esc(r.angleLbl)}" title="이 앵글만 보기">${esc(r.angleLbl)}</td>
        <td class="nv-rev" title="${r.year ? r.year + "년 재무 기준" : "직전 패널(2024) 기준"}">${money(r.rev)}${r.year ? `<sup class="nv-yr">'${String(r.year).slice(2)}</sup>` : ""}</td>
        <td>${pct(r.opm)}</td>
        <td>${pct(r.cagr3)}</td>
        <td>${r.listed === true ? "상장" : r.listed === false ? "비상장" : "–"}</td>
        <td>${st(r)}</td>
        <td class="nv-note">${esc(r.note || "")}</td></tr>`).join("")}
    </table></div>${scored.length > 40 ? `<p class="nv-dim">…상위 40개 표시 (전체 ${scored.length}) · 우선순위순 정렬</p>` : ""}`;
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

  // 활성 필터 적용
  function applyFilters(scored) {
    return scored.filter((r) =>
    (!nodeFilter || (r.node || "") === nodeFilter) && (
    !tierFilter || (tierFilter === "COW" ? r.cashcow : r.tier === tierFilter)) && (
    !angleFilter || r.angleLbl === angleFilter));
  }

  function renderSheet() {var _t$catalog0, _t$catalog1, _t$catalog10, _t$provenance, _t$provenance2;
    const t = data.themes.find((x) => x.id === curTheme);
    const el = document.getElementById("themeSheet");
    if (!t) {el.innerHTML = "";return;}
    const e = ELAS[(_t$catalog0 = t.catalog) === null || _t$catalog0 === void 0 ? void 0 : _t$catalog0.supply_elasticity] || {};
    const scored = scoreLonglist(t.longlist, (_t$catalog1 = t.catalog) === null || _t$catalog1 === void 0 ? void 0 : _t$catalog1.supply_elasticity, (_t$catalog10 = t.catalog) === null || _t$catalog10 === void 0 ? void 0 : _t$catalog10.payer);
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
      ${t.harvest_reinforce && t.harvest_reinforce.length ? `<div class="nv-reinforce">🌱 자산 재확증 ${t.harvest_reinforce.length}건 — ${t.harvest_reinforce.map(esc).join(" · ")}</div>` : ""}
      ${kpiGrid(t)}
      ${t.supply_verdict ? `<div class="nv-verdict"><b>공급탄력성 판정</b> — ${esc(t.supply_verdict)}</div>` : ""}
      ${screenList(t)}
      ${nodeChips}
      <h3 class="h3">롱리스트 <span class="nv-dim">(우선순위순 · ★=주목 기업)</span></h3>
      ${tierSummary(scored)}
      ${angleSummary(scored)}
      ${methodBox()}
      ${filterBanner(filtered.length, scored.length)}
      ${longlistTable(filtered)}
      ${t.whitespace ? `<div class="meta"><b>화이트스페이스</b> — ${esc(t.whitespace)}</div>` : ""}
      ${t.bolton ? `<div class="meta"><b>볼트온</b> — ${esc(t.bolton)}</div>` : ""}
      ${t.sources && t.sources.length ? `<p class="nv-dim">출처: ${t.sources.map(esc).join(" · ")}</p>` : ""}
      ${communityBox(t)}
      <div id="giscusMount"></div>
    </section>`;
    wireFilters(el);
    if (window.mountGiscus) window.mountGiscus(el.querySelector("#giscusMount"), t.id, `${t.emoji} ${t.title}`);
  }

  // 테제 3문 렌즈 칩 — ②해자(3년 복제 테스트) · ③딜 윈도우 · ①지불자
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
  // 댓글은 테제 검토 로직의 입력 — /deal-angle 세션이 리뷰 후 KPI·스크린·롱리스트에 반영.
  function communityBox(t) {
    const c = t.community;
    if (!c || !c.count) return "";
    const recent = (c.recent || []).slice(0, 5).map((m) =>
    `<div class="nv-comm-row"><span class="nv-comm-author">${esc(m.author)}</span><span class="nv-comm-date">${esc((m.date || "").slice(0, 10))}</span><div class="nv-comm-body">${esc(m.body)}</div></div>`).join("");
    return `<div class="nv-community"><b>💬 커뮤니티 시그널 ${c.count}건</b> <span class="nv-dim">— 검토 큐에 편입됨 (테제 반박·보강·신규 리드 환영)</span>
      ${recent}${c.url ? `<a class="nv-comm-link" href="${esc(c.url)}" target="_blank" rel="noopener">전체 스레드 →</a>` : ""}</div>`;
  }

  // 필터 상호작용 배선 — 노드칩·표 노드셀·티어칩·해제버튼
  function wireFilters(el) {
    const toggleNode = (n) => {nodeFilter = nodeFilter === n ? null : n;renderSheet();};
    const toggleTier = (tKey) => {tierFilter = tierFilter === tKey ? null : tKey;renderSheet();};
    const toggleAngle = (a) => {angleFilter = angleFilter === a ? null : a;renderSheet();};
    el.querySelectorAll(".nv-nodeclick").forEach((c) => c.addEventListener("click", () => toggleNode(c.dataset.node)));
    el.querySelectorAll(".nv-nodecell").forEach((c) => c.addEventListener("click", () => {if (c.dataset.node) toggleNode(c.dataset.node);}));
    el.querySelectorAll(".nv-tsum[data-tier]").forEach((c) => c.addEventListener("click", () => toggleTier(c.dataset.tier)));
    el.querySelectorAll(".nv-asum[data-angle]").forEach((c) => c.addEventListener("click", () => toggleAngle(c.dataset.angle)));
    el.querySelectorAll(".nv-anglecell").forEach((c) => c.addEventListener("click", () => {if (c.dataset.angle) toggleAngle(c.dataset.angle);}));
    const clr = el.querySelector("#nvFclear");
    if (clr) clr.addEventListener("click", () => {nodeFilter = null;tierFilter = null;angleFilter = null;renderSheet();});
  }
})();
