# roz — Arquitectura

> 🇬🇧 *English:* [ARCHITECTURE.md](ARCHITECTURE.md)

`roz` es la capa de **contexto, enrutamiento y notificación** alrededor del trabajo de
desarrollo. El trabajo vive en roz como **tareas nativas** (un calendario + backlog con
identificadores locales `ROZ-123`), y sobre eso roz hace tres cosas y solo tres:

1. **Gestionar contexto** (el *second brain*): Claude *lee* contexto del proyecto vía MCP;
   roz *escribe* contexto (casi siempre al completarse el trabajo).
2. **Enrutar**: decide a qué dev se asigna una propuesta (skill + carga).
3. **Notificar**: email (Resend).

La ingesta es **multi-canal** pero converge en el mismo pipeline (evaluar contra contexto →
documentar → enrutar → tarea nativa): (a) **conversacional** vía MCP —el chat conduce una entrevista
guiada y roz documenta y sugiere asignado; el humano confirma—; (b) **tickets desde apps** vía
`POST /v1/intake` —auto-documentado y auto-asignado, sin humano en el loop—; (c) **directo en el
dashboard** —una tarea se crea de forma nativa (calendario / backlog)—. De ahí en adelante el
trabajo vive en roz. Lo posterior (al completarse): documentar / actualizar contexto, reconciliar
commits de GitHub y avisar a quien propuso. La pieza más difícil — y la razón de varias decisiones
de diseño — es **no duplicar**: ni tareas, ni documentación, ni conocimiento.

---

## Principios rectores

Cuatro patrones se repiten en TODOS los dominios de roz:

1. **Identidad canónica.** Cada unidad (tarea, commit, átomo de conocimiento) tiene un ID estable.
   Las tareas nativas de roz son la **fuente de verdad del trabajo**; GitHub es la **fuente de
   verdad del código**.
2. **Supersede, no dupliques.** Nada se borra ni se apila ciegamente: lo viejo se marca
   `superseded` y se conserva con su procedencia. Aplica al brain y a la documentación.
3. **Procedencia hacia la tarea.** Todo átomo de conocimiento y toda doc generada apunta de vuelta
   a la tarea (`work_item`) que la originó.
4. **MCP hacia adentro, APIs directas hacia afuera.**
   - *Adentro* (Claude/humanos → roz): roz **expone un servidor MCP** (Streamable HTTP). Así se
     "implementa un feature desde Claude": el chat llama herramientas de roz.
   - *Afuera* (roz → herramientas): roz consume **APIs/webhooks directos** de GitHub,
     Resend (email) y OpenAI/Anthropic.

---

## Stack

| Capa | Tecnología |
|---|---|
| Runtime / deploy | **Vercel serverless functions** (un solo entry `api/index.ts`) |
| Framework HTTP | **Hono** |
| Lenguaje | **TypeScript** (ESM, `strict`) |
| Datos + vectores | **Supabase Postgres + pgvector** (service role, server-side) |
| Razonamiento | **Claude** (Anthropic SDK, con prompt caching) — spec, clasificación, reconciliación |
| Embeddings | **OpenAI** `text-embedding-3-large` (3072 dims) — vía API |
| Cola async | **Outbox en Postgres drenado por Vercel Cron** — sin servicio externo |
| Cara interactiva | **Servidor MCP** sobre HTTP (JSON-RPC stateless propio) |
| Integraciones | **GitHub** (verdad del código), **Resend** (email) |

> **No hay worker persistente.** En serverless no existe un proceso de larga vida. El rol del
> worker lo cumple el **outbox en Postgres + Vercel Cron**: cada efecto se escribe como
> `outbox_event` y un cron (`/v1/internal/drain`, cada minuto) toma los pendientes y los ejecuta.
> Reintentos con **backoff exponencial** (`attempts` + `next_attempt_at`) y **dead-letter** tras 5
> intentos. Cero vendor extra; idempotencia vía `idempotency_key`.

---

## Por qué serverless cambia el diseño

Tres consecuencias directas de no tener proceso persistente:

1. **El outbox se drena por poll (Vercel Cron).** Cada cambio de estado escribe un `OutboxEvent`
   en la misma transacción que el dato (patrón outbox). Un cron (`/v1/internal/drain`, cada minuto)
   toma los `pending`/`failed` vencidos, hace un claim optimista (`pending`→`processing`) y ejecuta
   el efecto. Si falla, reprograma con backoff exponencial (`next_attempt_at`) hasta 5 intentos;
   luego `dead`. Idempotencia vía `idempotency_key` hace que el reintento sea seguro.
