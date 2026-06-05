-- Marca de reconciliación: un work_item queda "documentado" cuando un commit lo enlaza o lo
-- resuelve (fase 5). Sirve para saber qué trabajo ya tiene respaldo en código.
alter table work_item add column if not exists documented boolean not null default false;
