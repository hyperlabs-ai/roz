# Comandos de roz en Discord (/roz y acciones de mensaje): contrato

Estado: construido (base, handlers, puente y paridad del compositor). Este documento sigue siendo el
contrato: un cambio de protocolo, custom_id o subcomando se refleja aquí y en el código en el mismo
cambio.
Flag: `ROZ_DISCORD_CHAT` (con el flag apagado todo esto responde 404). **No hace falta migración.**

Complementa a [`discord-chat-contracts.md`](./discord-chat-contracts.md) (espejo, `discord_link`,
proyecto ↔ canal). Si algo de aquí cambia, cambia también el código citado en el mismo cambio.

| Pieza | Dónde | Estado |
|---|---|---|
| Definición de comandos + hash | `src/discord/commands/definitions.ts` | hecho |
| custom_ids versionados | `src/discord/commands/custom-id.ts` | hecho |
| Router (tipo, subcomando, identidad, servidor, presupuesto de 3 s) | `src/discord/commands/router.ts` | hecho |
| Respuestas (efímero, diferido, modal, componentes, completar con el token) | `src/discord/commands/respond.ts` | hecho |
| Fichas con la identidad de roz (Components V2, §7.1) | `src/discord/commands/{embeds,v2,emojis}.ts`, `links.ts` | hecho |
| Emojis de aplicación (íconos de proveedores y Roz-bot) | `scripts/discord-emojis.ts` (`npm run discord:emojis`), `discord-bridge/assets/emojis/` | hecho |
| Registro de handlers | `src/discord/commands/registry.ts` | hecho |
| Registro de comandos en el servidor | `src/discord/commands/register.ts`, `scripts/discord-commands.ts` (`npm run discord:commands`) | hecho |
| REST de interacciones y comandos de servidor | `src/adapters/discord.ts` | hecho |
| Rutas `/v1/internal/discord/{interactions,commands,commands/sync}` | `src/routes/internal.ts` | hecho |
| Handlers tarea, ticket, status, crear tarea, citar | `src/discord/commands/handlers/{tarea,ticket,status,mensaje-crear-tarea,mensaje-citar}.ts` | hecho |
| Handlers plan, pulso, infra, junta, decisión | `src/discord/commands/handlers/{plan,pulso,infra,junta,mensaje-decision}.ts` | hecho |
| Reenvío de INTERACTION_CREATE + callback + sync al arrancar | `discord-bridge/src/{interactions,commands,register-commands}.ts` | hecho |
| Paridad del compositor de roz | `src/discord/commands/from-roz.ts`, `src/routes/discord.ts`, `web/src/components/discord/{DiscordComposer,CommandDialog}.tsx`, `web/src/discord/commands.ts` (§9) | hecho |

Tests: `test/discord-commands-{definitions,custom-id,router}.test.ts`, `test/discord-v2.test.ts` (formato).

---

## 1. Flujo

```
Discord ──INTERACTION_CREATE (gateway)──▶ puente ──POST /v1/internal/discord/interactions──▶ roz
                                            │                                   │ router: servidor, identidad,
                                            │ ◀──── 200 { callback } ───────────┘ despacho, presupuesto
                                            │
                                            └─POST /interactions/{id}/{token}/callback (body = callback)──▶ Discord
roz (en segundo plano, si difirió) ──PATCH /webhooks/{app}/{token}/messages/@original──▶ Discord
                                   ──POST  /webhooks/{app}/{token} (followups)─────────▶ Discord
```

- **Toda la lógica vive en roz.** El puente no interpreta nada: reenvía el payload crudo y manda a
  Discord el `callback` que roz le devuelve.
- La respuesta INICIAL la manda el puente: ya tiene una conexión viva con Discord y la ventana de 3 s
  no incluye un segundo viaje de roz. Lo que tarda se **difiere** (type 5/6) y roz lo completa con el
  token de la interacción (15 min de vida). Ninguna de las dos llamadas usa el token del bot: el token
  de la interacción es la credencial.
- Funciona igual en local que en Railway: el puente solo hace peticiones de SALIDA (a `ROZ_API_URL` y a
  Discord); roz también solo sale (a Discord). Nadie necesita URL pública ni "Interactions Endpoint URL"
  en el Developer Portal (déjalo vacío: si se llena, Discord deja de mandar las interacciones por el
  gateway).

## 2. Protocolo puente → roz

### 2.1 Interacciones

```
POST {ROZ_API_URL}/v1/internal/discord/interactions
Authorization: Bearer <ROZ_BRIDGE_SECRET>
Content-Type: application/json

{
  "guildId": "<DISCORD_GUILD_ID del puente>",
  "receivedAt": 1731340000000,          // opcional, epoch ms en que el puente recibió el evento
  "interaction": { ...payload CRUDO `d` de INTERACTION_CREATE (snake_case), sin tocar... }
}
```

El puente toma el payload con `client.on('raw', p => p.t === 'INTERACTION_CREATE')` (no
`interaction.toJSON()`, que es camelCase) y **no** usa `interaction.reply/deferReply` de discord.js.
INTERACTION_CREATE llega sin intents adicionales.

Respuestas de roz:

