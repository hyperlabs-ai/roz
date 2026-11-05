-- 0031 — Asignación automática: cada decisión de roz, y la corrección humana, queda registrada.
--
-- El problema que resuelve: roz ya puede elegir responsable para una tarea nueva (src/assign), y
-- una elección que nadie puede auditar se discute cada sprint en vez de mejorar. Esta tabla guarda
-- el porqué completo de cada decisión y, si alguien la corrige, con qué motivo.
--
-- Decisiones:
--   · UNA tabla. La corrección (override) vive en la misma fila: hay a lo más una por decisión —
--     cambios posteriores ya son ediciones normales de la tarea, no correcciones al algoritmo.
--   · `jev_request` es el cuerpo EXACTO que se envió a TypeSafe (sin la llave, que viaja en el
--     header) y `jev_model` el modelo que respondió: cualquier caso se puede repetir tal cual.
--   · `candidates` guarda a TODOS los evaluados con sus motivos (elegido / alternativa / descartado
--     por filtro o por capacidad). Es lo que la UI muestra en "¿Por qué X?".
--   · `override_category` es una lista CERRADA (espejo de OVERRIDE_CATEGORIES en
--     src/assign/rules.ts). Cada categoría apunta a la palanca del algoritmo que habría que mover; un
--     texto libre no se puede contar.
--   · Índice único parcial sobre `pending`: no puede haber dos corridas en curso para la misma tarea
--     (crear + botón manual, o un reintento del outbox que se cruza).
--   · `work_item` no gana columnas: la última decisión se busca por índice. Solo se empieza a
--     escribir `estimate` (ya existía, migración 0007, y nadie lo llenaba).
--
-- Aditiva e idempotente, como el resto de migraciones de roz.

create table if not exists roz.assignment_decision (
  id                uuid primary key default gen_random_uuid(),
  work_item_id      uuid not null references roz.work_item(id) on delete cascade,
  -- create | chat | intake | manual
  origin            text not null,
  -- auth.users.id de quien la pidió (null = intake, sin persona)
  requested_by      uuid,
  -- pending | assigned | escalated | failed | skipped
  outcome           text not null default 'pending',
  -- Código cerrado en TS (sin_candidatos, clasificacion_incierta, ya_asignada, error_jev, …)
  reason            text,
  policy_version    text not null,
  questions_version text,
  jev_model         text,
  jev_request       jsonb,
  jev_response      jsonb,
  classification    jsonb,
  candidates        jsonb not null default '[]'::jsonb,
  tie_breaks        jsonb not null default '[]'::jsonb,
  chosen_dev_id     uuid references roz.dev(id) on delete set null,
  effective_hours   numeric(6, 2),
  -- Escalamiento: { suggested, options[] } (dividir / repriorizar / backlog / clasificar)
  suggestion        jsonb,
  error             text,
  attempts          int not null default 0,
  created_at        timestamptz not null default now(),
  decided_at        timestamptz,
  -- Override: alguien cambió al responsable que eligió roz.
  overridden_at     timestamptz,
  overridden_by     uuid,
  override_dev_id   uuid references roz.dev(id) on delete set null,
  override_category text,
  override_note     text
);

do $$ begin
  alter table roz.assignment_decision add constraint assignment_decision_origin_check
    check (origin in ('create', 'chat', 'intake', 'manual'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table roz.assignment_decision add constraint assignment_decision_outcome_check
    check (outcome in ('pending', 'assigned', 'escalated', 'failed', 'skipped'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table roz.assignment_decision add constraint assignment_decision_override_category_check
    check (override_category is null or override_category in (
      'clasificacion_erronea', 'carga_real', 'ausencia', 'contexto_cliente', 'continuidad',
      'desarrollo_persona', 'urgencia', 'preferencia', 'otro'
    ));
exception when duplicate_object then null; end $$;

-- Un override siempre lleva su categoría, y una categoría sin override no tiene sentido.
do $$ begin
  alter table roz.assignment_decision add constraint assignment_decision_override_pair_check
    check ((overridden_at is null) = (override_category is null));
exception when duplicate_object then null; end $$;

-- "Otro" sin explicación no enseña nada.
do $$ begin
  alter table roz.assignment_decision add constraint assignment_decision_override_note_check
    check (override_category is distinct from 'otro' or coalesce(btrim(override_note), '') <> '');
exception when duplicate_object then null; end $$;

create index if not exists idx_roz_assignment_decision_item
  on roz.assignment_decision (work_item_id, created_at desc);

create unique index if not exists uq_roz_assignment_decision_pending
  on roz.assignment_decision (work_item_id) where outcome = 'pending';

-- Solo el backend (service_role) la toca, como el resto de tablas de roz.
grant all on roz.assignment_decision to service_role;
alter table roz.assignment_decision enable row level security;

notify pgrst, 'reload schema';
