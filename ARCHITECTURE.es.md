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
| Juicios | **TypeSafe Jev** (`fetch` directo, opcional) — preguntas tipadas sobre una tarea para la asignación automática |
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
    adapters/           # github, email(resend), anthropic, embeddings(openai), typesafe(jev)
    mcp/server.ts       # servidor MCP: define las tools (cara interactiva)
    intake/             # propuesta -> evaluación -> tarea nativa (MCP + apps) [fase 1]
    assign/             # asignación automática: Jev juzga, la política pura decide, registro de decisiones
    router/             # sugerencia por embeddings (MCP, e intake con assign/ apagado) [fase 2]
    notify/             # email (Resend): asignación, cierre, doc, repo, digest [fase 3]
    brain/              # second brain: átomos, embeddings, grafo, retrieval [fase 4]
    reconcile/          # commits (dedup/auto-doc) + repos nuevos (detección/vínculo) [fase 5-6]
    projects/           # resolución repo→proyecto y auto-onboarding de proyectos
    dashboard/          # queries de visibilidad de ingeniería (consumidas por web/)
    chat/               # chat del equipo: canales, MDs, hilos, adjuntos, tiempo real y push
    routes/             # health, mcp, webhooks (github), intake, dashboard (+ chat), internal
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

### 2. Tickets inteligentes y asignación automática (`src/tickets/`, `src/assign/`)
**`/ticket`** (la pestaña *Ticket* en `/app/ticket`, o escribir `/ticket` en el chat): cualquiera del
equipo escribe solo **nombre, proyecto y descripción**. roz lo lee con Jev, completa el resto (tipo de
solución, skills, nivel, puntos, urgencia), propone responsable y lo muestra en una **vista previa**
corregible. Corregir tipo, puntos, prioridad o fecha NO vuelve a llamar a Jev: se reusa su respuesta y
solo se recalcula la política. Al **crear**, la tarea queda asignada y el responsable recibe un DM
**desde el perfil de quien pidió el ticket** ("Te asigné una nueva tarea #KEY-12"). La vista previa es
una fila `preview` de `assignment_decision` que, al crear, pasa a ser la decisión de la tarea.

La misma asignación corre con `/v1/intake` y con el botón "Asignar automáticamente" de una tarea
abierta sin responsable. El diálogo normal de "Nueva tarea" ya **no** autoasigna (`POST /tickets` solo
lo hace con `autoAssign: true`).

**Skills ≠ tipos de solución.** Una *skill* es lo que sabe una persona (nivel 1–5). Un *tipo de
solución* (`roz.solution_type`, 0032, editable en Skills → Tipos de solución) es qué clase de trabajo
es la tarea, y fija skill primaria (o "la del módulo afectado", para bugs y refactor), nivel mínimo,
skill secundaria y tamaño típico. Jev solo elige el tipo; la tabla decide el resto.

**Jev juzga, el código decide.** Una sola request a TypeSafe por tarea (`jev-questions.ts`, el único
lugar con la redacción y los umbrales; preguntas `q2`) responde solo lo que exige leer la tarea: qué
tipo de solución es (Choice + Noul compañero), qué skill/módulo toca (Choice + Noul), qué tan grande
(Score → 1/2/3/5/8/13 puntos; por debajo del mínimo del tipo se sube al mínimo, por encima del máximo se
respeta y se avisa), si hay producción caída / un cliente bloqueado (dos Nouls) y el proyecto si falta.
Las preguntas van en inglés (donde Jev es más preciso); el texto de la tarea y la tabla de tipos van
tal cual. Jev nunca ve personas ni fechas. Lo que fijó una persona gana (proyecto, tipo, prioridad,
fecha, estimación). Sin tipo claro, la tarea pide decisión humana.

