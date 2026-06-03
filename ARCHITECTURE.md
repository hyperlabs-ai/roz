# roz — Arquitectura

`roz` es la capa de **contexto, enrutamiento y notificación** alrededor del trabajo de
desarrollo. **No es un gestor de tareas ni tiene bandeja** — esa es **Linear**. roz hace tres
cosas y solo tres:

1. **Gestionar contexto** (el *second brain*): Claude *lee* contexto del proyecto vía MCP;
   roz *escribe* contexto (casi siempre al completarse el trabajo).
2. **Enrutar**: decide a qué dev se asigna una propuesta (skill + carga).
3. **Notificar**: WhatsApp / email.

El **Claude conversacional** redacta la propuesta (usando contexto del brain si lo necesita) y la
envía a roz **vía MCP**; roz la evalúa contra el contexto del proyecto, sugiere asignado, y —tras
la confirmación del humano en el chat— crea el issue en Linear (ya asignado) y notifica por
WhatsApp. De ahí en adelante el trabajo vive en Linear. Lo posterior (al completarse): documentar
/ actualizar contexto, reconciliar commits de GitHub y avisar a quien propuso. La pieza más
difícil — y la razón de varias decisiones de diseño — es **no duplicar**: ni tickets, ni
documentación, ni conocimiento.

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
     Twilio (WhatsApp) y OpenAI/Anthropic.

---

## Stack

| Capa | Tecnología |
|---|---|
| Runtime / deploy | **Vercel serverless functions** (un solo entry `api/index.ts`) |
| Framework HTTP | **Hono** (mismo patrón que `hyperflow-core`) |
| Lenguaje | **TypeScript** (ESM, `strict`) |
| Datos + vectores | **Supabase Postgres + pgvector** (service role, server-side) |
| Razonamiento | **Claude** (Anthropic SDK, con prompt caching) — spec, clasificación, reconciliación |
| Embeddings | **OpenAI** `text-embedding-3-small` (1536 dims) — vía API |
| Cola async | **Outbox en Postgres drenado por Vercel Cron** — sin servicio externo |
| Cara interactiva | **Servidor MCP** sobre HTTP (JSON-RPC stateless propio) |
| Integraciones | **Linear** (verdad del trabajo), **GitHub** (verdad del código), **WhatsApp/Twilio** |

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
    adapters/           # linear, github, whatsapp(twilio), anthropic, embeddings(openai)
    mcp/
      server.ts         # servidor MCP: define las tools (cara interactiva)
    intake/             # propuesta -> evaluación -> Linear     [fase 1]
    router/             # sugiere asignado por skill + carga     [fase 2]
    brain/              # second brain: átomos, embeddings, grafo, retrieval [fase 4]
    reconcile/          # dedup de commits / auto-doc            [fase 5]
    routes/             # health, mcp, webhooks (linear/github/twilio), queue, internal
  migrations/
    0001_init.sql       # schema completo (pgvector, outbox, idempotencia)
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
                                                 │  · WhatsApp al dev asignado     │
                                                 └─────────────────────────────────┘

Webhooks entrantes:
  Linear   → issue pasa a Done  → documenta/actualiza brain + WhatsApp a quien propuso
  GitHub   → push/commit        → ¿apunta a un issue? si no, ¿es trabajo huérfano sustantivo?
                                  → enlaza/dedup contra Linear + brain
