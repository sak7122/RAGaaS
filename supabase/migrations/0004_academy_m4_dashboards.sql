-- RAGaaS Academy M4: dashboards, due dates, sign-off and certificates.
-- Additive only. Same access model as 0001: RLS on, no policies, service_role only.

alter table public.learners add column if not exists name text;

-- An assignment row is created the first time a learner opens Academy and a
-- path applies to them; due_at = assigned_at + the path's due window.
alter table public.assignments add column if not exists assigned_at  timestamptz;
alter table public.assignments add column if not exists certified_at timestamptz;
alter table public.assignments add column if not exists certified_by text;
create index if not exists assignments_due_idx on public.assignments (tenant_id, due_at)
  where status in ('assigned', 'in_progress');

-- Questions the knowledge base couldn't answer (admin "knowledge gaps" report).
-- learner_uid is not a foreign key: admins and not-yet-profiled users ask too.
create table if not exists public.kb_gaps (
  id           bigint generated always as identity primary key,
  tenant_id    text not null references public.tenants(id) on delete cascade,
  learner_uid  text not null,
  question     text not null check (char_length(question) <= 500),
  created_at   timestamptz not null default now()
);
create index if not exists kb_gaps_tenant_idx on public.kb_gaps (tenant_id, created_at desc);
alter table public.kb_gaps enable row level security;
