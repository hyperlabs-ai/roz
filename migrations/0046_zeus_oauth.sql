-- 0046 — zeus: el MCP como conector de claude.ai (OAuth 2.1 + PKCE, registro dinámico de clientes).
--
-- claude.ai (web, escritorio y móvil) no deja pegar un header con el token: un conector personalizado
-- descubre el servidor de autorización (/.well-known/…), se registra solo (RFC 7591), manda a la
-- persona a roz (/autorizar) a aprobar con su sesión y cambia el código por un token. El token que
-- recibe es un zeus_… normal (fila en zeus_token, a nombre de quien aprobó): se ve y se revoca en
-- zeus → MCP como cualquier otro.
--
-- Nada de lo guardado sirve para entrar:
--   · zeus_oauth_client es público (client_id sin secreto; la protección es PKCE + redirect_uri exacto).
--   · zeus_oauth_code guarda solo el sha256 del código, vence en 5 minutos y se cobra UNA vez
--     (UPDATE condicional sobre used_at). El token se crea en el canje; aquí solo queda su id.
-- Idempotente.

create table if not exists roz.zeus_oauth_client (
  -- Lo que el cliente manda como client_id (zoc_…). Público.
  client_id      text primary key,
  client_name    text not null default '',
  -- URIs exactas a las que se puede devolver el código (https, o http a localhost).
  redirect_uris  text[] not null,
  client_uri     text,
  created_ip     text,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);

create table if not exists roz.zeus_oauth_code (
  id                     uuid primary key default gen_random_uuid(),
  code_hash              text not null unique,
  client_id              text not null references roz.zeus_oauth_client(client_id) on delete cascade,
  dev_id                 uuid not null references roz.dev(id) on delete cascade,
  redirect_uri           text not null,
  -- PKCE S256 (obligatorio).
  code_challenge         text not null,
  -- RFC 8707: el recurso para el que se pidió (la URL del MCP). Informativo.
  resource               text,
  expires_at             timestamptz not null,
  used_at                timestamptz,
  token_id               uuid references roz.zeus_token(id) on delete set null,
  created_at             timestamptz not null default now()
);
create index if not exists idx_zeus_oauth_code_expires on roz.zeus_oauth_code (expires_at);

-- RLS deny-all como el resto de roz: solo el service_role (zeus) las toca.
grant all on roz.zeus_oauth_client, roz.zeus_oauth_code to service_role;
alter table roz.zeus_oauth_client enable row level security;
alter table roz.zeus_oauth_code enable row level security;
