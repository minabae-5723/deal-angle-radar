// telegram.mjs — 텔레그램 채널 수집 (GitHub Actions 러너에서 실행).
//
//   두 가지 경로를 지원한다.
//     preview : 공개 채널의 웹 미리보기(https://t.me/s/<handle>) 파싱. 토큰·권한 불필요.
//     bot     : Bot API getUpdates. 비공개 채널용이며 봇이 그 채널의 관리자여야 한다.
//               (텔레그램은 봇을 채널에 '일반 멤버'로 넣을 수 없다 — 추가하면 관리자가 된다)
//
//   왜 러너에서 도는가: Claude 세션 컨테이너는 t.me·api.telegram.org 로의 egress 가 막혀 있다.
//   GitHub Actions 러너는 막혀 있지 않으므로 수집은 여기서 하고, 판단은 Claude 가 파일을 읽어서 한다.
//
//   출력: data/feeds/telegram-YYYY-MM-DD.json
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "feeds/channels.json"), "utf8"));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const today = new Date().toISOString().slice(0, 10);
const out = { generated: new Date().toISOString(), source: "telegram", posts: [], errors: [] };

const deHtml = (s) => s
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .trim();

// 공개 채널 미리보기 파싱 — 텔레그램이 서버사이드로 렌더한 HTML 에서 본문·시간·링크를 뽑는다.
async function fetchPreview(ch) {
  const url = `https://t.me/s/${ch.handle}`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; deal-angle-radar/1.0)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const posts = [];
  // 각 메시지 블록: data-post="handle/123" ... <div class="tgme_widget_message_text ...">본문</div> ... <time datetime="...">
  const blocks = html.split('class="tgme_widget_message ').slice(1);
  for (const b of blocks) {
    const idm = b.match(/data-post="([^"]+)"/);
    const txm = b.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const dtm = b.match(/<time[^>]*datetime="([^"]+)"/);
    if (!idm || !txm) continue;
    const text = deHtml(txm[1]);
    if (!text) continue;
    posts.push({
      channel: "@" + ch.handle, priority: ch.priority || "C",
      date: dtm ? dtm[1] : null, text,
      url: `https://t.me/${idm[1]}`
    });
  }
  return posts;
}

// Bot API — 봇이 관리자인 채널의 새 글만 들어온다. offset 은 상태파일로 관리한다.
async function fetchBot() {
  if (!TOKEN) return [];
  const statePath = path.join(ROOT, "data/feeds/.telegram-offset.json");
  let offset = 0;
  try { offset = JSON.parse(fs.readFileSync(statePath, "utf8")).offset || 0; } catch { }
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=0&limit=100${offset ? "&offset=" + offset : ""}`);
  const j = await res.json();
  if (!j.ok) throw new Error(j.description || "getUpdates 실패");
  const posts = [];
  let last = offset;
  for (const u of j.result || []) {
    last = Math.max(last, u.update_id + 1);
    const m = u.channel_post || u.message;
    if (!m || !(m.text || m.caption)) continue;
    const chat = m.chat || {};
    posts.push({
      channel: chat.username ? "@" + chat.username : (chat.title || String(chat.id)),
      priority: "A", date: new Date(m.date * 1000).toISOString(),
      text: m.text || m.caption,
      url: chat.username ? `https://t.me/${chat.username}/${m.message_id}` : null
    });
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ offset: last }), "utf8");
  return posts;
}

const enabled = (cfg.channels || []).filter(c => c.enabled !== false);
for (const ch of enabled.filter(c => (c.mode || "preview") === "preview")) {
  try { out.posts.push(...await fetchPreview(ch)); }
  catch (e) { out.errors.push({ channel: ch.handle, error: String(e.message || e) }); }
}
try { out.posts.push(...await fetchBot()); }
catch (e) { out.errors.push({ channel: "bot-api", error: String(e.message || e) }); }

out.posts.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
fs.mkdirSync(path.join(ROOT, "data/feeds"), { recursive: true });
fs.writeFileSync(path.join(ROOT, `data/feeds/telegram-${today}.json`), JSON.stringify(out, null, 1), "utf8");
console.log(`telegram-${today}.json — 채널 ${enabled.length}개, 글 ${out.posts.length}건${out.errors.length ? `, 오류 ${out.errors.length}건` : ""}`);
for (const e of out.errors) console.log(`  ! ${e.channel}: ${e.error}`);
