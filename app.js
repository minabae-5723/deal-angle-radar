// Deal Angle Radar — standalone dashboard
// data/index.json { dates: ["YYYY-MM-DD", ...] } 최신 앞 · data/YYYY-MM-DD.md 를 범용 렌더러로 표시.
// /deal-angle 세션(Claude)이 md·index.json을 생성한다. 고정 스키마 파서 없음 — 포맷이 진화해도 안 깨짐.

const INDEX_URL = './data/index.json';
const MAX_DAYS = 14;
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
    state.dates = (data.dates || []).slice().sort().reverse().slice(0, MAX_DAYS);
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

loadIndex();
