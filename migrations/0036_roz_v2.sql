-- 0036 — roz v2: Linear vuelve a ser la fuente de verdad, juntas → bandeja, planes del agente por dev.
--
-- El problema que resuelve: las tareas nativas (0016) sacaron el trabajo de Linear, y el equipo
-- sigue planeando ahí. roz v2 invierte la dirección: Linear manda, `work_item` es un ESPEJO de solo
-- lectura (webhook + reconciliación GraphQL), y sobre ese espejo roz agrega lo que Linear no hace:
-- convertir juntas en issues verificados contra el texto y preparar un plan de agente por issue en la
-- cola de su dueño, que corre en la PC del dev (roz-runner), nunca en la nube.
--
-- Todo va detrás de ROZ_LINEAR_SOT (default false). Con el flag apagado estas tablas quedan vacías y
-- roz se comporta exactamente como antes: nada de lo de abajo cambia una fila existente.
--
-- Decisiones:
--   · `work_item` no se reemplaza: gana las columnas linear_* que le faltaban (estado de Linear, ciclo,
--     asignado de Linear) y un embedding opcional para deduplicar candidatas de juntas con la misma
--     búsqueda híbrida (keyword + vector + RRF) que usa el brain.
--   · `linear_link` es UNA tabla de mapeo para equipos/proyectos/usuarios/etiquetas/estados: el
--     webhook de Linear solo trae ids, y resolverlos contra roz en una tabla por tipo multiplicaría
--     las consultas del espejo.
--   · `runner.token_hash` guarda sha256(token): el token en claro se muestra UNA vez al registrar. Una
--     fuga de la base no deja correr agentes en la PC de nadie.
--   · `agent_plan` tiene a lo más UN plan vivo por issue (índice único parcial). Reclamar, jalar y la
--     toma de trabajo del runner son updates condicionales sobre el estado: dos personas que reclaman
--     a la vez → una gana, la otra recibe 409. `roz.agent_plan_next` toma el siguiente plan con
--     FOR UPDATE SKIP LOCKED: dos runners del mismo dev nunca toman el mismo plan.
--   · `agent_plan_event` es la bitácora append-only del plan (quién hizo qué, latidos con avance):
--     el feed en vivo del Pulso sale de aquí.
--   · `assignment_decision` gana la categoría de override 'reclamado' (un dev tomó el plan de otro) y
--     el origen 'meeting' (issue nacido de una junta). Espejo de src/assign/rules.ts.
--
-- Aditiva e idempotente, como el resto de migraciones de roz.

-- ---------- 1. Espejo de Linear en work_item ----------
alter table roz.work_item add column if not exists linear_team_id      text;
alter table roz.work_item add column if not exists linear_project_id   text;
alter table roz.work_item add column if not exists linear_state_id     text;
-- Tipo de estado de Linear: backlog | unstarted | started | completed | canceled | triage.
alter table roz.work_item add column if not exists linear_state_type   text;
-- Nombre legible tal cual en Linear ("In Review"); `status` sigue siendo el vocabulario de roz.
alter table roz.work_item add column if not exists linear_state_name   text;
alter table roz.work_item add column if not exists linear_assignee_id  text;
-- Prioridad nativa de Linear (0 sin prioridad, 1 urgente … 4 baja). `priority` guarda la de roz.
alter table roz.work_item add column if not exists linear_priority     smallint;
-- Ciclo actual: { id, number, name, startsAt, endsAt, progress } (avance del ciclo en el Pulso).
alter table roz.work_item add column if not exists linear_cycle        jsonb;
alter table roz.work_item add column if not exists linear_branch_name  text;
alter table roz.work_item add column if not exists linear_completed_at timestamptz;
alter table roz.work_item add column if not exists linear_canceled_at  timestamptz;
-- Última vez que el espejo se escribió desde Linear (webhook o reconciliación).
alter table roz.work_item add column if not exists linear_synced_at    timestamptz;
-- Embedding del issue (nombre + descripción) para la deduplicación de candidatas de juntas.
-- Opcional: se llena perezosamente; sin él la búsqueda cae a solo keyword.
alter table roz.work_item add column if not exists embedding           extensions.vector(3072);
alter table roz.work_item add column if not exists embedding_hash      text;

