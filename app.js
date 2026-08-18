// Deal Angle Radar — standalone dashboard
// data/index.json { dates: ["YYYY-MM-DD", ...] } 최신 앞 · data/YYYY-MM-DD.md 를 범용 렌더러로 표시.
// /deal-angle 세션(Claude)이 md·index.json을 생성한다. 고정 스키마 파서 없음 — 포맷이 진화해도 안 깨짐.

const INDEX_URL = './data/index.json';
const BIZ_DAYS_KEPT = 10;   // 보드 노출: 최근 10영업일 (주말·공휴일 제외). 지난 회차 md는 data\에 남되 보드에서만 숨김.

// 한국 공휴일 (연 1회 갱신 필요 — /deal-angle 스킬 주의사항 참조)
const KR_HOLIDAYS = new Set([
  '2026-01-01',                               // 신정
  '2026-02-16', '2026-02-17', '2026-02-18',   // 설 연휴
  '2026-03-02',                               // 삼일절 대체(3/1 일)
  '2026-05-05',                               // 어린이날
  '2026-05-25',                               // 부처님오신날 대체(5/24 일)
  '2026-06-03',                               // 지방선거
  '2026-08-17',                               // 광복절 대체(8/15 토)
  '2026-09-24', '2026-09-25', '2026-09-26',   // 추석 연휴
  '2026-10-05',                               // 개천절 대체(10/3 토)
  '2026-10-09',                               // 한글날
  '2026-12-25',                               // 성탄절
  '2027-01-01'                                // 신정
]);

function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function isBizDay(d) {
  const wd = d.getDay();
  return wd !== 0 && wd !== 6 && !KR_HOLIDAYS.has(fmtDate(d));
}

// 오늘 포함 최근 n영업일의 가장 오래된 날짜(YYYY-MM-DD) — 이보다 이전 회차는 보드에서 제외
function bizCutoff(n) {
  const d = new Date();
  let counted = 0;
  for (let i = 0; i < 90; i++) {
    if (isBizDay(d)) {
      counted++;
      if (counted >= n) return fmtDate(d);
    }
    d.setDate(d.getDate() - 1);
  }
  return fmtDate(d);
}

let state = { dates: [], current: null, cache: {} };

// ─── clock ────────────────────────────────────────────────
function tickClock() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleString('ko-KR', { hour12: false }) + ' KST';
}
setInterval(tickClock, 1000);
tickClock();

// ─── index + date pills ───────────────────────────────────
async function loadIndex() {
  try {
    const res = await fetch(`${INDEX_URL}?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const cutoff = bizCutoff(BIZ_DAYS_KEPT);
    state.dates = (data.dates || []).filter(d => d >= cutoff).sort().reverse();
    renderPills();
    if (state.dates.length > 0) {
      await loadDate(state.dates[0]);
    } else {
      renderEmpty();
    }
  } catch (err) {
    console.warn('index load failed:', err);
    renderEmpty();
  }
}

function todayKr() {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

function renderPills() {
  const el = document.getElementById('datePills');
  if (!el) return;
  if (state.dates.length === 0) {
    el.innerHTML = '<span class="loading">저장된 스크리닝 없음</span>';
    return;
  }
  const today = todayKr();
  el.innerHTML = state.dates.map(d => {
    const rel = (d === today) ? '<span class="pill-rel">오늘</span>' : '';
    const active = (d === state.current) ? ' active' : '';
    return `<button class="date-pill${active}" data-date="${d}">${d}${rel}</button>`;
  }).join('');
  el.querySelectorAll('.date-pill').forEach(btn => {
    btn.addEventListener('click', () => loadDate(btn.dataset.date));
  });
}

async function loadDate(date) {
  state.current = date;
  renderPills();
  let md = state.cache[date];
  if (!md) {
    try {
      const res = await fetch(`./data/${date}.md?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      md = await res.text();
      state.cache[date] = md;
    } catch (err) {
      document.getElementById('body').innerHTML =
        `<div class="empty"><h3>로딩 실패</h3><p>${err.message}</p></div>`;
      return;
    }
  }
  document.getElementById('body').innerHTML = renderMd(md);
  window.scrollTo({ top: 0 });
}

function renderEmpty() {
  document.getElementById('body').innerHTML = `
    <div class="empty">
      <div class="empty-ico">🎯</div>
      <h3>아직 저장된 스크리닝이 없습니다</h3>
      <p>/deal-angle 세션이 DART 공시를 스크리닝하면 여기에 표시됩니다.</p>
    </div>
  `;
}

