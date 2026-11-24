-- 0045 — zeus: organigrama con puesto, reporte secundario y "quién se encarga de qué".
--
-- `dev.role` sigue siendo la categoría que usan la capacidad y la asignación automática (ceo, pm,
-- account_manager, dev, designer, intern). Lo que la gente reconoce como su puesto ("Líder técnico y
-- desarrollador de AI", "Jefa de operaciones") va en `dev.title`, texto libre.
--
-- `dev.reports_to` es el jefe directo (lo que dibuja el árbol y la primera opción para enrutar);
-- `dev.also_reports_to` son líneas punteadas: personas a las que también se reporta.
--
-- `zeus_duty` dice quién se encarga de cada tema (revisión de código, deploys, arquitectura, clientes,
-- accesos avanzados…) y en qué orden se le busca (`rank` 1 = primero). zeus lo usa para enrutar una
-- solicitud con tema y el MCP para contestar "¿a quién le pido X?". El catálogo de temas vive en el
-- código (src/zeus/duties.ts): aquí solo se valida el formato.
--
-- Idempotente.

alter table roz.dev add column if not exists title text;
alter table roz.dev add column if not exists also_reports_to uuid[] not null default '{}';

create table if not exists roz.zeus_duty (
  duty        text not null check (duty ~ '^[a-z][a-z_]{1,40}$'),
  dev_id      uuid not null references roz.dev(id) on delete cascade,
  rank        int  not null default 1 check (rank between 1 and 20),
  note        text,
  updated_at  timestamptz not null default now(),
  primary key (duty, dev_id)
);
create index if not exists idx_zeus_duty_dev on roz.zeus_duty (dev_id);

-- RLS deny-all como el resto de roz: solo el service_role (zeus) la toca.
grant all on roz.zeus_duty to service_role;
alter table roz.zeus_duty enable row level security;
