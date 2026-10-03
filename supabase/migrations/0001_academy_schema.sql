-- RAGaaS Academy — system of record (see docs/PRD-onboarding.md §7.1).
-- Access model: RLS ON for every table with NO policies → anon/authenticated
-- keys read nothing. Only the backend (service_role, from Secret Manager)
-- touches these tables. Tenant + entitlement filtering happens in SQL.

create extension if not exists vector with schema extensions;

-- sensitivity / clearance: 0 = public, 1 = internal, 2 = restricted
create table public.tenants (
  id          text primary key,
  name        text not null,
  config      jsonb not null default '{}'::jsonb,
  mode        text not null default 'hosted' check (mode in ('hosted', 'byo')),
  created_at  timestamptz not null default now()
);

create table public.kb_documents (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     text not null references public.tenants(id) on delete cascade,
  title         text not null,
  storage_path  text not null,
  version       int  not null default 1,
  sensitivity   smallint not null default 1 check (sensitivity between 0 and 2),
  dept_tags     text[] not null default '{}',
  role_tags     text[] not null default '{}',
  owner_email   text,
  updated_at    timestamptz not null default now(),
  unique (tenant_id, storage_path)
);

-- Fallback/self-hosted retrieval (primary retrieval = Vertex AI Search while
-- the trial credit lasts). Tags are denormalised from the document for filtering.
create table public.kb_chunks (
  id           bigint generated always as identity primary key,
  tenant_id    text not null references public.tenants(id) on delete cascade,
  doc_id       uuid not null references public.kb_documents(id) on delete cascade,
  page         int,
  idx          int not null,
  text         text not null,
  embedding    extensions.vector(768),
  sensitivity  smallint not null default 1,
  dept_tags    text[] not null default '{}',
  role_tags    text[] not null default '{}'
);
create index kb_chunks_tenant_idx on public.kb_chunks (tenant_id, doc_id);
create index kb_chunks_doc_idx on public.kb_chunks (doc_id);
create index kb_chunks_embedding_idx on public.kb_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

create table public.learners (
  uid          text primary key,               -- Firebase UID
  tenant_id    text not null references public.tenants(id) on delete cascade,
  email        text not null,
  role         text,
  department   text,
  seniority    smallint not null default 1,
  location     text,
  start_date   date,
  clearance    smallint not null default 1 check (clearance between 0 and 2),
  created_at   timestamptz not null default now()
);
create index learners_tenant_idx on public.learners (tenant_id);

create table public.paths (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   text not null references public.tenants(id) on delete cascade,
  title       text not null,
  rules       jsonb not null default '{}'::jsonb,  -- assignment rules (dept/role/seniority)
  pass_mark   numeric(4,3) not null default 0.8,
  status      text not null default 'draft' check (status in ('draft', 'published', 'stale')),
  created_at  timestamptz not null default now()
);
create index paths_tenant_idx on public.paths (tenant_id);

create table public.modules (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        text not null references public.tenants(id) on delete cascade,
  path_id          uuid not null references public.paths(id) on delete cascade,
  position         int  not null,
  title            text not null,
  lesson_md        text,
  source_chunk_ids bigint[] not null default '{}',
  status           text not null default 'draft' check (status in ('draft', 'published', 'stale'))
);
create index modules_path_idx on public.modules (path_id, position);
create index modules_tenant_idx on public.modules (tenant_id);

create table public.items (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        text not null references public.tenants(id) on delete cascade,
  module_id        uuid not null references public.modules(id) on delete cascade,
  type             text not null check (type in ('mcq', 'true_false', 'short_answer', 'scenario')),
  stem             text not null,
  options          jsonb,
  answer           jsonb,
  rubric           text,
  source_chunk_ids bigint[] not null default '{}',
  difficulty       smallint not null default 2,
  status           text not null default 'draft' check (status in ('draft', 'published', 'stale'))
);
create index items_module_idx on public.items (module_id);
create index items_tenant_idx on public.items (tenant_id);