// ─── generic markdown renderer ────────────────────────────
// h1/h2/h3, blockquote, ul, table, bold, links, code. H2 단위로 카드를 끊는다.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inline(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderMd(md) {
  const lines = md.split(/\r?\n/);
  let html = '';
  let cardOpen = false;
  let listOpen = false;
  let tableBuf = null;

  const closeList = () => { if (listOpen) { html += '</ul>'; listOpen = false; } };
  const flushTable = () => {
    if (!tableBuf || tableBuf.length === 0) { tableBuf = null; return; }
    const rows = tableBuf.filter(r => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
    const cells = r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => inline(c.trim()));
    let t = '<div class="table-wrap"><table>';
    rows.forEach((r, i) => {
      const tag = i === 0 ? 'th' : 'td';
      t += '<tr>' + cells(r).map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
    });
    t += '</table></div>';
    html += t;
    tableBuf = null;
  };
  const closeCard = () => { closeList(); flushTable(); if (cardOpen) { html += '</section>'; cardOpen = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*\|/.test(line)) {
      closeList();
      if (!tableBuf) tableBuf = [];
      tableBuf.push(line);
      continue;
    }
    flushTable();
    if (line.startsWith('# ')) {
      closeCard();
      html += `<h1 class="doc-title">${inline(line.slice(2))}</h1>`;
    } else if (line.startsWith('>> ')) {
      // 도식 라인: ">> 라벨: A → B → C" — 노드 체인을 칩+화살표로 렌더링. 라벨 앵글/시나리오는 골드 강조.
      closeList();
      let content = line.slice(3);
      let label = '', kind = '';
      const m = content.match(/^(팩트|구조|앵글|시나리오)\s*:\s*(.*)$/);
      if (m) {
        label = m[1];
        content = m[2];
        if (label === '앵글' || label === '시나리오') kind = ' flow-angle';
      }
      const nodes = content.split('→').map(s => s.trim()).filter(Boolean);
      html += `<div class="flow${kind}">`
        + (label ? `<span class="flow-label">${escapeHtml(label)}</span>` : '')
        + nodes.map(n => `<span class="flow-node">${inline(n)}</span>`).join('<span class="flow-arrow">→</span>')
        + '</div>';
    } else if (line.startsWith('## ')) {
      closeCard();
      html += `<section class="card"><h2 class="card-title">${inline(line.slice(3))}</h2>`;
      cardOpen = true;
    } else if (line.startsWith('### ')) {
      closeList();
      html += `<h3 class="h3">${inline(line.slice(4))}</h3>`;
    } else if (line.startsWith('> ')) {
      closeList();
      html += `<div class="meta">${inline(line.slice(2))}</div>`;
    } else if (/^\s*[-*] /.test(line)) {
      if (!listOpen) { html += '<ul class="list">'; listOpen = true; }
      html += `<li>${inline(line.replace(/^\s*[-*] /, ''))}</li>`;
    } else if (line === '---' || line.trim() === '') {
      closeList();
    } else {
      closeList();
      html += `<p class="p">${inline(line)}</p>`;
    }
  }
  closeCard();
  return `<div class="doc">${html}</div>`;
}

// ─── view switching (일별 레이더 ↔ 자금소요 스크리너) ─────────
const VIEW_FOOT = {
  radar: 'Source: DART OpenAPI (주요사항보고 · 지분공시) + 뉴스 크로스체크 · 스크리닝: /deal-angle 세션 · Reverent Partners 내부용',
  funding: 'Source: 국내기업 Screening Masterfile (KISVALUE 재무패널) + DART OpenAPI 공시이력 · 산출: funding\\build.ps1 · Reverent Partners 내부용',
  thesis: 'Source: 섹터별 전문지 모니터링맵 + 웹리서치 (탑다운 신규 발굴) × funding-pool 외감 배선 (바텀업) · theses.json · Reverent Partners 내부용',
};

function switchView(name) {
  document.querySelectorAll('.viewtab').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.getElementById('view-radar').hidden = (name !== 'radar');
  document.getElementById('view-funding').hidden = (name !== 'funding');
  document.getElementById('view-thesis').hidden = (name !== 'thesis');
  const foot = document.getElementById('footNote');
  if (foot) foot.textContent = VIEW_FOOT[name] || VIEW_FOOT.radar;
  if (name === 'funding' && window.initFunding) window.initFunding();
  if (name === 'thesis' && window.initThesis) window.initThesis();
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
  window.scrollTo({ top: 0 });
}

document.getElementById('viewTabs').addEventListener('click', e => {
  const btn = e.target.closest('.viewtab');
  if (btn) switchView(btn.dataset.view);
});

loadIndex();
{
  const h = location.hash.slice(1);
  if (h === 'funding' || h === 'thesis') switchView(h);
}