| Código | Cuándo | Cuerpo | Qué hace el puente |
|---|---|---|---|
| 200 | siempre que roz pudo decidir (incluye errores del usuario: sin cuenta, otro servidor, handler que falló) | `{ "callback": InteractionCallbackBody }` | `POST /interactions/{id}/{token}/callback` con `callback` tal cual |
| 400 | cuerpo inválido | `{ error: { code: 'VALIDATION_ERROR' } }` | fallback (abajo) |
| 403 | bearer malo, secreto vacío en roz, o `guildId` ≠ el de roz | `{ error: 'forbidden' }` | fallback |
| 404 | `ROZ_DISCORD_CHAT=false` | `{ error: { code: 'DISCORD_CHAT_DISABLED' } }` | fallback con el texto "roz no tiene activado Discord" |
| 5xx / red / **> 2500 ms** | roz caído, cold start lento | — | fallback |

`InteractionCallbackBody = { type: number, data?: object }` es exactamente el cuerpo del callback de
Discord (type 1 PONG, 4 mensaje, 5 diferido, 6 diferido sobre el componente, 7 editar el mensaje del
componente, 8 autocompletado, 9 modal). Nunca lleva el token.

**Fallback del puente** (roz no contestó a tiempo o no-200): según `interaction.type`:
- 4 (autocompletado) → `{ type: 8, data: { choices: [] } }`;
- 2, 3, 5 → `{ type: 4, data: { content: "roz no respondió a tiempo. Intenta de nuevo en un momento.", flags: 64, allowed_mentions: { parse: [] } } }`.

El texto cambia según la causa (constantes en `discord-bridge/src/interactions.ts`):
- timeout (> presupuesto) → "roz no respondió a tiempo. Intenta de nuevo en un momento.";
- red caída, 5xx, 403, 400 o un 200 sin `callback` → "roz no está disponible. Intenta de nuevo en un momento.";
- 404 (flag apagado) → "roz no tiene activado Discord.".

Espera del puente: 2500 ms como máximo; si la interacción ya llegó tarde (según su snowflake),
`3000 − 300 − lo ya pasado` con un mínimo de 250 ms.

Ojo: si roz contestó tarde, el efecto ya ocurrió (p. ej. "Tomar" asignó la tarea) aunque el usuario
vea el fallback; si había diferido, su `PATCH @original` reemplaza el texto del fallback con el
resultado real.

Si roz respondió tarde pero sí difirió y luego completa, su `PATCH @original` editará el mensaje del
fallback (efímero): degrada bien. Si Discord contesta al callback del puente `40060` (ya reconocida) se
ignora. El puente nunca reintenta un callback (una interacción se reconoce una sola vez) y nunca loguea
el token ni el contenido: solo `interaction.id`, tipo, ms y código de respuesta.

### 2.2 Presupuesto de tiempo (lo hace roz)

- `INLINE_BUDGET_MS = 1800`: lo máximo que roz espera a un handler en línea.
- Se descuenta lo que ya pasó desde que Discord creó la interacción (fecha del snowflake), dejando
  `BRIDGE_MARGIN_MS = 800` para que el puente mande el callback: `min(1800, 3000 - 800 - transcurrido)`.
  Con el reloj no creíble (negativo o > 10 s) se usa 1800.
- Handler a tiempo → su `Reply` es el callback (type 4/7/8/9).
- Handler tarde → callback diferido según su `defer`:
  `ephemeral` → `{type:5,data:{flags:64}}`, `public` → `{type:5}`, `update` → `{type:6}` (solo
  componentes / modales abiertos desde un componente; si no, cae a `ephemeral`), `never` → efímero
  "roz tardó demasiado" (modales y autocompletado no se pueden diferir).
- El resultado diferido se manda en segundo plano (`inBackground` → `waitUntil` en Vercel):
  diferido 5 → `PATCH /webhooks/{app}/{token}/messages/@original`; diferido 6 + `update` → mismo PATCH
  (edita el mensaje del componente); diferido 6 + `message` → followup `POST /webhooks/{app}/{token}`.
  La visibilidad la fijó el diferido (no se puede cambiar al editar).
- Como el callback lo manda el puente DESPUÉS de que roz responde, el PATCH/followup de roz puede llegar
  antes: Discord responde 10015/10008 y roz reintenta (8 × 350 ms, `withAckRetry`).
- Followups (`Reply.followups`) salen después de la respuesta inicial, inmediata o diferida.
- `with_components=true` va en toda edición/followup/webhook con componentes (sin él Discord los ignora).

### 2.3 Registro de comandos

- `POST /v1/internal/discord/commands/sync` (mismo bearer) → `{ ok, changed, dryRun, hash, remoteHash, count }`.
  `?force=1` registra aunque coincida; `?dryRun=1` solo dice si cambiaría. Errores: 503
  `DISCORD_NOT_CONFIGURED`, 502 `DISCORD_COMMANDS_SYNC_FAILED`, 404 con el flag apagado.
- **El puente lo llama una vez al llegar a `ready`** (y lo reintenta 3 veces con backoff si falla; no es
  fatal). Así un deploy de roz con comandos nuevos queda registrado en el siguiente arranque del puente.