**Contexto del proyecto (q3, migración 0033).** Jev recibe el *perfil* del proyecto —tipo principal
(landing, e-commerce, app web con backend, app móvil, API, producto con IA) y una descripción—, para no
leer "arreglar un botón" igual en una landing que en una app con backend. Y una pregunta más,
`server_side` (¿toca el lado del servidor?): en un bug/refactor de un proyecto **con backend**, si el
ticket no es claramente solo interfaz, la skill que adivinó Jev no filtra y la tarea va primero con
quien lleva el proyecto. El perfil lo propone roz leyendo los repos en GitHub (`src/projects/profile.ts`):
Jev juzga el tipo; la descripción la redacta Claude o, si no está disponible, se arma con lo que dice
GitHub (descripción/README y stack detectado). Queda marcado "IA" hasta que una persona lo revisa;
`scripts/fill-project-profiles.ts` llena los vacíos de todos los proyectos sin pisar lo humano.

Todo lo demás es una **política pura y probada** (`policy.ts`, `p2`):

1. **Filtros duros** (excluyen, nunca penalizan): activo, rol asignable (dev/designer/intern),
   disponibilidad > 0, skill ≥ nivel pedido, WIP ≤ 3 tareas activas (`en_progreso` + `revision`, como
   principal) y ≤ 2 proyectos simultáneos.
2. **Orden:** encargado (`dev_assignment` principal) → subencargado (secundaria) → especialista (nivel
   ≥ 4) → pool. Si la tarea pide nivel ≥ 4, el especialista va primero. La skill secundaria del tipo no
   excluye a nadie: entre especialistas y en el pool ordena a quienes empatan en la primaria.
3. **Desempate** (dentro de cada grupo): entre candidatos a ≤ 1 nivel, gana el de nivel menor si la
   tarea es de ≤ 3 pts, no urgente y hay revisor senior (nivel ≥ 4) — evita el punto único de falla.
4. **Tamaño efectivo** (costo de contexto): ×1.0 encargado, ×1.15 subencargado, ×1.3 externo, ×1.5
   externo sin historial en el proyecto (1 pt = 2 h).
5. **Capacidad como filtro por candidato:** carga + horas efectivas ≤ 85% de las horas que le quedan
   antes de la fecha límite (días hábiles × horas semanales / 5 × disponibilidad). Gana el primero que cabe.
6. **Escalar** si nadie cabe: sugiere dividir (el especialista define el approach en 1–2 h, el encargado
   implementa), repriorizar (quién cabría posponiendo trabajo de menor prioridad) o backlog. La tarea
   queda sin asignar con un "Necesita decisión" visible; nada se divide solo.

**Registro y overrides.** Cada corrida escribe `roz.assignment_decision` (0031): el payload exacto que
se mandó a Jev y el modelo, la clasificación con la fuente de cada campo, cada candidato con sus
motivos y el resultado. Cambiar al responsable que eligió roz pide un **motivo de categoría cerrada**
(una vez): ese log es lo que hace que el algoritmo mejore en vez de discutirse cada sprint. Un fallo de
Jev es un error (tarea sin asignar y marcada, reintentada por el outbox), nunca un "no". Crear una
tarea nunca espera a Jev: la corrida va por el evento `work_item.auto_assign` del outbox, procesado al
instante en segundo plano. Sin `TYPESAFE_API_KEY` la función está apagada y el intake sigue con el
router de embeddings (`src/router/`).

### 3. Notificaciones (vía outbox → drain)
Adapter de **email (Resend)** con plantillas HTML branded: asignación, cierre, cambio documentado,
repo detectado y digest semanal. Cada notificación es un efecto idempotente disparado por el drain;
reclama una llave por destinatario para no enviar duplicados aunque el evento se reintente.

**Interruptores (killswitch).** `roz.notification_switch` gobierna si roz envía, con dos alcances
que se multiplican: **global** (todo el entorno) y **por persona**. Se mueven desde Configuración en
el dashboard, sin redeploy. Con el interruptor apagado el aviso se **omite en silencio** en vez de
lanzar: el evento del outbox cierra en `done` y la cola no se llena de dead-letters — que es lo que
pasaba cuando Resend fallaba de forma permanente (dominio sin verificar, cuota agotada).

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

### 7. Chat del equipo
Un chat estilo Slack dentro del dashboard (`/app/chat`): canales públicos y privados, mensajes
directos (1:1 y grupales), hilos, adjuntos, @menciones (incluido `@canal`) y edición/borrado de los
mensajes propios. La identidad es `roz.dev`, la misma de toda la app. El código vive en `src/chat/`
(reglas puras en `rules.ts`/`text.ts`, probadas sin base) y la API en `/api/dashboard/chat/*`.