create index if not exists idx_roz_work_item_linear_assignee
  on roz.work_item (linear_assignee_id) where linear_assignee_id is not null;
create index if not exists idx_roz_work_item_linear_updated
  on roz.work_item (linear_updated_at desc) where linear_id is not null;
create index if not exists idx_roz_work_item_fts
  on roz.work_item using gin (to_tsvector('spanish', name || ' ' || coalesce(description, '')));

do $$ begin
  alter table roz.work_item add constraint work_item_linear_state_type_check
    check (linear_state_type is null or linear_state_type in ('backlog', 'unstarted', 'started', 'completed', 'canceled', 'triage'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table roz.work_item add constraint work_item_linear_priority_check
    check (linear_priority is null or linear_priority between 0 and 4);
exception when duplicate_object then null; end $$;

-- ---------- 2. Perfil de cliente del proyecto ----------
-- Dominios de correo del cliente (sin @): una junta con asistentes de @acme.com se resuelve sola al
-- proyecto. Y si el cliente tiene SLA: sube el riesgo del plan del agente (regla, no IA).
alter table roz.project add column if not exists client_email_domains text[] not null default '{}';
alter table roz.project add column if not exists client_sla          boolean not null default false;
-- Rutas extra que el proyecto considera sensibles (globs, se suman a las reglas fijas del código).
alter table roz.project add column if not exists agent_risk_paths    text[] not null default '{}';

create index if not exists idx_roz_project_client_domains on roz.project using gin (client_email_domains);

-- ---------- 3. Mapeo Linear ↔ roz ----------
create table if not exists roz.linear_link (
  id          uuid primary key default gen_random_uuid(),
  -- team | project | user | label | state
  kind        text not null,
  linear_id   text not null,
  -- Lo que es en roz: project.id (team/project), dev.id (user), solution_type.id (label). Null =
  -- conocido en Linear pero sin vínculo (estados, o un usuario que no es dev de roz).
  roz_id      uuid,
  -- Equipo de Linear al que pertenece (labels/estados/proyectos son por equipo). Null en `team`.
  team_id     text,
  name        text not null,
  -- team: key ("HYP"); state: type (backlog|unstarted|started|completed|canceled|triage);
  -- user: email en minúsculas; label/project: null.
  key         text,
  meta        jsonb not null default '{}'::jsonb,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (kind, linear_id)
);

do $$ begin
  alter table roz.linear_link add constraint linear_link_kind_check
    check (kind in ('team', 'project', 'user', 'label', 'state'));
exception when duplicate_object then null; end $$;

create index if not exists idx_roz_linear_link_roz on roz.linear_link (kind, roz_id) where roz_id is not null;
create index if not exists idx_roz_linear_link_key on roz.linear_link (kind, team_id, key);

-- ---------- 4. Juntas ----------
create table if not exists roz.meeting (
  id                 uuid primary key default gen_random_uuid(),
  -- manual (pegado / archivo / resumen de Granola) | granola (API)
  source             text not null,
  -- Id de la nota en Granola. Null en las manuales.
  external_id        text,
  title              text not null,
  held_at            timestamptz not null,
  duration_min       int,
  -- [{ name, email }] — el email puede faltar en transcripciones pegadas.
  attendees          jsonb not null default '[]'::jsonb,
  project_id         uuid references roz.project(id) on delete set null,
  -- dominio (por correo del cliente) | elegido (lo eligió la persona) | null (sin proyecto aún)
  project_source     text,
  -- texto | vtt | srt | granola_resumen | granola_api
  transcript_format  text not null,
  -- Texto NORMALIZADO (sin marcas de tiempo de vtt/srt) contra el que se verifican las citas.
  transcript         text not null,
  -- pendiente | extrayendo | lista | error
  status             text not null default 'pendiente',
  error              text,
  extraction_model   text,
  extracted_at       timestamptz,
  -- auth.users.id / roz.dev.id de quien la subió (null en Granola por API).
  created_by         uuid,
  created_by_dev_id  uuid references roz.dev(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

do $$ begin
  alter table roz.meeting add constraint meeting_source_check check (source in ('manual', 'granola'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table roz.meeting add constraint meeting_status_check
    check (status in ('pendiente', 'extrayendo', 'lista', 'error'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table roz.meeting add constraint meeting_format_check
    check (transcript_format in ('texto', 'vtt', 'srt', 'granola_resumen', 'granola_api'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table roz.meeting add constraint meeting_project_source_check
    check (project_source is null or project_source in ('dominio', 'elegido'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table roz.meeting add constraint meeting_duration_check check (duration_min is null or duration_min between 1 and 1440);
exception when duplicate_object then null; end $$;

-- Una nota de Granola entra una sola vez aunque el poll la vea en dos ticks.
create unique index if not exists uq_roz_meeting_external
  on roz.meeting (source, external_id) where external_id is not null;
create index if not exists idx_roz_meeting_held on roz.meeting (held_at desc);
create index if not exists idx_roz_meeting_project on roz.meeting (project_id, held_at desc);

create table if not exists roz.meeting_candidate (
  id                     uuid primary key default gen_random_uuid(),
  meeting_id             uuid not null references roz.meeting(id) on delete cascade,
  -- tarea | compromiso | decision
  kind                   text not null,
  title                  text not null,
  description            text,
  -- Cita LITERAL del texto. El código verifica que exista (normalizada) antes de guardarla; una
  -- candidata sin cita verificada no se guarda.
  quote                  text not null,
  -- Posición de la cita en meeting.transcript (para resaltarla en la bandeja).
  quote_start            int,
  -- Nombre/correo de quien quedó a cargo según el texto ("Ana lo manda el viernes").
  owner_hint             text,
  due_hint               text,
  due_date               date,
  -- Clasificación de Jev (q3) y su modelo; mismo shape que assignment_decision.classification.
  classification         jsonb,
  jev_model              text,
  solution_type_id       uuid references roz.solution_type(id) on delete set null,
  estimate               int,
  -- Prioridad de Linear 1-4 (urgente … baja).
  priority               smallint,
  -- Deduplicación contra el espejo: el issue más parecido y su puntaje (RRF).
  duplicate_work_item_id uuid references roz.work_item(id) on delete set null,
  duplicate_score        real,
  -- Responsable que propone la política (p2) y la decisión completa (candidatos, motivos).
  proposed_dev_id        uuid references roz.dev(id) on delete set null,
  assignment_decision_id uuid references roz.assignment_decision(id) on delete set null,
  -- pendiente | aceptada | comentada (se comentó el duplicado) | descartada | guardada (decisión → brain)
  status                 text not null default 'pendiente',
  discard_reason         text,
  -- Resultado al aceptar.
  linear_issue_id        text,
  linear_identifier      text,
  linear_comment_id      text,
  work_item_id           uuid references roz.work_item(id) on delete set null,
  knowledge_atom_id      uuid references roz.knowledge_atom(id) on delete set null,
  decided_by             uuid,
  decided_by_dev_id      uuid references roz.dev(id) on delete set null,
  decided_at             timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

do $$ begin
  alter table roz.meeting_candidate add constraint meeting_candidate_kind_check
    check (kind in ('tarea', 'compromiso', 'decision'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table roz.meeting_candidate add constraint meeting_candidate_status_check
    check (status in ('pendiente', 'aceptada', 'comentada', 'descartada', 'guardada'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table roz.meeting_candidate add constraint meeting_candidate_priority_check
    check (priority is null or priority between 1 and 4);
exception when duplicate_object then null; end $$;
-- Una cita vacía no prueba nada.
do $$ begin
  alter table roz.meeting_candidate add constraint meeting_candidate_quote_check check (btrim(quote) <> '');
exception when duplicate_object then null; end $$;

create index if not exists idx_roz_meeting_candidate_meeting on roz.meeting_candidate (meeting_id, created_at);
-- La bandeja: lo pendiente, de lo más nuevo a lo más viejo.
create index if not exists idx_roz_meeting_candidate_inbox
  on roz.meeting_candidate (created_at desc) where status = 'pendiente';

-- ---------- 5. Runners (la PC de cada dev) ----------
create table if not exists roz.runner (
  id              uuid primary key default gen_random_uuid(),
  dev_id          uuid not null references roz.dev(id) on delete cascade,
  -- Nombre del equipo (PC), p.ej. "laptop-ana".
  name            text not null,
  -- sha256 hex del token. El token en claro solo se muestra al crearlo.
  token_hash      text not null unique,
  -- Primeros caracteres del token, para reconocerlo en la lista sin poder usarlo.
  token_prefix    text not null,
  -- Horario en el que el runner toma trabajo: { tz, days: [1..7], start: 'HH:MM', end: 'HH:MM' }.
  schedule        jsonb not null default '{}'::jsonb,
  -- Máximo de planes corriendo a la vez en este equipo.
  max_concurrent  int not null default 1,
  version         text,
  platform        text,
  last_seen_at    timestamptz,
  revoked_at      timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

do $$ begin
  alter table roz.runner add constraint runner_max_concurrent_check check (max_concurrent between 1 and 8);
exception when duplicate_object then null; end $$;

create index if not exists idx_roz_runner_dev on roz.runner (dev_id) where revoked_at is null;

-- ---------- 6. Planes del agente ----------
create table if not exists roz.agent_plan (
  id                  uuid primary key default gen_random_uuid(),
  work_item_id        uuid not null references roz.work_item(id) on delete cascade,
  linear_issue_id     text,
  -- Identificador legible (HYP-123): es también el prefijo de la rama.
  identifier          text not null,
  -- Dueño de la cola (el asignado del issue, o quien reclamó).
  owner_dev_id        uuid not null references roz.dev(id) on delete cascade,
  -- en_cola | planeando | esperando_aprobacion | implementando | pr_abierto | hecho | jalado | cancelado
  status              text not null default 'en_cola',
  -- Qué hará el runner cuando lo tome: planear (escribir PLAN.md) o implementar (hasta PR).
  phase               text not null default 'planear',
  -- 0 = planea e implementa hasta PR; 1 = planea y espera aprobación; 2 = solo plan.
  risk                smallint not null,
  -- [{ code, detail }] — las reglas que dispararon el riesgo.
  risk_reasons        jsonb not null default '[]'::jsonb,
  repo                text,
  base_branch         text,
  branch              text,
  plan_md             text,
  plan_version        int not null default 0,
  -- Lo que pidió una persona al "pedir cambios".
  feedback            text,
  pr_number           int,
  pr_url              text,
  -- Runner que lo tiene tomado ahora (planeando / implementando).
  runner_id           uuid references roz.runner(id) on delete set null,
  -- Lease del runner: cada progress/latido lo trae; uno viejo (tras el watchdog) se rechaza.
  lease_id            uuid,
  heartbeat_at        timestamptz,
  -- Último avance que reportó el runner { step, message, pct, at }.
  progress            jsonb,
  attempts            int not null default 0,
  error               text,
  -- Watchdog: cualquier dev puede reclamarlo (dueño fuera de línea o mucho tiempo en cola).
  claimable           boolean not null default false,
  claimable_reason    text,
  claimable_at        timestamptz,
  approved_by         uuid,
  approved_at         timestamptz,
  pulled_by_dev_id    uuid references roz.dev(id) on delete set null,
  pulled_at           timestamptz,
  enqueued_at         timestamptz not null default now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

do $$ begin
  alter table roz.agent_plan add constraint agent_plan_status_check check (status in (
    'en_cola', 'planeando', 'esperando_aprobacion', 'implementando', 'pr_abierto', 'hecho', 'jalado', 'cancelado'
  ));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table roz.agent_plan add constraint agent_plan_phase_check check (phase in ('planear', 'implementar'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table roz.agent_plan add constraint agent_plan_risk_check check (risk between 0 and 2);
exception when duplicate_object then null; end $$;
-- Corriendo ⇔ tiene runner y lease.
do $$ begin
  alter table roz.agent_plan add constraint agent_plan_running_check
    check ((status in ('planeando', 'implementando')) = (runner_id is not null and lease_id is not null));
exception when duplicate_object then null; end $$;
-- Riesgo 2 nunca lo implementa el agente.
do $$ begin
  alter table roz.agent_plan add constraint agent_plan_risk2_check
    check (risk < 2 or status <> 'implementando');
exception when duplicate_object then null; end $$;

-- A lo más UN plan vivo por issue: reencolar dos veces el mismo issue (webhook + reconciliación)
-- choca aquí (23505) y se trata como no-op.
create unique index if not exists uq_roz_agent_plan_live
  on roz.agent_plan (work_item_id)
  where status not in ('hecho', 'jalado', 'cancelado');
-- La cola de cada dev.
create index if not exists idx_roz_agent_plan_queue
  on roz.agent_plan (owner_dev_id, enqueued_at) where status = 'en_cola';
-- El watchdog: lo que está corriendo, por latido.
create index if not exists idx_roz_agent_plan_running
  on roz.agent_plan (heartbeat_at) where status in ('planeando', 'implementando');
create index if not exists idx_roz_agent_plan_status on roz.agent_plan (status, updated_at desc);
create index if not exists idx_roz_agent_plan_claimable on roz.agent_plan (claimable_at) where claimable;

create table if not exists roz.agent_plan_event (
  id           uuid primary key default gen_random_uuid(),
  plan_id      uuid not null references roz.agent_plan(id) on delete cascade,
  -- enqueued | started | progress | plan_ready | approved | changes_requested | claimed | pulled |
  -- released | canceled | pr_opened | done | requeued | failed | claimable
  kind         text not null,
  from_status  text,
  to_status    text,
  -- Quién: una persona (dev), un runner o roz mismo (ambos null).
  actor_dev_id uuid references roz.dev(id) on delete set null,
  runner_id    uuid references roz.runner(id) on delete set null,
  data         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists idx_roz_agent_plan_event_plan on roz.agent_plan_event (plan_id, created_at);
create index if not exists idx_roz_agent_plan_event_feed on roz.agent_plan_event (created_at desc);

-- Toma atómica del siguiente plan para un runner. Respeta max_concurrent y salta los planes que
-- otro runner está tomando en el mismo instante (SKIP LOCKED). Devuelve 0 o 1 fila.
-- `p_max_attempts`: un plan que ya falló tantas veces deja de tomarse solo (queda reclamable).
create or replace function roz.agent_plan_next(p_runner_id uuid, p_max_attempts int default 3)
returns setof roz.agent_plan
language plpgsql
set search_path = roz, public
as $$
declare
  r        roz.runner%rowtype;
  running  int;
  picked   uuid;
begin
  select * into r from roz.runner where id = p_runner_id and revoked_at is null;
  if not found then
    return;
  end if;

  select count(*) into running
  from roz.agent_plan
  where runner_id = r.id and status in ('planeando', 'implementando');
  if running >= r.max_concurrent then
    return;
  end if;

  select id into picked
  from roz.agent_plan
  where owner_dev_id = r.dev_id
    and status = 'en_cola'
    and attempts < p_max_attempts
    and not (risk = 2 and phase = 'implementar')
  order by enqueued_at
  limit 1
  for update skip locked;

  if picked is null then
    return;
  end if;

  return query
  update roz.agent_plan p
  set status       = case when p.phase = 'implementar' then 'implementando' else 'planeando' end,
      runner_id    = r.id,
      lease_id     = gen_random_uuid(),
      heartbeat_at = now(),
      started_at   = coalesce(p.started_at, now()),
      updated_at   = now()
  where p.id = picked
  returning p.*;
end;
$$;

-- ---------- 7. Asignación: 'reclamado' y origen 'meeting' ----------
alter table roz.assignment_decision drop constraint if exists assignment_decision_override_category_check;
alter table roz.assignment_decision add constraint assignment_decision_override_category_check
  check (override_category is null or override_category in (
    'clasificacion_erronea', 'carga_real', 'ausencia', 'contexto_cliente', 'continuidad',
    'desarrollo_persona', 'urgencia', 'preferencia', 'reclamado', 'otro'
  ));

alter table roz.assignment_decision drop constraint if exists assignment_decision_origin_check;
alter table roz.assignment_decision add constraint assignment_decision_origin_check
  check (origin in ('create', 'chat', 'intake', 'manual', 'ticket', 'meeting'));

-- ---------- 8. Deduplicación contra el espejo ----------
-- Misma receta que search_atoms_hybrid (keyword + vector + RRF), sobre los issues del proyecto.
-- `p_include_closed`: por defecto solo issues abiertos (un duplicado de algo ya cerrado es trabajo
-- nuevo, no un comentario).
create or replace function roz.search_work_items_hybrid(
  p_project_id     uuid,
  p_query          text,
  p_embedding      extensions.vector(3072),
  p_limit          int default 5,
  p_include_closed boolean default false
)
returns table (id uuid, identifier text, name text, status text, linear_id text, score real)
language sql stable
set search_path = roz, public, extensions
as $$
  with base as (
    select w.*
    from roz.work_item w
    where w.project_id = p_project_id
      and (p_include_closed or w.status not in ('completada', 'cancelada'))
  ),
  kw as (
    select b.id,
           row_number() over (
             order by ts_rank(to_tsvector('spanish', b.name || ' ' || coalesce(b.description, '')),
                              plainto_tsquery('spanish', p_query)) desc
           ) as rnk
    from base b
    where to_tsvector('spanish', b.name || ' ' || coalesce(b.description, '')) @@ plainto_tsquery('spanish', p_query)
    limit 50
  ),
  vec as (
    select b.id,
           row_number() over (order by b.embedding <=> p_embedding) as rnk
    from base b
    where p_embedding is not null and b.embedding is not null
    limit 50
  ),
  fused as (
    select coalesce(kw.id, vec.id) as id,
           coalesce(1.0 / (60 + kw.rnk), 0) + coalesce(1.0 / (60 + vec.rnk), 0) as score
    from kw full outer join vec on kw.id = vec.id
  )
  select w.id, w.identifier, w.name, w.status, w.linear_id, f.score::real
  from fused f join roz.work_item w on w.id = f.id
  order by f.score desc
  limit p_limit;
$$;

-- ---------- Permisos ----------
-- RLS deny-all como el resto de roz: el service_role (backend) la bypassa; anon/authenticated no
-- tienen grants. El dashboard y el runner pasan por la API, nunca por la tabla directo.
grant all on roz.linear_link, roz.meeting, roz.meeting_candidate, roz.runner, roz.agent_plan, roz.agent_plan_event
  to service_role;
alter table roz.linear_link enable row level security;
alter table roz.meeting enable row level security;
alter table roz.meeting_candidate enable row level security;
alter table roz.runner enable row level security;
alter table roz.agent_plan enable row level security;
alter table roz.agent_plan_event enable row level security;

revoke execute on function roz.agent_plan_next(uuid, int) from public, anon, authenticated;
revoke execute on function roz.search_work_items_hybrid(uuid, text, extensions.vector, int, boolean) from public, anon, authenticated;
grant execute on function roz.agent_plan_next(uuid, int) to service_role;
grant execute on function roz.search_work_items_hybrid(uuid, text, extensions.vector, int, boolean) to service_role;

notify pgrst, 'reload schema';
