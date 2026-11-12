# Chat de roz sobre Discord — contratos

Estado: contrato para construir (fase con mocks: todavía no hay token del bot ni id del servidor).
Flag: `ROZ_DISCORD_CHAT` (default `false`). Migración: `migrations/0038_discord_chat.sql` (NO aplicada).

Este documento es la fuente de verdad entre las tres piezas que se construyen en paralelo. Si algo
de aquí cambia, cambia también `src/types/discord.ts` y el espejo a mano de `web/src/lib/api.ts`
**en el mismo cambio**.

| Pieza | Dónde | Dueño de |
|---|---|---|
| Puente | `discord-bridge/` (paquete nuevo, Node + discord.js, Railway) | gateway, espejo en Supabase, backfill, reconciliación, avisos a roz, `/health` |
| API de roz | `src/discord/*`, `src/routes/discord.ts`, `src/routes/discord-oauth.ts`, `src/routes/internal.ts` | lectura con permisos, envío por webhook, OAuth, tiempo real, `/ticket`, issue desde mensaje |
| Front | `web/src/pages/Chat.tsx`, `web/src/discord/*`, `web/src/components/chat/*`, `web/src/lib/api.ts` | UI con el diseño de roz (DESIGN.md / brand.tsx), Configuración → ligar cuenta |

Piezas YA hechas (no reescribir; extender si hace falta):

| Archivo | Qué da |
|---|---|
| `src/types/discord.ts` | Filas (snake_case), vistas UI (camelCase), eventos de tiempo real, avisos del puente |
| `src/discord/permissions.ts` | Algoritmo oficial de permisos, PURO. `channelAbilities`, `visibleChannelIds`, `devsWhoCanView`, `isSyncedWithCategory` |
| `src/discord/reply.ts` | Línea de respuesta de roz (`buildReplyPrefix` / `parseReplyPrefix`) |
| `src/discord/normalize.ts` | Mensaje crudo de la API/gateway → columnas de `discord_message` (lo usan roz Y el puente) |
| `src/discord/enabled.ts` | `discordChatEnabled()`, `assertDiscordChat()`, `assertInternalChatWritable()` |
| `src/adapters/discord.ts` | REST: webhooks (crear/listar/ejecutar multipart/editar/borrar), bot (mensaje, DM, miembro), OAuth2, refresh de URLs de adjuntos, CDN, rate limit, `DiscordError` |
| `src/chat/realtime.ts` | `broadcastToDevs` ya acepta los eventos `discord.*` |
| `src/config.ts` | `config.discord.{botToken, guildId, clientId, clientSecret, oauthRedirectUri, apiUrl, maxUploadBytes, bridgeSecret, chatEnabled}` |

Convenciones: ids de Discord = snowflakes en **string**; bitfields de permisos = string decimal;
HTTP en camelCase; base en snake_case; textos y comentarios en español; errores con `AppError`
(`{ error: { code, message } }` como el resto del dashboard).

---

## A. Protocolo puente → roz

### A.1 Decisión: el puente escribe DIRECTO en Supabase y luego avisa a roz con ids

El puente usa `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` y escribe las tablas `roz.discord_*`.
Después de cada escritura manda un aviso (solo ids) a `POST /v1/internal/discord/events`; roz relee
la fila, calcula quién la puede ver y transmite.

Por qué así y no "el puente manda todo a roz y roz escribe":

1. **Volumen del backfill.** Arrancar = estructura completa + N mensajes × cada canal. Por HTTP a
   Vercel serían cientos de invocaciones (y cold starts, y el tope de 4.5 MB por cuerpo); directo a
   Postgres es un upsert por lote.
2. **El puente sigue espejando aunque roz (Vercel) esté caído o desplegando.** La base queda
   correcta; solo se pierde el empujón de tiempo real, y el front se pone al día al reconectar.
3. **Los permisos se calculan en un solo lugar** (`src/discord/permissions.ts`, en roz). El puente
   no decide quién ve qué: si lo hiciera, habría dos implementaciones del algoritmo que divergen.
4. **Avisos idempotentes.** El aviso solo dice "mira el mensaje X"; roz siempre transmite el estado
   ACTUAL de la base. Un aviso repetido, tardío o fuera de orden no puede pintar un estado viejo.

### A.2 Endpoint

