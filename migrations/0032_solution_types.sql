-- 0032 — Tipos de solución y tickets inteligentes.
--
-- El problema que resuelve: hasta 0031 la asignación automática juntaba dos cosas distintas —qué
-- SABE una persona (skill, nivel 1–5) y qué CLASE de trabajo es una tarea—: Jev elegía una skill y
-- estimaba la complejidad. El equipo ya tiene una tabla de "tipos de solución" (Endpoint / CRUD,
-- Integración de pagos, Bug crítico…) y cada tipo dice qué skill pide, con qué nivel mínimo, qué
-- skill ayuda y cuánto suele medir. Ahora Jev solo clasifica la tarea en un tipo; la tabla decide el
-- resto, y el equipo la ajusta desde /app/skills sin desplegar.
--
-- Decisiones:
--   · `name` es la opción que lee Jev y `description` su criterio: por eso son editables, y cada
--     decisión guarda el payload exacto que se envió (assignment_decision.jev_request).
--   · `primary_skill_id` NULL = "la skill del módulo afectado" (bugs, refactor): Jev dice qué módulo
--     toca con la pregunta de skill. `on delete restrict`: borrar una skill que un tipo usa falla en
--     vez de convertir el tipo, en silencio, en "del módulo".
--   · Tamaños en la escala de puntos de roz (1/2/3/5/8/13; 1 pt = 2 h).
--   · Un tipo no se borra, se desactiva: hay tareas y decisiones que lo citan.
--   · `work_item.solution_type_id`: el tipo que fijó una PERSONA (en la tarea o al confirmar un
--     ticket). Siempre gana sobre lo que juzgue Jev.
--   · `assignment_decision` admite la vista previa de un ticket (`outcome='preview'`, sin tarea
--     todavía): al crear el ticket, la misma fila se completa con la tarea y el resultado.
--   · El seed mapea los tipos a las skills de HyperLabs por `tag`. Si una skill no existe en la
--     instalación, ese tipo se omite (se crea a mano desde /app/skills).
--
-- Aditiva e idempotente, como el resto de migraciones de roz.

