-- Supabase outbound relay for Colab Qwen -> local DeepSeek Harness bridge.
-- Apply this migration to a dedicated/test Supabase project.
-- Both the Windows bridge and the Colab worker should use a server-side
-- sb_secret_* key (or legacy service_role key). No anon/public policy is added.

create extension if not exists pgcrypto;

create table if not exists public.qwen_relay_jobs (
  id uuid primary key default gen_random_uuid(),
  relay_id text not null,
  request_path text not null,
  status text not null default 'queued'
    check (status in ('queued','running','done','error','cancelled')),
  worker_id text,
  error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists qwen_relay_jobs_queue_idx
  on public.qwen_relay_jobs (relay_id, status, created_at);

create table if not exists public.qwen_relay_chunks (
  job_id uuid not null references public.qwen_relay_jobs(id) on delete cascade,
  seq bigint not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (job_id, seq)
);

create table if not exists public.qwen_relay_workers (
  relay_id text not null,
  worker_id text not null,
  status text not null check (status in ('online','offline','error')),
  model text not null,
  context_window integer not null,
  detail text,
  updated_at timestamptz not null default now(),
  primary key (relay_id, worker_id)
);

create or replace function public.qwen_relay_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if new.status in ('done','error','cancelled') and new.completed_at is null then
    new.completed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists qwen_relay_jobs_updated_at on public.qwen_relay_jobs;
create trigger qwen_relay_jobs_updated_at
before update on public.qwen_relay_jobs
for each row execute function public.qwen_relay_set_updated_at();

create or replace function public.qwen_relay_worker_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists qwen_relay_workers_updated_at on public.qwen_relay_workers;
create trigger qwen_relay_workers_updated_at
before update on public.qwen_relay_workers
for each row execute function public.qwen_relay_worker_updated_at();

-- Atomically claim one queued job. SKIP LOCKED keeps this safe if another
-- worker is added later.
create or replace function public.qwen_relay_claim_job(
  p_relay_id text,
  p_worker_id text
)
returns setof public.qwen_relay_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id
  from public.qwen_relay_jobs
  where relay_id = p_relay_id
    and status = 'queued'
  order by created_at asc
  for update skip locked
  limit 1;

  if v_id is null then
    return;
  end if;

  return query
  update public.qwen_relay_jobs
  set status = 'running',
      worker_id = p_worker_id,
      claimed_at = now(),
      updated_at = now()
  where id = v_id
  returning *;
end;
$$;

create or replace function public.qwen_relay_worker_alive(
  p_relay_id text,
  p_max_age_seconds integer default 30
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.qwen_relay_workers
    where relay_id = p_relay_id
      and status = 'online'
      and updated_at >= now() - make_interval(secs => greatest(p_max_age_seconds, 1))
  );
$$;

alter table public.qwen_relay_jobs enable row level security;
alter table public.qwen_relay_chunks enable row level security;
alter table public.qwen_relay_workers enable row level security;

-- No anon/authenticated policies on purpose. The relay is backend-to-backend
-- and should be accessed only with a server-side secret/service-role key.
grant all on public.qwen_relay_jobs to service_role;
grant all on public.qwen_relay_chunks to service_role;
grant all on public.qwen_relay_workers to service_role;
grant execute on function public.qwen_relay_claim_job(text,text) to service_role;
grant execute on function public.qwen_relay_worker_alive(text,integer) to service_role;

-- Private Storage bucket for potentially very large compressed Harness prompts.
insert into storage.buckets (id, name, public)
values ('qwen-relay', 'qwen-relay', false)
on conflict (id) do update set public = false;
