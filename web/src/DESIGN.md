# Sistema de diseño roz v2

Identidad del mock "plano de control" (estilo Stape): fondo hueso cálido, tinta casi negra,
naranja de marca y bloques de color. Claro y oscuro (`.dark`) comparten la identidad; nada se
invierte a mano.

## Reglas

1. **Cero hex en componentes.** Todo color sale de un token (`bg-orange-soft`, `text-purple-deep`,
   `hsl(var(--chart-2))`). Si falta uno, se crea en `styles.css` (`:root` **y** `.dark`) y se expone
   en `tailwind.config.js`.
2. **No uses la escala cruda de Tailwind** (`bg-orange-500`, `text-green-600`, `bg-amber-100`…). Usa
   los tokens de marca de abajo: siguen al tema.
3. **Nada de barras horizontales para comparar categorías.** Comparación → `Columns` (columnas
   verticales). Progreso de UNA cosa → `ProgressBar` (barra fina de 6px).
4. **Tipografía:** Inter Tight para TODO, incluidas las etiquetas de interfaz (ver "Etiquetas" abajo).
   JetBrains Mono (`font-mono`) queda SOLO para código, IDs de issue (`WAT-44`, `HYP-12`), hashes,
   ramas, rutas/repos y bloques de terminal. Nunca para eyebrows, labels, roles, botones o contadores.
5. **Superficies:** tarjeta blanca con hairline (`Card`, radio 10px, sin sombra) sobre fondo hueso;
   panel gris (`Panel`, radio 14px) para agrupar o secuenciar. La separación es por borde, no por
   sombra.
6. Solo presentación: no cambies llamadas a la API ni lógica de estado al rediseñar.
7. Textos de UI en español.

## Tokens

| Token (Tailwind) | Uso |
| --- | --- |
| `background` | Fondo hueso `#f6f5f1` / negro cálido `#161615` |
| `card` | Tarjeta blanca / `#1f1f1d` |
| `panel` (= `muted`, `secondary`) | Panel gris cálido `#eeede8` / `#2a2a28`, pistas de barras, chips neutros |
| `sidebar` | Aside de navegación, pie de modal, hover de filas |
| `foreground` / `muted-foreground` / `faint` | Tinta 1 / 2 / 3 (`faint` = etiquetas `label-caps`, ids, ejes) |
| `border` | Hairline cálida `#e1dfd8` |
| `primary` = `orange` | Naranja roz `#ff5b23`: activo de navegación, acción de marca, serie principal |
| `orange-soft` / `orange-ink` | Fondo de activo/selección y su texto |
| `salmon` | Bloque de color secundario |
| `purple` / `purple-deep` / `lavender` | Agentes y LLM (`purple-deep` es texto sobre `lavender`) |
| `yellow` / `yellow-soft` / `yellow-ink` | Juntas, lo humano, "en junta" |
| `green` / `green-soft` (= `success`) | CTA principal, éxito, "a tiempo" |
| `red` / `red-soft` (= `destructive`) | Error, bloqueado |
| `blue` / `blue-soft` / `blue-ink` | Info, "en código" |
| `warning` | Ámbar legible como texto |
| `ink` / `ink-foreground` | Botón/tooltip de tinta (se vuelve hueso en oscuro) |
| `toggle-off` | Pista de switch apagada, casillas vacías |
| `scrim` | Fondo del modal |
| `chart-1..5` | Naranja, morado, verde, amarillo, cielo (categórica) |
| `hyper` | Dorado de logro (hyper points) |

Radios: `rounded-lg` 10px (tarjeta), `rounded-xl` 14px (panel/modal), `rounded-md` 6px (campo),
`rounded-sm`/`rounded-btn` 4px (botón, segmento). Clases CSS: `.eyebrow`, `.label-caps`,
`.title-tight`, `.scroll-list`, `.scroll-none`.

## Componentes base (`components/ui`)

- **Button** — `default` verde CTA · `brand` naranja (una por vista) · `secondary` gris · `dark`
  tinta · `outline` · `destructive` · `ghost`/`link` (sin mayúsculas, para iconos y acciones en
  línea). Los primeros seis son Inter Tight 600 MAYÚSCULAS, tracking 0.05em, radio 4px (sin mono).
