// comments.js — 테마별 giscus 댓글 (GitHub Discussions 기반 집단지성 레이어)
//   각 네러티브 테마 시트 하단에 giscus 를 마운트한다. 매핑: specific term = "narrative:<theme-id>"
//   → 테마당 Discussion 스레드 1개. 외부인은 GitHub 계정으로 질문·반박·리드 제보를 남기고,
//   narrative/comments-harvest.mjs 가 이를 data/community.json 으로 수집 →
//   빌드가 테마에 병합 → /deal-angle 세션이 검토 후 테제 로직(KPI·스크린·롱리스트)에 반영.
//   설정: data/site-config.json .giscus (categoryId 비면 셋업 가이드 표시)
(function () {
  let cfg = null,cfgLoaded = false;

  async function loadCfg() {
    if (cfgLoaded) return cfg;
    cfgLoaded = true;
    try {
      const res = await fetch("./data/site-config.json", { cache: "no-store" });
      if (res.ok) cfg = (await res.json()).giscus || null;
    } catch (_unused) {/* 설정 없음 — 가이드 표시 */}
    return cfg;
  }

  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function setupCard() {
    return `<div class="nv-giscus-setup">
      <b>💬 테마 댓글 (셋업 필요)</b>
      <p>이 자리에 테마별 GitHub Discussions 댓글이 붙습니다 — 외부 참여자의 질문·반박·리드 제보가 테제 검토 큐로 들어갑니다. 1회 셋업:</p>
      <ol>
        <li>GitHub repo <b>Settings → Features → Discussions</b> 활성화</li>
        <li><a href="https://github.com/apps/giscus" target="_blank" rel="noopener">giscus 앱</a>을 이 repo 에 설치</li>
        <li>Discussions 에 <b>Deal Angle</b> 카테고리 생성 (Announcements 타입 권장)</li>
        <li><a href="https://giscus.app" target="_blank" rel="noopener">giscus.app</a> 에서 repo 입력 후 <code>data-category-id</code> 값을 <code>data/site-config.json</code> 의 <code>giscus.categoryId</code> 에 붙여넣고 커밋</li>
      </ol>
    </div>`;
  }

  // narrative.js 가 테마 시트 렌더 후 호출. 테마 전환 시마다 giscus iframe 을 새 term 으로 재마운트.
  window.mountGiscus = async function (mountEl, themeId, themeTitle) {
    if (!mountEl) return;
    const c = await loadCfg();
    if (!c || !c.repoId || !c.categoryId) {mountEl.innerHTML = setupCard();return;}
    mountEl.innerHTML = `<div class="nv-giscus-head"><b>💬 이 테마에 의견 남기기</b> <span class="nv-dim">— 반박·보강·신규 리드·질문 모두 환영. 검토 후 테제 로직에 반영됩니다. (${esc(themeTitle)})</span></div><div class="giscus"></div>`;
    const s = document.createElement("script");
    s.src = "https://giscus.app/client.js";
    s.async = true;
    s.crossOrigin = "anonymous";
    s.setAttribute("data-repo", c.repo);
    s.setAttribute("data-repo-id", c.repoId);
    s.setAttribute("data-category", c.category || "Deal Angle");
    s.setAttribute("data-category-id", c.categoryId);
    s.setAttribute("data-mapping", "specific");
    s.setAttribute("data-term", "narrative:" + themeId);
    s.setAttribute("data-strict", "0");
    s.setAttribute("data-reactions-enabled", "1");
    s.setAttribute("data-emit-metadata", "0");
    s.setAttribute("data-input-position", "top");
    s.setAttribute("data-theme", "light");
    s.setAttribute("data-lang", "ko");
    mountEl.querySelector(".giscus").appendChild(s);
  };
})();
