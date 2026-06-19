-- 0008 — Flag para el correo "cambio documentado". En vez de agrupar por ventana de tiempo
-- (frágil: 2 PRs en la misma hora colisionaban y se perdía un correo), agrupamos por
-- "pendientes de notificar": cada cambio auto-documentado nace con change_notified=false; el
-- correo agrupa todos los pendientes del dev y los marca. Así cada PR notifica y dentro de una
-- PR sale un solo correo (el primer evento agarra todos; los demás ven 0 y no envían).
alter table roz.work_item add column if not exists change_notified boolean not null default true;
-- default true: los issues YA existentes no deben dispararse. Los nuevos auto-documentados se
-- insertan explícitamente con false (ver reconcile/commits.ts).
