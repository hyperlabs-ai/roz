-- 0035 — Bucket PROPIO para los adjuntos del chat de roz.
--
-- Por qué: la 0030 intentó crear 'chat-attachments' privado, pero el proyecto de Supabase es
-- compartido con otra app que YA tenía un bucket con ese nombre (público, con lista blanca de MIME
-- solo para imágenes/PDF/Office y tope de 50 MB). El `on conflict do nothing` lo reutilizó en
-- silencio, así que el chat de roz:
--   · guardaba archivos de conversaciones privadas en un bucket PÚBLICO ajeno, y
--   · no podía subir video, .md, .html, .zip… (la lista blanca de la otra app los rechaza).
-- Y la 0034 le bajó a esa app su tope de 50 a 20 MB.
--
-- Esta migración:
--   1. crea 'roz-chat': PRIVADO (URLs firmadas), 20 MB, sin lista blanca de MIME;
--   2. guarda en cada adjunto en qué bucket vive (los viejos siguen en 'chat-attachments' hasta
--      que scripts/move-chat-files.ts los mueva; los nuevos van a 'roz-chat');
--   3. le devuelve a 'chat-attachments' su tope original de 50 MB.

-- 1. Bucket propio. Si ya existe con ese id, se le imponen las reglas de roz (nadie más lo usa:
--    se verificó antes de escribir esta migración).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('roz-chat', 'roz-chat', false, 20971520, null)
on conflict (id) do update
  set public = false, file_size_limit = 20971520, allowed_mime_types = null;

-- 2. Bucket por adjunto. Las filas existentes quedan en el bucket viejo; las nuevas, en el propio.
alter table roz.chat_attachment add column if not exists bucket text not null default 'chat-attachments';
alter table roz.chat_attachment alter column bucket set default 'roz-chat';

-- 3. Deshacer el efecto colateral de la 0034 sobre el bucket de la otra app.
update storage.buckets
   set file_size_limit = 52428800 -- 50 MB, el valor que tenía antes de la 0034
 where id = 'chat-attachments';
