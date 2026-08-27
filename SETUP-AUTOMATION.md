# 자동화 설정 — 수집(GitHub Actions) + 심사(Claude 예약)

수집은 러너가, 판단은 Claude가 한다. 러너는 판단을 못 하고, Claude로 수집을 하면 토큰만 태운다.

```
05:00 KST  GitHub Actions   텔레그램·전문지 RSS 수집 → data/feeds/*.json 커밋
07:00 KST  Claude 예약 작업  그 파일을 읽어 Thesis 심사·반증 점검·워치리스트 조사 → 커밋 + 보고
```

---

## 1. 텔레그램 채널 등록

### 공개 채널 — 토큰도, 봇 초대도 필요 없다

`feeds/channels.json` 에 핸들만 추가하면 끝이다. 웹 미리보기(`https://t.me/s/<handle>`)를 러너가 읽는다.

```json
{ "handle": "channel_name", "note": "이 채널이 잡는 것", "priority": "A", "mode": "preview", "enabled": true }
```

- `handle` — `@` 없이. `https://t.me/abc_news` 면 `abc_news`
- `priority` — A(매일 확인) / B(격일) / C(주간)
- 채널이 공개인지 확인하는 법: 로그아웃 상태 브라우저에서 `https://t.me/s/<handle>` 이 열리면 공개다

### 비공개 채널 — ROCKY를 관리자로 넣어야 한다

텔레그램은 **봇을 채널에 일반 멤버로 넣을 수 없다.** 채널에 추가하면 자동으로 관리자가 된다.
그래서 "그냥 들어가 있는" 상태로는 봇이 글을 못 읽는다. 관리자 권한이 없으면 방법은 하나 —
그 채널 글을 **ROCKY와의 1:1 대화방으로 전달(forward)** 하면 봇이 받는다.

`mode: "bot"` 으로 두고 아래 토큰을 등록한다.

---

## 2. ROCKY 봇 토큰을 GitHub Secret 에 넣기

토큰은 **코드나 파일에 절대 넣지 않는다.** GitHub Secret 에만 저장한다.

1. **토큰 확인** — 텔레그램에서 `@BotFather` 대화방 → `/mybots` → ROCKY 선택 → `API Token`.
   (잊었으면 `/token`, 유출됐으면 `/revoke` 로 새로 발급)
2. **등록** — GitHub 저장소 `minabae-5723/deal-angle-radar` 로 이동 →
   **Settings** → 왼쪽 **Secrets and variables** → **Actions** → **New repository secret**
   - Name: `TELEGRAM_BOT_TOKEN`
   - Secret: 봇 토큰 (`123456789:AAF...` 형식)
   - **Add secret**
3. 끝. 워크플로가 `${{ secrets.TELEGRAM_BOT_TOKEN }}` 으로 읽는다. 로그에도 값은 마스킹된다.

> 공개 채널만 쓸 거면 이 단계는 건너뛰어도 된다. 토큰이 없으면 봇 수집만 조용히 건너뛴다.

---

## 3. 전문지 RSS 등록

`feeds/rss.json` 에 추가한다. URL 이 틀리면 그 매체만 실패하고 나머지는 정상 수집되며,
실패한 매체는 결과 파일의 `errors` 와 Actions 로그에 남는다.

```json
{ "name": "매체명", "url": "https://.../rss/allArticle.xml", "sector": "섹터", "tier": 2 }
```

---

## 4. 동작 확인

- GitHub 저장소 → **Actions** 탭 → `daily-feeds` → **Run workflow** 로 즉시 실행
- 성공하면 `data/feeds/telegram-YYYY-MM-DD.json`, `press-YYYY-MM-DD.json` 이 gh-pages 에 커밋된다
- 실행 요약(Summary)에 파일별 크기가 찍힌다

---

## 5. 로컬 풀빌드 — 매출 100억대 기업까지 올리기

배포 환경에는 외감 41,409 패널(`data/funding-panel.json`)이 없다. 이 파일이 있는 로컬에서
아래 한 줄만 실행하면 새 규모 게이트(**매출 100억 이상 OR 3년 성장률 20% 이상**)가 실제로 적용된다.

```
node narrative/build-narrative.mjs
```

- funding 파이프라인(`funding\build.ps1`)을 다시 돌릴 필요는 **없다.**
  롱리스트의 모수는 패널이고, funding-pool 은 자금소요 진단(need·status)만 얹는다.
- 다만 100억~300억 구간 기업은 pool 밖이라 **자금니즈 진단이 비어 있다.** 재무·성장률은 패널에서 나온다.
- 빌드가 어느 모드로 돌았는지 콘솔 첫 줄에 찍는다. 패치 모드면 게이트가 무효라고 경고한다.
