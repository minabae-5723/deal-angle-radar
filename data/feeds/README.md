# data/feeds — 매일 새벽 자동 수집물

`.github/workflows/daily-feeds.yml` 이 매일 05:00 KST 에 채워 넣는다. **수집만 하고 판단은 하지 않는다.**

| 파일 | 내용 | 수집 방법 |
|---|---|---|
| `telegram-YYYY-MM-DD.json` | 지정 채널의 최근 글 | 공개 채널은 웹 미리보기(`t.me/s/`), 비공개 채널은 Bot API |
| `press-YYYY-MM-DD.json` | 전문지 RSS 헤드라인 | `feeds/rss.json` 목록 |

최근 14일치만 보관한다(그 이상은 워크플로가 지운다).

## 설정 파일

- `feeds/channels.json` — 텔레그램 채널 목록. `handle`(@ 제외), `priority`, `mode`(preview/bot), `enabled`
- `feeds/rss.json` — 전문지 RSS 목록

## 이 파일을 읽는 쪽

Claude 예약 작업이 매일 이 폴더를 읽어 ① 새 Thesis 후보 심사 ② 기존 Thesis 반증 신호 점검 ③ 워치리스트 조사를 한다.
텔레그램은 **Tier 3~4**(속보 단서)로 취급하며, 승격 근거로 쓰려면 Tier 1·2 로 교차 확인해야 한다.
