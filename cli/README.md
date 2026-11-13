# zeus (CLI)

CLI que corre en la PC de cada dev. Hace dos cosas:

1. **Mantiene sincronizadas las variables de entorno** de cada proyecto (`.env`) a través de la bóveda de
   zeus, que es de **conocimiento cero**: los valores se cifran y descifran en tu equipo; zeus solo guarda
   texto cifrado.
2. **Conecta tu equipo con zeus** (el back de roz): guarda tu token y te da el comando para conectar
   Claude Code al MCP de zeus.

Solo habla con zeus por `/v1/zeus/*`. No tiene dependencias en tiempo de ejecución: todo el cifrado es
`node:crypto`. Contrato: `docs/zeus-contracts.md`, secciones 4 (API) y 5 (cifrado).

## Modelo de amenazas, en claro

**Cómo funciona.** Cada equipo (laptop, PC) tiene su propio par de llaves X25519; la privada vive en
`~/.zeus/key.json` y nunca sale de ahí. Cada entorno de un proyecto (`ROZ/development`) tiene una llave
de datos (DEK) con la que se cifra cada secreto. Esa DEK se guarda en zeus **envuelta** una vez por cada
equipo con acceso, de modo que solo la privada de ese equipo la abre. Dar acceso = alguien que ya tiene
la DEK la envuelve para la pública del equipo nuevo.

**Qué ve zeus (el servidor, su base de datos y quien los administre):**

- Los **nombres** de las variables, cuántas son, cuándo cambian y quién las cambió.
- Qué equipos tienen acceso a qué entorno, sus llaves públicas y sus huellas.
- Texto cifrado. Nada más.

**Qué no ve:** ningún valor, ninguna DEK, ninguna llave privada. Un respaldo robado de la base de datos
no sirve para leer secretos. zeus tampoco puede "recuperar" un secreto: si todos los equipos con acceso
pierden su `key.json`, ese entorno se perdió y hay que crearlo de nuevo.

**Qué sí puede hacer un servidor comprometido:** negar el servicio, borrar datos, devolver versiones
viejas, y **mentir sobre las llaves públicas**: presentarte la llave de un atacante con el nombre de un
compañero para que tú mismo le envuelvas la DEK. Contra eso están las huellas (siguiente punto). Lo que
no puede es cambiar un secreto por otro sin que se note: cada texto cifrado está atado a su proyecto,
entorno, nombre y versión de llave, y si lo mueven de lugar el CLI se niega a descifrarlo.

**Por qué verificar la huella.** La huella (`a1b2-c3d4-e5f6-0718`) es un resumen de la llave pública.
Antes de dar acceso, la persona te la lee **en voz alta** (en persona o por llamada, no por un chat que
pase por la misma infraestructura) y tú la comparas con la que muestra `zeus env grant`. Si coincide, la
DEK se está envolviendo para su equipo y no para otro. El CLI recuerda las huellas que verificaste
(`~/.zeus/known-keys.json`) y se niega a rotar si alguna cambió después.

**Qué hace y qué NO hace quitar un acceso.** `zeus env revoke` borra la DEK envuelta de ese equipo: ya no
puede bajar nada nuevo. Pero esa persona **ya vio los valores** y pudo copiarlos, y también pudo
guardarse la DEK. Revocar no des-comparte nada. Lo correcto después de revocar es:

1. `zeus env rotate`: DEK nueva, todo se vuelve a cifrar, y solo los equipos vigentes la reciben.
2. **Cambiar en el proveedor** (Supabase, Stripe, Vercel, etc.) los secretos que importen y subir los
   nuevos con `zeus env set`.

**Rotar en la bóveda no rota el secreto en el proveedor.** `rotate` cambia la llave con la que se cifra;
la contraseña de la base de datos sigue siendo la misma hasta que la cambies donde vive.

**Lo que queda de tu lado.** El `.env` que escribe `pull` está en claro en tu disco, igual que siempre:
no lo subas a git. Quien tenga acceso a tu sesión de usuario tiene tu `key.json` y tu token. Si pierdes
o te roban el equipo: revoca su llave desde el dashboard (zeus → Bóveda) y pide rotar.

## Instalación

Requiere Node 20 o superior.

```bash
cd cli
npm install
npm run build
npm link        # deja el comando `zeus` en tu PATH
```

## Primera vez

### (a) Admin: crear el entorno de un proyecto

```bash
# 1. Token: en el dashboard, zeus → Acceso → Nuevo token. Se muestra UNA vez.
zeus login --url https://zeus.tu-equipo.com
#    (pega el token cuando lo pida; no se muestra en pantalla)

# 2. Llave de este equipo. Imprime la huella.
zeus key init --name "laptop de Ana"

# 3. Crear el entorno (por defecto: development). Este equipo queda como el primero con acceso.
zeus env init ROZ
zeus env init ROZ production

# 4. Subir el .env que ya tienes. Muestra solo los nombres que cambian y pide confirmar.
cd ~/dev/hyper/roz
zeus env push ROZ                       # lee ./.env
zeus env push ROZ production --from .env.production

# 5. Dar acceso a alguien que ya corrió `zeus key init` (te lee su huella en voz alta).
zeus env grant ROZ --to "Beto"          # nombre del dev, o el id de su llave
zeus env grant ROZ --to Beto --all-devices
```

### (b) Dev nuevo: entrar a un proyecto

```bash
zeus login --url https://zeus.tu-equipo.com
zeus key init                            # imprime tu huella y el id de tu llave

# Llama a un admin, léele la huella y pásale el id. Él corre `zeus env grant …`. Luego:
zeus env ls                              # proyectos/entornos y si este equipo tiene acceso
cd ~/dev/hyper/roz
zeus env pull ROZ                        # escribe ./.env

# Opcional: conectar Claude Code con el MCP de zeus.
zeus mcp                                 # imprime el comando `claude mcp add …` (lleva tu token)
```