```
POST /v1/internal/discord/events
Authorization: Bearer <ROZ_BRIDGE_SECRET>
Content-Type: application/json

DiscordBridgeEventsBody = {
  guildId: string,                 // debe ser config.discord.guildId; otro → 403
  notices: DiscordBridgeNotice[]   // 1..100
}
```

`DiscordBridgeNotice` (ver `src/types/discord.ts`):

| kind | campos | cuándo lo manda el puente |
|---|---|---|
| `message.created` | `channelId`, `messageId` | MESSAGE_CREATE ya escrito (incluido el eco de un webhook de roz) |
| `message.updated` | `channelId`, `messageId` | MESSAGE_UPDATE, reacciones (ADD/REMOVE/REMOVE_ALL/REMOVE_EMOJI), hilo creado desde el mensaje |
| `message.deleted` | `channelId`, `messageIds[]` | MESSAGE_DELETE / MESSAGE_DELETE_BULK (borrado suave ya escrito) |
| `structure.changed` | `scope`, `channelIds?`, `userIds?` | canal/categoría/hilo creado-editado-borrado, overwrites, roles, miembros (alta/baja/roles), emojis, guild |
| `bridge.status` | `status` | `connecting` → `backfilling` → `ready`; `disconnected` al perder el gateway |

Respuestas:

| Código | Cuándo | Cuerpo |
|---|---|---|
| 200 | procesado | `DiscordBridgeEventsResult = { ok: true, processed, skipped }` |
| 400 | cuerpo inválido (zod) | `{ error: { code: 'VALIDATION_ERROR', … } }` |
| 403 | bearer inválido, secreto vacío en roz (fail-closed), o `guildId` ajeno | `{ error: 'forbidden' }` |
| 404 | `ROZ_DISCORD_CHAT=false` | `{ error: { code: 'DISCORD_CHAT_DISABLED' } }` — el puente deja de avisar hasta el próximo arranque |

Implementación en roz (`src/routes/internal.ts` + `src/discord/events.ts`):

- Bearer comparado con `secureEqual` (como `requireCron`), sin depender del entorno. Secreto vacío →
  403 siempre.
- `skipped` = aviso de un canal/mensaje que no está en el espejo, o de una guild ajena. No es error.
- Cada aviso de mensaje: cargar fila + canal (+ padre si es hilo) → `devsWhoCanView` sobre los devs
  **ligados** (`discord_link` ⋈ `discord_member` con `left_at is null`) → armar `DiscordMessageView`
  → `broadcastToDevs(devs, 'discord.message.created' | 'discord.message.updated', { channelId, message })`.
- `message.deleted`: destinatarios por el canal (la fila del canal sigue existiendo: borrado suave)
  → `'discord.message.deleted', { channelId, messageIds }`.
- `structure.changed`: `'discord.channels.changed', { reason: scope }` a **todos** los devs ligados
  (incluye a quien acaba de PERDER acceso: tiene que enterarse para esconder el canal).
- `bridge.status`: `'discord.bridge.status', { status }` a todos los ligados.
- Se agrupan destinatarios: un `broadcastToDevs` por aviso (una sola petición HTTP a Realtime).
- Cargar guild/roles/miembros/canales UNA vez por llamada, no por aviso.

### A.3 Lo que el puente garantiza al escribir

Intents: `Guilds`, `GuildMessages`, `MessageContent`, `GuildMembers`, `GuildMessageReactions`,
`GuildEmojisAndStickers`. Partials de mensaje/reacción activados (reacciones a mensajes viejos).

Variables del puente: `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `ROZ_API_URL` (base de roz, p. ej. `https://roz.example.com`),
`ROZ_BRIDGE_SECRET`, `DISCORD_BACKFILL_MESSAGES` (default 200 por canal), `PORT` (health).
Nunca loguea tokens.

Reglas por tabla (todas con upsert por la llave primaria; **borrado = `deleted_at`/`left_at`, nunca DELETE**):