- roz compara el hash de `definitions.ts` contra el de `GET /applications/{app}/guilds/{guild}/commands`
  normalizado igual (`commandsHash`): no guarda estado. Si difieren, `PUT` masivo (idempotente; borra los
  comandos de la app en el servidor que ya no están en la definición).
- A mano: `npm run discord:commands` (`-- --check`, `-- --force`). Necesita `DISCORD_BOT_TOKEN`,
  `DISCORD_CLIENT_ID` (Application ID) y `DISCORD_GUILD_ID`.
- Desde el puente: `npm run register-commands` (`-- --check` → `dryRun=1`, `-- --force`); en Railway
  `node dist/register-commands.js`. Solo necesita `ROZ_API_URL` y `ROZ_BRIDGE_SECRET` (llama a la ruta
  de sync; el PUT lo hace roz). No reemplaza a `npm run discord:commands`: son dos entradas al mismo
  `syncGuildCommands`. `DISCORD_REGISTER_COMMANDS=false` en el puente apaga el registro al arrancar.
- `GET /v1/internal/discord/commands` → `{ hash, commands }` (diagnóstico).
- Invitación del bot: agregar el scope `applications.commands`
  (`…/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=…`).

## 3. Definición

Comando de SERVIDOR. Desplegable de Discord al escribir `/roz`: los subcomandos en este orden. Las
opciones con autocompletado mandan como `value` un **id** (uuid de roz) o un **identificador**
(`WAT-44`), nunca un nombre.

```json
[
  {
    "type": 1, "name": "roz",
    "description": "roz: tareas, tickets, daily, planes del agente, pulso, infra y juntas",
    "options": [
      { "type": 1, "name": "tarea", "description": "Busca una tarea y publica su ficha en el canal", "options": [
        { "type": 3, "name": "buscar", "description": "Texto, ID (WAT-44) o persona", "required": true, "autocomplete": true, "max_length": 100 },
        { "type": 3, "name": "persona", "description": "Solo tareas de esta persona", "autocomplete": true, "max_length": 100 } ] },
      { "type": 1, "name": "ticket", "description": "Crea un ticket inteligente: roz propone prioridad y responsable", "options": [
        { "type": 3, "name": "proyecto", "description": "Proyecto del ticket (si no, el del canal)", "autocomplete": true, "max_length": 100 } ] },
      { "type": 1, "name": "status", "description": "Tu daily: elige tus tareas y publica su estado en el canal" },
      { "type": 1, "name": "plan", "description": "Plan del agente de un issue (sin issue: tus planes)", "options": [
        { "type": 3, "name": "issue", "description": "Issue del plan, p. ej. WAT-44", "autocomplete": true, "max_length": 100 } ] },
      { "type": 1, "name": "pulso", "description": "Quién trabaja en qué ahora (solo lo ves tú)", "options": [
        { "type": 3, "name": "persona", "description": "Ver el detalle de una persona", "autocomplete": true, "max_length": 100 } ] },
      { "type": 1, "name": "infra", "description": "Estado de los servicios (solo lo ves tú)", "options": [
        { "type": 3, "name": "proyecto", "description": "Solo los servicios de este proyecto", "autocomplete": true, "max_length": 100 } ] },
      { "type": 1, "name": "junta", "description": "Pega notas o el transcript de una junta para la bandeja de Juntas", "options": [
        { "type": 3, "name": "proyecto", "description": "Proyecto de la junta (opcional)", "autocomplete": true, "max_length": 100 } ] }
    ]
  },
  { "type": 3, "name": "Crear tarea con roz", "description": "" },
  { "type": 3, "name": "Guardar como decisión", "description": "" },
  { "type": 3, "name": "Citar tareas", "description": "" }
]
```

Valores de autocompletado por opción:

| Opción | `value` | `name` (≤ 100) |
|---|---|---|
| `tarea.buscar` | `work_item.id` | `WAT-44 · Título — Responsable` |
| `*.persona` | `dev.id` | nombre del dev |
| `*.proyecto` | `project.id` | nombre del proyecto |
| `plan.issue` | identificador (`WAT-44`) | `WAT-44 · Título — Estado del plan` |

Reglas verificadas por `validateDefinitions` (y por el test): nombres de barra 1-32 en minúsculas
`^[-_'\p{L}\p{N}]+$`; descripciones 1-100; ≤ 25 opciones; requeridas antes que opcionales;
autocompletado sin `choices`; ≤ 4000 caracteres por comando; comandos de mensaje con nombre 1-32,
descripción vacía y ≤ 5 por servidor. El valor `__ligar_cuenta__` (`NOT_LINKED_CHOICE_VALUE`) solo
aparece para quien no tiene cuenta ligada.

## 4. custom_id

`roz1:<acción>[:<arg>…]`, ≤ 100 caracteres (`buildCustomId` / `parseCustomId`). Args: **solo ids**
(`uuid`, `snowflake`; `_` = sin valor). Nunca nombres, textos, tokens ni ids de usuario: quién actúa
lo dice la interacción (quien hace clic) y los permisos se revisan en roz. Un `roz0`/`roz2` responde
"esta ficha es de una versión anterior"; algo que no empieza con `rozN` o con args raros no ejecuta
nada. Si cambia el significado de una acción, se sube a `roz2`.

