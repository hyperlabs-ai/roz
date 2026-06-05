-- URL del issue en Linear, para enlazar directo desde las notificaciones (botón de acceso).
alter table work_item add column if not exists url text;
