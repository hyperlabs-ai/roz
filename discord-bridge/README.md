# roz-discord-bridge

Servicio puente entre el servidor de Discord de la empresa y roz. Mantiene la conexión persistente
al gateway de Discord (por eso vive en **Railway** y no en Vercel), **espeja** el servidor en
Supabase (schema `roz`, tablas `discord_*` de `migrations/0038_discord_chat.sql`) y **avisa** a roz
para que el chat del dashboard se actualice en tiempo real.

Solo se usa con `ROZ_DISCORD_CHAT=true` en roz. Con el flag apagado el puente puede ni existir: roz
responde 404 a sus avisos y el puente deja de avisar (sigue espejando).

Contrato completo (fuente de verdad): [`docs/discord-chat-contracts.md`](../docs/discord-chat-contracts.md), sección A.
Comandos `/roz` y acciones de mensaje: [`docs/discord-commands-contract.md`](../docs/discord-commands-contract.md).

## Qué hace

| | |
|---|---|
| Conexión | discord.js v14 con los intents `Guilds`, `GuildMessages`, `MessageContent`, `GuildMembers`, `GuildMessageReactions`, `GuildEmojisAndStickers`. RESUME automático; si Discord pide re-identificar, repite backfill + reconciliación. |
| Espejo | Guild (dueño), categorías, canales e hilos (nombre, orden, tema, tipo, padre, permission overwrites, archivado, miembros de hilos privados), roles, miembros y sus roles, emojis, mensajes (contenido, autor, adjuntos, embeds, stickers, menciones, respuestas, reacciones, ediciones, borrados). |
| Tiempo real | Cada evento del gateway se escribe en la base y **después** se avisa a roz (`POST /v1/internal/discord/events`, solo ids, agrupados cada ~250 ms o 100 avisos). roz relee la fila, calcula quién la ve y transmite. |
| Backfill | Al arrancar: estructura completa + los últimos `DISCORD_BACKFILL_MESSAGES` mensajes por canal de texto/anuncios e hilo activo. Con cursores por canal (`discord_sync_state`): un arranque nuevo solo trae lo que falta. |
| Reconciliación | Lo que cambió mientras estuvo caído: canales/roles/emojis borrados → `deleted_at`; miembros que se fueron → `left_at`; hilos archivados o borrados; mensajes nuevos (`after=` paginando), editados y borrados (dentro de los últimos 100 por canal). |
| Eco de webhooks | Un mensaje enviado desde roz llega dos veces (respuesta del webhook en roz y MESSAGE_CREATE aquí) con el mismo id: ambos hacen upsert sobre la misma fila y el puente **nunca** escribe `dev_id` ni `client_nonce`, así que el autor real se conserva sin importar el orden. |
| Comandos | `/roz` (tarea, ticket, status, plan, pulso, infra, junta) y las acciones de mensaje. El puente **no interpreta nada**: reenvía cada `INTERACTION_CREATE` crudo a roz y manda a Discord la respuesta que roz decide (ver §6). Al primer `READY` le pide a roz que registre los comandos del servidor si cambió su definición. |
| Salud | `GET /health` (200 conectado / 503 si lleva más de 60 s desconectado) y latido cada 30 s en `discord_bridge_state`. Incluye contadores de interacciones (`forwarded`, `fallbacks`, `callbackErrors`, `inFlight`). |
| Apagado | `SIGTERM` (Railway) → termina el canal en curso, espera las interacciones en vuelo, marca `disconnected`, manda los avisos pendientes y cierra el gateway. |

Nunca escribe con `DELETE` (todo borrado es suave), nunca loguea tokens ni contenido de mensajes.

Las reacciones son **solo lectura** en roz (contrato §B.7): el puente las cuenta, pero nadie
reacciona desde roz.

## 1. Crear la app en el Developer Portal

1. Entra a <https://discord.com/developers/applications> → **New Application** → nombre `roz`.
2. **General Information**: copia el **Application ID** → `DISCORD_CLIENT_ID` (lo usa roz para OAuth).
3. **OAuth2**:
   - Copia el **Client Secret** → `DISCORD_CLIENT_SECRET` (roz, en Vercel).
   - En **Redirects** agrega `https://<tu-roz>/api/discord/callback` → `DISCORD_OAUTH_REDIRECT_URI` (roz).
