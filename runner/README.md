# roz-runner

CLI que corre en la PC de cada dev. Toma los planes de **tu** cola en roz, los planea e implementa con
Claude Code en modo headless (`claude -p`) dentro de un `git worktree` aislado, y abre la PR con `gh`.
No hay nube: el código, las llaves y la cuota de Claude son los de tu equipo.

Solo habla con roz por `/v1/runner/*` (polling saliente, no abre puertos) y con el MCP de roz. Nunca
toca Supabase ni Linear directamente. Contrato: `docs/roz-v2-contracts.md`, sección (c).

## Requisitos

- Node 20 o superior.
- `git`, [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`, con sesión iniciada) y
  [GitHub CLI](https://cli.github.com) (`gh auth login` hecho).
- roz con `ROZ_LINEAR_SOT=true` (con el flag apagado el runner espera sin hacer nada).

## Instalación

```bash
cd runner
npm install
npm run build
npm link        # deja el comando `roz-runner` en tu PATH
```

## Uso

```bash
# 1. Token: en el dashboard, Configuración → roz-runner en tus equipos → Nuevo token. Se muestra UNA vez.
roz-runner login --url https://roz.tu-equipo.com
#    (pega el token cuando lo pida; no se muestra en pantalla)

# 2. Dile dónde están tus clones (una vez por repo).
roz-runner repo add hyperlabs-ai/roz ~/dev/hyper/roz
roz-runner repo add ~/dev/otro-repo          # deduce owner/name del remoto origin
roz-runner repo list

# 3. Arranca. Se queda escuchando; Ctrl+C para detener.
roz-runner start --max 1 --horario 9-19 --dias 1-5

# Implementar tú un plan (el agente ya no corre): crea la rama con el ID de Linear y PLAN.md.
cd ~/dev/hyper/roz
roz-runner pull HYP-123

roz-runner status
roz-runner logout
```

| Comando | Qué hace |
|---|---|
| `login` | Guarda URL y token en `~/.roz-runner/config.json` (0600) y verifica contra roz. `--url`, `--token`, `--name`, `--worktrees`. También lee `ROZ_URL` y `ROZ_RUNNER_TOKEN`. |
| `repo add/list/rm` | Mapeo `owner/name` → ruta del clon local. Sin mapeo, el plan falla con un error que dice exactamente qué correr. |
| `start` | Registra el runner, late cada 60 s y pide trabajo con backoff. `--max N` (planes a la vez, 1-8), `--horario 9-19` o `9:30-18:00`, `--dias 1-5` o `1,3,5`, `--tz`. Se recuerdan para la próxima vez. |
| `pull <ID>` | Marca el plan como "lo implementa una persona", crea/cambia a la rama (`hyp-123-…`) en el repo actual y escribe `PLAN.md`. |
| `status` | Config, repos, si el proceso está corriendo y qué planes lleva, y el estado según roz (horario incluido). |
| `logout` | Borra la config local. El token sigue vigente hasta que lo revoques en el dashboard. |

## Qué hace con cada plan

1. Busca el clon del repo del plan en tu mapeo.
2. `git fetch` y crea un worktree en `~/.roz-runner/worktrees/<owner__name>/<id>` con la rama del ID de
   Linear (reusa la rama si un intento anterior dejó avance). `PLAN.md` se ignora en `info/exclude`.
3. **Fase plan**: `claude -p` con el prompt que arma roz, solo herramientas de lectura + `Write(PLAN.md)`
   + el MCP de roz. Reporta el plan (`plan_ready`).
   - Riesgo 0: roz responde `continue` y el runner implementa enseguida.
   - Riesgo 1: el plan espera aprobación en el dashboard; al aprobarlo vuelve como trabajo de implementación.
   - Riesgo 2: solo plan; lo implementa una persona (`roz-runner pull`).
4. **Fase implementación**: `claude -p` con la lista blanca de implementación (editar, `git add/commit`,
   tests, typecheck). Si quedaron cambios sin commit, el runner los commitea.
5. `git push -u origin <rama>` y `gh pr create` (título `HYP-123: …`, cuerpo con el issue, el riesgo y el plan).
   Reporta `pr_opened` y borra el worktree (la rama queda).

Claude Code corre con `--strict-mcp-config` (solo el MCP de roz, no tus MCP personales) y
`--allowedTools` con la lista blanca que manda roz; lo que no está en la lista se rechaza. El prompt va
por stdin. El archivo MCP con el token se escribe en `~/.roz-runner/tmp` (0600) y se borra al terminar.

### Cancelación

- **Ctrl+C**: mata a Claude y regresa cada plan en curso a la cola (`released`). Ctrl+C otra vez fuerza la
  salida; en ese caso el watchdog de roz los regresa en ~10 min.
- **Desde roz** (cancelado, reclamado por otro dev, lease vencido): el latido lo avisa y el runner detiene
  ese plan sin reportar nada más.

### Errores

- Red caída, 5xx o 429: reintenta con backoff exponencial (2 s → 5 min, con jitter).
- `401`: token inválido o revocado; el runner se detiene. Crea otro y corre `login`.
- `409 LINEAR_SOT_OFF`: roz v2 está apagado; reintenta cada 5 min.
- Fallo de un plan (repo sin mapear, Claude sin PLAN.md, sin commits, `gh` falló): se reporta `failed` con
  el motivo; roz lo reencola y a los 3 fallos lo marca como reclamable.

## Configuración

`~/.roz-runner/config.json` (cambia la carpeta con `ROZ_RUNNER_HOME`):

```json
{
  "url": "https://roz.tu-equipo.com",
  "token": "rozr_…",
  "name": "mi-laptop",
  "repos": { "hyperlabs-ai/roz": "C:\\Users\\yo\\dev\\hyper\\roz" },
  "worktreesDir": "D:\\worktrees",
  "claudeBin": "claude",
  "ghBin": "gh",
  "gitBin": "git"
}
```

En Windows los permisos 0600 no aplican igual; el archivo vive en tu perfil, que ya es privado de tu usuario.
Si `claude` está instalado con npm (`claude.cmd`), el runner lo lanza por `cmd.exe` con los argumentos
escapados; no hace falta configurar nada.

## Desarrollo

```bash
npm run typecheck
npm test          # vitest: horario, armado de comandos, reintentos, flujo de un trabajo con procesos falsos
```

Todo lo que ejecuta procesos pasa por `Exec` (`src/exec.ts`) y los archivos por `FileOps`
(`src/fsops.ts`), así los tests no tocan git, gh ni Claude. Los tipos de la API (`src/types.ts`) son un
espejo a mano de `src/types/roz-v2.ts` del backend: si cambian allá, cambian aquí.