create table if not exists roz.solution_type (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique,
  name               text not null unique,
  description        text not null,
  primary_skill_id   uuid references roz.skill(id) on delete restrict,
  min_level          smallint not null,
  secondary_skill_id uuid references roz.skill(id) on delete set null,
  size_min           smallint not null,
  size_max           smallint not null,
  active             boolean not null default true,
  sort_order         int not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

do $$ begin
  alter table roz.solution_type add constraint solution_type_min_level_check check (min_level between 1 and 5);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table roz.solution_type add constraint solution_type_size_check
    check (size_min in (1, 2, 3, 5, 8, 13) and size_max in (1, 2, 3, 5, 8, 13) and size_min <= size_max);
exception when duplicate_object then null; end $$;

grant all on roz.solution_type to service_role;
alter table roz.solution_type enable row level security;

-- Seed: tabla de tipos de solución del equipo, sobre el catálogo de skills actual.
insert into roz.solution_type (slug, name, description, primary_skill_id, min_level, secondary_skill_id, size_min, size_max, sort_order)
select v.slug, v.name, v.description, p.id, v.min_level, s.id, v.size_min, v.size_max, v.sort_order
from (values
  ('maquetacion-ui', 'Maquetación / UI básica',
   'Construir o ajustar pantallas, secciones o componentes visuales siguiendo un diseño, sin lógica de estado compleja: layouts, formularios simples, tablas, estilos.',
   'frontend', 2, 'diseno', 1, 3, 10),
  ('fix-visual', 'Fix visual / responsive',
   'Corregir cómo se ve algo que ya existe: alineaciones, espaciados, colores, textos que se desbordan, la vista en celular rota.',
   'frontend', 2, null, 1, 2, 20),
  ('componente-complejo', 'Componente interactivo complejo',
   'Un componente de interfaz con mucho estado o interacción: editores, tableros que se arrastran, filtros combinados, formularios de varios pasos, datos en tiempo real en pantalla.',
   'frontend', 3, null, 3, 8, 30),
  ('conexion-front-back', 'Conexión front-back',
   'Conectar una pantalla con un endpoint que ya existe o casi: llamar a la API, manejar carga y errores y mostrar los datos.',
   'backend', 2, 'frontend', 2, 5, 40),
  ('endpoint-crud', 'Endpoint / CRUD',
   'Crear o cambiar endpoints de la API para leer, crear, editar o borrar datos, con su validación.',
   'backend', 3, 'arquitectura', 2, 5, 50),
  ('logica-negocio', 'Lógica de negocio compleja',
   'Reglas de negocio con muchos casos en el servidor: cálculos, estados, permisos, procesos de varios pasos.',
   'backend', 4, 'arquitectura', 5, 13, 60),
  ('migracion-datos', 'Migración / modelo de datos',
   'Cambiar el modelo de datos: tablas o columnas nuevas, relaciones, o mover y transformar datos que ya existen.',
   'backend', 4, 'arquitectura', 5, 13, 70),
  ('optimizacion-queries', 'Optimización de queries',
   'Algo es lento por la base de datos: consultas pesadas, índices, reportes que tardan en cargar.',
   'backend', 4, null, 3, 8, 80),
  ('integracion-pagos', 'Integración de pagos',
   'Cobros, suscripciones, checkout, Stripe u otro procesador de pagos, reembolsos, conciliación de pagos.',
   'pagos', 4, 'integraciones', 5, 13, 90),
  ('login-sso', 'Login / SSO / OAuth',
   'Inicio de sesión, registro, recuperar contraseña, SSO, OAuth, roles y permisos de acceso de los usuarios.',
   'backend', 4, 'arquitectura', 3, 8, 100),
  ('api-terceros', 'API de terceros (CRM, ERP)',
   'Conectar con un sistema externo por su API: CRM, ERP, HubSpot, Google, sincronizar datos con otro servicio.',
   'integraciones', 3, 'backend', 3, 8, 110),
  ('webhooks-colas', 'Webhooks / colas / eventos',
   'Recibir o enviar webhooks, procesos en segundo plano, colas, tareas programadas, eventos entre sistemas.',
   'integraciones', 4, 'devops', 3, 8, 120),
  ('mensajeria', 'WhatsApp / SMS / correo',
   'Mandar o recibir mensajes por WhatsApp, SMS o correo: plantillas, notificaciones, recordatorios automáticos.',
   'integraciones', 3, 'backend', 2, 5, 130),
  ('tracking', 'Tracking GA4 / GTM',
   'Medición y analítica: eventos de Google Analytics 4, Tag Manager, píxeles, conversiones.',
   'frontend', 3, 'seo', 1, 3, 140),
  ('dashboard-reportes', 'Dashboard / reportes',
   'Pantallas de métricas, gráficas, tablas de reportes o exportaciones de datos.',
   'frontend', 3, 'backend', 3, 8, 150),
  ('seo-tecnico', 'SEO técnico',
   'Posicionamiento en buscadores desde el código: metadatos, sitemap, velocidad de carga, datos estructurados.',
   'seo', 3, 'frontend', 2, 5, 160),
  ('deploy-cicd', 'Deploy / CI-CD',
   'Despliegues, builds que fallan, pipelines de CI/CD, variables de entorno, ambientes de preview o producción.',
   'devops', 4, null, 2, 5, 170),
  ('servidor-dns', 'Servidor / DNS / SSL',
   'Dominios, DNS, certificados SSL, servidores, correos del dominio.',
   'devops', 4, null, 1, 3, 180),
  ('bug-menor', 'Bug menor',
   'Algo no funciona bien pero no bloquea a nadie: un error en un caso poco común, un dato que se muestra mal.',
   null, 2, null, 1, 2, 190),
  ('bug-critico', 'Bug crítico en producción',
   'Algo está roto en producción y afecta ahora a usuarios reales: caídas, errores que impiden usar el sistema, datos que no se guardan o que se exponen.',
   null, 4, 'devops', 1, 5, 200),
  ('refactor', 'Refactor / deuda técnica',
   'Reorganizar o limpiar código que ya funciona, actualizar librerías o dependencias, pagar deuda técnica, sin cambiar lo que ve el usuario.',
   null, 4, 'qa-retro', 3, 8, 210),
  ('pruebas', 'Pruebas automatizadas',
   'Escribir o arreglar pruebas automáticas: unitarias, de integración o end-to-end.',
   'qa-retro', 3, 'backend', 2, 5, 220),
  ('diseno-visual', 'Diseño visual',
   'Diseñar en Figma u otra herramienta: pantallas, banners, logos, piezas gráficas, prototipos.',
   'diseno', 3, null, 1, 5, 230),
  ('landing-page', 'Landing page',
   'Crear o modificar una landing o un sitio de marketing: secciones, textos, formularios de contacto, páginas de campaña.',
   'landing-pages', 3, 'frontend', 2, 5, 240),
  ('feature-ia', 'Feature con IA / LLM',
   'Funciones que usan inteligencia artificial: prompts, agentes, LLMs, embeddings, clasificar o generar texto.',
   'ai', 3, 'backend', 3, 8, 250)
) as v(slug, name, description, primary_tag, min_level, secondary_tag, size_min, size_max, sort_order)
left join roz.skill p on p.tag = v.primary_tag
left join roz.skill s on s.tag = v.secondary_tag
where v.primary_tag is null or p.id is not null
on conflict (slug) do nothing;

-- El tipo que fijó una persona en la tarea (o al confirmar un ticket).
alter table roz.work_item add column if not exists solution_type_id uuid references roz.solution_type(id) on delete set null;

-- Vista previa de un ticket: todavía no hay tarea.
alter table roz.assignment_decision alter column work_item_id drop not null;

alter table roz.assignment_decision drop constraint if exists assignment_decision_origin_check;
alter table roz.assignment_decision add constraint assignment_decision_origin_check
  check (origin in ('create', 'chat', 'intake', 'manual', 'ticket'));

alter table roz.assignment_decision drop constraint if exists assignment_decision_outcome_check;
alter table roz.assignment_decision add constraint assignment_decision_outcome_check
  check (outcome in ('preview', 'pending', 'assigned', 'escalated', 'failed', 'skipped'));

-- Solo una vista previa puede no tener tarea.
do $$ begin
  alter table roz.assignment_decision add constraint assignment_decision_item_check
    check (work_item_id is not null or outcome = 'preview');
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