| Acción | Superficie | Args | Dueño | Qué hace |
|---|---|---|---|---|
| `tarea.tomar` | botón | taskId | tarea | te asigna la tarea |
| `tarea.estado` | select (1) | taskId | tarea | `values[0]` = `TaskState` |
| `ticket.modal` | modal | projectId \| `_` | ticket | campos `titulo`, `descripcion` (+ `proyecto` select si `_`) |
| `status.elegir` | select (1..25) | — | status | `values` = ids de tareas → publica el status |
| `status.buscar` | botón | — | status | abre `status.buscar.modal` |
| `status.buscar.modal` | modal | — | status | campo `buscar` |
| `msg.tarea.modal` | modal | channelId, messageId | mensaje-crear-tarea | campos `titulo`, `descripcion`, `proyecto` (select) |
| `plan.aprobar` | botón | planId | plan | aprueba |
| `plan.cambios` | botón | planId | plan | abre `plan.cambios.modal` |
| `plan.cambios.modal` | modal | planId | plan | campo `comentario` (≤ `FEEDBACK_MAX`) |
| `junta.modal` | modal | projectId \| `_` | junta | campos `titulo`, `notas` (≤ 4000) |
| `msg.decision.proyecto` | select (1) | channelId, messageId | mensaje-decision | `values[0]` = projectId |

Los ids de los CAMPOS de un modal (`titulo`, `descripcion`…) son nombres fijos, no van versionados.
Los modales usan la forma actual de Discord: `Label` (type 18) con un `TextInput` (4) o `StringSelect`
(3) dentro (`textField` / `selectField` de respond.ts). `readModalFields` entiende esa forma y la vieja
(filas). Un select dentro de un modal admite ≤ 25 opciones: con más proyectos, ordenar el mapeado al
canal primero y luego por actividad reciente.

## 5. Subcomandos

Visibilidad: **efímero** para consultas (pulso, infra, búsquedas sin publicar, errores); **público**
para fichas, status y tickets creados. "defer" = qué pasa si no termina en el presupuesto (§2.2).

### 5.1 `/roz tarea <buscar> [persona]` — trabajo
- autocomplete `buscar`: `searchTasks(actor.devId, texto)` (src/chat/tasks.ts); si `persona` ya está
  llena, filtrar por ese dev. `persona`: devs activos.
- run (defer `public`): carga la tarea (`tasksByIds` + responsables) → `taskCardMessage(taskCardFromRef(…))`
  → `publicMessage`. Un `buscar` que no es uuid (escribió y dio Enter sin elegir) → resolver por
  identificador o primera coincidencia; sin nada → efímero "no encontré esa tarea".
- `tarea.tomar` (defer `update`): asignar al actor con las reglas de tareas (con `ROZ_LINEAR_SOT`, en
  Linear) → `updateMessage(taskCardMessage(ficha nueva))`.
- `tarea.estado` (defer `update`): cambiar a `values[0]` con las mismas reglas que el PATCH del
  dashboard → `updateMessage(ficha nueva)`. Un estado no permitido → `ephemeral` con el motivo.

### 5.2 `/roz ticket [proyecto]` — trabajo
- run (defer `never`): **siempre** `openModal`. Proyecto = opción, o el mapeado del canal
  (`discord_project_channel`), o `_` → el modal trae `selectField('proyecto', …)`.
- `ticket.modal` (defer `public`): `previewTicket` + `createTicket` de src/tickets/smart.ts con
  `TicketUser { userId: actor.authUserId, devId: actor.devId }` y el responsable propuesto (Jev +
  política p2). Con `ROZ_LINEAR_SOT` el issue nace en Linear; sin él, tarea nativa. Responde público:
  la ficha + "Asignado a X" (con `mentionUserIds` del responsable si tiene Discord ligado).

### 5.3 `/roz status` — trabajo
- run (defer `ephemeral`): select `status.elegir` (min 1, max ≤ 25) con las tareas abiertas del actor
  (`searchTasks(devId, '')`, default = las en curso) + botón `status.buscar`.
- `status.buscar` (defer `never`): modal `status.buscar.modal` con `textField('buscar')`.
- `status.buscar.modal` (defer `update`): rehace el efímero con el select de los resultados.
- `status.elegir` (defer `update`): `updateMessage(notice('ok', 'Publicado en el canal.'))` +
  `followup(statusMessage(…), { ephemeral: false })` (formato en §7.1).

### 5.4 `/roz plan [issue]` — visibilidad
- defer: con `issue` → `public`; sin → `ephemeral` (ya en el stub).
- autocomplete `issue`: planes visibles (identificador).
- run: con issue → `planByIdentifier` + `getPlanDetail(id, actor.devId)` → `planMessage(plan)`; los
  botones salen de `plan.actions` (calculado para el actor). Sin issue → `listPlans({ scope: 'mine' })`
  en un mensaje efímero (`myPlansMessage`).