```

### 1. Intake (un solo paso, vía MCP)
roz no tiene bandeja ni estados de borrador. El Claude conversacional llama a la tool MCP
`propose_change` con la spec redactada. roz:
- recupera contexto relevante del brain (retrieval híbrido) para el/los proyectos implicados;
- pide a Claude un **veredicto de optimalidad**: ¿el cambio es coherente con el contexto?,
  ¿colisiona con algo existente?, ¿debería/puede hacerse?, ¿qué riesgos?;
- corre el **router** para sugerir asignado;
- devuelve todo al chat. El humano **acepta o elige otro dev** → `confirm_proposal`.

Al confirmar, roz **crea el issue en Linear ya asignado**, guarda el `WorkItem` espejo y emite
`work_item.created` al outbox. De ahí, Linear es la bandeja.

### 2. Router de devs
roz tiene contexto de todos los devs: skills (con embedding de perfil), disponibilidad manual y
**carga derivada** (nº de issues Linear `in progress`). Calcula `match_skill × disponibilidad`,
**propone** y un humano confirma (humano-en-el-loop al inicio; auto tras calibrar).

### 3. Notificaciones (vía outbox → drain)
Adapter de **WhatsApp (Twilio)** con plantillas pre-aprobadas por Meta (asignación, cambio de
estado, nudge, digest). Cada notificación es un efecto idempotente disparado por el drain.

### 4. Second brain (al completarse)
Disparado por `work_item.done` (webhook de Linear). roz junta el **delta** (spec + diff del PR +
descripción), pide a Claude **extracción + reconciliación**: crea átomos nuevos, **supersede** los
obsoletos, busca por similitud antes de crear para no duplicar. Análisis de impacto cross-project
vía el grafo (`AtomEdge`); reindexa embeddings; procedencia ligada al issue. **Y notifica por
WhatsApp a quien hizo la propuesta** que su cambio quedó cerrado y documentado.

### 5. Reconciliación de commits (el reto principal)
Por cada commit (webhook de GitHub):
1. **¿Apunta a un issue de Linear?** La integración nativa Linear↔GitHub lo resuelve por nombre
   de branch / magic words. Si sí → enlaza, marca documentado. **roz no reimplementa esto.**
2. Si no → **trabajo huérfano**. Un clasificador (Claude) decide: ¿trivial o sustantivo?
3. Si es sustantivo → **búsqueda semántica** contra issues y átomos. Solo crea ticket/doc si NO
   hay match sobre el umbral.
4. **Idempotencia**: cada commit y cada doc tiene llave estable (issue ID o hash normalizado);
   se procesa una sola vez.

Se construye **al final** (fase 5): necesita el índice canónico de Linear y el brain para dedup.

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

Mismo dominio que roz-legacy, portado a SQL/pgvector (ver `migrations/0001_init.sql`):

- **dev / skill / dev_skill** — router: persona, perfil de skill (con `embedding`), nivel y carga.
- **project / work_item** — espejo de Linear; `linear_id`/`identifier` (ROZ-123) es canónico.
- **knowledge_atom / atom_edge** — second brain: átomo direccionable (`status`, `superseded_by`,
  `provenance[]`, `embedding`) y el grafo de relaciones (`references`/`derived_from`/`project`).
- **notification** — saliente WhatsApp/email con estado de envío y `provider_id`.
- **outbox_event / idempotency_key** — núcleo de eventos e idempotencia.

### Recuperación híbrida
Postgres da **full-text (keyword/BM25)** + **pgvector (semántico)** combinados con *reciprocal
rank fusion*. Keyword atrapa identificadores exactos (`ROZ-123`, nombres de función); embeddings
atrapa el duplicado disfrazado. A escala chica, KNN exacto basta (sin HNSW).

---

## Seguridad / superficie pública

- **MCP** (`/mcp`): protegido por bearer `ROZ_MCP_TOKEN` que presenta el Claude conversacional.
- **Webhooks**: firma verificada por proveedor (Linear `LINEAR_WEBHOOK_SECRET`, GitHub HMAC
  `GITHUB_WEBHOOK_SECRET`, Twilio firma de request).
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
| 3 | **Notificaciones**: plantillas WhatsApp aprobadas + cambios de estado. |
| 4 | **Brain**: átomos, embeddings (OpenAI), grafo, retrieval híbrido; loop de actualización. |
| 5 | **Reconciliación**: commits huérfanos, clasificación, dedup, auto-doc. |