- **Badge** (alias `Chip`) — píldora redondeada; `dot` antepone un punto. Variantes por tipo:
  `rule`, `llm`, `human`; por estado: `ok`, `warn`, `bad`, `info`, `neutral`, `brand`. Los nombres
  viejos (`success`, `warning`, `destructive`, `secondary`, `outline`, `default`) siguen válidos.
- **Card** — `CardTitle` es 14px semibold como `.ct` del mock.
- **Tabs** — control segmentado (`TabsList` gris + píldora blanca que viaja).
- **Dialog** — backdrop con blur; `DialogHeader eyebrow="Junta manual"` pinta el eyebrow y la
  cabecera queda separada por hairline; `DialogFooter` es el pie gris con acciones a la derecha.
- **Switch** (`ui/switch.tsx`) — interruptor naranja con pulgar cuadrado-redondeado.
- **Table** — encabezados `label-caps` en `faint`.
- **Input / Select / Tooltip** — campos blancos radio 6px con foco morado; tooltip de tinta.

## Piezas de marca (`components/brand.tsx`)

```tsx
import { Eyebrow, SectionHeader, Panel, IntegrationIcon, GithubHandle, GithubAvatar, CapsLabel, tokenColor } from '@/components/brand';

<Eyebrow color="purple-deep">Consola · agentes</Eyebrow>       // cuadrito (radio 2px) + label-caps
<SectionHeader eyebrow="Semana 46 · 10–14 nov" title="Pulso del equipo"
  lede="Quién trabaja en qué y cómo avanza." actions={<Tabs …/>} />  // size: sm | md | lg
<Panel n={1} title="Juntas" description="Granola o sesión manual">…</Panel>  // gris "001"
<IntegrationIcon name="linear" />                // ícono oficial; versión clara en oscuro
<IntegrationIcon name="github" size="sm" framed />  // cajita blanca con hairline (feed, listas)
<GithubHandle login="corzv" />                   // ícono GitHub + login, enlaza al perfil
<GithubAvatar login="corzv" name="Manuel" presence="on" />  // foto de GitHub + on | meet | off
<CapsLabel>Issues cerrados</CapsLabel>          // = <span className="label-caps">
<ProgressBar pct={78} color="purple-deep" />     // en bits.tsx; `color` acepta cualquier BrandColor
```

`IntegrationIcon` nombres: `linear`, `github`, `claude`, `anthropic`, `vercel`, `railway`,
`supabase`, `posthog`, `googlecalendar`, `googlemeet`, `resend`, `granola`, `orwel`, `hyperops`, `discord`.
Los archivos viven en `public/integrations/`.

`tokenColor('chart-2', 0.2)` → `hsl(var(--chart-2) / 0.2)` para `style` y SVG.

## Etiquetas (`label-caps`)

Una sola tipografía para TODA etiqueta de interfaz: eyebrows, labels de KPI, roles, encabezados de
tabla y de columna, chips/badges de texto, separadores de fecha, contadores con texto y secciones del
nav. `.label-caps` = Inter Tight 600, MAYÚSCULAS, tracking 0.06em, 11px, color `faint`. Color y
tamaño se pisan con utilidades (`label-caps text-orange-ink`, `label-caps text-[10px]`). En React:
`<CapsLabel>`. El `Eyebrow` es la misma letra con el cuadrito de color (8px, **radio 2px**).

`font-mono` SOLO para: código (`<code>`, `<pre>`, terminal), IDs de issue (`WAT-44`), hashes,
ramas, nombres de repo/rutas, tokens y los campos donde se escribe uno de ellos. Cifras y tiempos van
en sans con `tabular-nums`; los ejes de recharts también.

## Rejillas balanceadas (`components/grid.tsx`)

Regla global: **ninguna rejilla deja una última fila con huecos** (8 tarjetas en 3 columnas = 3+3+2 y
un hueco: prohibido). Para N elementos de cantidad variable usa `BalancedGrid`:

```tsx
import { BalancedGrid, balancedCols, balancedLayout } from '@/components/grid';
<BalancedGrid max={{ base: 2, md: 3, lg: 5 }}>{kpis}</BalancedGrid>   // tope de columnas por breakpoint
balancedCols(7, 4)  // → 4   (4 + 3, la última fila se estira)
```

Cómo elige columnas (por breakpoint, con el tope `max`; por defecto 1 → sm 2 → lg 4):

1. `n <= max` → una fila de `n` (5 → 5).
2. Un divisor exacto de `n` entre `max` y `max/2` sin agregar más de una fila (8 → 4+4, 6 → 3+3).
3. Si no hay, `max` o `max-1`, la que deje la última fila más llena, y esa fila se **estira** a todo
   el ancho en partes iguales (7 → 4+3, 5 con tope 4 → 3+2, 10 → 4+4+2). Técnica: el grid usa
   mcm(cols, última) pistas y cada celda recibe su span (`.bgrid`/`.bgrid-item` en `styles.css`).

Cada celda se estira a la altura de su fila. Para listas largas y homogéneas (más de ~12) usa una
lista, no una rejilla. Dos columnas fijas solo cuando los lados son de distinto tipo (gráfica + feed),
y entonces balancea la ALTURA: nada de una columna larguísima junto a otra vacía.

## Scroll

- La barra es global (`styles.css`, capa base): delgada, sin pista ni flechas, pulgar `toggle-off`
  → `faint` al hover, dibujado con borde transparente para que quede fino y pegado al borde.
  Firefox: `scrollbar-width: thin`. `.scroll-thin`/`.scrollbar-thin` quedan como alias (solo agregan
  `overscroll-behavior: contain`).
- El scroll va en el CONTENEDOR (tarjeta o panel), pegado a su borde derecho. Si la lista con scroll
  vive dentro de una tarjeta con padding, usa `.scroll-list` (con `--edge` = padding horizontal de
  la tarjeta, por defecto 1rem): saca la barra al borde de la tarjeta.
- Evita scrolls anidados: una página = el scroll del documento; una lista interna solo si tiene un
  alto máximo con sentido (feed, historial). `.scroll-none` oculta la barra en carriles de chips.
- `<main>` del `AppShell` usa `overflow-x-clip` (no `hidden`): así `position: sticky` funciona
  dentro de las páginas (panel lateral de Skills, transcript de una junta). No lo regreses a
  `overflow-x-hidden`, que convierte a `<main>` en contenedor de scroll y rompe todo sticky.
- Columnas de distinto alto lado a lado: la corta NO se queda con hueco abajo. O se estira (la
  gráfica en modo `fill`), o la larga hace scroll interno a la altura de la otra (Pulso: historial
  `absolute inset-0` en su columna; ProjectDetail/DeveloperProfile: la lista más larga con
  `.scroll-list`).

## Íconos prohibidos

El ícono de chispa (lucide `Sparkle`, `Sparkles`, `WandSparkles`/`Wand2` y similares) está
**prohibido** en toda la app. Usa uno con sentido: `Bot` (lo hizo roz / el agente), `Zap` (ejecutar
algo automático), `Cpu`, `GraduationCap` (skills). Lo vigila `test/web-banned-icons.test.ts`
(falla si algún archivo de `web/src` importa un nombre que contenga "Sparkle").

## Avatares e íconos de identidad (`components/avatars.tsx`)

- **`PersonAvatar`** — el único avatar de persona. `GithubAvatar` (brand) y `UserAvatar` (bits)
  son envoltorios suyos. Prioridad: foto de GitHub (`url` o `login`) → avatar de Discord
  (`discordUrl`, si el front lo tiene) → DiceBear **micah** generado en el cliente con semilla =
  correo en minúsculas (`email`) o, sin correo, el id del dev (`id`). **Nunca el nombre.** Si una
  foto falla al cargar cae a la siguiente. Sin foto ni semilla (autor externo, demo de la landing)
  quedan iniciales. Pasa siempre `id`/`email` cuando el dato exista. `MeAvatar` = el usuario de la
  sesión (chip del AppShell, Configuración).