4. **Bot**:
   - **Reset Token** → copia el token → `DISCORD_BOT_TOKEN` (puente en Railway **y** roz en Vercel).
     Es un secreto: quien lo tiene controla el bot.
   - Desactiva **Public Bot** (solo lo invita la empresa).
   - En **Privileged Gateway Intents** activa:
     - **Server Members Intent** (miembros y sus roles → permisos por canal).
     - **Message Content Intent** (el texto de los mensajes).
     - Presence Intent **no** hace falta.
   Sin los dos primeros el gateway cierra con el código 4014 y el puente no arranca.

### Avatar del bot

El bot es **Roz-bot**. Discord solo acepta PNG/JPG como ícono, así que se sube el PNG exportado:

1. Developer Portal → tu app → **Bot** → **Icon** → sube `discord-bridge/assets/roz-bot.png`
   (512×512) → **Save Changes**. Opcional: el mismo archivo en **General Information → App Icon**.
2. En roz, los mensajes del propio bot (autor con id = `DISCORD_CLIENT_ID`) ya se pintan con
   `roz-bot.svg` en el chat, aunque el ícono en Discord todavía no esté subido.

Las otras expresiones son para thumbnails de embeds, si un aviso del bot llega a publicar uno
(URL pública: `DASHBOARD_URL` + `/brand/roz-bot-<expresión>.png`):

| Archivo | Cuándo |
| --- | --- |
| `roz-bot-happy.png` | PR mergeado, algo salió bien |
| `roz-bot-thinking.png` | Planeando, trabajo en curso |
| `roz-bot-alert.png` | Incidente, error, algo caído |

Hoy el único aviso del bot (`src/discord/notify.ts`, asignación de `/ticket`) es texto con mención,
sin embed, así que todavía no usa thumbnail. Los PNG salen de `web/public/brand/roz-bot*.svg`; para
regenerarlos tras cambiar un SVG:

```bash
npm i --prefix <dir-temporal-fuera-del-repo> @resvg/resvg-js
RESVG_FROM=<dir-temporal-fuera-del-repo> node discord-bridge/scripts/export-bot-avatars.mjs
```

## 2. Invitar el bot al servidor

Permisos que necesita el bot:

| Permiso | Para qué |
|---|---|
| View Channels | ver los canales que espeja |
| Read Message History | backfill y reconciliación |
| Manage Webhooks | roz crea/reutiliza un webhook por canal para publicar con el nombre y la foto de cada dev |
| Send Messages / Send Messages in Threads | avisos de `/ticket` y "Se creó HYP-45 a partir de este mensaje" |
| Embed Links | esos avisos con vista previa |
| Manage Threads (opcional) | ver hilos **privados** de los que el bot no es miembro |

Scopes: **`bot` y `applications.commands`**. El segundo es el que deja a la app registrar `/roz` y
las acciones de mensaje en el servidor; sin él el registro falla con `Missing Access` (50001) y los
comandos no aparecen.