- **Mensaje → tarea.** Cada mensaje tiene la acción "Crear tarea": abre el diálogo de tarea con
  título, descripción (con enlace de vuelta) y responsables (los mencionados) ya llenos. La tarea
  guarda `work_item.chat_message_id`; el mensaje muestra su ficha con estado y responsables
  actuales, y en su hilo queda un aviso de sistema. Desde la tarea, "Ver conversación de origen"
  abre ese hilo.
- **Citar tareas.** En el compositor, `@tarea <persona> <texto>` busca tareas (las palabras que
  coinciden con un dev filtran por responsable; el resto, por nombre o identificador) e inserta
  `#ROZ-12`. El texto se guarda tal cual —el identificador ya es canónico y estable— y el backend
  resuelve las tarjetas al leer, en una sola consulta por página. Cada cita se pinta con la MISMA
  tarjeta del kanban (`web/src/components/tasks/card-parts.tsx`, compartida con el tablero), con su
  estado y responsables actuales, y abre la tarea al hacer clic.
- **Tiempo real: un buzón por persona.** Supabase Realtime Broadcast en canales PRIVADOS
  (`chat:dev:<devId>`). El backend publica cada mensaje ya completo, con UNA petición REST para
  todos los miembros. La policy sobre `realtime.messages` (migración 0030) deja a cada cliente
  escuchar solo su buzón, con el mismo mapeo usuario→dev que el auth del dashboard. Si el socket no
  está, el cliente sigue con polling de `/chat/unread` y re-sincroniza la conversación abierta.
  **Paso manual en Supabase:** desactivar "Allow public access" en Realtime → Settings para que
  solo existan canales privados.
- **Push sin outbox.** Un chat que avisa un minuto tarde no sirve, así que el push de los mensajes
  NO pasa por el outbox: sale justo después de responder (`waitUntil`, `src/utils/background.ts`)
  y es best-effort como el resto de push. Respeta los interruptores de Configuración y el nivel de
  aviso de cada conversación (todos / solo menciones / silenciado; MD → todos, canal → menciones).
  El service worker no muestra el aviso si la persona ya tiene esa conversación abierta y enfocada.
  Los envíos exitosos no se registran en `roz.notification` (solo los fallos): serían uno por mensaje.
- **Adjuntos privados.** Bucket `chat-attachments` privado; el backend firma URLs temporales al
  entregar mensajes. Mismo tope de 4 MB que los adjuntos de tareas (límite de body de Vercel).

#### 7b. Chat de Discord (`ROZ_DISCORD_CHAT`, default `false`)
Con el flag encendido el chat de `/app/chat` deja de ser el interno y muestra los canales reales del
servidor de Discord de la empresa, con el diseño de roz. Con el flag apagado todo lo anterior queda
idéntico. Contrato completo en `docs/discord-chat-contracts.md`; tablas `discord_*` en la migración 0038.
- **Puente (`discord-bridge/`, Railway).** Servicio Node + discord.js aparte, porque el gateway de
  Discord necesita una conexión persistente que Vercel no da. Espeja en Supabase el servidor completo
  (categorías, canales, hilos, roles, miembros, emojis, mensajes, reacciones, ediciones y borrados
  suaves), hace backfill y se pone al día en cada `READY`, y después de escribir avisa a roz por
  `POST /v1/internal/discord/events` (Bearer `ROZ_BRIDGE_SECRET`; 404 con el flag apagado). Copia
  `src/types/discord.ts`, `reply.ts` y `normalize.ts` con `npm run sync-shared` (un test falla si se
  desfasan). No se despliega en Vercel (`.vercelignore`).
- **Lectura** (`src/discord/`, `/api/dashboard/discord/*`). Sale del espejo, filtrada por el
  algoritmo oficial de permisos de Discord (`permissions.ts`, puro y probado): @everyone + roles +
  overwrites, ADMINISTRATOR ve todo, los hilos heredan del padre. Sin cuenta ligada (OAuth2
  `identify`, callback en `/api/discord/callback`) no se ve ningún canal.