- **`ProjectIcon`** — DiceBear **shapes** con semilla = id del proyecto (sobrevive a un renombre),
  tamaños `xs | sm | md | lg`. Es ADICIONAL al color propio del proyecto (`project.color`): en la
  tarjeta de Proyectos el color va como punto sobre el ícono.
- **Roz-bot** (`RozBotAvatar`, `mood`: `normal | happy | thinking | alert`) — personaje del bot de
  Discord y de los avisos del sistema. SVG en `public/brand/roz-bot*.svg`, PNG 512 en
  `public/brand/` y `discord-bridge/assets/` (los regenera `discord-bridge/scripts/export-bot-avatars.mjs`).
  En el chat de Discord, un mensaje con `author.rozBot` se pinta con Roz-bot.

Excepción a "cero hex": la paleta de DiceBear vive en `avatars.tsx` (fondos `ffe4d8 e7e4fa fff1cc
dcf2e8 eeede8`; figuras `ff5b23 8a7fdc ffc84a 2f9e74 ffa274 5546c4`) porque el SVG se genera fuera
del DOM y no lee variables CSS. Es la misma en claro y oscuro a propósito.

## Marco

- `AppShell` dibuja el aside (secciones Visibilidad / Entrada / Agentes / Operación) y el header.
- `Layout` acepta `title`, `eyebrow` (por defecto, la sección del menú), `icon` y `actions`.
  **Sin descripción bajo el título** (se quitó `subtitle`): la cabecera es eyebrow + título. Si una
  pantalla necesita contexto, va en el contenido. No repitas el título dentro del contenido.
- El chip del usuario (abajo a la izquierda del aside) lleva el rol en `label-caps`.
- Menú del avatar (abajo a la izquierda; en móvil, al final del menú ☰): selector de tema
  (Claro / Oscuro / Sistema) y el acceso a **Configuración**. Ni el tema ni Configuración están en
  el header ni en el menú lateral (decisión del usuario).
- Nav: Ideas ya no existe; Actividad se unificó con el Pulso (`/app/activity` redirige a
  `/app/pulse#historial`, donde vive el historial de eventos). Con el chat de Discord activo, el
  ítem "Chat" se llama "Discord" y lleva el logo oficial. La píldora de eventos del header es
  discreta (ícono + punto; con eventos sin procesar, punto rojo + número) y abre `/app/pulse#historial`.
- `MetricCard` (layout `stack`) es el KPI del mock: etiqueta `label-caps`, cifra grande tabular,
  delta en color con flecha.
- Chat (`/app/chat`) es full-bleed como Discord: en desktop `AppShell` oculta su topbar
  (`fullBleed && 'md:hidden'`); en móvil se queda porque lleva el menú. Las dos barras del chat
  (servidor y canal) comparten la altura `CHAT_BAR` (`h-14`, en `discord/ChannelSidebar.tsx`) y
  cada canal lleva UN solo ícono (`ChannelGlyph`: el emoji del nombre o el ícono del tipo;
  `splitChannelName` en `discord/channelName.ts` separa el emoji del nombre).
- Configuración tiene secciones por hash: `/app/settings#notifications|calendar|discord|runner|
  appearance|account`. Enlaza a la sección concreta (p.ej. "Registrar runner" → `#runner`).

## Composición (ver `#producto` del mock)

- Cabecera de pantalla → `Layout`; secciones internas → `SectionHeader size="sm"` o `CardTitle`.
- Fila de KPIs: `<BalancedGrid max={{ base: 2, md: 3, lg: 5 }}>` de `MetricCard` (nunca un
  `grid-cols-N` fijo: ver "Rejillas balanceadas").
- Rejillas: `g21` = `grid gap-3.5 lg:grid-cols-[2fr_1fr]`, `g12` = `lg:grid-cols-[1fr_1.6fr]`.
- Kanban: columnas `bg-panel rounded-lg p-2` con encabezado `label-caps`; tarjetas `bg-card rounded-md`.
- Línea de agente: `bg-lavender text-purple-deep rounded-md px-2 py-1 text-xs` con punto que late.
- Fila "ahora": `border-l-[3px]` del color de la persona + `bg-sidebar`, id en mono `faint`.

## Chips y estados: pares suave/tinta

