#!/usr/bin/env bash
# deploy.sh — 배포본(gh-pages) 안전 배포
#
#   왜 스크립트가 필요한가: 배포 브랜치 gh-pages 는 코드 배포처이면서 동시에
#   런타임 쓰기 대상이다 — 웹 UI 에서 테마 보드 카드를 옮기면 GitHub 토큰
#   보유자의 브라우저가 data/board-state.json 을 gh-pages 에 직접 커밋한다.
#   따라서 작업 브랜치를 그냥 밀면 그 사이 쌓인 보드 이동이 사라진다.
#   → 배포 전에 gh-pages 의 board-state.json 을 먼저 회수해 병합한다.
#
#   사용: bash deploy.sh ["커밋 메시지"]
#   (커밋 메시지를 주면 스테이지된 변경을 먼저 커밋한다)
set -euo pipefail
cd "$(dirname "$0")"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "작업 브랜치: $BRANCH"

if [ "${1-}" != "" ]; then
  git add -A
  # 이미 커밋된 상태에서 메시지를 넘겨도 배포가 중단되지 않게 (set -e 회피)
  git diff --cached --quiet || git commit -m "$1"
fi

echo "gh-pages 최신 상태 확인…"
git fetch origin gh-pages

# 배포본에 우리보다 새로운 보드 상태가 있으면 회수 (웹 UI 발 카드 이동)
if git cat-file -e origin/gh-pages:data/board-state.json 2>/dev/null; then
  git show origin/gh-pages:data/board-state.json > /tmp/board-remote.json
  if ! cmp -s /tmp/board-remote.json data/board-state.json; then
    REMOTE_DATE="$(python3 -c "import json;print(json.load(open('/tmp/board-remote.json')).get('updated',''))" 2>/dev/null || echo "")"
    LOCAL_DATE="$(python3 -c "import json;print(json.load(open('data/board-state.json')).get('updated',''))" 2>/dev/null || echo "")"
    if [ "$REMOTE_DATE" \> "$LOCAL_DATE" ] || [ "$LOCAL_DATE" = "" ]; then
      echo "배포본 보드 상태가 더 최신 ($REMOTE_DATE > ${LOCAL_DATE:-없음}) — 회수해 병합"
      cp /tmp/board-remote.json data/board-state.json
      git add data/board-state.json
      git commit -m "보드: 배포본의 카드 이동 내역 회수 (웹 UI 커밋 승계)"
    else
      echo "로컬 보드 상태가 최신 이상 — 그대로 배포"
    fi
  fi
fi

echo "작업 브랜치 푸시…"
git push -u origin "$BRANCH"

echo "gh-pages 배포…"
git push origin HEAD:gh-pages

echo
echo "✅ 배포 완료 — 1~2분 후 반영: https://minabae-5723.github.io/deal-angle-radar/"
echo "   검증 시 주의: 배포본은 #view-review 를 DOM 에서 제거하므로 localhost 로는"
echo "   재현되지 않는 버그가 있다. Playwright 검증은 반드시 비-localhost 호스트명으로:"
echo "   --host-resolver-rules='MAP fake.example.com 127.0.0.1'"