- **Escritura.** Por un webhook del canal (token cifrado con `utils/crypto.ts`) con el nombre del dev
  y su foto de GitHub; respuestas como cita + mención, hilos, adjuntos y menciones seguras. Editar y
  borrar solo lo propio enviado desde roz. El eco del gateway se funde con la fila de roz
  (`client_nonce`/`dev_id`). Reacciones de solo lectura.
- **Tiempo real.** Los mismos buzones privados `chat:dev:<devId>` del chat interno, con eventos
  `discord.*`, solo a quien puede ver el canal.
- **Lo de roz que sigue.** Fichas de tarea (`#HYP-12`, `ROZ-123`), "crear issue desde un mensaje"
  (Linear con `ROZ_LINEAR_SOT`, tarea nativa sin él) y el aviso de `/ticket`: con el flag se publica
  en el canal mapeado al proyecto mencionando al responsable, o por DM del bot (`src/discord/notify.ts`).
  Las escrituras del chat interno responden 409 `CHAT_REPLACED_BY_DISCORD` (leer sigue permitido).
- **Límites de Discord** (la UI los explica): no se ven los DMs personales ni la voz, y no se puede
  escribir como la cuenta real (sale como webhook con etiqueta APP).
- **Comandos `/roz` y acciones de mensaje** (`src/discord/commands/`, contrato
  `docs/discord-commands-contract.md`). Un solo comando de servidor `/roz` con subcomandos (`tarea`,
  `ticket`, `status`, `plan`, `pulso`, `infra`, `junta`) y tres acciones de mensaje ("Crear tarea con
  roz", "Guardar como decisión", "Citar tareas"). Sin URL pública: el puente recibe
  `INTERACTION_CREATE` por el gateway y la reenvía a `POST /v1/internal/discord/interactions` (Bearer
  `ROZ_BRIDGE_SECRET`, comparado en tiempo constante); roz devuelve el `callback` exacto de Discord y el
  puente lo manda. Para los 3 s: el router (`router.ts`) corre el handler con un presupuesto (≤ 1,8 s
  según el snowflake); si no alcanza, responde diferido (type 5/6) y completa en segundo plano con el
  token de la interacción (`PATCH @original` / followup). Modales y autocompletado no se pueden
  diferir. El puente espera ≤ 2,5 s y, si roz no contesta, manda un fallback efímero.
  - **Identidad y permisos**: el usuario de Discord → su dev (`discord_link` ⋈ dev activo); sin vínculo,
    efímero con el link a Configuración. Interacciones de otro servidor o app no se ejecutan. Los
    `custom_id` (`roz1:<acción>:<ids>`, `custom-id.ts`) solo llevan ids validados por tipo; todo se
    revalida en el servidor con los servicios de siempre (planes: solo su dueño aprueba; tareas: reglas
    del PATCH del dashboard, Linear con `ROZ_LINEAR_SOT`; mensajes: permisos del espejo).
  - **Respuestas** (`respond.ts`): efímero para consultas y errores, público para fichas, status y
    tickets; `allowed_mentions` siempre `parse: []` (solo suenan los usuarios que el handler nombra);
    topes de Discord recortados; errores sin detalle crudo ni tokens. Embeds naranja `#ff5b23`, autor
    "roz" y Roz-bot según el caso (`embeds.ts`, `links.ts`; se omiten si la URL de roz es local).
  - **Registro** (`register.ts`): comandos de servidor, idempotente por hash. Al primer `READY` el
    puente llama a `POST /v1/internal/discord/commands/sync`; a mano `npm run discord:commands` (roz) o
    `npm run register-commands` (puente).
  - **Paridad en roz** (`from-roz.ts`, `/api/dashboard/discord/commands*`): el compositor del chat de
    Discord tiene "/" con los mismos subcomandos, "@tarea" y el botón "Status"; corre el MISMO handler
    con un contexto sin token, como el dev de la sesión, y publica lo público por el webhook del dev.

### 8. roz v2: Linear como fuente de verdad, juntas, planes del agente y Pulso
Todo detrás de **`ROZ_LINEAR_SOT`** (default `false`). Con el flag apagado roz se comporta como
antes: las rutas nuevas de juntas, planes, runners y `/v1/runner` responden `409 LINEAR_SOT_OFF`, los
crons nuevos se saltan y el webhook de Linear responde 200 sin emitir. Contratos entre módulos en
`docs/roz-v2-contracts.md`; tablas en las migraciones 0036 y 0037.

- **Linear manda (`src/linear/`).** `work_item` pasa a ser espejo de solo lectura (columnas
  `linear_*`), alimentado por `POST /webhooks/linear` (firma + anti-replay → outbox `linear.webhook`)
  y por la reconciliación GraphQL cada 30 min (`/v1/internal/linear-reconcile`, que sustituye a
  `ops-bridge` con el flag encendido). El espejo es monótono por `updatedAt` y emite los efectos
  (`plan.enqueue`, `work_item.assigned`, `work_item.done`). `/ticket` e intake siguen pasando por Jev
  y la política p2, pero crean el issue en Linear. Las demás escrituras de tareas responden
  `409 TASKS_READ_ONLY` (`assertTasksWritable`). Las señales de código ya no mueven el estado (lo hace
  la integración de GitHub de Linear) y un `ROZ-123` viejo se resuelve a su issue vigente.
- **Juntas (`src/meetings/`).** Sesión manual (texto, .txt/.vtt/.srt o resumen de Granola) o Granola
  por API (cron cada 5 min, opcional). Claude extrae tareas, compromisos y decisiones con cita
  literal; el código descarta las citas que no aparecen en el texto. Jev clasifica (q3), la búsqueda
  híbrida marca duplicados y la política propone responsable. La bandeja acepta (issue en Linear o
  comentario en el duplicado) o descarta. Las decisiones van al brain como átomos.
- **Planes por dev (`src/plans/`, `runner/`).** Cada issue asignado genera un `agent_plan` en la cola
  de su dueño, con riesgo 0/1/2 por reglas (paths sensibles, migraciones, auth/RLS, pagos, SLA). Las
  transiciones pasan solo por `transitionPlan` (update condicional → 409 `PLAN_TAKEN`). Reclamar es
  atómico, cambia el asignado en Linear y queda como corrección `'reclamado'`. Un watchdog cada 5 min
  regresa a la cola lo que no late y marca reclamable lo atorado (push al equipo). Sin nube: el
  **roz-runner** (CLI Node en la PC del dev, token `rozr_…` revocable, polling saliente) corre
  `claude -p` en un git worktree por plan, con el MCP de roz y lista blanca de herramientas. Con su
  token, `/mcp` solo expone las herramientas de lectura y `report_progress`.
- **Pulso (`src/dashboard/pulse.ts`, `/app` con el flag).** KPIs de la semana, tarjeta por persona,
  mapa de calor y feed en vivo. Lecturas puras y tolerantes: sin la migración 0036 esa parte sale
  vacía en vez de dar 500.

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
- **notification_switch** — interruptores de envío: fila `global` (killswitch del equipo) y una por
  dev que se silencia. Para enviar, ambos alcances tienen que estar encendidos.
- **outbox_event / idempotency_key** — núcleo de eventos e idempotencia.
- **chat_conversation / chat_member / chat_message / chat_attachment** — chat del equipo (0030).
  `work_item.chat_message_id` enlaza una tarea con el mensaje del que nació.
- **assignment_decision** — registro de la asignación automática (0031): payload/modelo de Jev,
  clasificación, candidatos con motivos, resultado y el override humano (categoría cerrada).
  `work_item.estimate` (story points) ahora lo escriben el diálogo de tareas y la asignación automática.
  Desde 0032 también guarda la vista previa de un ticket (`outcome='preview'`, sin tarea todavía).
- **solution_type** — tipos de solución (0032): skill primaria (o "del módulo"), nivel mínimo, skill
  secundaria y tamaño típico. `work_item.solution_type_id` es el tipo que fijó una persona.
- **project.project_type / description / profile_source** — perfil del proyecto (0033): el contexto que
  lee Jev; `profile_source='ia'` = propuesto por roz desde GitHub, pendiente de revisión.

### El SPA del dashboard (`web/`)

Cuatro piezas sostienen la sensación de la app; se documentan porque cada una nació de un síntoma
concreto de "la app se siente rota":

- **Sesión fuera de React** (`web/src/auth/store.ts`, con `useSyncExternalStore`). supabase-js puede
  emitir un `SIGNED_OUT` TRANSITORIO al volver a la pestaña (refresh token vencido, dos pestañas
  peleando el token). Con la sesión en un contexto, eso desmontaba el dashboard entero. Ahora un
  cierre solo se da por real si lo pedimos nosotros o si otra pestaña borró la sesión; el resto se
  recupera en silencio con backoff (3 intentos) mientras el usuario sigue trabajando, y `RequireAuth`
  garantiza que, una vez dentro, ningún estado posterior sustituye el `<Outlet/>`.
- **Caché stale-while-revalidate compartida** (`web/src/lib/store.ts` + `useApi`, opt-in por
  `key`/`ttl`). Antes cada montaje arrancaba en `loading` → volver a una sección era siempre
  skeletons y refetch. La clave lleva el id del usuario dentro y se tira al cambiar de cuenta (más
  el descarte de respuestas en vuelo): son los tres cerrojos que impiden servir datos de otra cuenta.
  Tras una mutación se usa `invalidate(prefijo)`, no `reload()`.
- **Chrome persistente** (`web/src/components/AppShell.tsx`, layout de ruta). `Layout` conserva su
  firma y publica título y acciones en el header por portal, así que navegar entre secciones ya no
  reconstruye sidebar, header ni el pulso de la cola.
- **Mutaciones con retroalimentación** (`web/src/lib/useMirror.ts` y `useAction.ts`): update
  optimista, `busy` por fila o por acción, encadenado por entidad, rollback parcial y adopción de la
  entidad que devuelve el backend. Es la extracción de lo que arregló Tareas, para que ninguna
  sección tenga que reescribirlo.

### Sistema de diseño (`web/src/styles.css`, `charts.tsx`, `bits.tsx`)

Dos piezas más, añadidas cuando el reporte fue que las gráficas eran muy básicas:

- **Una sola escala de movimiento** (`:root` de `web/src/styles.css`). Duraciones, curvas,
  distancias, escalas y desenfoques salen de [transitions.dev](https://transitions.dev), y las
  recetas viven en el mismo archivo bajo clases `t-*`. Dos reglas: `--ease-smooth-out` **es** el
  `ease-spring` de Tailwind (el config lee el token, así que hay un valor y no dos), y un valor
  hardcodeado se sustituye solo cuando su USO corresponde a un uso documentado — el "hover lift" y
  los bucles decorativos de la landing conservan sus números a propósito. Las recetas van como
  `@keyframes` sobre el `data-state` de Radix y no como transiciones: el Presence de Radix decide
  cuándo desmontar leyendo `animationName`, así que con una transición pura el cierre no se ve
  nunca. La guarda de `prefers-reduced-motion` ya apaga todo de forma global.
- **Un componente por concepto.** `charts.tsx` es la única frontera con recharts; el lenguaje visual
  es la familia "mono" de amicro, portada y no copiada (los originales traen los datos y los colores
  fijos dentro del archivo). Todo color sale de un token — cero hex en la dataviz —, así que claro y
  oscuro necesitan una sola declaración. Una sola regla de forma, puesta por el usuario:
  comparar categorías es SIEMPRE **columnas verticales** (`Columns`) — ninguna barra horizontal en
  la app, y la lista rankeada, el embudo, el radar y la primitiva `Bar` se eliminaron para que no
  vuelvan por inercia. Composición es `Donut` / `StackedBar`; tiempo es `AreaTrend`. En `bits.tsx`
  están las primitivas que estaban duplicadas: un `ProgressBar` (había dos), un `SegmentMeter`
  (había tres), y `MetricCard` absorbió las cinco tarjetas de estadística que tenían cinco APIs
  distintas y de las que solo una animaba su cifra.

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
| + | **Chat del equipo**: canales, MDs, hilos y adjuntos; mensaje → tarea; tiempo real y push. |