| Tabla | Fuente | Reglas |
|---|---|---|
| `discord_guild` | READY / GUILD_UPDATE | `owner_id` siempre actualizado (el dueño ve todo). |
| `discord_channel` | GUILD_CREATE, CHANNEL_*, THREAD_*, THREAD_LIST_SYNC, THREAD_MEMBERS_UPDATE | Categorías, canales e hilos en la misma tabla. `overwrites` = `permission_overwrites` tal cual (`{id, type, allow, deny}` con strings). Hilos: `parent_id`, `archived`, `locked`, `archived_at`, `owner_id`, `message_count`; privados: `member_ids` mantenido con THREAD_MEMBERS_UPDATE (y `threads.members.fetch` al descubrirlo). CHANNEL_DELETE/THREAD_DELETE → `deleted_at`. |
| `discord_role` | GUILD_CREATE, GUILD_ROLE_* | `permissions` string decimal. Incluye @everyone (`id = guild_id`). |
| `discord_member` | GUILD_MEMBERS_CHUNK al arrancar (`guild.members.fetch()`), GUILD_MEMBER_* | `roles` SIN el id de @everyone. Baja → `left_at = now()`; reingreso → `left_at = null`. `communication_disabled_until` siempre. |
| `discord_emoji` | GUILD_EMOJIS_UPDATE | Los que desaparecen del arreglo → `deleted_at`. |
| `discord_message` | MESSAGE_*, reacciones | `normalizeApiMessage(raw, guildId)` de `src/discord/normalize.ts` sobre el payload CRUDO (`client.on('raw')` o REST), no sobre `message.toJSON()` (camelCase). **Nunca escribe `dev_id` ni `client_nonce`.** MESSAGE_UPDATE puede ser parcial: solo se actualizan las columnas presentes en el payload (si falta `content`, no se pisa). Reacciones: el puente mantiene `reactions` (incrementa/decrementa `count`, agrega/quita el `user_id` en `userIds`, REMOVE_ALL → `[]`, REMOVE_EMOJI → quita la entrada). |
| `discord_sync_state` | backfill / reconexión | Ver A.4. |
| `discord_bridge_state` | ciclo de vida | `last_heartbeat_at` cada 30 s; `status` según el ciclo; `last_error` sin secretos. |

Orden: primero la base, después el aviso. Si el aviso falla, se reintenta con backoff (máx. 5 min
encolado en memoria); si roz responde 404 (flag apagado), se descartan.

Avisos agrupados: ventana de ~250 ms o 100 avisos, lo que llegue primero.

### A.4 Backfill y reconciliación

Al arrancar (y en cada READY que no sea RESUMED):

1. **Estructura completa**: guild, roles, canales (incluye categorías), hilos activos
   (`guild.channels.fetchActiveThreads()`), emojis, miembros. Lo que está en la base y ya no viene
   de Discord → `deleted_at` / `left_at`. Al terminar: aviso `structure.changed { scope: 'guild' }`.
2. **Mensajes, por canal de texto/anuncios e hilo activo** que el bot pueda leer:
   - Si `discord_sync_state.newest_message_id` existe → pedir `after=newest` paginando hasta el
     presente (lo que pasó mientras estuvo caído). Actualizar `newest_message_id`.
   - Si `backfill_complete = false` → pedir `before=oldest_message_id` (o sin cursor la primera vez)
     hasta juntar `DISCORD_BACKFILL_MESSAGES` en total; actualizar `oldest_message_id`; al llegar a N
     o al principio del canal → `backfill_complete = true`.
   - Borrados mientras estuvo caído: Discord no los reenvía. Se re-piden los últimos 100 mensajes y
     los ids que están en la base dentro de ese rango pero no en la respuesta → `deleted_at`.
   - Ediciones mientras estuvo caído: el re-pedido de los últimos 100 las trae (`edited_timestamp`).
   - Un canal a la vez, respetando el rate limit (discord.js ya lo hace). Estado `backfilling`.
   - Los avisos de mensajes del backfill NO se mandan uno por uno: al terminar cada canal, un
     `structure.changed { scope: 'channels', channelIds: [id] }` basta (el front recarga si lo tiene abierto).
3. `bridge.status { status: 'ready' }`.

Reconexión: discord.js reanuda (RESUME) solo; si el gateway pide re-identificar, se repite este
procedimiento (los cursores evitan volver a traer lo que ya hay).

### A.5 Health (Railway)

`GET /health` → `200 { ok: true, status, guildId, wsPing, lastEventAt, backfill: { pending, done } }`
mientras el gateway está `ready`/`backfilling`; `503 { ok: false, status, lastError }` si está
desconectado más de 60 s. Sin auth, sin secretos ni contenido de mensajes.

---

## B. Endpoints del dashboard `/api/dashboard/discord/*`