URL de invitación (cambia `CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=275414862848
```

Con Manage Threads (hilos privados):

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=292594732032
```

**Si el bot ya estaba invitado solo con `bot`**, vuelve a abrir la URL de arriba (con
`applications.commands`) y autoriza en el mismo servidor: no hace falta sacarlo antes, Discord solo
agrega el scope. Después reinicia el puente o corre `npm run register-commands` (§6).

En **General Information → Interactions Endpoint URL** no pongas nada: si se llena, Discord deja de
mandar las interacciones por el gateway y el puente no las recibe.

Importante: el bot solo espeja lo que **él** puede ver. Si un canal privado no le da acceso al rol del
bot, ese canal no aparece en roz para nadie. Lo que cada dev ve en roz lo decide roz con los permisos
reales de **ese dev** en Discord (algoritmo oficial, `src/discord/permissions.ts` de roz).

Id del servidor: en Discord, Configuración → Avanzado → **Modo desarrollador**; luego clic derecho en
el servidor → **Copiar ID del servidor** → `DISCORD_GUILD_ID`.

## 3. Variables

Ver [`.env.example`](./.env.example).

| Variable | Obligatoria | Qué es |
|---|---|---|
| `DISCORD_BOT_TOKEN` | sí | token del bot (secreto) |
| `DISCORD_GUILD_ID` | sí | id del servidor de la empresa |
| `SUPABASE_URL` | sí | URL del proyecto de Supabase de roz |
| `SUPABASE_SERVICE_ROLE_KEY` | sí | service role (secreto; las tablas son deny-all salvo service_role) |
| `ROZ_API_URL` | sí | base de roz, p. ej. `https://roz.example.com` |
| `ROZ_BRIDGE_SECRET` | sí | secreto compartido; **el mismo valor** en roz (Vercel) |
| `DISCORD_BACKFILL_MESSAGES` | no (200) | mensajes por canal en el backfill inicial |
| `DISCORD_CATCHUP_MAX_PAGES` | no (50) | tope de páginas de 100 al ponerse al día tras una caída larga |
| `PORT` | no (8080) | puerto del health (Railway lo inyecta) |
| `LOG_LEVEL` | no (info) | `debug`/`info`/`warn`/`error` |
| `DISCORD_REGISTER_COMMANDS` | no (true) | `false` para no pedir el registro de `/roz` al arrancar |

En **roz** (Vercel) los comandos necesitan además `ROZ_DISCORD_CHAT=true`, `DISCORD_BOT_TOKEN`,
`DISCORD_CLIENT_ID` (Application ID) y `DISCORD_GUILD_ID` (el mismo que el del puente).

Si falta una obligatoria el proceso sale con un error que nombra la variable (nunca su valor).

## 4. Desplegar en Railway

Antes: la migración `0038_discord_chat.sql` aplicada en Supabase y el schema `roz` expuesto en la API
(si no, PostgREST responde PGRST106).

1. Railway → **New Project** → **Deploy from GitHub repo** → este repo.
2. En el servicio: **Settings → Source → Root Directory** = `discord-bridge`.
   Railway detecta el `Dockerfile` de esa carpeta y construye con él. No hay `railway.json`: Railway
   retiró Config as Code (los servicios nuevos ya no pueden usarlo), así que lo demás va en Settings.
3. **Variables**: las de la tabla de arriba.
4. **Settings → Deploy**: **Healthcheck Path** = `/health` (timeout 120 s), **Restart Policy** =
   On Failure (10 reintentos) y **1 réplica**. Dos instancias con el mismo token se pelearían la
   sesión del gateway y duplicarían escrituras.
   sesión del gateway y duplicarían escrituras.
5. Despliega. En los logs debe verse `conectando al gateway`, `estado del puente … backfilling` y
   `backfill terminado`. En roz, `GET /api/dashboard/discord/status` → `bridge.healthy: true`.
6. No hace falta dominio público; si lo agregas, solo expone `/health` (sin datos sensibles).

Al rotar `ROZ_BRIDGE_SECRET`: cámbialo en Vercel **y** en Railway y redespliega ambos (roz lee el
secreto al arrancar). Mientras no coincidan, roz responde 403 y el puente reintenta hasta 5 minutos;
el espejo en la base sigue correcto, solo se pierde el empujón de tiempo real.

## 5. Desarrollo

```bash
cd discord-bridge
npm install
npm run typecheck   # src + tests
npm test            # vitest, todo con dobles: sin Discord ni Supabase reales
npm run build
```

Estructura:

```
src/
  index.ts            arranque, señales, watchdog
  bridge.ts           ciclo de vida, estado, latido, health, carril serial
  handlers.ts         DISPATCH crudo del gateway → espejo → avisos
  backfill.ts         estructura, mensajes con cursores, reconciliación
  map.ts              payload crudo → columnas (puro)
  reactions.ts        conteo de reacciones (puro)
  notifier.ts         avisos a roz: lotes, dedupe, reintentos
  interactions.ts     INTERACTION_CREATE → roz → callback a Discord (3 s, fallback)
  commands.ts         pide a roz el registro de /roz (al arrancar, con reintentos)
  register-commands.ts  CLI de `npm run register-commands`
  store/              MirrorStore (interfaz) + Supabase
  source/             Gateway y DiscordSource (interfaces) + discord.js
  shared/             copias GENERADAS de roz (types, reply, normalize) + api-types
test/                 vitest; fakes/ = Discord y base en memoria
scripts/sync-shared.mjs
```

### Código compartido con roz

`src/shared/{types,reply,normalize}.ts` son **copias generadas** de `src/types/discord.ts`,
`src/discord/reply.ts` y `src/discord/normalize.ts` de roz (el puente se despliega solo, sin `../src`).
Si cambias el original, corre `npm run sync-shared`; `test/shared-sync.test.ts` falla mientras la
copia esté desfasada.

### Probar contra Discord real

Todavía no hay token ni servidor. Cuando existan: un servidor de pruebas, un `.env` local con
Supabase de **desarrollo** (nunca el de producción) y `npm run dev`.

## 6. Comandos `/roz` y acciones de mensaje

Contrato: [`docs/discord-commands-contract.md`](../docs/discord-commands-contract.md). Toda la
lógica (qué hace cada subcomando, permisos, identidad por `discord_link`, fichas) vive en roz; el
puente es solo el transporte.

### Qué hay

Al escribir `/roz` Discord muestra el desplegable de subcomandos con su descripción:

| Subcomando | Qué hace | Respuesta |
|---|---|---|
| `/roz tarea <buscar> [persona]` | ficha de la tarea (autocompletado por texto, ID o persona) con "Tomar", "Cambiar estado" y "Abrir" | pública |
| `/roz ticket [proyecto]` | modal → ticket inteligente por el mismo camino que `/ticket` (Jev + política; Linear con `ROZ_LINEAR_SOT`) | pública: ficha + responsable |
| `/roz status` | tu daily: eliges tareas y se publican con su estado actual | selector efímero → tarjeta pública |
| `/roz plan [issue]` | plan del agente; "Aprobar" / "Pedir cambios" solo para su dueño | pública con issue; tus planes efímero |
| `/roz pulso [persona]` | quién trabaja en qué | efímera |
| `/roz infra [proyecto]` | servicios, último error y deploy sospechoso | efímera |
| `/roz junta [proyecto]` | modal con notas/transcript → sesión en la bandeja de Juntas | efímera con el link |

Acciones de mensaje (clic derecho → Apps): **Crear tarea con roz**, **Guardar como decisión** y
**Citar tareas**.

- **Identidad**: cada interacción corre como el dev de roz ligado a ese usuario de Discord
  (`discord_link`). Sin cuenta ligada, respuesta efímera con el link a Configuración y no se ejecuta
  nada.
- **Servidor**: roz solo atiende interacciones de `DISCORD_GUILD_ID` (y de su `DISCORD_CLIENT_ID`).
- **Permisos**: los de roz, revisados en el servidor en cada clic (un `custom_id` solo lleva ids; quién
  actúa lo dice la interacción). Nada de lo que publica el bot hace sonar @everyone, @here ni roles.
- **Variables en roz (Vercel)**: `ROZ_DISCORD_CHAT=true`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID` (el
  mismo del puente), `DISCORD_BOT_TOKEN` y `ROZ_BRIDGE_SECRET`. En el puente (Railway) la única
  variable nueva es `DISCORD_REGISTER_COMMANDS` (opcional, default `true`).
- Los mismos subcomandos existen en roz: el compositor del chat de Discord (`/`, `@tarea`, botón
  "Status") los ejecuta contra la API de roz y publica por el webhook como el resto de mensajes.

### Cómo viaja una interacción

```
Discord ──INTERACTION_CREATE (gateway)──▶ puente ──POST /v1/internal/discord/interactions──▶ roz
                                            │ ◀──────────── 200 { callback } ───────────────┘
                                            └─POST /interactions/{id}/{token}/callback──▶ Discord
roz (si difirió) ──PATCH @original / followup con el token de la interacción──▶ Discord
```

- El puente toma el payload **crudo** (`client.on('raw')`, snake_case), lo manda a roz con
  `Authorization: Bearer ROZ_BRIDGE_SECRET` y `{ guildId, receivedAt, interaction }`, y manda a Discord
  el `callback` que roz devuelve **tal cual** (mensaje, modal, autocompletado, diferido…). No usa
  `interaction.reply()` de discord.js.
- **3 segundos**: roz decide en ≤ 1,8 s; si su lógica tarda más, devuelve un diferido (type 5/6) y
  termina en segundo plano editando la respuesta con el token. El puente espera a roz como máximo
  **2,5 s** (menos si la interacción ya venía tarde, según la fecha de su snowflake).
- **Fallback** (roz no contestó a tiempo, caído, 5xx, 403, 400): autocompletado → lista vacía; el resto
  → efímero "roz no respondió a tiempo…" (timeout), "roz no está disponible…" (caído/error) o
  "roz no tiene activado Discord." (404, flag apagado). Si roz sí difirió y completa después, su
  edición reemplaza ese efímero.
- Una interacción se reconoce **una sola vez**: el callback nunca se reintenta; `40060` (ya
  reconocida) y `10062` (venció) solo se loguean.
- Logs: `interactionId`, tipo, ms y códigos. Nunca el token de la interacción, el secreto ni lo que
  escribió el usuario.
- Solo hay peticiones de **salida** (puente → roz, puente → Discord, roz → Discord): funciona igual en
  local que en Railway, sin URL pública. No configures "Interactions Endpoint URL" en el portal.
- No necesita intents adicionales.

### Registrar los comandos

Son comandos de **servidor** (aparecen al instante, no en una hora como los globales). La definición
vive en roz (`src/discord/commands/definitions.ts`); roz compara el hash de esa definición con lo que
Discord ya tiene y solo hace el `PUT` si cambió (idempotente, sin estado guardado).

- **Automático**: al primer `READY` el puente llama a `POST /v1/internal/discord/commands/sync`
  (3 reintentos con backoff; si falla, lo intenta de nuevo en el siguiente READY; nunca tumba el
  puente). Un deploy de roz con comandos nuevos queda registrado al reiniciar el puente.
  `DISCORD_REGISTER_COMMANDS=false` lo apaga.
- **A mano** (solo necesita `ROZ_API_URL` y `ROZ_BRIDGE_SECRET`):

  ```bash
  npm run register-commands              # registra si cambió
  npm run register-commands -- --check   # solo dice si cambiaría
  npm run register-commands -- --force   # registra aunque coincida
  node dist/register-commands.js         # lo mismo dentro del contenedor de Railway
  ```

  Desde roz también existe `npm run discord:commands` (habla directo con Discord, con el token del bot).

Si los comandos no aparecen al escribir `/roz`:

1. `npm run register-commands -- --check`: un `503 DISCORD_NOT_CONFIGURED` = falta
   `DISCORD_CLIENT_ID`/`DISCORD_GUILD_ID`/`DISCORD_BOT_TOKEN` en roz; `404` = `ROZ_DISCORD_CHAT` apagado;
   `403` = el secreto no coincide.
2. Un `502` con `Missing Access` en los logs de roz = el bot se invitó sin `applications.commands`:
   reinvítalo con la URL de §2 y vuelve a correr `npm run register-commands`.
3. En Discord: Ajustes del servidor → Integraciones → roz → que el comando no esté desactivado para
   tu rol o canal. Recarga Discord (Ctrl+R) si acabas de registrar.

### Cómo probar

- **Tests** (sin red): `npm test` cubre el reenvío (callback tal cual, modales, diferidos), el
  presupuesto de 3 s, los fallbacks por tipo, 40060/10062, que los logs no llevan token ni contenido,
  el registro con reintentos y el script.
- **Local contra Discord** (servidor de pruebas): roz en `localhost:3000` con `ROZ_DISCORD_CHAT=true`,
  el puente con `ROZ_API_URL=http://localhost:3000` y el mismo `ROZ_BRIDGE_SECRET`. Al arrancar debe
  verse `comandos de roz registrados en el servidor` (o `al día`). Escribe `/roz` en un canal: el
  desplegable muestra los subcomandos; cada uso deja en el log del puente `interacción respondida`
  con `source: "roz"` y el `callbackType`. Si ves `source: "fallback"`, mira el log de roz con el
  mismo `interactionId`.
- **Salud**: `curl localhost:8080/health` → `interactions.forwarded` / `fallbacks`.
