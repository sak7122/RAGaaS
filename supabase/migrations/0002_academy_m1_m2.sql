-- RAGaaS Academy M1 (KB admin, learners import) + M2 (course generation).
-- Additive only: new columns default safely; check constraints widened.

-- Change detection: a re-upload with the same content is a no-op; different
-- content bumps version and marks dependent modules/items stale.
alter table public.kb_documents add column if not exists content_hash text;

-- Retrieval for the pilot runs on Vertex AI Search (no chunk ids in Postgres),
-- so generated content tracks the documents it cites.
alter table public.modules add column if not exists source_doc_ids uuid[] not null default '{}';
alter table public.items   add column if not exists source_doc_ids uuid[] not null default '{}';
alter table public.items   add column if not exists explanation text;
create index if not exists modules_source_docs_idx on public.modules using gin (source_doc_ids);
create index if not exists items_source_docs_idx   on public.items   using gin (source_doc_ids);

-- Paths are generated asynchronously.
alter table public.paths drop constraint if exists paths_status_check;
alter table public.paths add constraint paths_status_check
  check (status in ('generating', 'failed', 'draft', 'published', 'stale'));
alter table public.paths add column if not exists error text;
alter table public.paths add column if not exists updated_at timestamptz not null default now();

-- Learners imported by CSV before they sign up are keyed `email:<address>`
-- and re-keyed to the Firebase uid on first sign-in; one row per email per tenant.
create unique index if not exists learners_tenant_email_idx
  on public.learners (tenant_id, lower(email));