Montados dentro de `dashboardRoutes` (pasan por `requireDashboardAuth`; el dev sale SIEMPRE de
`c.get('user').devId`, nunca del body). Todas llaman `assertDiscordChat()` primero: con el flag
apagado responden **404 `DISCORD_CHAT_DISABLED`**, excepto `GET /status` (ver abajo).

Toda ruta que toca un canal valida con permisos (B.0). Un canal/hilo/mensaje que el dev no puede ver
responde **404** (como el chat interno: no se confirma ni que exista).

### B.0 Contexto de permisos del dev

```
loadViewer(devId) → { link, member, guild, roles, channels }   // src/discord/access.ts
```
- Sin `discord_link` → `403 DISCORD_NOT_LINKED`.
- Sin `discord_member` o con `left_at` → `403 DISCORD_NOT_MEMBER`.
- `PermissionContext = { guild: {id, ownerId, roles (sin deleted_at)}, member: {userId, roles, communicationDisabledUntil}, channels (sin deleted_at) }`.
- `channelAbilities(ctx, channelId)` decide ver/leer/escribir/adjuntar. `view=false` → 404.
  `readHistory=false` → la lista de mensajes devuelve `[]` (Discord tampoco muestra historial).

### B.1 Estado

`GET /status` → `DiscordStatusView`. **Responde también con el flag apagado** (`{ enabled: false,
unavailable: 'disabled', … }`) para que el front decida qué chat montar con una sola llamada.

`limits` (texto fijo que la UI muestra en un aviso "Qué no se puede desde roz"):
1. "Los mensajes directos personales de Discord no se ven en roz: Discord no los comparte con bots."
2. "Los canales de voz y escenarios aparecen, pero la voz no está disponible en roz."
3. "Lo que escribes sale con tu nombre y tu foto, pero desde roz (Discord le pone la etiqueta APP); no es tu cuenta de Discord."
4. "Las reacciones se ven pero no se pueden poner desde roz."
5. "Los foros se pueden leer y responder en sus publicaciones, pero las publicaciones nuevas se crean en Discord."

`bridge.healthy = status ∈ {ready, backfilling} && now - last_heartbeat_at < 90 s`.

### B.2 Canales

`GET /channels` → `DiscordChannelTreeView`
- Solo ids de `visibleChannelIds(ctx)`. Categorías ordenadas por `position`; canales por
  (`position`, id) dentro de su categoría; `uncategorized` primero, como en Discord.
- `supported = type ∈ {0, 5}` (texto, anuncios). Foro (15)/media (16) → `supported=false` pero
  `threads` sí lista sus publicaciones (hilos) que se pueden abrir. Voz (2, 13) → `supported=false`.
- `threads`: hilos NO archivados y visibles, ordenados por `last_message_at desc`.
- `syncedWithCategory` con `isSyncedWithCategory`.
- `abilities` con `channelAbilities`.

`GET /channels/:channelId/threads?archived=true&before=<ISO>&limit=25` → `{ threads: DiscordThreadView[], hasMore }` (`before` = `archivedAt` del último hilo de la página anterior)
(hilos archivados del espejo; el puente los guarda cuando los ve).

### B.3 Mensajes

`GET /channels/:channelId/messages?before=<messageId>&limit=50` → `DiscordMessagePage`
- `channelId` puede ser canal o hilo. `limit` 1..100 (default 50). Orden **descendente** (más nuevo
  primero), paginación hacia atrás con `before` (se resuelve el `created_at` de ese id y se usa
  `(created_at, id) < (…)`; índice `idx_roz_discord_message_channel`).
- `around=<messageId>` (alternativo a `before`): 25 antes + el mensaje + 25 después, para saltar a
  un mensaje citado o a uno que originó una tarea.
