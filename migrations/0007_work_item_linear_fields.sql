-- 0007 — Enriquece work_item con campos de Linear para la sección de Tickets del dashboard.
-- El espejo guardaba lo mínimo (estado tipo, prioridad, assignee). Para reflejar el trabajo de
-- Linear con fidelidad agregamos: número, nombre legible del estado, estimate, due date, labels,
-- creador y los timestamps propios de Linear (distintos de los de roz). Idempotente.

alter table roz.work_item add column if not exists number            int;
alter table roz.work_item add column if not exists state_name        text;          -- "In Progress", "Backlog"…
alter table roz.work_item add column if not exists estimate          int;           -- story points
alter table roz.work_item add column if not exists due_date          date;
alter table roz.work_item add column if not exists labels            text[] not null default '{}';
alter table roz.work_item add column if not exists creator_name      text;          -- quién lo creó en Linear
alter table roz.work_item add column if not exists linear_created_at timestamptz;
alter table roz.work_item add column if not exists linear_updated_at timestamptz;

create index if not exists idx_roz_work_item_state         on roz.work_item(state);
create index if not exists idx_roz_work_item_project_state on roz.work_item(project_id, state);
