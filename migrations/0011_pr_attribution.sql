-- 0011 — Atribución de Pull Requests. roz pasa a documentar el trabajo POR PR (no por commit
-- suelto), lo que mata la duplicación (rama + squash en main = mismo trabajo dos veces) y, sobre
-- todo, permite registrar QUIÉN hizo qué: autor(es), revisor(es) y quién mergeó.
--
-- · Columnas de conveniencia en work_item para consultas rápidas y para el dashboard.
-- · Tabla work_item_actor: atribución normalizada (un work_item ↔ N actores con rol). Se guarda
--   github_login SIEMPRE (aunque el actor no esté mapeado a un dev de roz), para no perder la
--   atribución de quien aún no aceptó Linear / no está en roz.dev.

alter table roz.work_item add column if not exists pr_number int;     -- nº de PR (si nació de una PR)
alter table roz.work_item add column if not exists repo      text;    -- "owner/name" de origen
alter table roz.work_item add column if not exists source    text;    -- 'pr' | 'commit' | null (Linear/chat)
alter table roz.work_item add column if not exists merger_dev_id uuid references roz.dev(id); -- quién mergeó (atajo)

create index if not exists idx_roz_work_item_pr     on roz.work_item(repo, pr_number);
create index if not exists idx_roz_work_item_merger on roz.work_item(merger_dev_id);

-- Atribución completa y consultable: "¿qué PRs revisó X?", "¿quién mergeó este ticket?", etc.
create table if not exists roz.work_item_actor (
  id            uuid primary key default gen_random_uuid(),
  work_item_id  uuid not null references roz.work_item(id) on delete cascade,
  dev_id        uuid references roz.dev(id),            -- null si el login no está mapeado a un dev
  github_login  text not null,                          -- siempre presente (fuente de la atribución)
  role          text not null check (role in ('author','reviewer','merger')),
  review_state  text,                                   -- approved|changes_requested|commented|dismissed (solo reviewer)
  created_at    timestamptz not null default now(),
  unique (work_item_id, github_login, role)
);
create index if not exists idx_roz_wia_work_item on roz.work_item_actor(work_item_id);
create index if not exists idx_roz_wia_dev        on roz.work_item_actor(dev_id);
create index if not exists idx_roz_wia_login      on roz.work_item_actor(github_login);
create index if not exists idx_roz_wia_role       on roz.work_item_actor(role);

grant all on roz.work_item_actor to service_role;
