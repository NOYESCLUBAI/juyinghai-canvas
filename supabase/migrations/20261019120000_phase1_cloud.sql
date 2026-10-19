-- Phase 1 invite beta. Apply in the Supabase SQL editor or via the Supabase CLI.
-- FastAPI connects with the database password / service role and bypasses RLS,
-- so the application also filters every query by user_id. The policies below
-- match that filter for any request made with a signed-in user's JWT.

create table if not exists public.projects (
  id text primary key,
  user_id uuid not null,
  document jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_opened_at timestamptz,
  favorite boolean not null default false,
  trashed_at timestamptz,
  cover_asset_id text
);

create index if not exists projects_user_updated on public.projects (user_id, updated_at desc);

create table if not exists public.library_meta (
  user_id uuid primary key,
  last_opened_project_id text
);

create table if not exists public.project_assets (
  user_id uuid not null,
  project_id text not null,
  asset_id text not null,
  kind text not null check (kind in ('image', 'video')),
  file_name text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, project_id, asset_id)
);

create index if not exists project_assets_by_asset on public.project_assets (user_id, asset_id);

create table if not exists public.global_assets (
  user_id uuid not null,
  asset_id text not null,
  project_id text,
  kind text not null check (kind in ('image', 'video')),
  file_name text not null,
  created_at timestamptz not null default now(),
  saved_at timestamptz not null default now(),
  primary key (user_id, asset_id)
);

create table if not exists public.model_configs (
  id text not null,
  user_id uuid not null,
  name text not null,
  kind text not null,
  protocol text not null,
  base_url text not null,
  model text not null,
  api_key_ciphertext text not null,
  primary key (user_id, id)
);

create table if not exists public.agnes_connections (
  user_id uuid primary key,
  base_url text not null,
  api_key_ciphertext text not null
);

create table if not exists public.video_jobs (
  id text primary key,
  user_id uuid not null,
  status text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists video_jobs_status on public.video_jobs (status);
create index if not exists video_jobs_user on public.video_jobs (user_id, updated_at desc);

create table if not exists public.agent_sessions (
  user_id uuid not null,
  project_id text not null,
  canvas_id text not null,
  messages jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id, canvas_id)
);

create table if not exists public.invite_allowlist (
  email text primary key,
  created_at timestamptz not null default now()
);

alter table public.projects enable row level security;
alter table public.library_meta enable row level security;
alter table public.project_assets enable row level security;
alter table public.global_assets enable row level security;
alter table public.model_configs enable row level security;
alter table public.agnes_connections enable row level security;
alter table public.video_jobs enable row level security;
alter table public.agent_sessions enable row level security;
alter table public.invite_allowlist enable row level security;

-- Model keys, video jobs and the invite list stay server-side. No authenticated
-- policy is created for those tables, so the anon/authenticated API roles cannot
-- read ciphertext even though RLS is on. Projects and assets are readable by
-- the owning user, matching FastAPI's user_id filter.

drop policy if exists projects_owner on public.projects;
create policy projects_owner on public.projects
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists library_meta_owner on public.library_meta;
create policy library_meta_owner on public.library_meta
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists project_assets_owner on public.project_assets;
create policy project_assets_owner on public.project_assets
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists global_assets_owner on public.global_assets;
create policy global_assets_owner on public.global_assets
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists agent_sessions_owner on public.agent_sessions;
create policy agent_sessions_owner on public.agent_sessions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