2. **Sin embeddings locales.** Los embeddings son una llamada a la API de OpenAI. Implica costo por
   uso y latencia de red → se **cachea** el vector por hash de contenido y solo se reindexa cuando el
   cuerpo del átomo cambia.
3. **MCP stateless por request.** El servidor MCP se monta como handler HTTP (Streamable HTTP).
   Cada request trae su contexto; no hay sesión en memoria entre invocaciones.

---

## Layout del código

```
roz/
  api/
    index.ts            # entry de Vercel: re-exporta el app de Hono
  src/
    index.ts            # server local (dev) con @hono/node-server
    app.ts              # Hono app: monta middleware + rutas
    config.ts           # settings (zod) desde env
    db/supabase.ts      # cliente Supabase (service role)
    types/              # tipos compartidos (Hono context, dominio)
    middleware/         # logger, auth del MCP
    utils/              # errores, verificación de firmas de webhook
    events/outbox.ts    # emit() + drenado idempotente con reintentos (drainOutbox)
    adapters/           # github, email(resend), anthropic, embeddings(openai)
    mcp/server.ts       # servidor MCP: define las tools (cara interactiva)
    intake/             # propuesta -> evaluación -> tarea nativa (MCP + apps) [fase 1]
    router/             # sugiere asignado por skill + carga     [fase 2]
    notify/             # email (Resend): asignación, cierre, doc, repo, digest [fase 3]
    brain/              # second brain: átomos, embeddings, grafo, retrieval [fase 4]
    reconcile/          # commits (dedup/auto-doc) + repos nuevos (detección/vínculo) [fase 5-6]
    projects/           # resolución repo→proyecto y auto-onboarding de proyectos
    dashboard/          # queries de visibilidad de ingeniería (consumidas por web/)
    routes/             # health, mcp, webhooks (github), intake, dashboard, internal
  migrations/           # schema completo (pgvector, outbox, idempotencia)
  web/                  # SPA React: landing pública (/) + dashboard (/app)
```

---

## El flujo, de punta a punta

```
Ciclo de vida de la tarea nativa (en la app):
  tarea creada / movida        → calendario + backlog; task.done → documenta/actualiza brain + email
Webhooks entrantes:
  GitHub   → rama ROZ-123        → mueve la tarea a "en curso"
           → PR abierta          → mueve la tarea a "en revisión"
           → PR mergeada         → mueve la tarea a "completado" (dispara work_item.done)
           → push/commit         → ¿apunta a una tarea? si no, ¿trabajo huérfano sustantivo?
                                    → enlaza/dedup contra tareas existentes + auto-doc
           → repo nuevo (1er push)→ vincula a un proyecto por similitud o avisa a los devs
```

### 1. Intake (multi-canal, tareas nativas)
Tres puertas de entrada, un solo pipeline: conversacional (MCP), tickets desde apps (`/v1/intake`)
y directo en el dashboard (calendario / backlog). Al confirmar/ingerir, roz **crea la tarea nativa
ya asignada** (`source='native'`, identificador local `ROZ-123`), guarda el `WorkItem` y emite el
evento al outbox. De ahí en adelante la tarea vive en roz y su estado lo manejan el dashboard y la
actividad de GitHub.

### 2. Router de devs
roz tiene contexto de todos los devs: skills (con embedding de perfil), disponibilidad manual y
**carga derivada** (nº de tareas `in progress`). Calcula `match_skill × disponibilidad`,
**propone** y un humano confirma.

### 3. Notificaciones (vía outbox → drain)
Adapter de **email (Resend)** con plantillas HTML branded: asignación, cierre, cambio documentado,
repo detectado y digest semanal. Cada notificación es un efecto idempotente disparado por el drain;
reclama una llave por destinatario para no enviar duplicados aunque el evento se reintente.

### 4. Second brain (al completarse)
Disparado por `work_item.done`, emitido cuando una tarea pasa a **completado** —sea manualmente en
el dashboard o automáticamente al mergearse su PR—. roz crea/actualiza un **átomo de conocimiento**
con embedding y procedencia ligada al identifier; si ya había un átomo para esa tarea con otro
contenido, lo marca **superseded** en vez de duplicar. Barrida diaria de embeddings faltantes.

