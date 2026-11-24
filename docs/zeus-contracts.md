# zeus: contratos

zeus es el back de roz (un proceso: API, MCP, planificador, gateway de Discord) y, dentro de él, el
módulo de **contexto unificado** del equipo (`src/zeus/`). Este documento fija los contratos entre
sus piezas: el API del dashboard, el API del CLI, las herramientas MCP y el formato de cifrado de la
bóveda. Los tipos viven en `src/types/zeus.ts`; el esquema, en `migrations/0040_zeus.sql`.

## 1. Principios

- **El registro central es la fuente de verdad; git solo importa.** Todo documento (ADR, spec,
  cambio, regla, diseño, recurso) vive en la base de zeus y se edita ahí, por la web o por MCP, con
  historial de revisiones. Los repos son el ORIGEN de una importación: zeus trae los documentos que
  todavía no conoce (webhook de push + barrida) y a partir de ahí no los vuelve a tocar. `source`,
  `source_repo`, `source_path`, `source_url` y `source_sha` quedan como procedencia ("importado
  de…"), no como candado. Git solo vuelve a pisar un documento si alguien lo pide ("traer la versión
  del repo", §7).
- **El grafo es para navegar, no para recuperar.** El agente recupera con: un índice corto siempre
  disponible (`zeus_context_index`), búsqueda de texto (`zeus_search`) y el documento por id
  (`zeus_get`). Las aristas existen para lo que sí aporta: reemplaza a, depende de, dueño.
- **Identidad por persona.** Cada dev tiene sus tokens `zeus_…`; todo queda atribuido en
  `roz.zeus_activity`.
- **La bóveda es de conocimiento cero.** zeus guarda texto cifrado; las llaves privadas no salen de
  la PC de cada dev.

## 2. Referencias del grafo

`<tipo>:<id>` — `node:<uuid>`, `dev:<uuid>`, `project:<uuid>`, `repo:<owner/name>`, `runner:<uuid>`.
Los nodos guardados son `adr | spec | change | doc | design | rule | resource | team`. Personas,
proyectos, repos y runners se derivan de sus tablas (no se duplican).

Aristas guardadas: `supersedes · depends_on · relates_to · implements · owns · applies_to · part_of ·
connects_to · documents`. Aristas derivadas (no se guardan ni se borran): `reports_to` (dev → jefe),
`part_of` (nodo → proyecto, repo → proyecto, runner → dev), `owns` (dev → nodo del que es dueño).

## 3. API del dashboard

Base `/api/dashboard/zeus`, `Authorization: Bearer <JWT de Supabase>` (mismo auth que el resto del
dashboard). Errores: `{ error: { code, message } }`.

| Método y ruta | Cuerpo / query | Respuesta |
|---|---|---|
| `GET /me` | | `ZeusMe` |
| `POST /admin/bootstrap` | | `ZeusMe` (solo si `needsAdmin`) |
| `GET /graph` | `?projectId=` | `ZeusGraph` |
| `GET /nodes` | `?projectId=&kind=&status=&q=` | `{ nodes: ZeusNodeSummary[] }` |
| `GET /nodes/:id` | | `ZeusNodeDetail` |
| `POST /nodes` | `ZeusNodeInput` | `ZeusNodeDetail` |
| `PATCH /nodes/:id` | `Partial<ZeusNodeInput>` | `ZeusNodeDetail` (cualquier documento, también los importados; 409 `ZEUS_CONFLICT` si alguien lo editó mientras tanto) |
| `DELETE /nodes/:id` | | `{ ok: true }` (archiva; cualquier documento) |
| `POST /nodes/:id/reimport` | | `ZeusNodeDetail` con la versión del repo aplicada (§7). 409 `ZEUS_NOT_IMPORTED` si se creó en zeus; 404 `ZEUS_SOURCE_GONE` (con `details: { repo, path, branch }`) si el archivo ya no existe; 409 `ZEUS_SOURCE_TRUNCATED` si GitHub devolvió el árbol incompleto |
| `POST /edges` | `{ src, dst, kind, note? }` | `ZeusGraphEdge` |
| `DELETE /edges/:id` | | `{ ok: true }` (cualquier arista guardada, también las que salieron de una importación) |
| `GET /search` | `?q=&projectId=&kinds=a,b` | `{ hits: ZeusSearchHit[] }` |
| `GET /org` | | `ZeusOrg` |
| `PATCH /org/:devId` | `{ reportsTo?, zeusAdmin? }` | `ZeusOrgMember` (admin) |
| `GET /tokens` | | `{ tokens: ZeusTokenSummary[] }` |
| `POST /tokens` | `{ name }` | `{ token, summary }` (el token se muestra una vez) |
| `DELETE /tokens/:id` | | `{ ok: true }` |
| `GET /device/:userCode` | | `ZeusDeviceRequest` (la solicitud de `zeus setup` con ese código; una ya decidida solo la ve quien la decidió) |
| `POST /device/:userCode/approve` | | `ZeusDeviceRequest`. 410 `ZEUS_DEVICE_EXPIRED`, 409 `ZEUS_DEVICE_DECIDED`, 409 `ZEUS_TOKEN_LIMIT` |
| `POST /device/:userCode/deny` | | `ZeusDeviceRequest` |
| `GET /inbox` | | `ZeusInbox` (`open`: encargos y planes que me tocan; `waiting`: los que mandé y siguen abiertos) |
| `POST /messages` | `{ toDevId, subject?, body, ref?, kind?: 'message' \| 'task', projectKey? }` | `ZeusMessage` (un `task` exige `subject` y nace `pending`) |
| `POST /plans` | `{ toDevId, title, plan, projectKey?, revises? }` | `ZeusMessage` (kind `plan`; con `revises` la versión anterior queda `superseded`) |
| `GET /messages/:id` | | `ZeusMessage & { history: ZeusMessage[] }` (versiones anteriores del plan). Solo remitente o destinatario |
| `POST /messages/:id/status` | `{ status, note? }` | `ZeusMessage`. Destinatario: `accepted`, `changes_requested` (nota obligatoria), `declined` (nota obligatoria), `done`. Remitente: `cancelled`. 409 `ZEUS_MESSAGE_CLOSED` si ya se cerró. Al otro lado le llega un aviso |
| `POST /messages/read` | `{ ids: string[] \| 'all' }` | `{ ok: true }` |
| `POST /requests` | `{ kind, title, detail?, resourceRef? }` | `ZeusRequest` |
| `POST /requests/:id/resolve` | `{ decision: 'approved' \| 'denied', note? }` | `ZeusRequest` |
| `POST /requests/:id/cancel` | | `ZeusRequest` |
| `GET /sources` | | `{ sources: ZeusSource[] }` |
| `POST /sources/sync` | `{ repo }` | `{ ok: true }` (encola la lectura del repo: importa lo nuevo, no pisa nada) |
| `GET /activity` | `?since=<ISO>` | `{ events: ZeusActivityEvent[], now }` |
| `GET /vault` | | `ZeusVaultOverview` |
| `POST /vault/keys/:id/revoke` | | `{ ok: true }` (dueño de la llave o admin) |

## 4. API del CLI

Base `/v1/zeus`, `Authorization: Bearer zeus_<43 caracteres base64url>`. El dominio es el de zeus
(Railway), no el del front.

| Método y ruta | Cuerpo | Respuesta |
|---|---|---|
| `GET /whoami` | | `{ dev: { id, name, email }, zeusAdmin }` |
| `GET /vault/keys` | `?all=1` (admin: todas) | `{ keys: ZeusVaultKey[] }` |
| `POST /vault/keys` | `{ name, publicKey }` | `{ key: ZeusVaultKey }` |
| `GET /vault/projects` | | `{ projects: [{ key, name, envs: [{ name, dekVersion, hasGrant, needsRotation }] }] }` |
| `POST /vault/keys/rotate` | `{ oldKeyId, newKeyId, grants: [{ projectKey, env, dekVersion, wrappedDek }], compromised }` | `{ ok, moved }`. Ambas llaves del dev del token; solo entornos donde la vieja tiene acceso vigente. Revoca la vieja; con `compromised` marca sus entornos `needsRotation` |
| `POST /vault/envs` | `{ projectKey, env, keyId, wrappedDek }` | `{ envId, dekVersion: 1 }` (cualquier dev; su llave queda como primer acceso). Nombre `^[a-z][a-z0-9_-]{0,63}$`; el CLI lo arma `<repo>-<etapa>` dentro de un repo |
| `GET /vault/envs/:projectKey/:env` | `?keyId=` | `{ envId, dekVersion, wrappedDek, secrets: [{ name, ciphertext, dekVersion, version, updatedAt, updatedByName }], grants: [{ keyId, devName, keyName, fingerprint }], needsRotation }` |
| `GET /vault/envs/:projectKey/:env/history` | `?keyId=&name=` | `{ dekVersion, revisions: [{ name, version, ciphertext \| null, dekVersion, setAt, setByName, replacedAt, replacedByName, current }] }` (vigente + hasta 10 anteriores por nombre; `ciphertext: null` = borrada en esa versión) |
| `PUT /vault/envs/:projectKey/:env/secrets` | `{ keyId, dekVersion, set: [{ name, ciphertext }], delete: string[] }` | `{ ok, written, deleted }`. Lo reemplazado pasa al historial y a quien tiene acceso le llega un aviso `env_change` (solo nombres) |
| `POST /vault/envs/:projectKey/:env/grants` | `{ keyId, grants: [{ keyId, wrappedDek }] }` | `{ ok, granted }` (quien tiene acceso vigente) |
| `DELETE /vault/envs/:projectKey/:env/grants/:keyId` | | `{ ok }` (quien tiene acceso al entorno, o un admin; deja `needsRotation`) |
| `POST /vault/envs/:projectKey/:env/rotate` | `{ keyId, dekVersion, grants: [{ keyId, wrappedDek }], secrets: [{ name, ciphertext }], revisions?: [{ name, version, ciphertext }] }` | `{ ok, dekVersion }` (quien tiene acceso vigente) |
| `GET /inbox` | | `{ unread, open, waiting, envChanges, toResolve }` resumido (para `zeus doctor` y el inicio de sesión de Claude) |
| `POST /device/start` (sin token) | `{ clientName, platform?, version? }` | `{ deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn: 600, interval: 5 }`. 429 `RATE_LIMITED` |
| `POST /device/poll` (sin token) | `{ deviceCode }` | `{ status: 'pending' | 'slow_down', interval }`, `{ status: 'denied' | 'expired' | 'delivered' }` o, UNA vez, `{ status: 'approved', token, dev }` |

`device/*` es la conexión por navegador de `zeus setup` (estilo RFC 8628, migración 0044): el CLI abre
la solicitud, la persona la aprueba en `<roz>/conectar?code=<userCode>` con su sesión y el siguiente
`poll` entrega un token `zeus_…` nuevo a su nombre ("<equipo> (setup)", reemplaza al anterior del mismo
equipo). Solo se guarda el sha256 del `deviceCode`; el token se crea al entregarlo y no se guarda.
Modelo de amenaza en `src/zeus/device-auth.ts`.

Reglas: leer y escribir secretos exige un `grant` vigente de `keyId` (que debe ser del dev del
token y no estar revocada). `dekVersion` del cuerpo debe ser la vigente del entorno (409
`ZEUS_VAULT_STALE` si no). En `rotate`, `dekVersion` es la NUEVA (vigente + 1), `secrets` debe traer
todos los nombres existentes re-cifrados y `revisions` todas las versiones anteriores legibles con la
DEK vigente (409 `ZEUS_VAULT_INCOMPLETE` si falta alguna). Un CLI anterior al historial no manda
`revisions`: la rotación procede y ese historial se descarta (no se puede re-cifrar sin la DEK).

## 5. Cifrado de la bóveda

Todo con `node:crypto`, sin dependencias. Base64url sin relleno.

- **Llave de equipo**: par X25519. La pública viaja como los 32 bytes crudos en base64url (43
  caracteres). `fingerprint` = primeros 16 hex de `sha256(pública cruda)` en grupos de 4
  (`a1b2-c3d4-e5f6-0718`).
- **DEK** (llave del entorno): 32 bytes aleatorios. Una por entorno y versión.
- **DEK envuelta** (`wrappedDek`): caja sellada para una pública.
  `zv1.<ephPub>.<nonce>.<ct||tag>` donde `ephPub` es una pública X25519 efímera (43), `nonce` 12
  bytes (16) y `ct||tag` la DEK cifrada con AES-256-GCM (48 bytes → 64).
  Llave = `HKDF-SHA256(ikm = ECDH(ephPriv, destinatarioPub), salt = ephPub || destinatarioPub,
  info = "zeus-vault-wrap-v1", 32 bytes)`. AAD = `utf8("<projectKey>:<env>:<dekVersion>")`.
- **Secreto**: `zs1.<nonce>.<ct||tag>`, AES-256-GCM con la DEK, nonce de 12 bytes aleatorio.
  AAD = `utf8("<projectKey>:<env>:<name>:<dekVersion>")`: un texto cifrado movido a otro nombre,
  entorno o versión no descifra.
- Nombres de secreto: `^[A-Za-z_][A-Za-z0-9_]*$`, hasta 128. Valor hasta 64 KiB.

Dar acceso = alguien que ya tiene la DEK la envuelve para la pública del nuevo equipo. Quitar acceso
borra la fila del grant; como esa persona ya vio los valores, lo correcto después es **rotar**: DEK
nueva, se re-cifra todo, y se cambian en el proveedor los secretos que importen.

## 6. Herramientas MCP

Endpoint `POST /mcp` (JSON-RPC). Con un token `zeus_…` el agente actúa como ese dev.

| Herramienta | Para qué |
|---|---|
| `zeus_context_index` | Índice corto de un proyecto: lo fijado, y título + una línea de cada ADR, spec, regla y diseño. Punto de partida. |
| `zeus_search` | Búsqueda de texto. Devuelve id, título, una línea y un recorte. |
| `zeus_get` | Documento completo por id (con sus aristas). `maxChars` para acotar. |
| `zeus_related` | Vecinos de una referencia del grafo. |
| `zeus_write` | Crea o edita un documento en el registro central. Sirve para cualquiera, también los importados de un repo: se editan aquí, no en su archivo. `status: "archived"` lo retira. |
| `zeus_reimport` | Trae la versión que hay hoy en el repo de un documento importado y la aplica como una edición más. Pisa el texto de zeus: solo a pedido explícito. |
| `zeus_link` / `zeus_unlink` | Arista entre dos referencias (quitar sirve también para las que salieron de una importación). |
| `zeus_org` | Organigrama: rol, a quién reporta, proyectos, skills, quién está en línea. |
| `zeus_who_owns` | A quién pedirle un acceso o permiso sobre un recurso o proyecto, y por qué. |
| `zeus_request` | Abre una solicitud (acceso, permiso, revisión, cambio) y la enruta sola. |
| `zeus_requests` / `zeus_resolve_request` | Ver y resolver solicitudes. |
| `zeus_send_message` / `zeus_inbox` / `zeus_mark_read` | Mensajes entre devs y agentes. `kind: "task"` = encargo con estado. `zeus_inbox` separa `open` (mis pendientes), `waiting`, `messages` y `envChanges` (avisos de variables, uno por entorno y persona: los cambios seguidos se juntan). |
| `zeus_share_plan` | Comparte un plan de implementación (markdown completo). `revises` = id del plan que esta versión reemplaza. |
| `zeus_get_message` | Mensaje, encargo o plan completo (con versiones anteriores). |
| `zeus_respond` | Estado de un encargo o plan: `accepted`, `changes_requested`, `declined`, `done` (o `cancelled` quien lo mandó). |
| `zeus_plans` / `zeus_plan_claim` / `zeus_plan_release` | Bandeja de planes del planificador (issues): los míos, los reclamables; tomar o soltar uno. |
| `zeus_env_status` | Qué variables tiene un proyecto (nombres, versión, quién y cuándo), si tengo acceso y los comandos `pull`/`status`. |
| `zeus_message_history` | Historial completo de la bandeja (leído y no leído) con filtros: texto, persona, proyecto, tipo, recibidos/enviados. |
| `zeus_linear_issues` / `zeus_linear_issue` / `zeus_linear_teams` | Linear en vivo (sin espejo): tus tickets activos, el detalle completo de uno (descripción, comentarios, subtareas, rama) y equipos/estados/proyectos. |
| `zeus_linear_create` / `zeus_linear_update` | Crear y mover tickets con la llave del equipo. Se asignan a quien usa el MCP y cada cambio deja "vía zeus · <nombre>" (Linear pone como autor al dueño de la llave). |
| `zeus_meetings` / `zeus_meeting` | Juntas (transcripts subidos a mano): buscar por texto, persona, proyecto o fecha, y traer una completa. |

**Instrucciones y prompts.** El `initialize` devuelve `instructions` (`ZEUS_MCP_INSTRUCTIONS` en
`src/zeus/mcp.ts`): Claude Code las carga solo al conectarse, así que funcionan como una skill sin
instalar nada (cómo usar el contexto, qué hacer con un plan que llega, cómo manejar variables sin ver
valores). También expone `prompts/list` y `prompts/get` (`pendientes`, `compartir-plan`, `variables`),
que en Claude Code aparecen como `/mcp__zeus__<nombre>`.

**Flujo de un plan compartido.** A comparte (`zeus_share_plan`) → a B le llega `pending` → el Claude
de B lo ve en `zeus_inbox`, se lo resume y pregunta: implementar (`accepted` → `done`), ajustar
(`changes_requested` con nota → A manda `revises`, la anterior queda `superseded`) o rechazar
(`declined`). Cada cambio de estado le deja un aviso al otro lado.

**Canales de la bandeja** (`src/zeus/inbox.ts`, `src/zeus/mail.ts`). Todo queda en la bandeja de roz
(y la ve el Claude de cada quien con `zeus_inbox`) y sale por push si la persona lo activó. Por
correo (Resend) los mensajes directos y lo que pide acción, respetando los interruptores global y por dev:

| Evento | Correo a | Cuándo |
|---|---|---|
| Mensaje directo (`kind: message`) | quien lo recibe | inmediato, con el texto completo |
| Encargo nuevo (`kind: task`) | quien lo recibe | inmediato |
| Plan nuevo o versión ajustada | quien lo recibe | inmediato |
| Ajustes pedidos / rechazo | quien lo mandó | inmediato |
| Cambios de variables (`env_change`) | cada persona con acceso | resumen diario 15:00 UTC (`/v1/internal/zeus-env-digest`), solo lo no leído de las últimas 24 h, un correo por persona y día |
| Aceptado, hecho, retirado, avisos del sistema | nadie | solo bandeja y push |

Ruta de una solicitud (`zeus_request`): dueño del recurso → si no hay, líder del proyecto (el
`pm`/`ceo` asignado) → jefe directo de quien pide → un admin de zeus. La respuesta dice a quién se le
envió y por qué.

## 7. Importación desde git

Git no es la fuente de verdad: es de donde se IMPORTAN documentos al registro central. Por repo
vinculado a un proyecto (`roz.project_repo`), de la rama por defecto:

| Ruta | Nodo |
|---|---|
| `openspec/specs/<capacidad>/spec.md` | `spec` (slug = capacidad) |
| `openspec/changes/<cambio>/proposal.md` (+ `design.md`, `tasks.md`) | `change` (un nodo por cambio; no entra `archive/`) |
| `openspec/project.md`, `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE*.md` | `doc` (fijado) |
| `docs/adr/**`, `docs/adrs/**`, `adr/**`, `docs/decisions/**` | `adr` |
| `DESIGN.md`, `**/DESIGN.md`, `docs/design-system/**` | `design` |
| `docs/rules/**`, `.claude/rules/**` | `rule` |

Un push a la rama por defecto marca la fuente como pendiente; la barrida (`/v1/internal/zeus-sweep`,
cada 10 min) lee el árbol y baja solo los blobs de los documentos que zeus todavía no tiene.

- **Documento nuevo** (un repo + ruta que zeus no ha visto): entra como nodo (`source = git`, revisión
  1 con `editedVia: git`) con sus aristas iniciales: `supersedes` sale del texto del ADR ("Supersedes
  ADR-0003") y los enlaces markdown hacia otros documentos importados generan `relates_to`. Como al
  conectar a mano, el documento reemplazado pasa a `superseded` si seguía `active`; es lo único que
  una importación cambia en otro nodo.
- **Documento que ya tiene nodo**: no se toca. Ni contenido, ni estado, ni aristas, aunque el archivo
  cambie en el repo; y si el archivo desaparece del repo, el nodo NO se archiva.
- **Lo archivado no resucita**: un nodo archivado sigue ocupando su (repo, ruta) (índice único
  `uq_zeus_node_source`), así que la siguiente lectura lo cuenta como existente. No hay borrado duro
  de nodos en el API; se restaura desde zeus (`status: active`).
- La identidad de una importación es repo + cualquiera de los archivos que formaron el documento
  (`source_path` y `meta.files`): un cambio de OpenSpec que gana o pierde `design.md`/`tasks.md` sigue
  siendo el mismo nodo.
- `roz.zeus_source` guarda la última lectura: fecha, commit, cuántos documentos de contexto hay en el
  repo (`node_count`) y el último error.

**Traer la versión del repo** (`POST /nodes/:id/reimport`, `zeus_reimport`): vuelve a leer el archivo
de origen de UN nodo importado y lo aplica como una edición más: título, resumen y cuerpo; sube la
versión y deja una revisión `editedVia: git` a nombre de quien lo pidió (la versión anterior queda en
el historial). No cambia estado, dueño, etiquetas ni aristas. Si el archivo es igual a lo que ya hay,
no crea versión. Es la única forma en que git pisa un nodo existente.
