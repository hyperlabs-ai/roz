# roz

Capa de **contexto, enrutamiento y notificación** alrededor del trabajo de desarrollo. **No es
un gestor de tareas** — esa es Linear. roz: gestiona el *second brain*, enruta propuestas al dev
correcto y notifica por **email** (Resend).

La ingesta es **conversacional**: el Claude conversacional redacta una propuesta y la envía a roz
**vía MCP**; roz la evalúa contra el contexto del proyecto, sugiere asignado, y —tras la
confirmación en el chat— crea el issue en Linear (asignado) y notifica. Al completarse el trabajo,
roz documenta/actualiza contexto, reconcilia commits de GitHub y avisa a quien propuso.

Arquitectura completa: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Stack

**TypeScript + Hono** sobre **Vercel serverless** (mismo patrón que `hyperflow-core`) ·
**Supabase Postgres + pgvector** · cola async = **outbox en Postgres drenado por Vercel Cron**
(sin servicio externo) · **Claude** (razonamiento) · **OpenAI** (embeddings) · **Linear / GitHub / Resend** (email).

> Versión anterior (Python/FastAPI/Railway): `../roz-legacy-api`. Frontend React: `../roz-legacy`.

## Desarrollo local

```bash
npm install
cp .env.example .env      # llena las claves que necesites
npm run dev               # http://localhost:3000
```

`GET /health` debe responder `{ "status": "ok" }`. En local los efectos quedan `pending` en el
outbox; puedes drenarlos manualmente con `GET /v1/internal/drain` (en dev no exige el header de cron).

## Migración

Aplica `migrations/0001_roz_schema.sql` y luego `migrations/0002_project_links.sql` en tu
proyecto Supabase (SQL editor o `supabase db push`). El schema vive aislado en `roz`; asegúrate
de que `roz` esté en los *exposed schemas* de la API de Supabase (Settings → API).

Después del primer despliegue, siembra los datos base desde el MCP: `sync_projects` (importa los
Linear Projects), `sync_linear_members` (vincula devs con Linear) y corre
`npx tsx scripts/backfill-embeddings.ts` para generar los embeddings de skills.

## Superficie HTTP

| Ruta | Quién llama | Qué hace |
|---|---|---|
| `GET /health` | — | healthcheck |
| `POST /mcp` | Claude conversacional (bearer) | tools: `propose_change`, `confirm_proposal`, `list_devs`, `get_project_context` |
| `POST /webhooks/linear` | Linear | cambios de estado de issues (espejo + cierre) |
| `POST /webhooks/github` | GitHub | push/commits (reconciliación) |
| `POST /v1/intake` | Apps de clientes (bearer) | ingesta auto-documentada y auto-asignada |
| `GET /v1/internal/drain` | Vercel Cron (cada min) | drena el outbox (idempotente, con reintentos) |
| `GET /v1/internal/brain-sweep` | Vercel Cron (diario) | rellena embeddings faltantes |

## Estado

Fases 1–5 implementadas: intake (MCP + apps), router por skill, notificación por email,
second brain (documentación al cierre + retrieval híbrido + barrida de embeddings) y
reconciliación de commits. El digest semanal queda pendiente (sin modelo de destinatarios).
Ver `ARCHITECTURE.md` para el detalle por fase.
