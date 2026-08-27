// press-rss.mjs — 전문지 RSS 수집 (GitHub Actions 러너에서 실행).
//   전문지 맵(data/press-screen.json)의 소스 중 RSS 를 제공하는 매체를 feeds/rss.json 에 모아 두고 훑는다.
//   판단은 하지 않는다. 제목·링크·날짜만 모아 두고 심사는 Claude 예약 작업이 한다.
//   출력: data/feeds/press-YYYY-MM-DD.json
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "feeds/rss.json"), "utf8"));
const today = new Date().toISOString().slice(0, 10);
const out = { generated: new Date().toISOString(), source: "press-rss", items: [], errors: [] };

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim() || null;
};

for (const f of cfg.feeds || []) {
  try {
    const res = await fetch(f.url, { headers: { "user-agent": "Mozilla/5.0 (compatible; deal-angle-radar/1.0)" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = xml.split(/<item[\s>]/i).slice(1).concat(xml.split(/<entry[\s>]/i).slice(1));
    let n = 0;
    for (const it of items.slice(0, 40)) {
      const title = tag(it, "title");
      if (!title) continue;
      const link = tag(it, "link") || (it.match(/href="([^"]+)"/) || [])[1] || null;
      out.items.push({
        media: f.name, sector: f.sector, tier: f.tier || 2,
        title, link, date: tag(it, "pubDate") || tag(it, "updated") || tag(it, "published") || null
      });
      n++;
    }
    console.log(`  ${f.name}: ${n}건`);
  } catch (e) {
    out.errors.push({ media: f.name, error: String(e.message || e) });
    console.log(`  ! ${f.name}: ${e.message || e}`);
  }
}

fs.mkdirSync(path.join(ROOT, "data/feeds"), { recursive: true });
fs.writeFileSync(path.join(ROOT, `data/feeds/press-${today}.json`), JSON.stringify(out, null, 1), "utf8");
console.log(`press-${today}.json — ${out.items.length}건${out.errors.length ? `, 실패 ${out.errors.length}개 매체` : ""}`);
