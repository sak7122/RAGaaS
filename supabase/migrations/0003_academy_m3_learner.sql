-- RAGaaS Academy M3 (learner app): progress, grading, spaced review.
-- Additive only. Same access model as 0001: RLS on, no policies, service_role only.

alter table public.assignments add column if not exists score        numeric(4,3);
alter table public.assignments add column if not exists started_at   timestamptz;
alter table public.assignments add column if not exists completed_at timestamptz;

-- Attempts are grouped by module submission for progress and dashboards.
alter table public.attempts add column if not exists module_id uuid
  references public.modules(id) on delete cascade;
create index if not exists attempts_module_idx on public.attempts (learner_uid, module_id);

-- One row per learner per module: best/last score and pass state.
create table if not exists public.module_progress (
  tenant_id     text not null references public.tenants(id) on delete cascade,
  learner_uid   text not null references public.learners(uid) on delete cascade on update cascade,
  module_id     uuid not null references public.modules(id) on delete cascade,
  path_id       uuid not null references public.paths(id) on delete cascade,
  best_score    numeric(4,3) not null default 0,
  last_score    numeric(4,3) not null default 0,
  passed        boolean not null default false,
  attempts      int not null default 0,
  completed_at  timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (learner_uid, module_id)
);
create index if not exists module_progress_tenant_idx on public.module_progress (tenant_id);
create index if not exists module_progress_path_idx on public.module_progress (learner_uid, path_id);
alter table public.module_progress enable row level security;

-- A CSV-imported learner (uid `email:<addr>`) is re-keyed to the Firebase uid on
-- first sign-in; dependent rows must follow the key.
alter table public.assignments drop constraint if exists assignments_learner_uid_fkey,
  add constraint assignments_learner_uid_fkey foreign key (learner_uid)
  references public.learners(uid) on delete cascade on update cascade;
alter table public.attempts drop constraint if exists attempts_learner_uid_fkey,
  add constraint attempts_learner_uid_fkey foreign key (learner_uid)
  references public.learners(uid) on delete cascade on update cascade;
alter table public.review_queue drop constraint if exists review_queue_learner_uid_fkey,
  add constraint review_queue_learner_uid_fkey foreign key (learner_uid)
  references public.learners(uid) on delete cascade on update cascade;