### 5. Reconciliación de commits (el reto principal)
Por cada commit (webhook de GitHub): (1) ¿apunta a una tarea? (una referencia `ROZ-123` en la rama
o el mensaje la enlaza); (2) si no → **trabajo huérfano**: una sola pasada de Claude decide
trivial/sustantivo y dedup semántico contra tareas abiertas; (3) sustantivo sin match → roz crea la
tarea **ya completada** y avisa al autor; (4) persiste el commit para el dashboard; (5) idempotencia
por `repo:sha`.

El proyecto y el dev se resuelven **en vivo** (`resolveProjectByRepo`). El mapeo repo→proyecto vive
en `roz.project_repo`; existe un fallback **opcional** (`HYPEROPS_FALLBACK`, default off) hacia un
schema `public` interno de HyperLabs — en self-host se deja apagado.

### 6. Tracking de repos nuevos
Al primer `push` de un repo no resoluble, el webhook emite `repo.detected`. El drain intenta
vincularlo a un proyecto por similitud (tokens/Levenshtein → fallback Claude); con o sin match,
notifica a los devs. No crea proyectos: deja esa decisión al humano.

---

## Núcleo de eventos (outbox + Vercel Cron)

Todo cambio de estado escribe un `OutboxEvent` en la **misma transacción** que el dato. El cron
`/v1/internal/drain` (cada minuto) drena la cola: (1) claim optimista; (2) ejecuta el efecto
chequeando `idempotency_key` (exactamente-una-vez a efectos prácticos); (3) éxito → `done`, fallo →
`failed` con backoff exponencial, y tras 5 intentos → `dead`.

> Latencia ~≤1 min. Para push instantáneo se puede añadir un *Database Webhook* de Supabase
> (pg_net) que pegue al drain al insertar — sin cambiar el resto.

---

## Modelo de datos (resumen)

Ver `migrations/0001_roz_schema.sql`:

- **dev / skill / dev_skill** — router: persona, perfil de skill (con `embedding`), nivel y carga.
- **project / project_repo** — proyecto canónico y mapeo repo→proyecto.
- **work_item** — tareas nativas (`source='native'`); el `identifier` local (ROZ-123) es canónico.
  Las columnas `linear_*` legacy se conservan de solo lectura como espejo histórico de tickets
  previos al teardown.
- **commit** — historial de commits reconciliados (proyecto/dev resueltos) para el dashboard.
- **knowledge_atom / atom_edge** — second brain: átomo direccionable y grafo de relaciones.
- **notification** — saliente email (Resend) con estado de envío y `provider_id`.
- **outbox_event / idempotency_key** — núcleo de eventos e idempotencia.

### Recuperación híbrida
Postgres da **full-text (keyword)** + **pgvector (semántico)** combinados con *reciprocal rank
fusion*. Keyword atrapa identificadores exactos (`ROZ-123`); embeddings atrapan el duplicado
disfrazado. A escala chica, KNN exacto basta.

---

## Seguridad / superficie pública

- **MCP** (`/mcp`): bearer `ROZ_MCP_TOKEN`.
- **Intake de apps** (`/v1/intake`): bearer `ROZ_INGEST_TOKEN` (el proyecto se distingue por
  `projectKey`). Para escala conviene token por app + rate limiting.
- **Webhooks**: firma de GitHub verificada por HMAC (`GITHUB_WEBHOOK_SECRET`).
- **Internal/cron** (`/v1/internal/*`): protegido por `CRON_SECRET` (Vercel inyecta el bearer).
- **Dashboard** (`/app`): Supabase Auth + filtro de dominio (`DASHBOARD_ALLOWED_DOMAINS`). El rol
  se resuelve best-effort; si la tabla de perfiles no existe, el dashboard queda de solo lectura.
- roz usa la **service role key** de Supabase: corre server-side, sin sesión de usuario.

---

## Fases de construcción

| Fase | Entrega |
|---|---|
| 0 | Scaffold: Hono+Vercel, config, db, outbox+drain (cron), MCP, webhooks stub, migración. |
| 1 | **Intake**: `propose_change` / `confirm_proposal` → tarea nativa + notificación. |
| 2 | **Router**: skills, carga derivada de tareas, sugerencia de asignado. |
| 3 | **Notificaciones**: plantillas email (Resend) idempotentes. |
| 4 | **Brain**: átomos con embeddings (OpenAI), retrieval híbrido, documentación al cierre + barrida. |
| 5 | **Reconciliación**: commits huérfanos, clasificación, dedup, auto-doc. |
| 6 | **Tracking de repos**: detección, vínculo por similitud, aviso a los devs. |
| + | **Dashboard** de visibilidad (SPA en `web/`) y **digest semanal** por email (viernes). |
