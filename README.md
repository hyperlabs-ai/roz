# roz

Capa de **contexto, enrutamiento y notificación** alrededor del trabajo de desarrollo. **No es un
gestor de tareas** — esa es Linear. roz es la capa de **inteligencia** que observa lo que pasa en
Linear y GitHub, lo entiende con IA y mantiene vivo el contexto de cada proyecto y cada dev, para
**documentar, enrutar y avisar** automáticamente — sin que nadie tenga que administrarlo.

La diferencia con un gestor de tareas: este espera que tú lo alimentes (crear el ticket, asignarlo,
marcarlo hecho, vincular el repo); roz **deriva el estado de la realidad** —commits, issues, repos—
y reconcilia. El trabajo es la fuente de verdad; roz lo interpreta.

- **Razona, no solo registra.** Ante un commit huérfano, Claude decide si es trivial o sustantivo,
  si resuelve un issue abierto existente (dedup semántico, sin embeddings) y, si no, **crea el issue
  ya documentado**. No te pide que documentes: documenta por ti.
- **Tiene contexto de proyecto.** Ancla Linear (trabajo) y GitHub (código) al mismo proyecto
  canónico, auto-onboardea proyectos nuevos, y detecta repos nuevos para vincularlos al proyecto al
  que pertenecen por similitud —o avisar para que alguien lo haga.
- **Tiene contexto de dev.** Resuelve a la misma persona a través de Linear, su login de GitHub y el
  email de sus commits; conoce su carga y disponibilidad para enrutar trabajo por **skill+capacidad**,
  no al azar.
- **Cierra el loop con la gente.** Notifica por correo lo que importa (te asignaron, tu cambio quedó
  documentado, se detectó un repo) — comunicación dirigida, no un tablero que hay que ir a revisar.
- **Segundo cerebro.** Embeddings + retrieval para recuperar contexto histórico del proyecto y
  alimentar su propio razonamiento.

## Ingesta

La ingesta es **multi-canal**, pero toda converge en el mismo pipeline: roz evalúa contra el
contexto del proyecto, documenta, sugiere asignado y lleva el trabajo a Linear.

- **Conversacional** (skill + MCP): una entrevista guiada en el chat. La skill recoge lo mínimo
  (`projectKey`, tipo, prioridad y una descripción libre) vía `get_intake_form` → `propose_change`;
  **roz** genera el título y documenta el detalle —no te pide cada campo—, recomienda devs y, tras
  elegir asignado y `confirm_proposal`, crea el issue en Linear (asignado) y notifica.
- **Tickets desde apps** (skill [`roz-intake`](https://github.com/hyperlabs-ai/hyper-skills/blob/main/roz-intake/SKILL.md)
  → `POST /v1/intake`): cualquier app externa manda la solicitud del cliente desde su **servidor**;
  roz la auto-documenta, auto-asigna y la enruta a Linear **sin humano en el loop**.
- **Directo en Linear**: un issue creado de forma nativa se espeja vía webhook; roz lo ingiere y lo
  trackea sin onboarding.

Al completarse el trabajo, roz documenta/actualiza el contexto, reconcilia los commits de GitHub y
avisa a quien lo propuso.

Arquitectura completa: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Stack

**TypeScript + Hono** sobre **Vercel serverless** (mismo patrón que `hyperflow-core`) ·
**Supabase Postgres + pgvector** · cola async = **outbox en Postgres drenado por Vercel Cron**
(sin servicio externo) · **Claude** (razonamiento) · **OpenAI** (embeddings) · **Linear / GitHub / Resend** (email) ·
**dashboard** React (SPA en `web/`).

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

Aplica las migraciones de `migrations/` **en orden** (`0001_roz_schema.sql` … `0010_…`) en tu
proyecto Supabase (SQL editor o `supabase db push`). El schema vive aislado en `roz`; asegúrate de
que `roz` esté en los *exposed schemas* de la API de Supabase (Settings → API), o todo falla con
`PGRST106`.

Después del primer despliegue, siembra los datos base desde el MCP: `sync_projects` (importa los
Linear Projects), `sync_linear_members` (vincula devs con Linear) y corre
`npx tsx scripts/backfill-embeddings.ts` para generar los embeddings de skills.

## Superficie HTTP

| Ruta | Quién llama | Qué hace |
|---|---|---|
| `GET /health` | — | healthcheck |
| `POST /mcp` | Claude conversacional (bearer) | tools de intake, devs y contexto: `get_intake_form`, `propose_change`, `confirm_proposal`, `list_projects`, `suggest_assignee`, `list_devs`, `sync_*`, `upsert_dev`, `set_availability`, `set_dev_skills`, `get_project_context` |
| `POST /webhooks/linear` | Linear | issues (espejo + cierre) y proyectos (auto-onboarding) |
| `POST /webhooks/github` | GitHub | push/commits (reconciliación) y detección de repos nuevos |
| `POST /v1/intake` | Apps de clientes (bearer) | ingesta auto-documentada y auto-asignada (skill `roz-intake`) |
| `GET /api/dashboard/*` | SPA del dashboard (auth OpsHyper) | métricas de ingeniería (proyectos, devs, commits) + salud de infraestructura |
| `GET /v1/internal/drain` | Vercel Cron (cada min) | drena el outbox (idempotente, con reintentos) |
| `GET /v1/internal/infra-poll` | Vercel Cron (cada 15 min) | sondea Vercel/Railway/Supabase y guarda el estado por servicio |
| `GET /v1/internal/brain-sweep` | Vercel Cron (diario) | rellena embeddings faltantes |
| `GET /v1/internal/weekly-digest` | Vercel Cron (viernes) | digest semanal por email (`DIGEST_RECIPIENTS`) |
| `GET *` | navegador | sirve el SPA del dashboard (`web/dist`) |

## Estado

Implementado: ingesta multi-canal (conversacional vía MCP + apps vía `/v1/intake` + espejo de
Linear), router por skill, notificación por email, second brain (documentación al cierre + retrieval
híbrido + barrida de embeddings), reconciliación de commits, tracking de repos nuevos
(detección + vínculo por similitud + aviso a los devs), dashboard de visibilidad y digest semanal.
Ver `ARCHITECTURE.md` para el detalle por fase.