Un chip de color es SIEMPRE fondo suave + texto de su tinta, nunca `bg-x/12 text-x` (el amarillo y
el salmón son ilegibles como texto sobre hueso, y el alfa se ve sucio en oscuro):

| Significado | Chip | Punto |
| --- | --- | --- |
| ok / libre / PR | `bg-green-soft text-green` | `bg-green` |
| marca / procesando / commit | `bg-orange-soft text-orange-ink` | `bg-orange` |
| humano / junta / retrasado / tarea | `bg-yellow-soft text-yellow-ink` | `bg-yellow` |
| agente / LLM / aviso | `bg-lavender text-purple-deep` | `bg-purple-deep` |
| info / en código / holgura | `bg-blue-soft text-blue-ink` | `bg-blue` |
| error / bloqueado / saturado | `bg-red-soft text-red` | `bg-red` |
| neutro / sin datos | `bg-panel text-muted-foreground` | `bg-toggle-off` |

`lib/labels.ts` (`QUEUE_FAMILY`, `QUEUE_HEALTH`, `LOAD_STATE`, `DEV_PRESENCE`) ya sigue esta tabla.
Avisos en bloque (banner de sesión, aviso del calendario): `border-yellow/40 bg-yellow-soft
text-yellow-ink`. Selección en listas y menús (PeriodPicker, calendario): `bg-orange-soft
text-orange-ink`.

## Modo oscuro: trampas conocidas

- `purple-deep` es oscuro en claro y CLARO en oscuro (es "el morado legible"). Un relleno sólido
  `bg-purple-deep` lleva `text-background`, nunca `text-white`.
- `ink` se invierte (tinta en claro, hueso en oscuro): úsalo para el botón `dark` y tooltips, no
  para bloques que deban seguir oscuros. Para un bloque oscuro en ambos modos (terminal de
  `roz-runner`, sidebar del chat) usa `bg-chat-sidebar text-chat-sidebar-foreground`.
- Bloques de color grandes (landing, paneles destacados): `bg-yellow dark:bg-yellow-soft`,
  `bg-salmon dark:bg-orange-soft`, `bg-purple dark:bg-lavender`, con texto `text-foreground`.
  Bloque "negro": `bg-ink text-ink-foreground dark:border dark:bg-card dark:text-foreground`.
- `text-white` solo sobre `bg-orange`, `bg-green`, `bg-red` o medios (visor de imágenes/video,
  que es negro a propósito en ambos modos).
- Dentro de SVG: clases de token (`fill-orange`, `stroke-border`, `fill-faint`); para propiedades
  que no aceptan clase, `style={{ floodColor: tokenColor('scrim') }}`.

## Ayudas compartidas por pantalla

- `components/pulse/pulse-ui.tsx` — `Spark` (sparkline 84×22), `PulseDot`, `personColor(devId)`
  (color de marca estable por persona), `isoWeek`, `addDays`.
- `components/pulse/roz-v2.tsx` — `Segmented` (el `.seg` del mock: pista panel + píldora blanca).
  Para segmentados hechos a mano: `bg-panel rounded-md p-[3px]` + activo `bg-card rounded-sm
  shadow-sm`.
- `components/meetings/meeting-ui.tsx` — `SourceBadge`, `FieldLabel`, `MiniAvatar`,
  `TEXTAREA_CLS`, `candidateTones()`/`toneAt()` (tono suave por elemento con sus clases de
  mark/ring/borde/punto).
- `components/plans/plan-ui.tsx` — `PlanStatusBadge`, `StepsMini`, `planSteps(plan)`.
- `components/queue/QueueRow.tsx` — fila de un evento de la cola (`QueueRow`, `Ago`, `inflightPhrase`)
  y `components/queue/RetryEventButton.tsx` (reencola un evento `dead`). Son las piezas del historial
  de eventos del Pulso (`GET /queue` → `QueueResponse`; lo en vuelo, de `useQueueLive()`).
- `components/grid.tsx` — `BalancedGrid`, `balancedCols`, `balancedLayout`.
- `components/pulse/PulseHistory.tsx` — historial de eventos del Pulso (`id="historial"`): línea del
  pipeline (de `useQueueLive()`), aviso rojo de eventos sin procesar (abre modal con `QueueRow` y
  reintento), filtros por tipo y lista por día con encabezado sticky. Incluye `deploy` e `infra`.