- Excluye `deleted_at is not null`.
- Arma `DiscordMessageView`:
  - `author.displayName`: si `dev_id` → nombre del dev de roz; si no, si el autor es un miembro →
    `nick ?? global_name ?? username`; si no → `author_global_name ?? author_username`.
  - `author.avatarUrl`: dev de roz → su foto de GitHub; si no, `memberAvatarUrl` (avatar del
    servidor) o `userAvatarUrl`.
  - `author.devId`: `dev_id` de la fila, o el dev ligado al `author_id` (`discord_link`).
  - `fromRoz = dev_id != null && webhook_id = discord_webhook.webhook_id del canal (o de su padre)`.
  - `content`: `parseReplyPrefix(content).body` si `fromRoz` (o si `webhook_id` y la línea existe).
  - `replyTo`: con `reply_to_id` → `{ id, author, excerpt (texto plano, ≤120), deleted }`; null si
    no está en el espejo (se pinta "mensaje original no disponible").
  - `thread`: si `thread_id` → nombre/contador del hilo desde `discord_channel`.
  - `tasks`: identificadores con `extractTaskIdentifiers` (src/chat/text.ts) resueltos con
    `tasksByIdentifier` (src/chat/tasks.ts; ya entiende HYP-12 de Linear y ROZ-123 viejos vía
    `legacy_identifier`) + las tareas con `work_item.discord_message_id = id`.
  - **URLs de adjuntos caducan**: antes de responder, las que caducan en < 1 h
    (`attachmentUrlExpiresAt`) se refrescan con `refreshAttachmentUrls` (lotes de 50) y se guardan
    en la fila (`attachments[].url`). Si el refresh falla, se devuelven las viejas (best-effort).
- `hasMore`: hay filas más viejas en el espejo, o `backfill_complete=false` para ese canal.

### B.4 Enviar

`POST /channels/:channelId/messages`
```
{ content: string,               // 0..2000 tras anteponer la línea de respuesta; vacío solo con adjuntos
  replyToId?: string,            // snowflake de un mensaje del MISMO canal/hilo, visible y no borrado
  uploadIds?: string[],          // uuid de discord_upload completados, del mismo dev y canal, máx. 10
  clientNonce?: string }         // ≤ 64; vuelve en el view y en el tiempo real
→ 201 { message: DiscordMessageView }
```
Pasos (`src/discord/send.ts`):
1. `channelAbilities`: `send` (y `attach` si hay uploads); si no → 403 `DISCORD_CANNOT_SEND`.
   Canal no soportado (voz/foro raíz/categoría) → 400 `DISCORD_CHANNEL_UNSUPPORTED`.
2. Destino del webhook: hilo → webhook del **padre** + `threadId`; canal → el suyo.
3. Webhook: `discord_webhook` del canal; si no hay → `listChannelWebhooks` y reusar uno `type=1`
   con `name='roz'` y `application_id` = el de la app (tiene token); si no → `createChannelWebhook`.
   Guardar `token_enc = encryptSecret(token)`. Si al ejecutar falla con `UNKNOWN_WEBHOOK` (10015) →
   borrar la fila, recrear UNA vez y reintentar. `MISSING_PERMISSIONS` → 502 `DISCORD_BOT_PERMISSIONS`
   ("el bot no tiene Manage Webhooks en este canal").
4. Contenido: si `replyToId` → `withReplyPrefix({guildId, channelId: <canal o hilo>, messageId,
   authorId}, content)` donde `authorId` = `author_id` del citado si NO es webhook; si es un mensaje
   de roz → el `discord_user_id` ligado de su `dev_id` (o null).
5. Menciones: el front manda ya el formato de Discord (`<@id>`, `<#id>`, `<:name:id>`).
   `allowed_mentions = buildAllowedMentions(ids)` con `ids = extractUserMentions(content)` ∩
   miembros activos (+ el autor citado). **Nunca** `@everyone`/`@here`/roles (el texto se publica
   pero no hace sonar a nadie).
6. Identidad: `username` = nombre del dev (`sanitizeWebhookUsername`), `avatarUrl` =
   `https://github.com/<github_login>.png?size=128` si tiene `github_login`, si no el avatar de su
   cuenta de Discord ligada, si no ninguno.
7. Adjuntos: descargar de Storage (`bucket`/`storage_path` de `discord_upload`) y mandarlos en el
   mismo `executeWebhook` (multipart). Tope por archivo `config.discord.maxUploadBytes`, total 25 MiB.
8. `executeWebhook(wait=true)` → `normalizeApiMessage(res, guildId)` + `dev_id` + `client_nonce` +
   `synced_at` → **upsert** en `discord_message` (ver §D). Marcar uploads con `message_id` y borrar
   los objetos de Storage (best-effort).
9. `broadcastToDevs(visibles, 'discord.message.created', { channelId, message })` y responder 201.

Errores de Discord → `AppError`: `retryable` → 503 `DISCORD_UNAVAILABLE` (con `retryAfterSec` en
`details`); `ENTITY_TOO_LARGE` → 413; `THREAD_ARCHIVED`/hilo bloqueado → 409 `DISCORD_THREAD_LOCKED`.

