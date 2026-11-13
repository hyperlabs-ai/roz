// Mapa de rutas del front. Una sola fuente para el menú (`AppShell`), el árbol de rutas (`App.tsx`)
// y las redirecciones de compatibilidad.
//
// La app vive en la RAÍZ (`/` es el mapa de zeus, tras el login) y la landing pública en `/landing`:
// quien entra a diario no debe pasar por la landing. Antes la app colgaba de `/app`: todo `/app/*`
// redirige a la misma ruta sin el prefijo (y de ahí, si el nombre es viejo, a la nueva).
//
// Regla de nombres: la ruta es la palabra del menú, en minúsculas y sin acentos (Pulso → `/pulso`,
// Reportes → `/reportes`). Las palabras del producto que ya son en inglés en la interfaz
// (Developers, Skills, Ticket, Chat) conservan su ruta. Toda ruta vieja redirige a la nueva
// conservando parámetros, consulta y hash: hay enlaces vivos en avisos push, correos y Discord.

export const R = {
  /** Landing pública del producto (sin login). */
  landing: '/landing',
  // Zeus: el contexto del equipo. El mapa es la pantalla principal.
  mapa: '/',
  biblioteca: '/biblioteca',
  bandeja: '/bandeja',
  equipo: '/equipo',
  llaves: '/llaves',
  acceso: '/acceso',
  // Visibilidad
  pulso: '/pulso',
  resumen: '/resumen',
  developers: '/developers',
  capacidad: '/capacidad',
  proyectos: '/proyectos',
  // Entrada
  juntas: '/juntas',
  ticket: '/ticket',
  tareas: '/tareas',
  chat: '/chat',
  // Agentes
  planes: '/planes',
  skills: '/skills',
  // Operación
  infra: '/infra',
  reportes: '/reportes',
  configuracion: '/configuracion',
} as const;

/** Enlaces con parámetro. Úsalos en vez de armar la cadena a mano. */
export const to = {
  developer: (id: string) => `${R.developers}/${id}`,
  proyecto: (id: string) => `${R.proyectos}/${id}`,
  /** Canal o conversación del chat; `thread` abre el hilo. */
  chat: (id: string, thread?: string | null) => `${R.chat}/${id}${thread ? `?thread=${thread}` : ''}`,
  /** Enlace a un mensaje del chat interno. */
  chatMessage: (messageId: string) => `${R.chat}/m/${messageId}`,
  tarea: (id: string) => `${R.tareas}?task=${id}`,
  plan: (id: string) => `${R.planes}?plan=${id}`,
  /** Nodo del mapa de zeus (`ref` = `tipo:id`). */
  nodo: (ref: string) => `${R.mapa}?nodo=${encodeURIComponent(ref)}`,
  /** Sección de Configuración por hash (`runner`, `calendar`, `discord`…). */
  configuracion: (section?: string) => `${R.configuracion}${section ? `#${section}` : ''}`,
};

/** `/app/lo-que-sea` → `/lo-que-sea` (la app vivía bajo `/app`). Conserva el resto tal cual. */
export function stripAppPrefix(pathname: string): string {
  return pathname.replace(/^\/app(?=\/|$)/, '') || '/';
}

export type ZeusSection = 'mapa' | 'biblioteca' | 'bandeja' | 'equipo' | 'llaves' | 'acceso';

export const ZEUS_SECTIONS: { id: ZeusSection; path: string; label: string }[] = [
  { id: 'mapa', path: R.mapa, label: 'Mapa' },
  { id: 'biblioteca', path: R.biblioteca, label: 'Biblioteca' },
  { id: 'bandeja', path: R.bandeja, label: 'Bandeja' },
  { id: 'equipo', path: R.equipo, label: 'Equipo' },
  { id: 'llaves', path: R.llaves, label: 'Llaves' },
  { id: 'acceso', path: R.acceso, label: 'Acceso' },
];

/** Valores que tuvo `?tab=` cuando las secciones de zeus eran pestañas de una sola página. */
const ZEUS_TAB: Record<string, ZeusSection> = {
  mapa: 'mapa',
  documentos: 'biblioteca',
  biblioteca: 'biblioteca',
  bandeja: 'bandeja',
  organizacion: 'equipo',
  equipo: 'equipo',
  llaves: 'llaves',
  acceso: 'acceso',
};

/**
 * Destino de un enlace viejo con `?tab=X` (`/zeus?tab=bandeja`, `/?tab=documentos&doc=…`):
 * la ruta de la sección y el resto de la consulta, sin `tab`. `null` si no hay `tab`.
 */
export function zeusTabTarget(search: string): { pathname: string; search: string } | null {
  const q = new URLSearchParams(search);
  const tab = q.get('tab');
  if (tab == null) return null;
  q.delete('tab');
  const rest = q.toString();
  return { pathname: R[ZEUS_TAB[tab] ?? 'mapa'], search: rest ? `?${rest}` : '' };
}

/**
 * Rutas que cambiaron de nombre: `[vieja, nueva]`, relativas a la raíz. Los `:param` se conservan.
 * `App.tsx` monta una redirección por cada una.
 */
export const LEGACY_ROUTES: [from: string, to: string][] = [
  ['pulse', 'pulso'],
  ['overview', 'resumen'],
  ['meetings', 'juntas'],
  ['plans', 'planes'],
  ['projects', 'proyectos'],
  ['projects/:id', 'proyectos/:id'],
  ['tasks', 'tareas'],
  ['capacity', 'capacidad'],
  ['tickets', 'reportes'],
  ['settings', 'configuracion'],
];
