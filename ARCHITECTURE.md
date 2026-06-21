# roz — Arquitectura

`roz` es la capa de **contexto, enrutamiento y notificación** alrededor del trabajo de
desarrollo. **No es un gestor de tareas ni tiene bandeja** — esa es **Linear**. roz hace tres
cosas y solo tres:

1. **Gestionar contexto** (el *second brain*): Claude *lee* contexto del proyecto vía MCP;
   roz *escribe* contexto (casi siempre al completarse el trabajo).
2. **Enrutar**: decide a qué dev se asigna una propuesta (skill + carga).
3. **Notificar**: email (Resend).

La ingesta es **multi-canal** pero converge en el mismo pipeline (evaluar contra contexto →
documentar → enrutar → Linear): (a) **conversacional** vía MCP —el chat conduce una entrevista
guiada y roz documenta y sugiere asignado; el humano confirma—; (b) **tickets desde apps** vía
`POST /v1/intake` —auto-documentado y auto-asignado, sin humano en el loop—; (c) **directo en
Linear** —un issue nativo se espeja por webhook—. De ahí en adelante el trabajo vive en Linear. Lo
posterior (al completarse): documentar / actualizar contexto, reconciliar commits de GitHub y
avisar a quien propuso. La pieza más difícil — y la razón de varias decisiones de diseño — es **no
duplicar**: ni tickets, ni documentación, ni conocimiento.

> Reescritura 2026-06: el stack pasó de Python/FastAPI/Railway/procrastinate a **TypeScript /
> Hono / Vercel serverless**, replicando `hyperflow-core`. El código Python anterior vive en
> `../roz-legacy-api` (referencia); el frontend React en `../roz-legacy`.

---

## Principios rectores

Cuatro patrones se repiten en TODOS los dominios de roz:

1. **Identidad canónica.** Cada unidad (issue, commit, átomo de conocimiento) tiene un ID estable.
   Linear es la **fuente de verdad del trabajo**; GitHub es la **fuente de verdad del código**.
2. **Supersede, no dupliques.** Nada se borra ni se apila ciegamente: lo viejo se marca
   `superseded` y se conserva con su procedencia. Aplica al brain y a la documentación.
3. **Procedencia hacia Linear.** Todo átomo de conocimiento y toda doc generada apunta de vuelta
   al issue de Linear que la originó.
4. **MCP hacia adentro, APIs directas hacia afuera.**
   - *Adentro* (Claude/humanos → roz): roz **expone un servidor MCP** (Streamable HTTP). Así se
     "implementa un feature desde Claude": el chat llama herramientas de roz.
   - *Afuera* (roz → herramientas): roz consume **APIs/webhooks directos** de Linear, GitHub,
     Resend (email) y OpenAI/Anthropic.

---

## Stack

| Capa | Tecnología |
|---|---|
| Runtime / deploy | **Vercel serverless functions** (un solo entry `api/index.ts`) |
| Framework HTTP | **Hono** (mismo patrón que `hyperflow-core`) |
| Lenguaje | **TypeScript** (ESM, `strict`) |
| Datos + vectores | **Supabase Postgres + pgvector** (service role, server-side) |
| Razonamiento | **Claude** (Anthropic SDK, con prompt caching) — spec, clasificación, reconciliación |
| Embeddings | **OpenAI** `text-embedding-3-large` (3072 dims) — vía API (alineado con el RAG de `hyperflow-llm`) |
| Cola async | **Outbox en Postgres drenado por Vercel Cron** — sin servicio externo |
| Cara interactiva | **Servidor MCP** sobre HTTP (JSON-RPC stateless propio) |
| Integraciones | **Linear** (verdad del trabajo), **GitHub** (verdad del código), **Resend** (email) |

> **No hay worker persistente.** En serverless no existe un proceso de larga vida (adiós
> procrastinate). El rol del worker lo cumple el **outbox en Postgres + Vercel Cron**: cada
> efecto se escribe como `outbox_event` y un cron (`/v1/internal/drain`, cada minuto) toma los
> pendientes y los ejecuta. Reintentos con **backoff exponencial** (`attempts` + `next_attempt_at`)
> y **dead-letter** tras 5 intentos. Cero vendor extra; idempotencia vía `idempotency_key`.

---

## Por qué serverless cambia el diseño

Tres consecuencias directas de no tener proceso persistente:

1. **El outbox se drena por poll (Vercel Cron).** Cada cambio de estado escribe un `OutboxEvent`
   en la misma transacción que el dato (patrón outbox). Un cron (`/v1/internal/drain`, cada minuto)
   toma los `pending`/`failed` vencidos, hace un claim optimista (`pending`→`processing`) y ejecuta
   el efecto. Si falla, reprograma con backoff exponencial (`next_attempt_at`) hasta 5 intentos;
   luego `dead`. Idempotencia vía `idempotency_key` hace que el reintento sea seguro.
2. **Sin embeddings locales.** FastEmbed corría en Python local; ahora los embeddings son una
   llamada a la API de OpenAI. Implica costo por uso y latencia de red → se **cachea** el vector
   por hash de contenido y solo se reindexa cuando el cuerpo del átomo cambia.
3. **MCP stateless por request.** El servidor MCP se monta como handler HTTP (Streamable HTTP).
   Cada request trae su contexto; no hay sesión en memoria entre invocaciones.

---

## Layout del código

Un solo backend desplegable. Módulos con fronteras lógicas claras (espejo de los módulos del
roz-legacy, ahora en TS):

```
roz/
  api/
    index.ts            # entry de Vercel: re-exporta el app de Hono
  src/
    index.ts            # server local (dev) con @hono/node-server
    app.ts              # Hono app: monta middleware + rutas
    config.ts           # settings (zod) desde env
    db/
      supabase.ts       # cliente Supabase (service role)
    types/              # tipos compartidos (Hono context, dominio)
    middleware/         # logger, auth del MCP
    utils/              # errores, verificación de firmas de webhook
    events/
      outbox.ts         # escribir evento (emit) + drenar idempotente con reintentos (drainOutbox)
    adapters/           # linear, github, email(resend), anthropic, embeddings(openai)
    mcp/
      server.ts         # servidor MCP: define las tools (cara interactiva)
    intake/             # propuesta -> evaluación -> Linear (MCP + apps) [fase 1]
    router/             # sugiere asignado por skill + carga     [fase 2]
    notify/             # email (Resend): asignación, cierre, doc, repo, digest [fase 3]
    brain/              # second brain: átomos, embeddings, grafo, retrieval [fase 4]
    reconcile/          # commits (dedup/auto-doc) + repos nuevos (detección/vínculo) [fase 5]
    projects/           # resolución repo→proyecto y auto-onboarding desde Linear
    dashboard/          # queries de visibilidad de ingeniería (consumidas por web/)
    routes/             # health, mcp, webhooks (linear/github), intake, dashboard, internal
  migrations/
    0001_roz_schema.sql # schema completo (pgvector, outbox, idempotencia)
    0002_project_links.sql # alinea project (linear_project_id, hyperops_project_id, active)
    0003…0008_*.sql     # commit, timestamps de work_item, project_repo, project.kind, campos Linear, change_notified
  web/                  # SPA React (dashboard de ingeniería)
```

---

## El flujo, de punta a punta

```
┌─ Claude conversacional ─────────────┐         ┌─ roz (Vercel) ──────────────────┐
│ usuario describe un cambio/feature  │  MCP    │ propose_change(spec)            │
│  → propose_change(...)  ───────────────────▶  │   · busca contexto del proyecto │
│                                     │         │   · ¿es óptimo / debe hacerse?  │
│  ◀─── evaluación + asignado sugerido ◀──────  │   · sugiere dev (skill+carga)   │
│ usuario acepta / elige otro dev     │         │                                 │
│  → confirm_proposal(id, dev) ──────────────▶  │ crea issue en Linear (asignado) │
│                                     │         │ + escribe OutboxEvent           │
└─────────────────────────────────────┘         └───────────────┬─────────────────┘
                                                  Vercel Cron     │ cada minuto
                                                 ┌───────────────▼─────────────────┐
                                                 │ /v1/internal/drain (outbox)     │
                                                 │  · email al dev asignado        │
                                                 └─────────────────────────────────┘

Webhooks entrantes:
  Linear   → issue creado/actualizado → espeja al work_item (+ auto-onboarding de proyectos)
           → issue pasa a Done         → documenta/actualiza brain + email a quien propuso
  GitHub   → push/commit               → ¿apunta a un issue? si no, ¿trabajo huérfano sustantivo?
                                         → enlaza/dedup contra Linear + auto-doc
           → repo nuevo (1er push)     → vincula a un proyecto por similitud o avisa a los devs
```

