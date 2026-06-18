-- 0004 — Timestamps de transición de estado en work_item, para el dashboard.
-- El espejo de Linear solo guardaba el estado actual; para "tickets resueltos por período"
-- y cycle time hacen falta las fechas de inicio/cierre. Linear las entrega en el payload del
-- webhook (data.startedAt / data.completedAt / data.canceledAt), así que solo se persisten.
-- Idempotente.

alter table roz.work_item add column if not exists started_at   timestamptz;
alter table roz.work_item add column if not exists completed_at timestamptz;
alter table roz.work_item add column if not exists canceled_at  timestamptz;

create index if not exists idx_roz_work_item_completed_at on roz.work_item(completed_at);
create index if not exists idx_roz_work_item_assignee     on roz.work_item(assignee_dev_id);
