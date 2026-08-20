// chat.js — 페이지 내 Claude 챗봇 (BYO API key)
//   정적 GitHub Pages 라 서버가 없으므로 각자 Anthropic API 키를 입력해 브라우저에서 직접 호출한다
//   (localStorage 저장, 절대 커밋되지 않음). 데이터 그라운딩:
//     · 시스템 프롬프트에 26개 테마 카탈로그 요약 주입
//     · get_theme(id)      — 테마 상세(KPI·판정·스크린·롱리스트 상위) 클라이언트 툴
//     · lookup_company(명) — narrative-pool + funding-pool 재무·니즈 조회 클라이언트 툴
//     · web_search         — Claude 서버 툴 (웹리서치)
//   키가 없는 외부 참여자는 테마 하단 댓글(giscus)로 질문 → comments-harvest 가 검토 큐로 수집.
(function () {
  const LS_KEY = "dar_api_key", LS_MODEL = "dar_chat_model";
  const API = "https://api.anthropic.com/v1/messages";
  const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];
  const MAX_LOOPS = 8;

  let pool = null;          // narrative-pool.json (테마+롱리스트)
  let fundingRows = null;   // funding-pool.json rows (재무·니즈 1,443사) — lazy
  let messages = [];        // Claude 대화 히스토리 (content 블록 원형 유지 — thinking/server_tool 포함)
  let busy = false;

  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const $ = sel => document.querySelector(sel);

  // ── 데이터 로드 ────────────────────────────────────────────────────────────
  async function loadPool() {
    if (pool) return pool;
    const res = await fetch("./data/narrative-pool.json", { cache: "no-store" });
    pool = await res.json();
    return pool;
  }
  async function loadFunding() {
    if (fundingRows) return fundingRows;
    const res = await fetch("./data/funding-pool.json", { cache: "force-cache" });
    const raw = await res.json();
    fundingRows = raw.rows || raw;
    return fundingRows;
  }

  // ── 시스템 프롬프트 (테마 카탈로그 요약 — 안정 텍스트, 캐시 브레이크포인트) ──
  function systemPrompt() {
    const lines = (pool?.themes || []).map(t => {
      const c = t.catalog || {};
      return `- [${t.id}] ${t.emoji} ${t.title} | 공급탄력성:${c.supply_elasticity || "?"} | 해자:${c.moat || "-"} | 딜윈도우:${c.deal_window || "-"} | 지불자:${c.payer || "-"} | 롱리스트 ${t.stats?.total ?? 0}개(풀 ${t.stats?.inPool ?? 0}·비상장 ${t.stats?.unlisted ?? 0})${t.community?.count ? ` | 댓글 ${t.community.count}` : ""}`;
    }).join("\n");
    return `당신은 Reverent Partners 의 'Deal Angle Radar' 딜소싱 대시보드에 내장된 리서치 어시스턴트다.
이 페이지는 한국 PE 딜소싱 도구다: DART 공시 스크리닝 + 외감법인 재무 바텀업 + 네러티브 탑다운 스크리너.

테제 프레임 (테제 생성 3문):
① 수요의 확실성 — 지불자가 확정적인가 (수주잔고·규제 일정·인구구조·수가/환급/방위비/의무보험)
② 공급·경쟁의 봉쇄 — 3년 복제 테스트 (퀄·면허·총량 인허가·공정 노하우·설치기반)
③ 딜 윈도우 — 왜 지금 거래되는가 (승계절벽·FI 만기·밸류 리셋·제도화 캘린더·그룹 재편·저평가 P2P)
공통 킬 필터: 중국이 3~5년 내 보조금으로 복제 가능한가.

현재 테마 카탈로그 (${pool?.meta?.themes ?? 0}개, 회계 ${pool?.meta?.accounting_year || ""}, 빌드 ${pool?.meta?.built || ""}):
${lines}

도구 사용 원칙:
- 특정 테마의 KPI·근거·롱리스트 질문 → get_theme 을 먼저 호출해 실제 데이터로 답한다.
- 특정 회사 질문 → lookup_company 로 재무·니즈·소속 테마를 조회한다.
- 최신 뉴스·시장 데이터·페이지에 없는 사실 → web_search 로 확인하고 출처를 명시한다.
- 데이터에 없는 것을 지어내지 않는다. 조회 실패 시 그렇게 말한다.
답변 원칙: 한국어. 결론 먼저, 근거 다음. PE 딜소싱 관점(딜 앵글·티켓·촉매)으로. 숫자는 단위(억·조)를 명확히. 반박·리스크도 함께.`;
  }

  // ── 클라이언트 툴 ──────────────────────────────────────────────────────────
  const TOOLS_CLIENT = [
    {
      name: "get_theme",
      description: "네러티브 테마 1개의 상세(KPI, 공급탄력성 판정, 스크리닝 체크, 롱리스트 상위, 화이트스페이스, 볼트온, 커뮤니티 댓글)를 반환. 테마 id 는 시스템 프롬프트의 대괄호 값.",
      input_schema: { type: "object", properties: { id: { type: "string", description: "테마 id (예: grid-power)" } }, required: ["id"] }
    },
    {
      name: "lookup_company",
      description: "회사명으로 외감 재무(매출·OPM·CAGR·순차입)·자금니즈(need/type/status)·소속 테마·노트를 조회. 부분 일치 검색.",
      input_schema: { type: "object", properties: { name: { type: "string", description: "회사명 (부분 일치)" } }, required: ["name"] }
    }
  ];

  function webSearchTool(model) {
    // Opus 5·Sonnet 5 는 dynamic filtering 변형, Haiku 4.5 는 기본 변형
    const type = model.startsWith("claude-haiku") ? "web_search_20250305" : "web_search_20260209";
    return { type, name: "web_search", max_uses: 5 };
  }

  async function runTool(name, input) {
    try {
      if (name === "get_theme") {
        await loadPool();
        const t = (pool.themes || []).find(x => x.id === (input.id || "").trim());
        if (!t) return { error: "테마 없음: " + input.id, available: pool.themes.map(x => x.id) };
        return {
          id: t.id, title: t.title, status: t.status, catalog: t.catalog, kpi: t.kpi,
          supply_verdict: t.supply_verdict, screen: t.screen || null,
          provenance: t.provenance, whitespace: t.whitespace, bolton: t.bolton, sources: t.sources,
          nodes: (t.nodeCounts || []).map(n => `${n.node} (${n.n})`),
          longlist_top: (t.longlist || []).slice(0, 30).map(r => ({
            name: r.name, node: r.node, rev억: r.rev, opm: r.opm, cagr3: r.cagr3, nd억: r.nd,
            listed: r.listed, need: r.need, type: r.type, status: r.status, pick: r.pick || undefined, note: r.note || undefined
          })),
          longlist_total: (t.longlist || []).length,
          community: t.community || null
        };
      }
      if (name === "lookup_company") {
        await loadPool();
        const q = (input.name || "").replace(/\(주\)|주식회사|㈜|\s/g, "").toLowerCase();
        if (!q) return { error: "회사명 필요" };
        const hits = [];
        for (const t of pool.themes || []) {
          for (const r of t.longlist || []) {
            if ((r.name || "").replace(/\(주\)|주식회사|㈜|\s/g, "").toLowerCase().includes(q))
              hits.push({ theme: `${t.id} ${t.title}`, ...r });
          }
        }
        let funding = null;
        try {
          const rows = await loadFunding();
          const f = rows.filter(p => (p.name || "").replace(/\(주\)|주식회사|㈜|\s/g, "").toLowerCase().includes(q))
            .sort((a, b) => (b.rev || 0) - (a.rev || 0)).slice(0, 3);
          funding = f.map(p => ({
            name: p.name, listed: p.listed, industry: p.industry, latest_year: p.latest_year,
            rev억: p.rev, cagr3: p.cagr3, ebitda억: p.ebitda, ebitda_m: p.ebitda_m, op억: p.op,
            net_debt억: p.net_debt, nd_ebitda: p.nd_ebitda, debt_ratio: p.debt_ratio, cash억: p.cash,
            need: p.need, type: p.type, status: p.status, angle: p.angle_primary,
            gap_12m억: p.gap_12m, runway_m: p.runway_m, last_funding: p.last_funding, events_24m: p.events_24m
          }));
        } catch { /* funding-pool 미로드 환경 */ }
        if (!hits.length && (!funding || !funding.length)) return { error: "패널·풀에서 찾지 못함: " + input.name + " — 외감 미공시(소규모)이거나 표기가 다를 수 있음. web_search 로 확인 권장." };
        return { theme_rows: hits.slice(0, 10), funding_pool: funding };
      }
      return { error: "unknown tool " + name };
    } catch (e) { return { error: String(e && e.message || e) }; }
  }

  // ── Claude API 호출 루프 ───────────────────────────────────────────────────
  function apiKey() { return (localStorage.getItem(LS_KEY) || "").trim(); }
  function model() { return localStorage.getItem(LS_MODEL) || "claude-opus-5"; }

  async function callClaude(msgs) {
    const m = model();
    const body = {
      model: m, max_tokens: 8192,
      system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
      tools: [webSearchTool(m), ...TOOLS_CLIENT],
      messages: msgs
    };
    const headers = {
      "content-type": "application/json",
      "x-api-key": apiKey(),
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    };
    if (m.startsWith("claude-opus-5") || m.startsWith("claude-fable")) {
      headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
      body.fallbacks = "default"; // 안전분류기 거절 시 서버측 폴백 라우팅
    }
    const res = await fetch(API, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).error?.message || ""; } catch { }
      const e = new Error(`HTTP ${res.status}${detail ? " — " + detail : ""}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  async function agentTurn(userText, onStatus) {
    messages.push({ role: "user", content: userText });
    let loops = 0;
    while (loops++ < MAX_LOOPS) {
      const resp = await callClaude(messages);
      messages.push({ role: "assistant", content: resp.content });
      if (resp.stop_reason === "refusal") {
        return "요청이 안전 분류기에 의해 거절되었습니다" + (resp.stop_details?.explanation ? ` — ${resp.stop_details.explanation}` : ".") + " 질문을 바꿔 다시 시도해 주세요.";
      }
      if (resp.stop_reason === "pause_turn") { onStatus("웹리서치 계속 진행 중…"); continue; } // 이어서 재요청 — 서버가 자동 재개
      if (resp.stop_reason === "tool_use") {
        const toolUses = resp.content.filter(b => b.type === "tool_use");
        const results = [];
        for (const tu of toolUses) {
          onStatus(`데이터 조회: ${tu.name}(${esc(JSON.stringify(tu.input)).slice(0, 80)})`);
          const out = await runTool(tu.name, tu.input || {});
          results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out), is_error: !!out.error });
        }
        if (results.length) { messages.push({ role: "user", content: results }); continue; }
        continue;
      }
      // end_turn / max_tokens
      const text = resp.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      return text || "(빈 응답)";
    }
    return "툴 호출이 너무 깊어져 중단했습니다 — 질문을 좁혀 다시 시도해 주세요.";
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  function mdLite(s) {
    let h = esc(s);
    h = h.replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c}</pre>`);
    h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    h = h.replace(/^### (.+)$/gm, "<b>$1</b>");
    h = h.replace(/^## (.+)$/gm, "<b>$1</b>");
    h = h.replace(/^- (.+)$/gm, "<span class='dc-li'>• $1</span>");
    h = h.replace(/(https?:\/\/[^\s<)]+)/g, `<a href="$1" target="_blank" rel="noopener">$1</a>`);
    return h.replace(/\n/g, "<br>");
  }

  function addMsg(role, html) {
    const box = $("#dcMsgs");
    const div = document.createElement("div");
    div.className = "dc-msg dc-" + role;
    div.innerHTML = html;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  function keyPanelHTML() {
    const k = apiKey();
    return `<div class="dc-setup">
      <p><b>Anthropic API 키</b>가 브라우저(localStorage)에만 저장됩니다 — 커밋·전송되지 않습니다 (Claude API 호출에만 사용).</p>
      <input id="dcKey" type="password" placeholder="sk-ant-..." value="${esc(k)}" autocomplete="off">
      <div class="dc-setup-row">
        <select id="dcModel">${MODELS.map(m => `<option value="${m}"${m === model() ? " selected" : ""}>${m}</option>`).join("")}</select>
        <button id="dcSave">저장</button>
      </div>
      <p class="dc-dim">키가 없다면? 각 테마 하단 댓글로 질문을 남기면 검토 큐로 수집됩니다. 키 발급: console.anthropic.com</p>
    </div>`;
  }

  function ensurePanel() {
    if ($("#dcPanel")) return;
    const fab = document.createElement("button");
    fab.id = "dcFab"; fab.title = "리서치 챗 — 페이지 데이터 기반 질의 + 웹리서치";
    fab.innerHTML = "💬";
    document.body.appendChild(fab);

    const panel = document.createElement("div");
    panel.id = "dcPanel"; panel.hidden = true;
    panel.innerHTML = `
      <div class="dc-head">
        <b>📡 리서치 챗</b>
        <span class="dc-dim" id="dcModelLbl"></span>
        <span class="dc-head-btns">
          <button id="dcGear" title="API 키·모델 설정">⚙</button>
          <button id="dcClear" title="대화 초기화">🗑</button>
          <button id="dcClose" title="닫기">✕</button>
        </span>
      </div>
      <div id="dcMsgs"></div>
      <div id="dcSetupWrap"></div>
      <form id="dcForm">
        <textarea id="dcInput" rows="2" placeholder="예: 뿌리산업 테제의 반박 논리는? / 성림첨단산업 재무 보여줘 / 간병 급여화 최신 진행상황 웹에서 확인해줘"></textarea>
        <button id="dcSend" type="submit">전송</button>
      </form>`;
    document.body.appendChild(panel);

    const refreshLbl = () => { $("#dcModelLbl").textContent = model() + (apiKey() ? "" : " · 키 미설정"); };
    refreshLbl();

    fab.addEventListener("click", () => { panel.hidden = !panel.hidden; if (!panel.hidden && !apiKey()) showSetup(); });
    $("#dcClose").addEventListener("click", () => panel.hidden = true);
    $("#dcGear").addEventListener("click", showSetup);
    $("#dcClear").addEventListener("click", () => { messages = []; $("#dcMsgs").innerHTML = ""; addMsg("sys", "대화를 초기화했습니다."); });

    function showSetup() {
      const w = $("#dcSetupWrap");
      w.innerHTML = keyPanelHTML();
      $("#dcSave").addEventListener("click", (e) => {
        e.preventDefault();
        localStorage.setItem(LS_KEY, $("#dcKey").value.trim());
        localStorage.setItem(LS_MODEL, $("#dcModel").value);
        w.innerHTML = ""; refreshLbl();
        addMsg("sys", "설정 저장됨 — " + esc(model()));
      });
    }

    $("#dcForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      const input = $("#dcInput");
      const q = input.value.trim();
      if (!q) return;
      if (!apiKey()) { showSetup(); return; }
      input.value = "";
      busy = true; $("#dcSend").disabled = true;
      addMsg("user", esc(q));
      const status = addMsg("sys", "생각 중…");
      try {
        await loadPool();
        const ans = await agentTurn(q, s => { status.innerHTML = esc(s); });
        status.remove();
        addMsg("bot", mdLite(ans));
      } catch (err) {
        status.remove();
        const msg = err.status === 401 ? "API 키가 유효하지 않습니다 — ⚙에서 다시 입력해 주세요."
          : err.status === 429 ? "요청 한도 초과 — 잠시 후 재시도해 주세요."
          : "오류: " + esc(err.message || String(err));
        addMsg("sys", msg);
        // 실패한 user 턴 제거 (히스토리 오염 방지)
        while (messages.length && messages[messages.length - 1].role !== "user") messages.pop();
        messages.pop();
      } finally {
        busy = false; $("#dcSend").disabled = false;
      }
    });
    $("#dcInput").addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#dcForm").requestSubmit(); }
    });
  }

  document.addEventListener("DOMContentLoaded", ensurePanel);
  if (document.readyState !== "loading") ensurePanel();
})();