### 1. Intake (multi-canal, sin bandeja)
roz no tiene bandeja ni estados de borrador. Tres puertas de entrada, un solo pipeline:

- **Conversacional (MCP).** Una entrevista guiada (`get_intake_form`) recoge lo mínimo y llama
  `propose_change`. roz:
  - recupera contexto relevante del brain (retrieval híbrido) para el/los proyectos implicados;
  - pide a Claude un **veredicto de optimalidad**: ¿el cambio es coherente con el contexto?,
    ¿colisiona con algo existente?, ¿debería/puede hacerse?, ¿qué riesgos?;
  - **genera el título y documenta el detalle** y corre el **router** para sugerir asignado;
  - devuelve todo al chat. El humano **acepta o elige otro dev** → `confirm_proposal`.
- **Tickets desde apps (`/v1/intake`).** Una app externa manda la solicitud cruda; roz la
  auto-documenta, auto-asigna y la lleva a Linear **sin humano en el loop** (skill `roz-intake`).
- **Directo en Linear.** Un issue creado nativo se espeja al `work_item` vía webhook.

Al confirmar/ingerir, roz **crea el issue en Linear ya asignado** (o lo espeja), guarda el
`WorkItem` y emite el evento al outbox. De ahí, Linear es la bandeja.

### 2. Router de devs
roz tiene contexto de todos los devs: skills (con embedding de perfil), disponibilidad manual y
**carga derivada** (nº de issues Linear `in progress`). Calcula `match_skill × disponibilidad`,
**propone** y un humano confirma (humano-en-el-loop al inicio; auto tras calibrar).

### 3. Notificaciones (vía outbox → drain)
Adapter de **email (Resend)** con plantillas HTML branded: **asignación**, **cierre** (al proposer),
**cambio documentado** (trabajo auto-creado desde commits, agrupado para mandar un solo correo por
push), **repo detectado** (broadcast a todos los devs) y el **digest semanal**. Cada notificación es
un efecto idempotente disparado por el drain; reclama una llave por destinatario para no enviar
duplicados aunque el evento se reintente. El campo `whatsapp` del dev queda guardado para un canal
futuro, pero hoy no se notifica por ahí.

### 4. Second brain (al completarse)
Disparado por `work_item.done` (webhook de Linear). roz toma el **delta** del work_item (título +
spec) y crea/actualiza un **átomo de conocimiento** con embedding y procedencia ligada al
identifier; si ya había un átomo para ese issue con otro contenido, lo marca **superseded** en vez
de duplicar. Reindexación de embeddings faltantes vía la barrida diaria (`/v1/internal/brain-sweep`).
**Y notifica por email a quien hizo la propuesta** (si el requester es un correo) que su cambio
quedó cerrado y documentado. *(Pendiente: extracción multi-átomo con Claude y grafo `atom_edge`.)*

### 5. Reconciliación de commits (el reto principal)
Por cada commit (webhook de GitHub):
1. **¿Apunta a un issue de Linear?** La integración nativa Linear↔GitHub lo resuelve por nombre
   de branch / magic words. Si sí → enlaza, marca documentado. **roz no reimplementa esto.**
2. Si no → **trabajo huérfano**. Una sola pasada de Claude decide en un paso: ¿trivial o
   sustantivo? y, contra los **issues abiertos del proyecto**, ¿resuelve alguno? — es **dedup
   semántico por razonamiento, sin infra de embeddings** (el contexto cabe en el prompt).
3. Trivial → se ignora. Sustantivo que resuelve un issue → enlaza. Sustantivo **sin match** → roz
   crea el issue en Linear **ya completado** (el código ya existe) y emite `change.documented` para
   avisar al autor con un único correo agrupado por push.
4. Persiste el commit (proyecto + dev resueltos) para las métricas del dashboard.
5. **Idempotencia**: la llave por `repo:sha` (`claimOnce`) se libera si algo falla **antes** de
   crear el issue; una vez creado, no se libera (el espejo posterior es best-effort).

El proyecto y el dev se resuelven **en vivo** (`resolveProjectByRepo`, por email de commit/login),
así que un repo recién mapeado queda trackeado sin re-onboarding.

### 6. Tracking de repos nuevos
Al primer `push` de un repo que roz nunca vio (no resoluble a un proyecto), el webhook emite
`repo.detected` (dedup por repo). El drain intenta **vincularlo a un proyecto existente** por
similitud de nombre —primero por tokens/Levenshtein, luego un fallback con Claude—; si hay match lo
mapea en `project_repo`, y en cualquier caso **notifica a todos los devs** (vinculado, o
"detectado sin proyecto: vincúlenlo manualmente"). No crea proyectos: deja esa decisión al humano.