create table public.assignments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    text not null references public.tenants(id) on delete cascade,
  learner_uid  text not null references public.learners(uid) on delete cascade,
  path_id      uuid not null references public.paths(id) on delete cascade,
  due_at       timestamptz,
  status       text not null default 'assigned'
               check (status in ('assigned', 'in_progress', 'passed', 'failed', 'certified')),
  unique (learner_uid, path_id)
);
create index assignments_tenant_idx on public.assignments (tenant_id);
create index assignments_path_idx on public.assignments (path_id);

create table public.attempts (
  id              bigint generated always as identity primary key,
  tenant_id       text not null references public.tenants(id) on delete cascade,
  learner_uid     text not null references public.learners(uid) on delete cascade,
  item_id         uuid not null references public.items(id) on delete cascade,
  response        jsonb not null,
  score           numeric(4,3) not null,
  feedback        text,
  graded_by_model text,
  created_at      timestamptz not null default now()
);
create index attempts_learner_idx on public.attempts (learner_uid, created_at desc);
create index attempts_item_idx on public.attempts (item_id);
create index attempts_tenant_idx on public.attempts (tenant_id);

create table public.review_queue (
  id            bigint generated always as identity primary key,
  tenant_id     text not null references public.tenants(id) on delete cascade,
  learner_uid   text not null references public.learners(uid) on delete cascade,
  module_id     uuid not null references public.modules(id) on delete cascade,
  due_at        timestamptz not null,
  interval_days int not null default 1,
  unique (learner_uid, module_id)
);
create index review_due_idx on public.review_queue (learner_uid, due_at);
create index review_module_idx on public.review_queue (module_id);
create index review_tenant_idx on public.review_queue (tenant_id);

create table public.audit_log (
  id          bigint generated always as identity primary key,
  tenant_id   text not null,
  actor       text not null,
  action      text not null,
  chunk_ids   bigint[] not null default '{}',
  model       text,
  created_at  timestamptz not null default now()
);
create index audit_tenant_idx on public.audit_log (tenant_id, created_at desc);

-- RLS on, no policies: deny-all for anon/authenticated; service_role bypasses.
alter table public.tenants      enable row level security;
alter table public.kb_documents enable row level security;
alter table public.kb_chunks    enable row level security;
alter table public.learners     enable row level security;
alter table public.paths        enable row level security;
alter table public.modules      enable row level security;
alter table public.items        enable row level security;
alter table public.assignments  enable row level security;
alter table public.attempts     enable row level security;
alter table public.review_queue enable row level security;
alter table public.audit_log    enable row level security;

-- Entitlement-filtered vector search: tenant + clearance + tag overlap are
-- applied BEFORE ranking so restricted text never reaches the prompt.
-- Empty tag arrays on a chunk mean "everyone in the tenant".
create or replace function public.match_chunks(
  p_tenant      text,
  p_learner_uid text,
  p_query       extensions.vector(768),
  p_k           int default 8
)
returns table (id bigint, doc_id uuid, page int, text text, similarity float)
language sql stable
security invoker
set search_path = ''
as $$
  select c.id, c.doc_id, c.page, c.text,
         1 - (c.embedding operator(extensions.<=>) p_query) as similarity
  from public.kb_chunks c
  join public.learners l
    on l.uid = p_learner_uid and l.tenant_id = p_tenant
  where c.tenant_id = p_tenant
    and c.embedding is not null
    and c.sensitivity <= l.clearance
    and (cardinality(c.dept_tags) = 0 or l.department = any (c.dept_tags))
    and (cardinality(c.role_tags) = 0 or l.role = any (c.role_tags))
  order by c.embedding operator(extensions.<=>) p_query
  limit greatest(1, least(p_k, 50));
$$;

revoke execute on function public.match_chunks(text, text, extensions.vector, int)
  from public, anon, authenticated;

-- Private bucket for original documents: kb/{tenant_id}/{doc_id}
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kb', 'kb', false, 52428800,
        array['application/pdf',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'text/markdown', 'text/plain'])
on conflict (id) do nothing;
