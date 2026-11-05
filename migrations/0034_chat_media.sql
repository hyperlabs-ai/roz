-- 0034 — Chat: archivos de hasta 20 MB (subida directa a Storage) y previews de links.
--
-- ⚠ Corrección en la 0035: 'chat-attachments' resultó ser de OTRA app del mismo proyecto de
--   Supabase; la 0035 le devuelve su tope de 50 MB y mueve el chat a un bucket propio ('roz-chat').
--
-- 1. Tope de 20 MB en el bucket. El navegador sube directo a Storage con una URL firmada (ya no
--    pasa por la función de Vercel, que corta en 4.5 MB), así que el límite real lo pone Storage:
--    aunque el cliente mienta sobre el tamaño al pedir la URL, un archivo mayor se rechaza aquí.
update storage.buckets
   set file_size_limit = 20971520 -- 20 MB
 where id = 'chat-attachments';

-- 2. Previews de los links del mensaje (YouTube, posts, artículos). Los calcula el backend después
--    de enviar o editar (src/chat/unfurl.ts) y los reparte por tiempo real como message.updated.
--    Null = aún no se calculan o el mensaje no tiene links.
alter table roz.chat_message add column if not exists link_previews jsonb;