### B.5 Editar y borrar (solo mensajes propios salidos de roz)

`PATCH /messages/:messageId { content }` → `{ message: DiscordMessageView }`
`DELETE /messages/:messageId` → `{ ok: true }`
- Permitido solo si `dev_id = yo` y `webhook_id` = el webhook de roz del canal (o del padre del
  hilo). Otro caso → 403 `DISCORD_NOT_OWN_MESSAGE`. Borrado ya → 404.
- Editar conserva la línea de respuesta (se reconstruye desde `reply_to_id`) y recalcula
  `allowed_mentions`. `editWebhookMessage(…, threadId)` → upsert de la fila → `discord.message.updated`.
- Borrar: `deleteWebhookMessage(…, threadId)` → `deleted_at = now()` → `discord.message.deleted`.
- Mensajes de otros: ni editar ni borrar desde roz (no hay moderación desde roz).

### B.6 Adjuntos (subida directa a Storage, como `src/chat/attachments.ts`)

`POST /channels/:channelId/uploads { name, size, contentType }` →
`{ upload: DiscordUploadView, uploadUrl, token, path }` (URL firmada de SUBIDA al bucket privado
`roz-chat`, ruta `discord/<devId>/<uuid>/<nombre>`). Valida `attach` y `size ≤ maxUploadBytes`
(413 `DISCORD_UPLOAD_TOO_LARGE` con el mismo texto que el compositor).
`POST /uploads/:uploadId/complete` → `{ upload }` (comprueba que el objeto existe y guarda el tamaño
REAL; si supera el tope, borra y 413).

### B.7 Reacciones — DECISIÓN: solo lectura

Se muestran (emoji, conteo, y "tú" si el `discord_user_id` ligado está en `userIds`), pero roz NO
permite reaccionar. Motivo: el bot no puede reaccionar como el usuario; si reaccionara "en nombre
de roz", todas las reacciones de roz se fundirían en UNA sola del bot (dos personas reaccionan 👍 →
cuenta 1; una la quita → se le quita a las dos) y en Discord se vería que reaccionó "el bot". Eso
miente sobre quién reaccionó. Se documenta en `limits` (B.1, punto 4).

### B.8 Miembros, emojis, roles (para el compositor y para pintar)

- `GET /members?q=<texto>&limit=20` → `{ members: DiscordMemberView[] }` — solo miembros activos;
  busca en nick/global_name/username y en el nombre del dev ligado.
- `GET /emojis` → `{ emojis: DiscordEmojiView[] }` (disponibles, sin borrados; `url` con `emojiUrl`).
- `GET /roles` → `{ roles: DiscordRoleView[] }` (para pintar `<@&id>`; no se pueden mencionar con sonido).

### B.9 Ligar la cuenta de Discord (OAuth2, scope `identify`)

- `POST /link/start` → `{ url }`: crea un `roz.oauth_state` con `provider = 'discord'` (misma tabla
  y TTL que el calendario: `src/calendar/accounts.ts`) y devuelve `oauthAuthorizeUrl(state)`.
- `GET /api/discord/callback` — **fuera** de `/api/dashboard` (`app.route('/api/discord', discordOauthRoutes)`),
  por la misma razón que `/api/calendar/callback`: es una navegación del navegador sin Bearer; se
  autentica con el `state` de un solo uso. **`consumeOAuthState` hoy no filtra por `provider`:
  agregar el filtro (un state de Google no debe servir para Discord ni al revés).**
  1. `error` en query → redirect `/app/settings?discord=denied`.
  2. state inválido/vencido/usado → `?discord=state`.
  3. `exchangeOAuthCode` → `fetchOAuthUser` → `revokeOAuthToken` (best-effort; el token no se guarda).
  4. Si ese `discord_user_id` ya está ligado a OTRO dev → `?discord=taken` (no se roba el vínculo).
  5. Upsert `discord_link` (dev_id, discord_user_id, username, global_name, avatar).
  6. `getGuildMember` (con el bot) solo para el mensaje: no miembro → `?discord=not_member` (el
     vínculo queda; el dev verá "tu cuenta no está en el servidor").
  7. `broadcastToDevs([devId], 'discord.link.changed', { linked: true })` → `?discord=ok`.
  Cualquier otro error → `?discord=error` (sin detalles en la URL).
