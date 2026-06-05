-- Prioridad en propuestas y work items. La prioridad se setea explícitamente en el intake
-- (no se infiere) y se mapea a la prioridad nativa de Linear al crear el issue.
alter table proposal  add column if not exists priority text;   -- urgent | high | medium | low
alter table work_item add column if not exists priority text;
