// Lectura de los documentos de un repo: qué rutas son contexto, de qué tipo, y qué se saca de su
// markdown (título, resumen, estado, a qué reemplazan, a qué enlazan). PURO: sin red ni base, para
// poder probarlo con archivos de ejemplo.
import type { ZeusNodeKind, ZeusNodeStatus } from '../types/zeus.js';
import { slugify, summarize } from './nodes.js';

export interface Classified {
  kind: ZeusNodeKind;
  /** Estable por repo: es la identidad del documento aunque le cambien el título. */
  slug: string;
  /** Entra al índice siempre cargado. */
  pinned: boolean;
  /**
   * Varios archivos que forman UN documento (un cambio de OpenSpec = proposal + design + tasks)
   * comparten grupo; `part` ordena las secciones.
   */
  group: string;
  part: number;
  partTitle: string | null;
}

const ADR_DIRS = ['docs/adr/', 'docs/adrs/', 'adr/', 'adrs/', 'docs/decisions/', 'docs/architecture/decisions/'];
const RULE_DIRS = ['docs/rules/', '.claude/rules/'];
const ROOT_DOCS = new Set(['agents.md', 'claude.md', 'architecture.md', 'architecture.es.md', 'contributing.md']);
const CHANGE_PARTS: Record<string, { part: number; title: string | null }> = {
  'proposal.md': { part: 0, title: null },
  'design.md': { part: 1, title: 'Diseño' },
  'tasks.md': { part: 2, title: 'Tareas' },
};

const stem = (path: string) => path.split('/').pop()!.replace(/\.(md|mdx)$/i, '');

/** Decide si una ruta del repo es contexto y cómo se cataloga. Null = no se ingiere. */
export function classifyPath(path: string): Classified | null {
  const p = path.replace(/^\/+/, '');
  const low = p.toLowerCase();
  if (!/\.(md|mdx)$/.test(low)) return null;
  if (low.includes('node_modules/') || low.startsWith('dist/') || low.includes('/dist/')) return null;
  const single = (kind: ZeusNodeKind, slug: string, pinned = false): Classified => ({ kind, slug, pinned, group: p, part: 0, partTitle: null });

  // OpenSpec. Con o sin prefijo (monorepos: packages/api/openspec/…).
  const os = low.indexOf('openspec/');
  if (os === 0 || (os > 0 && low[os - 1] === '/')) {
    const rest = p.slice(os + 'openspec/'.length);
    const lowRest = rest.toLowerCase();
    const scope = os > 0 ? `${slugify(p.slice(0, os - 1))}-` : '';
    const spec = /^specs\/(.+)\/spec\.md$/i.exec(rest);
    if (spec) return single('spec', scope + slugify(spec[1]!));
    // Lo archivado ya se fusionó a specs/: ingerirlo duplicaría decisiones que ya no son un cambio.
    if (lowRest.startsWith('changes/archive/')) return null;
    const change = /^changes\/([^/]+)\/([^/]+)$/i.exec(rest);
    if (change) {
      const part = CHANGE_PARTS[change[2]!.toLowerCase()];
      if (!part) return null; // las deltas de specs/ dentro del cambio no son un documento aparte
      return { kind: 'change', slug: scope + slugify(change[1]!), pinned: false, group: `${p.slice(0, os)}openspec/changes/${change[1]}`, part: part.part, partTitle: part.title };
    }
    if (lowRest === 'project.md' || lowRest === 'agents.md') return single('doc', `${scope}openspec-${stem(p).toLowerCase()}`, lowRest === 'project.md');
    return null;
  }

  if (ADR_DIRS.some((d) => low.startsWith(d))) {
    const name = stem(p).toLowerCase();
    if (name === 'readme' || name === 'index' || name === 'template' || name.startsWith('0000-')) return null;
    return single('adr', slugify(stem(p)));
  }
  if (RULE_DIRS.some((d) => low.startsWith(d))) return single('rule', slugify(stem(p)));
  if (low.startsWith('docs/design-system/')) return single('design', `design-${slugify(stem(p))}`);
  if (low === 'design.md' || low.endsWith('/design.md')) {
    const dir = p.split('/').slice(0, -1).join('/');
    return single('design', dir ? `design-${slugify(dir)}` : 'design', !dir);
  }
  if (!p.includes('/') && ROOT_DOCS.has(low)) return single('doc', slugify(stem(p)), low === 'agents.md' || low === 'claude.md');
  return null;
}

export interface ParsedDoc {
  title: string;
  summary: string;
  status: ZeusNodeStatus;
  /** Estado tal como lo escribió el autor ("Accepted", "Propuesto"…). */
  nativeStatus: string | null;
  /** Identificadores que este documento dice reemplazar ("ADR-0003", "0003", "usar-postgres"). */
  supersedes: string[];
  /** Rutas del repo a las que enlaza (resueltas desde la carpeta del archivo, sin #ancla). */
  links: string[];
}