Se construye **al final** (fases 5–6): necesita el índice canónico de Linear y el brain para dedup.

---

## Núcleo de eventos (outbox + Vercel Cron)

Todo cambio de estado escribe un `OutboxEvent` en la **misma transacción** que el dato. El cron
`/v1/internal/drain` (cada minuto) drena la cola. Por cada evento:

1. **claim optimista**: `update ... set status='processing' where status in ('pending','failed')`
   — si otra ejecución ya lo tomó, se salta (reentrante);
2. ejecuta el efecto **chequeando `idempotency_key`** (tabla de llaves procesadas) — un reintento
   o un webhook duplicado no produce efectos dobles (**exactamente-una-vez** a efectos prácticos);
3. éxito → `done`; fallo → `failed` con `attempts++` y `next_attempt_at` futuro (backoff
   exponencial, tope 1h); tras 5 intentos → `dead` (dead-letter, para inspección manual).

> Latencia ~≤1 min (granularidad del cron). Si se necesita push instantáneo, se puede añadir un
> *Database Webhook* de Supabase (pg_net) que pegue al drain al insertar — sin cambiar el resto.

---

## Modelo de datos (resumen)

Mismo dominio que roz-legacy, portado a SQL/pgvector (ver `migrations/0001_roz_schema.sql`):

- **dev / skill / dev_skill** — router: persona, perfil de skill (con `embedding`), nivel y carga.
- **project / project_repo** — proyecto canónico (Linear+GitHub) y mapeo repo→proyecto.
- **work_item** — espejo de Linear; `linear_id`/`identifier` (ROZ-123) es canónico.
- **commit** — historial de commits reconciliados (proyecto/dev resueltos) para el dashboard.
- **knowledge_atom / atom_edge** — second brain: átomo direccionable (`status`, `superseded_by`,
  `provenance[]`, `embedding`) y el grafo de relaciones (`references`/`derived_from`/`project`).
- **notification** — saliente email (Resend) con estado de envío y `provider_id`.
- **outbox_event / idempotency_key** — núcleo de eventos e idempotencia.

### Recuperación híbrida
Postgres da **full-text (keyword/BM25)** + **pgvector (semántico)** combinados con *reciprocal
rank fusion*. Keyword atrapa identificadores exactos (`ROZ-123`, nombres de función); embeddings
atrapa el duplicado disfrazado. A escala chica, KNN exacto basta (sin HNSW).

---

## Seguridad / superficie pública

- **MCP** (`/mcp`): protegido por bearer `ROZ_MCP_TOKEN` que presenta el Claude conversacional.
- **Intake de apps** (`/v1/intake`): bearer `ROZ_INGEST_TOKEN`, compartido entre apps (el proyecto
  se distingue por `projectKey`). Para producción a escala conviene token por app + rate limiting.
- **Webhooks**: firma verificada por proveedor (Linear `LINEAR_WEBHOOK_SECRET`, GitHub HMAC
  `GITHUB_WEBHOOK_SECRET`).
- **Internal/cron** (`/v1/internal/*`, incluye el drain del outbox): solo invocable por Vercel
  Cron (header `x-vercel-cron`) en producción.
- roz usa la **service role key** de Supabase: corre server-side, sin sesión de usuario.

---

## Fases de construcción

| Fase | Entrega |
|---|---|
| 0 | Scaffold: Hono+Vercel, config, db, outbox+drain (cron), MCP, webhooks stub, migración. |
| 1 | **Intake**: `propose_change` / `confirm_proposal` → Linear + notificación. |
| 2 | **Router**: skills, carga derivada de Linear, sugerencia de asignado. |
| 3 | **Notificaciones**: plantillas email (Resend) idempotentes — base de asignación/cierre (luego: doc, repo, digest). |
| 4 | **Brain**: átomos con embeddings (OpenAI), retrieval híbrido, documentación al cierre + barrida. |
| 5 | **Reconciliación**: commits huérfanos, clasificación, dedup, auto-doc. |
| 6 | **Tracking de repos**: detección de repos nuevos, vínculo por similitud, aviso a los devs. |
| + | **Dashboard** de visibilidad (SPA en `web/`) y **digest semanal** por email (viernes). |
