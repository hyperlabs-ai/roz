# roz

Capa de **contexto, enrutamiento y notificación** alrededor del trabajo de desarrollo. **No es
un gestor de tareas** — esa es Linear. roz: gestiona el *second brain*, enruta propuestas al dev
correcto y notifica por WhatsApp.

La ingesta es **conversacional**: el Claude conversacional redacta una propuesta y la envía a roz
**vía MCP**; roz la evalúa contra el contexto del proyecto, sugiere asignado, y —tras la
confirmación en el chat— crea el issue en Linear (asignado) y notifica. Al completarse el trabajo,
roz documenta/actualiza contexto, reconcilia commits de GitHub y avisa a quien propuso.

Arquitectura completa: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Stack

**TypeScript + Hono** sobre **Vercel serverless** (mismo patrón que `hyperflow-core`) ·
**Supabase Postgres + pgvector** · cola async = **outbox en Postgres drenado por Vercel Cron**
(sin servicio externo) · **Claude** (razonamiento) · **OpenAI** (embeddings) · **Linear / GitHub / Twilio**.

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

Aplica `migrations/0001_init.sql` en tu proyecto Supabase (SQL editor o `supabase db push`).

## Superficie HTTP

| Ruta | Quién llama | Qué hace |
|---|---|---|
| `GET /health` | — | healthcheck |
| `POST /mcp` | Claude conversacional (bearer) | tools: `propose_change`, `confirm_proposal`, `list_devs`, `get_project_context` |
| `POST /webhooks/linear` | Linear | cambios de estado de issues |
| `POST /webhooks/github` | GitHub | push/commits |
| `POST /webhooks/twilio` | Twilio | estado de mensajes WhatsApp |
| `GET /v1/internal/drain` | Vercel Cron (cada min) | drena el outbox (idempotente, con reintentos) |
| `GET /v1/internal/*` | Vercel Cron | barridas/digest |

## Estado

Fase 0 (scaffold) listo: estructura, MCP, outbox+drain (cron), webhooks, migración. Lógica de negocio
de cada fase marcada con `TODO fase N` (ver tabla de fases en `ARCHITECTURE.md`).
