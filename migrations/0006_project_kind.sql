-- 0006 — Clasificación cliente/interno del proyecto. Antes se inferí­a por la presencia de
-- hyperops_project_id, pero hay proyectos de cliente sin proyecto en HyperOps (y producto
-- interno que sí tiene uno, como Orwel). `kind` es la fuente de verdad; hyperops_project_id
-- queda solo como vínculo de datos opcional.
alter table roz.project add column if not exists kind text not null default 'internal';
-- kind ∈ ('client','internal')
