-- Deal Angle Radar — Supabase 설정 SQL (전부 여러 번 실행해도 안전)
--   실행 위치: Supabase 대시보드 → 좌측 SQL Editor → New query → 붙여넣기 → Run
--   프로젝트: rolrqsqaqzemdgngzjmv
--
-- 이 파일 하나만 실행하면 아래 세 기능이 모두 켜진다.
--   ① 테마 보드 카드 이동 실시간 공유   (board_state)
--   ② Thesis별 토론 댓글 + 삭제         (comments)
--   ③ 구성원 Thesis 제안 → 승인 대기 보드 (thesis_ideas)
--
-- anon 키는 브라우저에 공개되는 키(원래 클라이언트에 두는 값)이고,
-- 실제 권한은 아래 RLS 정책이 통제한다. 사내 공유용이라 읽기·쓰기를 모두 열어 둔다.

-- ── ① 테마 보드 공유 상태 ────────────────────────────────────────────────
create table if not exists board_state (
  theme_id   text primary key,
  stage      text not null,
  updated_at timestamptz default now()
);
alter table board_state enable row level security;
drop policy if exists "anon read"   on board_state;
drop policy if exists "anon insert" on board_state;
drop policy if exists "anon update" on board_state;
create policy "anon read"   on board_state for select to anon using (true);
create policy "anon insert" on board_state for insert to anon with check (true);
create policy "anon update" on board_state for update to anon using (true) with check (true);

-- ── ② Thesis 토론 댓글 (등록·조회·삭제) ──────────────────────────────────
create table if not exists comments (
  id         bigint generated always as identity primary key,
  theme_id   text not null,
  author     text,
  body       text not null,
  created_at timestamptz default now()
);
-- client_id = 브라우저별 임의 식별자. 지금은 누구나 삭제할 수 있으므로 표시용으로만 쓴다.
alter table comments add column if not exists client_id text;
create index if not exists comments_theme_idx on comments(theme_id, created_at);
alter table comments enable row level security;
drop policy if exists "c anon read"   on comments;
drop policy if exists "c anon insert" on comments;
drop policy if exists "c anon delete" on comments;
create policy "c anon read"   on comments for select to anon using (true);
create policy "c anon insert" on comments for insert to anon with check (true);
create policy "c anon delete" on comments for delete to anon using (true);

-- ── ③ 구성원 Thesis 제안 (승인 대기 보드로 들어감) ───────────────────────
create table if not exists thesis_ideas (
  id         bigint generated always as identity primary key,
  title      text not null,   -- 한 줄 명제
  body       text,            -- 근거·설명
  author     text,
  sector     text,
  draft      text,            -- 제안자 API 키로 만든 Thesis 초안 (선택)
  status     text default 'new',
  created_at timestamptz default now()
);
create index if not exists thesis_ideas_created_idx on thesis_ideas(created_at desc);
alter table thesis_ideas enable row level security;
drop policy if exists "i anon read"   on thesis_ideas;
drop policy if exists "i anon insert" on thesis_ideas;
drop policy if exists "i anon delete" on thesis_ideas;
create policy "i anon read"   on thesis_ideas for select to anon using (true);
create policy "i anon insert" on thesis_ideas for insert to anon with check (true);
-- 잘못 올라간 제안을 정리할 수 있도록 삭제도 열어 둔다(현재 화면에는 버튼 없음 — 필요 시 추가).
create policy "i anon delete" on thesis_ideas for delete to anon using (true);

-- ── 확인 ─────────────────────────────────────────────────────────────────
-- 아래를 함께 실행하면 세 테이블이 다 보이면 성공.
select table_name from information_schema.tables
 where table_schema = 'public' and table_name in ('board_state','comments','thesis_ideas')
 order by table_name;