- `components/pulse/PersonCard.tsx` — `IdlePeople` (fila compacta de gente sin trabajo en curso:
  sin rejilla, sin huecos), `WeekStats` (commits / PRs / issues como ícono + cifra), `isWorking(p)`.
- `components/tasks/properties.tsx` — propiedades de tarea estilo Linear: `PropertyMenu` (píldora
  con menú buscable por teclado, simple/múltiple, `onCreate`), `PriorityIcon`, `DueDateMenu`,
  `ScheduleMenu`, `PropRow`/`SideSection`, `Kbd` (tecla en sans), `LabelDot`, `useAutosize`. Úsalas
  en cualquier lugar que edite una propiedad de tarea.
- `components/projects/` — `ProjectDialog` (crear/editar estilo Linear), `ArchiveProjectDialog`,
  `DeleteProjectDialog` (borrar exige escribir el nombre y solo se ofrece en archivados),
  `ProjectMenu`, `project-ui.ts` (`fold()` búsqueda sin acentos, `projectColor()`, `isArchived`).
- Barra de búsqueda de una pantalla (patrón de Proyectos y Developers): `Input` con ícono `Search`,
  X para limpiar o pista `/`, atajo `/` para enfocar y Esc para limpiar, `Segmented` de estado con
  contadores, `Select` h-8 que se pone `orange-soft` cuando filtra, botón "Limpiar" y "N de M".
- `components/capacity/cells.tsx` — `StatePill`, `groupMeta`, `AssignmentChip`, `LOAD_GROUPS`
  (holgura azul, óptima naranja, saturada roja). Cualquier pantalla que pinte carga los reusa.
- `components/infra/infra-ui.tsx` — `UptimeStrip` (franja de disponibilidad de `/infra/strips`),
  `deployOf`, `PROVIDER`, `STATUS`; `ServiceSheet` es el detalle por `?servicio=<id>`.
- `components/discord/ChatState.tsx` — `ChatState` (vacío/error centrado en la columna),
  `ChatSkeleton`, `ChannelSkeleton`.
- `components/settings/parts.tsx` — `SettingsHeader`, `RowsCard`, `Row`, `RowIcon`, `Notice`,
  `RowSkeleton`. `components/skills/levels.ts` — `LEVEL_LABEL`, `EXPERT_LEVEL` (4), `computeStats`.
- Paneles laterales (sheet): hoy hay dos locales sobre Radix Dialog, `capacity/PersonSheet.tsx` y
  `infra/ServiceSheet.tsx` (animación en `infra/infra.css`). Una tercera pantalla que necesite
  uno debe subirlo a `components/ui/sheet.tsx` en vez de copiar otro. Un sheet no empuja el
  contenido (regla de "modales, nunca secciones que se despliegan").
- `components/PresencePanel.tsx` — `avatarPresence(status)` (calendario → `presence` de
  `GithubAvatar`).

## Primitivas ya alineadas

`Calendar` (encabezados `label-caps`, rango en `orange-soft`, hoy en naranja), `AlertDialogCancel`
(gris `secondary`), `PeriodPicker` (etiquetas `label-caps`, selección naranja suave), `Login` y
`ErrorScreen` (eyebrow + título apretado), `QueuePill` (discreto: ícono + punto; rojo + número si hay
eventos sin procesar).

## Al ver la app en local

`tailwind.config.js` e `index.html` (fuentes de Google) no siempre entran por HMR: si la app se ve
con Geist o colores fríos, recarga duro (Ctrl+Shift+R) y, si persiste, reinicia `vite`.

## Excepciones decididas por el usuario (no "tokenizar")

- **Hyper points** (`--hyper`): dorado en claro, AZUL en oscuro.
- **Contribuciones de GitHub** (`GithubContributions.tsx`): los verdes reconocibles de GitHub en claro y la rampa de `--success` en oscuro. Es la única escala con hex en un componente, y es a propósito.
- Gráficas: nada de barras horizontales para comparar categorías (ni listas rankeadas con barra) y nada de radar.
