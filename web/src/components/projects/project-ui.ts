import type { ProjectKind, ProjectListItem } from '@/lib/api';

/**
 * Ayudas compartidas de Proyectos (lista y detalle).
 *
 * `active` vive aquí y no en `lib/api.ts` a propósito: el backend ya lo devuelve en `GET /projects`
 * y `GET /projects/:id` (archivar = `active: false`), pero `api.ts` lo comparten otras pantallas.
 * Cuando alguien lo suba a `ProjectListItem`, este alias se vuelve redundante y se puede borrar.
 */
export type ProjectRow = ProjectListItem & { active?: boolean };

/** Lo que edita el modal de proyecto (alta y edición). */
export interface ProjectDraft {
  name: string;
  key: string;
  kind: ProjectKind;
  /** `null` = automático (color generado por la clave). */
  color: string | null;
  projectType: string | null;
  description: string | null;
}

/** Un proyecto archivado: `active === false` (sin el campo, se asume activo). */
export const isArchived = (p: { active?: boolean | null }) => p.active === false;

/** Tono determinístico por proyecto (mismo seed → mismo tono) cuando no hay color fijado. */
export function projectHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

/**
 * Color de identidad del proyecto: el que se fijó a mano (hex, dato del usuario) o uno generado a
 * partir de la clave. Es DATO, no estilo de la app: por eso no sale de un token.
 */
export function projectColor(p: { color: string | null; key: string; name: string }): string {
  return p.color || `hsl(${projectHue(p.key || p.name)} 52% 48%)`;
}

/** HSL → hex, para previsualizar en el `ColorField` el color automático. */
export function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Texto en el que busca el buscador de Proyectos: nombre, clave, clase, tipo, repos y personas. */
export function projectHaystack(p: ProjectRow, typeLabel: (t: string) => string): string {
  return [
    p.name,
    p.key,
    p.kind === 'client' ? 'cliente' : 'interno',
    p.projectType ? typeLabel(p.projectType) : '',
    p.description ?? '',
    ...p.repos,
    ...p.contributors,
  ]
    .join(' ')
    .toLowerCase();
}

/** Normaliza para buscar sin acentos ("diseno" encuentra "Diseño"). */
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