- `DELETE /link` → `{ ok: true }` + `discord.link.changed { linked: false }`.

Sin cuenta ligada el front muestra el aviso "Liga tu cuenta de Discord para ver los canales"
(botón → `POST /link/start` → `window.location = url`) y no pide `/channels`.

### B.10 Proyecto ↔ canal (aviso de /ticket)

- `GET /project-channels` → `{ items: DiscordProjectChannelView[] }` (todos los proyectos activos,
  con o sin canal).
- `PUT /project-channels/:projectId { channelId: string | null }` → `{ item }`. El canal debe ser
  de texto/anuncios, visible para quien lo configura. `null` borra el mapeo.

### B.11 Lo de roz que se conserva

- **Fichas de tarea**: `DiscordMessageView.tasks` (B.3). El front reutiliza `TaskChip`.
- **Crear issue desde un mensaje**: `POST /messages/:messageId/task` con el mismo cuerpo que la
  creación de tareas del chat interno (proyecto, nombre, descripción, …). Valida que el dev ve el
  mensaje. Con `ROZ_LINEAR_SOT` → `createIssueFromTicket` (src/linear/issues.ts) y deja
  `work_item.discord_message_id`; sin él → el camino actual de `createTask` (src/dashboard/queries.ts)
  con `discord_message_id` en vez de `chat_message_id`. Después: un mensaje del **bot** en el canal
  respondiendo de forma nativa (`sendBotMessage` con `replyToMessageId`): "↪ Se creó HYP-45 a partir
  de este mensaje", sin menciones con sonido; y `discord.message.updated` del mensaje original
  (para que aparezca la ficha).
- **Aviso de /ticket** (`src/tickets/smart.ts`, hoy `openDm` + `sendMessage` internos): con el flag
  encendido, en lugar del DM interno:
  1. Canal del proyecto (`discord_project_channel`) → `sendBotMessage(canal, { content: "<@responsable> te asignaron HYP-45 · <título>", allowedMentions: buildAllowedMentions([responsable]) })`.
  2. Sin canal → `createDmChannel(responsable)` + `sendBotMessage(dm.id, …)`. `CANNOT_DM_USER` → se
     registra y la tarea queda igual (como hoy).
  3. Responsable sin cuenta ligada → no hay aviso por Discord (se registra en el log del ticket).
  El resultado sigue devolviendo `messageSent`; `conversationId` queda `null` con el flag encendido.

---

## C. Tiempo real al front

Mismo buzón privado que el chat interno: Supabase Realtime Broadcast, topic `chat:dev:<devId>`,
`private: true`, policy `roz.chat_topic_allowed` (0030). El front abre UNA suscripción y escucha
también los eventos con prefijo `discord.`.

| Evento | Payload | A quién |
|---|---|---|
| `discord.message.created` | `{ channelId, message: DiscordMessageView }` | devs ligados que ven el canal/hilo |
| `discord.message.updated` | `{ channelId, message: DiscordMessageView }` | ídem |
| `discord.message.deleted` | `{ channelId, messageIds: string[] }` | ídem (permisos calculados con la fila del canal aún presente) |
| `discord.channels.changed` | `{ reason: DiscordStructureScope }` | todos los ligados → el front vuelve a pedir `/channels` (con debounce ~500 ms) y, si el canal abierto desapareció, sale de él |
| `discord.link.changed` | `{ linked: boolean }` | solo el dev afectado → recarga `/status` |
| `discord.bridge.status` | `{ status }` | todos los ligados → banner "Discord sin conexión" si `disconnected` |

Reglas del front:
- `message.created`/`updated` = **upsert por `message.id`**. Llegan dos veces para los mensajes de
  roz (el de la API y el del eco del puente): el segundo solo reemplaza.
- Envío optimista: el front pinta un mensaje temporal con su `clientNonce`; cuando llega un
  `created` (o la respuesta 201) con ese `clientNonce`, lo reemplaza por el real.
- Al reconectar la suscripción o volver la pestaña al frente: volver a pedir la primera página del
  canal abierto (no hay replay de eventos perdidos).

---

## D. Deduplicación del eco del webhook

Un mensaje enviado desde roz existe dos veces en el tiempo: la respuesta de `executeWebhook`
(`wait=true`) en roz, y el MESSAGE_CREATE que el gateway le entrega al puente. Ambos tienen el
**mismo snowflake**, que es la llave primaria de `discord_message`. No hay tabla de pendientes ni
comparación de contenido:

