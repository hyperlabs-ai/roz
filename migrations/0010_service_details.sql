-- 0010 — Datos ricos por proveedor en el snapshot. Hasta 0009 el snapshot solo guardaba estado +
-- deploy + métricas; el dashboard pedía "más que activo/no". `details` (jsonb) guarda lo específico
-- de cada proveedor sin acoplar el esquema a ninguno:
--   vercel:   { framework, productionUrl, recent: [{state, sha, createdAt}] }
--   railway:  { replicas, region, runtime, plan, recent: [...] }
--   supabase: { region, dbVersion, postgresEngine, subsystems: [{name, healthy}], requests: {...} }
alter table roz.service_snapshot add column if not exists details jsonb;