- `plan.aprobar` (defer `update`): `approvePlan(planId, { userId, devId })` (solo el dueño: lo revisa
  `checkAction`; un `AppError` 403 sale como efímero con su mensaje) → `updateMessage(planMessage)`.
- `plan.cambios` (defer `never`): modal `plan.cambios.modal` con `textField('comentario', paragraph)`.
- `plan.cambios.modal` (defer `update`): `requestChanges` → `updateMessage(planMessage)`.

### 5.5 `/roz pulso [persona]` — visibilidad
- run (defer `ephemeral`): `getPulse()` → `pulseMessage(people)` o `personMessage(persona)` (issue
  actual, estado, plan del agente, presencia del calendario, su semana). Formato en §7.1.

### 5.6 `/roz infra [proyecto]` — visibilidad
- run (defer `ephemeral`): snapshots del poll (src/infra/*; nunca llamar a los proveedores en línea)
  → `infraMessage(servicios, { projectName, emojis })`: una tarjeta por caído/degradado con último
  error y deploy sospechoso (máx. 6; el resto contado) y una línea por proveedor. Formato en §7.1.

### 5.7 `/roz junta [proyecto]` — visibilidad
- run (defer `never`): modal `junta.modal:<proyecto|_>` con `titulo` y `notas` (paragraph, 4000: el
  tope de Discord por campo; para transcripts largos, la bandeja de roz).
- `junta.modal` (defer `ephemeral`): `createMeeting({ id: actor.authUserId, devId, devName }, { title,
  heldAt: ahora, attendees: [], projectId, format: 'texto', content })` → efímero con el link a
  `/app/meetings`.

## 6. Acciones de mensaje

`ctx.target` es el mensaje crudo de `data.resolved.messages[target_id]`.

### 6.1 "Crear tarea con roz" — trabajo
- run (defer `never`): modal `msg.tarea.modal:<channelId>:<messageId>` prellenado (título = primera
  línea ≤ 200, descripción = el resto) + select de proyecto (el del canal preseleccionado).
- `msg.tarea.modal` (defer `public`): `loadViewer(actor.devId)` + `createTaskFromDiscordMessage(viewer,
  messageId, …, actor.authUserId)` (valida que lo ve, guarda `discord_message_id`, link como evidencia,
  aviso del bot). Responde la ficha.

### 6.2 "Guardar como decisión" — visibilidad
- run (defer `ephemeral`): canal mapeado → guardar como átomo de decisión del brain del proyecto (con
  el link al mensaje como fuente; valida que el actor ve el mensaje) y confirmar. Sin mapeo → efímero
  con el select `msg.decision.proyecto:<canal>:<mensaje>`.
- `msg.decision.proyecto` (defer `update`): guarda en el proyecto elegido → `updateMessage('Guardado…')`.

### 6.3 "Citar tareas" — trabajo
- run (defer `public`): IDs del texto (sueltos, con `#`, dentro de nombres de rama; ignora bloques de
  código y URLs) y de los embeds de mensajes de bots → ids vigentes o viejos → fichas.
- Hasta 3 tareas: **una ficha por mensaje, cada una con sus botones** (la primera es la respuesta, las
  demás followups públicos). Más de 3: todas en un solo mensaje y **sin botones**. Motivo: "Tomar" y
  "Cambiar estado" reemplazan el mensaje entero; con varias fichas en un mensaje, apretar un botón
  borraría las demás. Sin IDs → efímero.

## 7. API para los handlers

Cada archivo de `handlers/` exporta `export const handlers: HandlerModule` (ya están los stubs con la
firma final; solo se llenan `run`/`autocomplete`). Tipos en `src/discord/commands/types.ts`:

```ts
interface CommandActor { devId; devName; githubLogin: string|null; authUserId: string|null; discordUserId }
interface BaseContext { interaction: DiscordInteraction; actor: CommandActor; guildId; channelId: string|null; log }
SlashContext        = BaseContext & { subcommand: RozSubcommand; options: Record<string, string|number|boolean> }
AutocompleteContext = BaseContext & { subcommand; focused: { name, value }; options }
MessageCommandContext = BaseContext & { command: MessageCommandKey; target: DiscordApiMessage }
ComponentContext    = BaseContext & { customId: { action, args: (string|null)[] }; values: string[]; message }
ModalContext        = BaseContext & { customId; fields: Record<string, string|string[]>; message }

SlashHandler   { defer: DeferSpec<SlashContext>; run(ctx): Promise<Reply>; autocomplete?(ctx): Promise<AutocompleteChoice[]> }
MessageCommandHandler / ComponentHandler / ModalHandler { defer: DeferSpec<Ctx>; run(ctx): Promise<Reply> }
DeferSpec<C> = 'ephemeral' | 'public' | 'update' | 'never' | ((ctx: C) => …)
```

Constructores (`respond.ts`): `ephemeral(msg, followups?)`, `publicMessage(msg, followups?)`,
`updateMessage(msg, followups?)`, `openModal(modal(customId, title, [textField|selectField|textDisplay]))`,
`followup(msg, { ephemeral })`, `row`, `button`, `linkButton`, `stringSelect`, `errorReply`.
Fichas (`embeds.ts`, Components V2): `taskCardFromRef`, `taskCardSection/Components/Message`,
`taskListMessage`, `planComponents/Message`, `statusMessage`, `pulseMessage`, `personMessage`,
`infraMessage`, `serviceProblemSection`, `githubAvatar`. Piezas (`v2.ts`): `v2Message`, `container`,
`header`, `text`, `section`, `sectionOrText`, `thumbnail`, `separator`, `notice`, `STATUS_EMOJI`,
`fitV2`, `toV2`. Emojis (`emojis.ts`): `appEmojis`, `providerIcon`, `icon`. Enlaces (`links.ts`):
`appLink`, `rozBotImage`, `publicBaseUrl`.

Reglas:
- **Lanzar `AppError` con un mensaje para el usuario** (status < 500) en errores esperados: el router
  lo muestra efímero como "No se pudo: <mensaje>". Cualquier otro error sale con un texto genérico.
- Nunca construir `allowed_mentions` a mano: `OutgoingMessage.mentionUserIds` (solo usuarios; nunca
  roles ni @everyone, aunque el texto los traiga).
- No llamar a Discord desde un handler para responder: devolver el `Reply`. Para mensajes extra, `followups`.
- Topes (40 componentes y 4000 caracteres de texto por mensaje V2, 5 botones por fila, 25 opciones,
  100 por valor, 45 título de modal) ya los recortan los constructores y `fitV2` (§7.1).
- Autocompletado: rápido (una consulta) y ≤ 25; si tarda más que el presupuesto vuelve vacío.

### 7.1 Formato de los mensajes (Components V2)

**Todos** los mensajes de roz en Discord (respuestas, followups, ediciones y lo que publica el
compositor por webhook) salen con el flag `IS_COMPONENTS_V2` (`1 << 15`; con efímero, `| 64`). Con ese
flag el mensaje **no lleva `content` ni `embeds`**: todo va en componentes. `respond.ts#toMessageBody`
lo garantiza: si un handler devuelve texto o filas clásicas, `toV2` lo envuelve en el Container de roz;
si devuelve un Container, el `content` suelto (p. ej. la nota del status) entra como su primer texto.

- **Al editar** (callback type 7, `PATCH …/messages/@original`) se manda `content: null` y `embeds: []`
  junto con el flag: Discord exige vaciarlos al ponerlo (así una ficha vieja con embeds se convierte al
  apretar "Tomar"). El flag no se puede quitar después. Al completar un diferido efímero, el PATCH repite
  el bit 64 (Discord pide incluir los flags ya puestos). El callback diferido (type 5/6) no lleva el
  flag: se pone en el PATCH que lo completa. `with_components=true` en toda edición/followup/webhook.
- **Topes** (docs.discord.com → Components → Reference): 40 componentes por mensaje contando los
  anidados (filas, botones, textos de una Section y su accesorio) y 4000 caracteres sumando todos los
  TextDisplay. Los constructores ya limitan (≤ 10 personas con tarjeta, ≤ 6 servicios con problema,
  títulos ~60 en las líneas, nombres de servicios con `joinFit` → "+N"); `fitV2` es la red de
  seguridad: quita del final lo que no sea el encabezado ni una fila de botones y deja "…y más en roz".

Piezas (`v2.ts`): Container (17) con `accent_color` naranja `#ff5b23`; TextDisplay (10) en markdown
(`### ` encabezado, `-# ` texto tenue, `**negritas**`, `` `código` ``, `<t:…:R>` hora relativa que
Discord pinta en el idioma de quien mira); Section (9) = 1-3 textos + accesorio Thumbnail (11) o botón
(una Section sin accesorio no existe: `sectionOrText` cae a texto); Separator (14) con `divider`
**entre grupos, no entre elementos**; ActionRow (1) con botones solo donde aportan.

Reglas de diseño:
- Un Container por mensaje. Encabezado `### <Título>` + `-# resumen en números · actualizado <t:…:R>`.
  Nunca "roz" de autor (el bot ya se llama roz).
- Lo importante primero; lo normal **colapsado**: nunca una línea por elemento cuando todos están bien.
- Estados con UN emoji en toda la app (`STATUS_EMOJI`): 🟢 trabajando / en línea / hecho · 🟡 en junta /
  ocupado / esperando · 🟣 el agente trabajando · 🔴 caído / bloqueado / error · ⚪ fuera / inactivo /
  sin datos. Tareas: en curso y hecha 🟢, en revisión 🟡, por hacer / cancelada ⚪.
- Personas: Section con la foto de GitHub (`https://github.com/<login>.png?size=96`, pública); sin login,
  sin miniatura. "**Nombre** · 🟢 En código" y debajo "`ID` título".
- "Abrir" solo con URL pública (`links.ts`), igual que antes.
- Errores y avisos: `notice(tono, frase, detalle?)` — una línea con 🔴/⚪/🟢 y, si hace falta, una tenue.

Por comando:

| Mensaje | Estructura |
|---|---|
| `/roz pulso` | `### Pulso del equipo` · `-# 2 trabajando · 2 en junta · 4 fuera · 1 agente · actualizado …`. Una Section por persona **con issue o agente** (agente/en código, luego en junta, luego el resto; ≤ 10, el resto en "-# También con issue: …"). Al final UNA línea tenue `-# Sin issue en curso: Manuel, Fer, …`. Botón "Abrir pulso". |
| `/roz pulso persona:X` | Section con la foto: `### Nombre`, estado, proyectos tenues. Luego **Trabajando en** (issue + estado), **Plan del agente** (🟣 + progreso), **Calendario** (presencia), **Esta semana** (ícono de GitHub · commits · PRs · issues). Botón "Abrir". |
| `/roz infra` | `### Infraestructura[ · Proyecto]` · `-# 21 servicios · 20 en línea · 1 sin datos · actualizado …`. Si hay problemas: una Section por servicio caído/degradado (🔴 nombre · estado, proveedor con ícono, último error, deploy sospechoso; botón "Abrir"). Si no: `## 🟢 Todo en línea`. Después UNA línea por proveedor: `<ícono> **Vercel** · 🟢 11/11 en línea` y debajo `-# hyperflow-app, hyperflow-core, …`. |
| Ficha de tarea (`/roz tarea`, citar ≤ 3, crear tarea, ticket) | Línea opcional arriba ("🟢 Ticket `ROZ-77` creado · asignado a @X"). Section: `**Título**`, chips `` `WAT-44` · 🟢 En curso · Prioridad alta · Manuel ``, `-# Proyecto`; miniatura = foto del responsable. Filas: Tomar / Abrir / Linear y el select "Cambiar estado". |
| Citar > 3 | `### N tareas citadas` + un texto con título y chips por tarea, **sin botones** (§6.3). |
| `/roz status` (daily publicado) | Section con la foto: `### Daily de Nombre` · `-# miércoles 12 nov · 5 tareas`; la nota; luego grupos `**🟢 En curso**`, `**⚪ Por hacer**`, `**🟡 En revisión**`, `**🟢 Hecho**` con una línea `` `ID` título `` por tarea. |
| `/roz status` (selector) | `### Tu status` + tenue + select + "Buscar otras". |
| `/roz plan issue:X` | Section con la foto del dueño: `### <ícono roz_bot> `WAT-44` título`, estado con emoji (+ progreso), `-# riesgo · dueño · proyecto`. Pasos numerados, "Por qué ese riesgo" tenue, PR (ícono de GitHub), error 🔴. Botones Aprobar / Pedir cambios (solo si `plan.actions`), Abrir, PR. |
| `/roz plan` (los míos) | `### Tus planes del agente` · `-# N planes · M esperan tu decisión`; una línea con emoji por plan; ≤ 3 filas de Aprobar/Pedir cambios. |
| Errores / sin cuenta / avisos | Un Container corto: `🔴 No se pudo: …`, `⚪ Tu cuenta de Discord no está ligada a roz.` + botón, `🟢 Publicado en el canal.`, `🟢 Junta «…» guardada`. |

**Emojis de aplicación** (íconos dentro del texto): `roz_vercel`, `roz_railway`, `roz_supabase`,
`roz_github`, `roz_linear`, `roz_bot`. Los sube `npm run discord:emojis` (`-- --check` para ver qué
falta; idempotente, nunca borra) desde los PNG 128×128 de `discord-bridge/assets/emojis/` (generados
de `web/public/integrations/*.svg` — Vercel, Railway y GitHub en blanco para el fondo oscuro — y de
`web/public/brand/roz-bot.svg`). En runtime `emojis.ts` los lee con `GET /applications/{app}/emojis`
(token del bot), cacheados 10 min (1 min si falló) y con ≤ 700 ms de espera; si falta uno, ese ícono
cae a texto plano.

**Chat de Discord dentro de roz**: el espejo pinta embeds, así que `normalize.ts` (compartido con el
puente) aplana un mensaje V2 en UN embed (`### ` → título, el resto a la descripción, la primera
miniatura y el color del Container), también en MESSAGE_UPDATE. Lo efímero del compositor
(`ephemeralView`) usa el mismo aplanado. "Citar tareas" busca IDs también en los textos de los
componentes.

## 8. Identidad, permisos y seguridad

- **Servidor**: `interaction.guild_id` = `DISCORD_GUILD_ID` y `application_id` = `DISCORD_CLIENT_ID`; si
  no, efímero y nada se ejecuta. Además el cuerpo del puente trae su `guildId` (≠ → 403).
- **Identidad**: `member.user.id` → `discord_link.discord_user_id` → `dev` activo. Sin vínculo (o dev
  inactivo) → efímero con el botón a `/app/settings` (texto con la URL si no hay URL pública) y, en
  autocompletado, un único choice que lo explica.
- **Permisos**: los de roz, revisados por los servicios que se reutilizan (aprobar solo el dueño, reglas
  de estados de tareas, ver el mensaje con `loadViewer`/`loadVisibleMessage`). Con `ROZ_LINEAR_SOT`
  las escrituras van a Linear por los mismos servicios.
- **Bearer** del puente con `secureEqual` (tiempo constante); secreto vacío → 403 siempre.
- **Tokens**: el de la interacción nunca se loguea ni se devuelve; `routeKey` lo tacha
  (`/interactions/:id/:token/callback`, `/webhooks/:app/:token/...`). Los logs de la ruta llevan
  `interactionId`, ruta despachada, ms y tipo de callback.
- **Identidad visual**: Components V2 con acento `#ff5b23` (§7.1). Los enlaces "Abrir" a roz se
  **omiten** si `DASHBOARD_URL` está vacía o es localhost/IP privada. Las fotos son las de GitHub
  (públicas). `rozBotImage` (PNG de Roz-bot) sigue en links.ts, pero las fichas ya no lo usan.

## 9. Paridad en roz (compositor del chat de Discord)

El compositor de `web/src/components/discord/*` debe ofrecer lo mismo que el chat interno de antes:

- **"/"**: menú con `commandMenu()` (definitions.ts) — la MISMA lista y descripciones que Discord.
  Endpoint sugerido: `GET /api/dashboard/discord/commands` → `{ items: CommandMenuItem[] }`.
- **"@tarea"**: búsqueda (`searchTasks`) que inserta la ficha.
- **Botón "Status"**: el daily.
- Ejecutar: `POST /api/dashboard/discord/channels/:channelId/commands` con
  `{ subcommand, options, fields? }` (sin modales en el navegador: el front pide los campos con su
  propia UI). La API reutiliza los mismos servicios y los constructores de `embeds.ts`, y publica en el
  canal **por el webhook del dev** (`executeWebhook` acepta `components` y `flags`: se publica en
  Components V2 igual que en Discord; los webhooks de
  roz los crea el bot, así que admiten botones) como el resto de mensajes. Consultas efímeras (pulso,
  infra) se devuelven al front sin publicar. Valida `channelAbilities` (`send`) como el envío normal.
  No pasa por el router (no hay interacción ni token).

Construido así (`src/discord/commands/from-roz.ts`, rutas en `src/routes/discord.ts`):

- `GET /api/dashboard/discord/commands` → `{ items: CommandMenuItem[] }`.
- `POST /api/dashboard/discord/channels/:channelId/commands` con `{ subcommand, options?, fields? }` →
  `{ published: DiscordMessageView[], ephemeral: { content, embeds, links }[] }`. Formato de `fields`:
  - `ticket` → `{ titulo, descripcion }` (+ `proyecto` opcional; corre el handler `ticket.modal`);
  - `junta` → `{ titulo, notas }` (corre `junta.modal`);
  - `status` → `{ tareas: id[] (≤ 25), nota? }` (corre `status.elegir`; la nota va como texto del
    mensaje publicado).
  - `tarea`, `plan`, `pulso`, `infra` → el `run` del subcomando con sus `options`.
- `POST /api/dashboard/discord/channels/:channelId/commands/autocomplete` con
  `{ subcommand, option, value, options? }` → `{ choices }`: el MISMO autocompletado que Discord.
- Identidad: el dev de la sesión, que debe coincidir con su `discord_link` (`resolveActor`); si no, 403.
  Lo que publica exige `send` en el canal ANTES de correr el handler (no se crea un ticket que no se
  puede publicar). Los handlers reciben `interaction.token = ''` y `message: null`: nunca llaman a
  Discord con el token, solo devuelven un `Reply`.
- Front: `DiscordComposer.tsx` ("/" con el menú, "@tarea" con la búsqueda del chat interno, botón
  "Status"), `CommandDialog.tsx` (opciones con autocompletado + texto libre, campos de ticket/junta,
  resultados privados dentro del diálogo) y `web/src/discord/commands.ts` (menú de respaldo idéntico a
  `commandMenu()`, lo revisa un test).

## 10. Pruebas

- `discord-commands-definitions`: reglas de Discord, orden, hash estable e independiente del orden y de
  los campos extra que devuelve Discord.
- `discord-commands-custom-id`: ida y vuelta, ≤ 100, rechazo de versión/acción/args.
- `discord-commands-router`: registro completo, PING, servidor/app ajenos, sin cuenta, inmediato vs
  diferido (5/6), reintento 10015, modales, autocompletado (recorte, vacío si tarda), componentes,
  modales (Label y fila), acciones de mensaje, followups, enmascarado del token, enlaces públicos y la
  ruta HTTP (403/400/200).
- `discord-cmd-trabajo`: tarea, ticket, status, crear tarea, citar, Tomar y Cambiar estado.
- `discord-cmd-vis`: plan, pulso, infra, junta y guardar como decisión.
- `discord-commands-composer`: paridad del compositor (from-roz, rutas, menú del front).
- `discord-v2`: formato (§7.1): flag y cuerpo V2 (crear/editar), topes y `fitV2`, colapso de infra y
  pulso, daily agrupado, plan, emojis de la app con caché y el aplanado para el espejo. Ayudas para
  leer mensajes V2 en las pruebas: `test/discord-v2-helpers.ts`.
- Puente: `discord-bridge/test/{interactions,commands}.test.ts` (+ casos en `bridge.test.ts` y
  `config-log.test.ts`).
- Los handlers llenos deben probarse con la base falsa (`test/discord-fixture.ts`) y `fetch` simulado;
  nunca contra Discord real ni la base del `.env` (apunta a producción).
