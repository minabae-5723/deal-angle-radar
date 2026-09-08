# PE Lens (知PE知己) — deal-angle-radar 6번째 탭

> 실적·밸류는 후행지표. 의사결정자(최대주주)의 유인구조와 현금흐름 경로가 선행지표. (키움증권 "지PE지기 백전불태", 2026-08-19)

PE 심사역 관점으로 기업을 읽는 스크리너 + 딜 관리 agent. 외감 41,409사 재무 패널에 DART 정기보고서(최대주주·임원·배당·자사주·증감자)와 시세를 붙여 **오너 렌즈 → Entry → Value-up → Exit** 4렌즈 스코어와 근거 카드를 만들고, 국내 PE 케이스 라이브러리에서 뽑은 규칙으로 스코어를 교정한다. 운영 프로토콜은 `~/.claude/skills/pe-lens/SKILL.md` (`/pe-lens`).

## 파이프라인
```
funding-panel(41k) ─┐
funding-pool / fs2025 ─┤
narrative-pool ─────────┤
pe-owner.json ◄─ fetch-owner.js (DART hyslrSttus·exctvSttus·hyslrChgSttus·alotMatter·tesstkAcqsDspsSttus·irdsSttus)
pe-market.json ◄─ fetch-market.js (네이버 m.stock integration: 시총·PBR·PER·52주)
pe-registry.json (PE 보유·개입 기업 큐레이션 47+)
pe-cases.json (케이스 71+) ── 규칙 evidence
pe-rules.json (R1~R17, predicate DSL) ── 스코어 가감·플래그
pe-policy.json (정책 15+, affects ±1·weight) ── 정책 컨텍스트
pe-playbook.json (Entry 11·Value-up 11·Exit 10, exit 압력 모델, IRR 기본값)
        │
        ▼  build-pe-lens.js  (lib.js 순수함수)
data/pe-lens-pool.json { meta, stats(by_owner·rules_eval·case_types…), industries, rows[5.5k] }
        │
        ▼  pe-lens.js / pe-lens.css  (#pelens, LOCAL_ONLY)
🔭 레이더 · ⏱ PE 보유기업 시계 · 📚 케이스·규칙 · 🏛 정책 레이더 · 📖 플레이북 · 🗂 파이프라인
```

## 실행
```
node pe-lens/fetch-owner.js --year 2025 --interval 550   # 상장 2.5k × 6 API, 증분·캐시. 약 2.5h 첫 실행
node pe-lens/fetch-market.js --interval 220              # 4k 종목 ~15분
node pe-lens/build-pe-lens.js                            # 2~3초
powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 8896   # http://localhost:8896/#pelens
bash deploy.sh "pe-lens: …"                              # gh-pages (탭은 배포본에서 제거, 데이터 파일만 동기화)
```

## 오너 유형 (lib.classifyOwner)
| 유형 | 판별 | 압력 지표 |
|---|---|---|
| PE_CONTROL / PE_MINORITY / PE_PENDING | 레지스트리 우선, 없으면 최대주주명 투자기구 패턴(유한회사·L.P.·Holdings LLC·제N호·파트너스·에쿼티…) → `pe_candidate` | exit 압력(보유연차·펀드잔존·회수율·인수금융 만기), 밸류업 유인(1−회수율), 단계별 예상 행동 |
| FOUNDER / FAMILY_2G | 개인명 최대주주 + exctvSttus 관계 "본인" 생년 → 연령, 가족 임원 <55세 → 차세대 | 승계 압력 |
| GROUP_SUB | 최대주주가 상장 모회사 | 카브아웃 확률(비핵심·소형·모회사 레버리지) |
| HOLDCO_PRIVATE / FOREIGN_SUB / GOVT / DISPERSED(<15%) | 법인명·외국법인·공공·분산 | 행동주의 취약성(분산·저PBR·순현금) |

## 규칙 DSL
`when: {and:[["owner.type","eq","PE_CONTROL"],["fin.payout_ratio","gt",1.5]]}` → `effect: {flag, target:"lens.exit.recap_only", delta:+15}`. `status: active|proposed|retired`, `evidence.supports/contradicts` = 케이스 id. 빌드가 `stats.rules_eval`(지지·반증·강도·히트)을 낸다. 승격·강등은 제안만, 확정은 사람.

## 파일 규칙
- 버전관리: `data/pe-registry.json` `pe-cases.json` `pe-rules.json` `pe-policy.json` `pe-playbook.json` `pe-theses.json` `pe-lens-pool.json`
- gitignore: `data/pe-owner.json` `data/pe-market.json` `pe-lens/*.log` `pe-lens/cases-research-raw.json`
- 프론트 변경 시 `index.html` 의 `pe-lens.js?v=` `pe-lens.css?v=` 증가

## 한계·다음
- 비상장(사업보고서 미제출)은 DART 최대주주 API 가 없어 오너 UNKNOWN → 스킬 verify/thesis 에서 감사보고서·뉴스로 보강.
- fs2025 API 값이 비정합(영업이익>매출 등)하면 패널 값을 유지(sanity 체크).
- S&LB·감액배당 재원(주식발행초과금)은 패널에 없음 → DART BS 주석 추출은 후속 과제.
- 스코어 가중은 판단 prior. `pe-theses.json` 의 예측을 사후 채점(F 모드)해 규칙 hit_rate 로 교정한다.
