-- 0017 — Adjuntos (imágenes) de tareas. Se suben desde la app: el backend (service_role) los sube
-- al bucket de Storage `task-attachments` y guarda una fila aquí con la URL pública para renderizar
-- en el detalle de la tarea. Aditiva.

create table if not exists roz.work_item_attachment (
  id            uuid primary key default gen_random_uuid(),
  work_item_id  uuid not null references roz.work_item(id) on delete cascade,
  storage_path  text not null,          -- ruta dentro del bucket (para borrar del Storage al eliminar)
  url           text not null,          -- URL pública (bucket público) para render directo
  name          text not null,          -- nombre original del archivo
  content_type  text,
  size          int,                    -- bytes
  uploaded_by   uuid,                   -- auth.users.id de quien subió
  created_at    timestamptz not null default now()
);
create index if not exists idx_roz_wi_attach_work_item on roz.work_item_attachment(work_item_id);

grant all on roz.work_item_attachment to service_role;
-- RLS deny-all como el resto de roz: el service_role (backend) la bypassa; nadie más tiene grants.
alter table roz.work_item_attachment enable row level security;

-- Bucket público para las imágenes de tareas. La subida va SIEMPRE por el backend (service_role,
-- que bypassa RLS de storage); al ser público, el render es por URL directa sin firmar. Idempotente.
insert into storage.buckets (id, name, public)
values ('task-attachments', 'task-attachments', true)
on conflict (id) do nothing;
