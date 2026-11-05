-- 0033 — Perfil del proyecto: tipo y descripción.
--
-- El problema que resuelve: al clasificar un ticket, Jev solo veía el nombre del proyecto y si era
-- de cliente o interno. "Arreglar un botón" no es lo mismo en una landing (CSS) que en una app con
-- backend complejo (probablemente el botón llama a algo que falla). Con el tipo y una descripción
-- del proyecto, Jev distingue el contexto.
--
-- Decisiones:
--   · `project_type` es una lista CERRADA (espejo de PROJECT_TYPES en src/projects/profile.ts): es
--     el "tipo principal"; los matices van en la descripción. Convive con `kind` (cliente/interno).
--   · `description` en español, corta (lo que es el producto, para quién y sus partes técnicas).
--   · `profile_source`: quién lo escribió. 'ia' = lo propuso roz leyendo GitHub y nadie lo ha
--     revisado; al editarlo una persona pasa a 'humano'. El llenado con IA solo escribe campos
--     vacíos: nunca pisa lo que puso una persona.
--
-- Aditiva e idempotente, como el resto de migraciones de roz.

alter table roz.project add column if not exists project_type text;
alter table roz.project add column if not exists description text;
alter table roz.project add column if not exists profile_source text;
alter table roz.project add column if not exists profile_updated_at timestamptz;

do $$ begin
  alter table roz.project add constraint project_type_check
    check (project_type is null or project_type in ('landing', 'ecommerce', 'app_web', 'app_movil', 'api_backend', 'ia', 'otro'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table roz.project add constraint project_profile_source_check
    check (profile_source is null or profile_source in ('ia', 'humano'));
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