## Comandos

| Comando | Qué hace |
|---|---|
| `login` | Valida el token con zeus y guarda URL y token en `~/.zeus/config.json` (0600). `--url`, `--token`; también lee `ZEUS_URL` y `ZEUS_TOKEN`. Nunca imprime el token. |
| `whoami` | Quién eres en zeus, si eres admin y el estado de la llave de este equipo. |
| `mcp` | Imprime el comando para conectar Claude Code. Es el único comando que muestra el token completo. |
| `key init` | Genera la llave del equipo (si no hay), la guarda en `~/.zeus/key.json` (0600) y registra la pública. `--name`, `--force` (genera otra: pierdes el acceso hasta que te lo vuelvan a dar; la anterior queda en `key.json.bak`). |
| `key show` | Pública, huella e id de la llave. Nunca la privada. |
| `env ls` | Proyectos y entornos de la bóveda, y si este equipo tiene acceso. |
| `env pull <proyecto> [entorno]` | Baja, descifra y escribe `./.env`. `--out <ruta>`, `--stdout` (no escribe a disco), `--format dotenv\|json`, `--yes`. |
| `env push <proyecto> [entorno]` | Sube lo que cambió en `./.env`. `--from <ruta>`, `--prune` (borra de la bóveda lo que no esté en el archivo), `--yes`. |
| `env set <proyecto> <entorno> NOMBRE` | Sube un valor. Lo lee de stdin o lo pregunta sin eco; nunca como argumento. `--empty` para un valor vacío. |
| `env rm <proyecto> <entorno> NOMBRE` | Borra una variable de la bóveda. |
| `run <proyecto> [entorno] -- <comando…>` | Corre el comando con los secretos en su entorno, sin escribirlos a disco. Devuelve el código de salida del comando. |
| `env init <proyecto> [entorno]` | (admin) Crea el entorno con una DEK nueva. |
| `env grant <proyecto> [entorno] --to <…>` | (admin) Da acceso a los equipos de un dev. `--to` acepta nombre del dev o id de llave; `--all-devices` si tiene varios. |
| `env revoke <proyecto> [entorno] --key <id>` | (admin) Quita el acceso de una llave. Después hay que rotar. |
| `env rotate <proyecto> [entorno]` | (admin) DEK nueva para los accesos vigentes y todos los secretos vueltos a cifrar. |

El entorno por defecto es `development`. Los comandos que cambian algo muestran antes una diferencia
**solo de nombres** (nunca valores) y piden confirmar; `--yes` la salta (necesario si no hay terminal,
p. ej. en un script).

### El archivo `.env`

`pull` reescribe el archivo completo, ordenado por nombre. Si ya existía y difiere, te muestra qué nombres
entran, cambian o salen, pide confirmar y deja el anterior en `.env.bak`.

Lo que sea solo de tu máquina va entre estos marcadores: `pull` lo conserva tal cual y `push` nunca lo
sube. Como va al final del archivo, pisa a lo de arriba.

```dotenv
# >>> local
PORT=4000
DATABASE_URL=postgres://localhost/roz_dev
# <<< local
```

Formato: valores simples sin comillas; con espacios, `#`, `$` o comillas dobles, entre comillas simples
(literal); con saltos de línea o comilla simple, entre comillas dobles con `\n`, `\"`, `\\` y `\$`
escapados. Al leer se aceptan `export NOMBRE=…`, comentarios y valores de varias líneas entre comillas.
No se expanden variables. Si tu `.env` tiene una línea que no se puede leer, `push` no sube nada y te
dice en qué línea está.

Ejemplos:

```bash
zeus env pull ROZ production --stdout --format json | jq 'keys'
printf '%s' "$NUEVO_VALOR" | zeus env set ROZ production STRIPE_SECRET_KEY
zeus run ROZ -- npm run dev
```

## Archivos y variables

| Ruta | Contenido |
|---|---|
| `~/.zeus/config.json` | URL de zeus y tu token. |
| `~/.zeus/key.json` | Llave de este equipo. **Respáldala o no la pierdas**: sin ella este equipo no abre nada. |
| `~/.zeus/known-keys.json` | Huellas que verificaste al dar acceso. |

`ZEUS_HOME` cambia la carpeta; `ZEUS_URL` y `ZEUS_TOKEN` pisan lo guardado; `ZEUS_DEBUG=1` muestra el
stack de los errores. La carpeta se crea 0700 y los archivos 0600. En Windows esos permisos no aplican;
los archivos viven en tu perfil, que ya es privado de tu usuario.

Límites: nombres `^[A-Za-z_][A-Za-z0-9_]*$` de hasta 128 caracteres; valores de hasta 64 KiB.

## Desarrollo

```bash
npm run typecheck
npm test          # vitest: cifrado, .env, y los comandos contra un zeus en memoria que solo guarda texto cifrado
```

- `src/crypto.ts`: el formato de la bóveda, funciones puras. `test/zeus-vault-crypto.test.ts` en la raíz
  del repo fija el formato desde la suite de CI.
- `src/dotenv.ts`: leer y escribir `.env`, funciones puras.
- `src/commands/*`: un módulo por grupo de comandos. Reciben `Ctx` (`src/context.ts`) con el API, el
  disco, la terminal y los procesos inyectados; las implementaciones reales están en `src/system.ts`.
- `src/types.ts` es un espejo a mano de `docs/zeus-contracts.md` §4: si cambia allá, cambia aquí.