function frontmatter(md: string): { data: Record<string, string>; body: string } {
  if (!md.startsWith('---')) return { data: {}, body: md };
  const end = md.indexOf('\n---', 3);
  if (end < 0) return { data: {}, body: md };
  const data: Record<string, string> = {};
  for (const line of md.slice(3, end).split('\n')) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line.trim());
    if (m) data[m[1]!.toLowerCase()] = m[2]!.replace(/^["']|["']$/g, '').trim();
  }
  return { data, body: md.slice(md.indexOf('\n', end + 1) + 1) };
}

const STATUS_WORDS: Array<[RegExp, ZeusNodeStatus]> = [
  [/supersed|reemplazad|sustituid|obsolet/i, 'superseded'],
  [/deprecat|rejected|rechazad|retirad|withdrawn|descartad/i, 'archived'],
  [/propos|propuest|draft|borrador|rfc|pending|pendiente|en discusi/i, 'draft'],
  [/accept|aceptad|aprobad|approved|active|vigente|implemented|implementad|done/i, 'active'],
];

/** Traduce el estado libre de un ADR al de zeus. Lo que no se reconoce queda como vigente. */
export function mapStatus(native: string | null): ZeusNodeStatus {
  if (!native) return 'active';
  for (const [re, status] of STATUS_WORDS) if (re.test(native)) return status;
  return 'active';
}

function nativeStatus(fm: Record<string, string>, body: string): string | null {
  if (fm.status || fm.estado) return fm.status ?? fm.estado ?? null;
  const inline = /^\s*(?:[-*]\s*)?\**(?:status|estado)\**\s*:\s*\**\s*(.+?)\**\s*$/im.exec(body);
  if (inline) return inline[1]!.trim();
  // "## Status" seguido de la primera línea con texto.
  const section = /^#{1,3}\s*(?:status|estado)\s*$/im.exec(body);
  if (section) {
    for (const line of body.slice(section.index + section[0].length).split('\n')) {
      const t = line.trim();
      if (t.startsWith('#')) break;
      if (t) return t.replace(/[*_`]/g, '');
    }
  }
  return null;
}

/** Resuelve un enlace relativo desde la carpeta de un archivo. Null si sale del repo o es externo. */
export function resolveLink(fromPath: string, href: string): string | null {
  const clean = href.split('#')[0]!.split('?')[0]!.trim();
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return null;
  const base = clean.startsWith('/') ? [] : fromPath.split('/').slice(0, -1);
  for (const seg of clean.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!base.length) return null;
      base.pop();
    } else base.push(seg);
  }
  return base.join('/');
}

export function parseDoc(path: string, markdown: string): ParsedDoc {
  const { data: fm, body } = frontmatter(markdown.replace(/\r\n/g, '\n'));
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  const title = (fm.title || h1?.[1] || stem(path).replace(/[-_]+/g, ' ')).replace(/[*_`]/g, '').trim().slice(0, 200);
  const native = nativeStatus(fm, body);

  const supersedes = new Set<string>();
  // "Supersedes ADR-0003, ADR-0007" / "Reemplaza a: 0003-usar-postgres" (no "Superseded by", que es
  // la relación inversa y la declara el otro documento).
  const re = /(?:^|\n)[^\n]*?\b(?:supersedes|reemplaza a|sustituye a|replaces)\b:?\s*([^\n]+)/gi;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    for (const piece of m[1]!.split(/[,;]| y | and /)) {
      const link = /\]\(([^)]+)\)/.exec(piece);
      const id = (link ? stem(link[1]!.split('#')[0]!) : piece).replace(/[[\]*_`.]/g, '').trim();
      if (id && id.length <= 120) supersedes.add(id);
    }
  }
  if (fm.supersedes) for (const id of fm.supersedes.replace(/[[\]]/g, '').split(',')) if (id.trim()) supersedes.add(id.trim());

  const links = new Set<string>();
  const linkRe = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (let m = linkRe.exec(body); m; m = linkRe.exec(body)) {
    const target = resolveLink(path, m[1]!);
    if (target && target !== path && /\.(md|mdx)$/i.test(target)) links.add(target);
  }

  return {
    title,
    summary: (fm.summary || fm.description || '').slice(0, 240) || summarize(body.replace(/^#\s+.+$/m, '')),
    status: mapStatus(native),
    nativeStatus: native,
    supersedes: [...supersedes],
    links: [...links],
  };
}

/** Clave de comparación de un identificador de ADR: "ADR-0003", "0003-usar-x" y "3" → "3". */
export function adrNumber(idOrSlug: string): string | null {
  const m = /(?:^|[^0-9])0*(\d{1,5})(?:[^0-9]|$)/.exec(idOrSlug);
  return m ? m[1]! : null;
}
