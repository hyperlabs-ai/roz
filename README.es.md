# roz

[![License: MIT](https://img.shields.io/badge/License-MIT-2853ff.svg)](LICENSE)
![Works with GitHub](https://img.shields.io/badge/Works%20with-GitHub-181717?logo=github)
![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white)

**La capa de inteligencia sobre GitHub.** Capa de **contexto, enrutamiento y
notificación** alrededor del trabajo de desarrollo. El trabajo vive en roz como **tareas nativas**
(un calendario + backlog que gestionas dentro de la app); roz es la capa de **inteligencia** que
observa lo que pasa en esas tareas y en GitHub, lo entiende con IA y mantiene vivo el contexto de
cada proyecto y cada dev, para **documentar, enrutar y avisar** automáticamente — sin que nadie
tenga que administrarlo.

> 🇬🇧 *English:* [README.md](README.md)

Lo que lo distingue de un gestor de tareas cualquiera: un tracker pasivo espera que tú lo alimentes
(marcar la tarea hecha, vincular el repo); roz **deriva el estado de la realidad** —commits, PRs,
repos— y reconcilia: una rama llamada `ROZ-123` mueve la tarea a *en curso*, una PR abierta a *en
revisión*, un merge a *completado*. El trabajo es la fuente de verdad; roz lo interpreta.

- **Razona, no solo registra.** Ante un commit huérfano, Claude decide si es trivial o sustantivo,
  si resuelve un issue abierto existente (dedup semántico, sin embeddings) y, si no, **crea el issue
  ya documentado**. No te pide que documentes: documenta por ti.
- **Tiene contexto de proyecto.** Ancla las tareas nativas (trabajo) y GitHub (código) al mismo
  proyecto canónico, auto-onboardea proyectos nuevos, y detecta repos nuevos para vincularlos al
  proyecto al que pertenecen por similitud —o avisar para que alguien lo haga.
- **Tiene contexto de dev.** Resuelve a la misma persona a través de su login de GitHub y el
  email de sus commits; conoce su carga y disponibilidad para enrutar trabajo por **skill+capacidad**,
  no al azar.
- **Tickets inteligentes que se asignan solos — y explican por qué.** En la pestaña *Ticket* (o con
  `/ticket` en el chat) escribes solo nombre, proyecto y descripción. Jev de TypeSafe lo lee y elige un
  *tipo de solución* (Endpoint / CRUD, Integración de pagos, Bug crítico…); una tabla editable lo
  convierte en skill requerida, nivel mínimo y tamaño típico, y una política pura y probada elige
  encargado → subencargado → especialista → pool, cuidando WIP y capacidad antes de la fecha límite.
  Revisas y corriges una vista previa, creas, y el responsable recibe un DM desde tu perfil. Cada
  decisión queda registrada con sus motivos; corregirla pide un motivo de categoría cerrada, para que
  el algoritmo mejore en vez de discutirse cada sprint.
- **Cierra el loop con la gente.** Notifica por correo lo que importa (te asignaron, tu cambio quedó
  documentado, se detectó un repo) — comunicación dirigida, no un tablero que hay que ir a revisar.
- **Segundo cerebro.** Embeddings + retrieval para recuperar contexto histórico del proyecto y
  alimentar su propio razonamiento.

## Stack

**TypeScript + Hono** sobre **Vercel serverless** · **Supabase Postgres + pgvector** · cola async =
**outbox en Postgres drenado por Vercel Cron** (sin servicio externo) · **Claude** (razonamiento) ·
**OpenAI** (embeddings) · **GitHub / Resend** (email) · **dashboard** React (SPA en `web/`).

Arquitectura completa: [`ARCHITECTURE.es.md`](ARCHITECTURE.es.md).

## Self-hosting

roz es open source bajo [MIT](LICENSE). **No hay servicio hospedado** — despliegas el tuyo, así que
**tus datos viven en tu propia base de datos**.

### Prerrequisitos (cuentas)

| Servicio | Para qué |
|---|---|
| **Supabase** | Postgres + pgvector (la base de datos de roz) |
| **Vercel** | runtime serverless + cron |
| **GitHub** | un PAT fine-grained — ver [`docs/GITHUB-SETUP.md`](docs/GITHUB-SETUP.md) |
| **Anthropic** | Claude (razonamiento) |
| **OpenAI** | embeddings (`text-embedding-3-large`, 3072 dims) |
| **Resend** | email transaccional |
| **TypeSafe** *(opcional)* | Jev — clasifica tareas para la asignación automática (`TYPESAFE_API_KEY`) |

Los tokens de observabilidad de infraestructura (Vercel / Railway / Supabase Management) son
**opcionales** y degradan sin romper. Sin `TYPESAFE_API_KEY` la asignación automática se apaga y
`/v1/intake` sigue con el router de embeddings. Para que asigne bien, llena **Capacidad**
(`/app/capacity`: quién encabeza o apoya cada proyecto, horas semanales) y **Skills** (`/app/skills`:
niveles 1–5 y la tabla de *tipos de solución*). La `availability` (0–1) de un dev es la fracción de su
tiempo disponible para tareas:
bájala por juntas o ausencias, no porque ya tenga muchas tareas (la carga se calcula de las tareas).

### Pasos

```bash
# 1. Instalar
npm install
npm install --prefix web

# 2. Configurar
cp .env.example .env        # llena tus claves (ver los comentarios del archivo)

# 3. Correr local (http://localhost:3000)
npm run dev                 # GET /health -> { "status": "ok" }
```

1. **Base de datos.** Aplica las migraciones de `migrations/` **en orden** (`0001_roz_schema.sql` …
   `0011_pr_attribution.sql`) en tu proyecto Supabase (SQL editor o `supabase db push`). El schema
   vive aislado en `roz`; asegúrate de que `roz` esté en los *exposed schemas* de la API
   (Supabase → Settings → API), o todo falla con `PGRST106`.
2. **Despliega** a Vercel. `vercel.json` define los crons (drain del outbox cada minuto, infra-poll
   cada 15 min, brain-sweep diario, digest semanal los viernes). Setea `CRON_SECRET` en producción o
   los crons responden `403`.
3. **Conecta GitHub.** Sigue [`docs/GITHUB-SETUP.md`](docs/GITHUB-SETUP.md) (scopes del PAT + webhook).
4. **Siembra.** Corre `npx tsx scripts/backfill-embeddings.ts` para los embeddings de skills.
   Opcional: `npx tsx scripts/backfill-commits.ts` para commits históricos. Crea tus proyectos y
   tareas de forma nativa desde el dashboard.

La **landing** pública se sirve en `/`; el **dashboard** de operación vive detrás de login en `/app`.

> **Fallback de HyperOps.** roz se construyó en HyperLabs y tiene un fallback interno opcional
> (`HYPEROPS_FALLBACK`, default `false`) para resolver repos vía un schema `public` aparte. Déjalo
> apagado en self-host — roz usa su propio mapeo `roz.project_repo` + proyectos manuales.

## Superficie HTTP

| Ruta | Quién llama | Qué hace |
|---|---|---|
| `GET /health` | — | healthcheck |
| `POST /mcp` | Claude (bearer `ROZ_MCP_TOKEN`) | tools de intake, devs y contexto |
| `POST /webhooks/github` | GitHub | push/commits (reconciliación), ciclo de vida de PRs (estado de tareas) y detección de repos; HMAC verificado |
| `POST /v1/intake` | Apps de clientes (bearer `ROZ_INGEST_TOKEN`) | ingesta auto-documentada y auto-asignada; `autoAssign` en la respuesta dice cómo (`assigned` / `escalated` / `pending` / `failed` / `legacy`) |
| `POST /api/dashboard/ticket/preview` | SPA del dashboard | ticket inteligente: Jev lo lee, roz completa tipo/skills/puntos/urgencia y propone responsable (sin crear la tarea) |
| `POST /api/dashboard/ticket` | SPA del dashboard | crea el ticket previsualizado, asignado, y manda un DM al responsable desde el perfil de quien lo pidió |
| `GET/POST/PATCH /api/dashboard/solution-types` | SPA del dashboard | tabla de tipos de solución (Skills → Tipos de solución) |
| `POST /api/dashboard/projects/:id/profile/suggest` | SPA del dashboard | propone tipo y descripción del proyecto leyendo sus repos de GitHub (no escribe) |
| `POST /api/dashboard/tickets/:id/auto-assign` | SPA del dashboard | corre la asignación automática sobre una tarea abierta sin responsable |
| `GET /api/dashboard/tickets/:id/assignment` | SPA del dashboard | por qué roz eligió (o no): clasificación, candidatos con motivos, payload exacto enviado a Jev |
| `GET /api/dashboard/*` | SPA del dashboard (auth Supabase + dominio) | métricas de ingeniería + salud de infra |
| `GET /v1/internal/drain` | Vercel Cron (cada min) | drena el outbox (idempotente, con reintentos) |
| `GET /v1/internal/infra-poll` | Vercel Cron (cada 15 min) | sondea Vercel/Railway/Supabase |
| `GET /v1/internal/brain-sweep` | Vercel Cron (diario) | rellena embeddings faltantes |
| `GET /v1/internal/weekly-digest` | Vercel Cron (viernes) | digest de equipo + por dev |
| `GET *` | navegador | sirve la SPA del dashboard / la landing pública |

## Estado

Implementado: ingesta multi-canal (conversacional vía MCP + apps vía `/v1/intake` + tareas
nativas), router por skill, notificación por email, second brain (documentación al cierre + retrieval
híbrido + barrida de embeddings), reconciliación de commits, tracking de repos nuevos (detección +
vínculo por similitud + aviso a los devs), dashboard de visibilidad y digest semanal. Ver
[`ARCHITECTURE.es.md`](ARCHITECTURE.es.md) para el detalle por fase.

## Licencia

[MIT](LICENSE) © HyperLabs. Soporte: **manuel@hyperlabs.vc**.
