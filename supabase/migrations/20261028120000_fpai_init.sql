-- FirstPerson Adaptive Intelligence — base do backend (Lemme / Bidese)
-- Escrita SOMENTE pelas funções do servidor (/api) com a chave secreta, que ignora RLS.
-- RLS ligado e nenhuma policy: a chave publicável (navegador) não lê nem escreve nada.

create extension if not exists pgcrypto;

-- ── Leads (dados pessoais: tabela privada) ─────────────────────────────────
create table if not exists public.leads (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  project       text not null default 'Lemme',
  nome          text not null check (char_length(nome) between 2 and 120),
  email         text check (email is null or char_length(email) <= 160),
  whatsapp      text check (whatsapp is null or char_length(whatsapp) <= 40),
  tipologia     text check (tipologia is null or char_length(tipologia) <= 80),
  scene         text,
  origem        text,                       -- referrer / utm
  -- contexto do percurso FirstPerson (só quando a pessoa autorizou no formulário)
  fp_session    uuid,
  fp_stage      text,
  fp_prioridades text[] not null default '{}',
  fp_interesses  text[] not null default '{}',
  fp_favoritos   text[] not null default '{}',
  fp_policy     text,
  -- integração com o CRM
  crm           text,
  crm_status    text not null default 'pending' check (crm_status in ('pending','sent','failed','skipped')),
  crm_error     text,
  check (email is not null or whatsapp is not null)
);
create index if not exists leads_created_at on public.leads (created_at desc);

-- ── Eventos semânticos do motor (sem dados pessoais) ───────────────────────
create table if not exists public.fp_events (
  id              uuid primary key,          -- event_id gerado no navegador; retry não duplica
  session_id      uuid not null,
  name            text not null,
  target_id       text,
  occurred_at     timestamptz not null,
  received_at     timestamptz not null default now(),
  schema_version  int  not null default 1,
  policy_version  text,
  catalog_version text,
  properties      jsonb not null default '{}' check (jsonb_typeof(properties) = 'object')
);
create index if not exists fp_events_session_time on public.fp_events (session_id, occurred_at);
create index if not exists fp_events_name_time    on public.fp_events (name, received_at desc);

-- ── Resultados comerciais (CRM → webhook), para calibrar o motor depois ────
create table if not exists public.fp_outcomes (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid references public.leads(id) on delete set null,
  fp_session      uuid,
  kind            text not null check (kind in ('visit_scheduled','visit_completed','proposal_created','sale_confirmed','lead_disqualified')),
  source          text not null,
  source_event_id text not null,
  occurred_at     timestamptz not null,
  properties      jsonb not null default '{}',
  unique (source, source_event_id)
);

-- ── Trava de acesso ────────────────────────────────────────────────────────
alter table public.leads       enable row level security;
alter table public.fp_events   enable row level security;
alter table public.fp_outcomes enable row level security;

revoke all on public.leads, public.fp_events, public.fp_outcomes from anon, authenticated;

-- Retenção sugerida (rodar periodicamente ou via pg_cron):
-- delete from public.fp_events where received_at < now() - interval '90 days';