1. **Misma fila**: los dos hacen `upsert(..., { onConflict: 'id' })`.
2. **Columnas disjuntas para lo que solo uno sabe**: el puente NUNCA incluye `dev_id` ni
   `client_nonce` en su upsert (PostgREST solo actualiza las columnas enviadas), y roz los incluye.
   Llegue primero quien llegue, la fila final tiene el autor real (`dev_id`) y el contenido de
   Discord.
3. **`reply_to_id` no depende del orden**: roz lo escribe, y el puente lo deduce de la línea de
   respuesta (`normalizeApiMessage` → `replyTargetOf` → `parseReplyPrefix`, solo en mensajes con
   `webhook_id`), así que ambos escriben el mismo valor.
4. **Atribución**: el mensaje se pinta como del dev cuando `dev_id` está y `webhook_id` es el webhook
   de roz del canal (`fromRoz`). Si el eco llega primero, durante unos milisegundos la fila no tiene
   `dev_id`: el front ya tiene el optimista por `clientNonce` y el `created` de roz llega después
   con el autor bien resuelto; además el view resuelve `displayName` con el `username` del webhook,
   que ya es el nombre del dev.
5. **Tiempo real duplicado**: inofensivo por el upsert por id del front (§C).
6. Un mensaje del webhook de roz escrito por OTRA instancia de roz/otro sistema sin `dev_id` se
   muestra como webhook genérico (sin "editar/borrar").

---

## E. El flag `ROZ_DISCORD_CHAT`

| | `false` (default) | `true` |
|---|---|---|
| Chat interno (`/api/dashboard/chat/*`, tablas 0030) | idéntico a hoy | lectura permitida; **escrituras → 409 `CHAT_REPLACED_BY_DISCORD`** (`assertInternalChatWritable()`) |
| `/api/dashboard/discord/*` | 404 `DISCORD_CHAT_DISABLED` (salvo `GET /status` → `enabled:false`) | activo |
| `/api/discord/callback` | redirect `?discord=error` | activo |
| `POST /v1/internal/discord/events` | 404 (el puente deja de avisar) | activo |
| Front (`Chat.tsx`) | monta el chat interno | monta el chat de Discord (decide con `GET /discord/status`) |
| Configuración | sin tarjeta de Discord | tarjeta "Cuenta de Discord" (ligar/desligar) y mapeo proyecto ↔ canal |
| `/ticket` | DM interno (como hoy) | canal del proyecto o DM del bot (B.11) |
| Crear tarea desde mensaje | chat interno | mensaje de Discord (`discord_message_id`) |
| Validación de config | ninguna | exige `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_OAUTH_REDIRECT_URI`, `ROZ_BRIDGE_SECRET`, `ROZ_ENCRYPTION_KEY` (el server no arranca sin ellas) |

El flag depende SOLO de configuración: si el puente o Discord fallan en caliente, el chat de Discord
se muestra "sin conexión"; nunca cae en silencio al chat interno.

---

## F. Lo que Discord no permite (documentado en la UI, B.1)

- Ver los DMs personales de cada quien: la API no da acceso a DMs de usuarios a un bot.
- Voz y escenarios.
- Escribir como la cuenta real del usuario: sale por webhook con su nombre y foto, con la etiqueta
  APP. Por eso tampoco hay respuesta nativa desde roz (webhook sin `message_reference`) — se usa la
  línea de respuesta de §D.3.
- Reaccionar como el usuario (B.7).
- Crear publicaciones nuevas en foros desde roz (fase 1; responder en las existentes sí).

## G. Pruebas (sin la API real de Discord)

- `test/discord-permissions.test.ts`, `test/discord-adapter.test.ts`, `test/discord-reply.test.ts` (hechos).
- API de roz: `fetch` simulado para Discord + base falsa (patrón `test/linear-fake-db.ts`):
  envío (webhook nuevo/reusado/10015→recrear), eco en cualquier orden (§D), permisos 404, edición y
  borrado solo propios, eventos internos con bearer malo/bueno/flag apagado.
- Puente: discord.js simulado (eventos del gateway como objetos crudos) y Supabase simulado; backfill
  con cursores, reconciliación de borrados, avisos agrupados.
- Nada de migraciones aplicadas ni escrituras a la base remota (el `.env` apunta a producción).
