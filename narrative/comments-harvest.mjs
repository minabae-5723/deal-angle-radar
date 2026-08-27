// comments-harvest.mjs — giscus Discussions → data/community.json 수집
//   집단지성 루프의 수집 단계: 페이지의 테마별 giscus 스레드(제목 "narrative:<theme-id>")에
//   달린 댓글을 GitHub GraphQL 로 긁어 테마별로 묶는다.
//   빌드(build-narrative.mjs)가 community.json 을 테마에 병합해 대시보드에 노출하고,
//   /deal-angle 세션은 이 파일을 읽고 댓글을 검토해 테제 로직(KPI·스크린·롱리스트·신규 테마)에 반영한다.
//
//   실행: GH_TOKEN=<repo read 권한 PAT> node narrative/comments-harvest.mjs
//   (Discussions 미활성/스레드 없음이면 빈 파일 생성 — 안전)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data");
const OWNER = "minabae-5723", REPO = "deal-angle-radar";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error("GH_TOKEN 필요 (repo read 권한 PAT)"); process.exit(1); }

const QUERY = `
query($owner:String!, $repo:String!, $cursor:String) {
  repository(owner:$owner, name:$repo) {
    discussions(first:50, after:$cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        title url
        comments(first:50) {
          totalCount
          nodes {
            author { login } bodyText createdAt url
            replies(first:20) { nodes { author { login } bodyText createdAt url } }
          }
        }
      }
    }
  }
}`;

async function gql(vars) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: vars })
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

const byTheme = {};
let cursor = null, pages = 0;
try {
  do {
    const d = await gql({ owner: OWNER, repo: REPO, cursor });
    const disc = d.repository?.discussions;
    if (!disc) break;
    for (const n of disc.nodes) {
      const m = /^narrative:(.+)$/.exec(n.title || "");
      if (!m) continue;
      const id = m[1].trim();
      const items = [];
      for (const c of n.comments.nodes) {
        items.push({ author: c.author?.login || "?", body: c.bodyText.slice(0, 1000), date: c.createdAt, url: c.url });
        for (const r of (c.replies?.nodes || []))
          items.push({ author: r.author?.login || "?", body: r.bodyText.slice(0, 1000), date: r.createdAt, url: r.url });
      }
      items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      byTheme[id] = { count: items.length, url: n.url, recent: items.slice(0, 10), all: items };
    }
    cursor = disc.pageInfo.hasNextPage ? disc.pageInfo.endCursor : null;
    pages++;
  } while (cursor && pages < 20);
} catch (e) {
  console.error("Discussions 조회 실패 (미활성이면 정상):", e.message);
}

const out = { meta: { synced: new Date().toISOString().slice(0, 10), repo: `${OWNER}/${REPO}`, themes: Object.keys(byTheme).length }, byTheme };
fs.writeFileSync(path.join(DATA, "community.json"), JSON.stringify(out, null, 2), "utf8");
console.log(`community.json written — ${Object.keys(byTheme).length}개 테마, 총 ${Object.values(byTheme).reduce((s, t) => s + t.count, 0)}건`);
console.log("다음: node narrative/build-narrative.mjs 재실행 → 대시보드 반영. /deal-angle 세션이 댓글 검토 후 테제 로직에 반영.");
