// Piezas compartidas por las pestañas de Zeus: cómo se nombra y se pinta cada tipo de nodo, cada
// estado y cada arista, más los bloques chicos que se repiten (copiar, comando de terminal, "hace X").
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BookOpen, Check, Copy, FileCode2, FilePen, FileText, FolderGit2, Gavel, GitBranch, Laptop, Link2, Palette, ShieldCheck, User, Users,
} from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/useApi';
import { cn } from '@/lib/utils';
import {
  zeusApi,
  type ZeusActivityEvent, type ZeusEdgeKind, type ZeusGraphKind, type ZeusMe, type ZeusNodeStatus, type ZeusRequestKind,
  type ZeusRequestStatus,
} from '@/lib/zeus';

type Icon = typeof FileText;

/** Tono de marca de un tipo: par suave/tinta para chips y clases de relleno/trazo para el SVG. */
export interface Tone {
  chip: string;
  dot: string;
  fill: string;
  stroke: string;
  text: string;
}

export const TONES = {
  orange: { chip: 'bg-orange-soft text-orange-ink', dot: 'bg-orange', fill: 'fill-orange', stroke: 'stroke-orange', text: 'text-orange-ink' },
  purple: { chip: 'bg-lavender text-purple-deep', dot: 'bg-purple-deep', fill: 'fill-purple-deep', stroke: 'stroke-purple-deep', text: 'text-purple-deep' },
  yellow: { chip: 'bg-yellow-soft text-yellow-ink', dot: 'bg-yellow', fill: 'fill-yellow', stroke: 'stroke-yellow', text: 'text-yellow-ink' },
  blue: { chip: 'bg-blue-soft text-blue-ink', dot: 'bg-blue', fill: 'fill-blue', stroke: 'stroke-blue', text: 'text-blue-ink' },
  green: { chip: 'bg-green-soft text-green', dot: 'bg-green', fill: 'fill-green', stroke: 'stroke-green', text: 'text-green' },
  red: { chip: 'bg-red-soft text-red', dot: 'bg-red', fill: 'fill-red', stroke: 'stroke-red', text: 'text-red' },
  sky: { chip: 'bg-blue-soft text-blue-ink', dot: 'bg-chart-5', fill: 'fill-chart-5', stroke: 'stroke-chart-5', text: 'text-blue-ink' },
  salmon: { chip: 'bg-orange-soft text-orange-ink', dot: 'bg-salmon', fill: 'fill-salmon', stroke: 'stroke-salmon', text: 'text-orange-ink' },
  neutral: { chip: 'bg-panel text-muted-foreground', dot: 'bg-faint', fill: 'fill-faint', stroke: 'stroke-faint', text: 'text-muted-foreground' },
} satisfies Record<string, Tone>;

export interface KindMeta {
  label: string;
  plural: string;
  icon: Icon;
  tone: Tone;
}

// Cada tipo de documento tiene su tono: en el mapa una zona se reconoce por su color antes que por
// su etiqueta, así que dos zonas vecinas nunca comparten uno. El ícono lo refuerza en listas y chips.
export const KIND_META: Record<ZeusGraphKind, KindMeta> = {
  adr: { label: 'ADR', plural: 'ADRs', icon: Gavel, tone: TONES.orange },
  spec: { label: 'Spec', plural: 'Specs', icon: FileCode2, tone: TONES.purple },
  change: { label: 'Cambio', plural: 'Cambios', icon: FilePen, tone: TONES.green },
  doc: { label: 'Documento', plural: 'Documentos', icon: FileText, tone: TONES.blue },
  design: { label: 'Diseño', plural: 'Diseño', icon: Palette, tone: TONES.yellow },
  rule: { label: 'Regla', plural: 'Reglas', icon: ShieldCheck, tone: TONES.red },
  resource: { label: 'Recurso', plural: 'Recursos', icon: Link2, tone: TONES.sky },
  team: { label: 'Equipo', plural: 'Equipos', icon: Users, tone: TONES.salmon },
  project: { label: 'Proyecto', plural: 'Proyectos', icon: FolderGit2, tone: TONES.blue },
  dev: { label: 'Persona', plural: 'Personas', icon: User, tone: TONES.salmon },
  repo: { label: 'Repo', plural: 'Repos', icon: GitBranch, tone: TONES.neutral },
  runner: { label: 'PC', plural: 'PCs', icon: Laptop, tone: TONES.sky },
};

/** Tonos para zonas que no son un tipo (proyectos): rotan para que dos vecinas no se confundan. */
const ZONE_CYCLE: Tone[] = [TONES.orange, TONES.purple, TONES.green, TONES.yellow, TONES.blue, TONES.salmon, TONES.sky, TONES.red];
export const zoneTone = (i: number): Tone => ZONE_CYCLE[i % ZONE_CYCLE.length]!;

const FALLBACK_KIND: KindMeta = { label: 'Nodo', plural: 'Otros', icon: BookOpen, tone: TONES.neutral };
/** Tolera un tipo que el back agregue antes que el front: se pinta neutro en vez de romper. */
export const kindMeta = (kind: string): KindMeta => KIND_META[kind as ZeusGraphKind] ?? { ...FALLBACK_KIND, label: kind, plural: kind };

export function KindChip({ kind, className }: { kind: string; className?: string }) {
  const m = kindMeta(kind);
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', m.tone.chip, className)}>
      <m.icon className="size-3" />
      {m.label}
    </span>
  );
}

export const STATUS_META: Record<ZeusNodeStatus, { label: string; variant: BadgeVariant }> = {
  draft: { label: 'Borrador', variant: 'secondary' },
  active: { label: 'Vigente', variant: 'ok' },
  superseded: { label: 'Reemplazado', variant: 'warn' },
  archived: { label: 'Archivado', variant: 'secondary' },
};

export function StatusBadge({ status }: { status: ZeusNodeStatus }) {
  const m = STATUS_META[status] ?? { label: status, variant: 'secondary' as const };
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

/**
 * Cómo se lee y se dibuja cada tipo de arista. La distinción visual es el PATRÓN de guiones (y el
 * grosor), no el color: los colores ya dicen el tipo de nodo, y una línea de color crudo por tipo de
 * relación sería ruido.
 */
export const EDGE_META: Record<ZeusEdgeKind | 'reports_to', { out: string; in: string; dash: string | undefined; width: number }> = {
  supersedes: { out: 'reemplaza a', in: 'reemplazado por', dash: undefined, width: 1.8 },
  depends_on: { out: 'depende de', in: 'lo necesita', dash: '7 4', width: 1.3 },
  implements: { out: 'implementa', in: 'implementado por', dash: '11 3 2 3', width: 1.3 },
  documents: { out: 'documenta', in: 'documentado por', dash: '5 3 1 3', width: 1.2 },
  applies_to: { out: 'aplica a', in: 'le aplica', dash: '9 5', width: 1.1 },
  owns: { out: 'es dueño de', in: 'su dueño es', dash: '1 5', width: 1.6 },
  part_of: { out: 'es parte de', in: 'contiene a', dash: '3 3', width: 1 },
  connects_to: { out: 'conecta con', in: 'conecta con', dash: '14 4', width: 1.1 },
  relates_to: { out: 'se relaciona con', in: 'se relaciona con', dash: '2 4', width: 1 },
  reports_to: { out: 'reporta a', in: 'le reporta', dash: '4 7', width: 1.1 },
};

export const edgeMeta = (kind: string) => EDGE_META[kind as ZeusEdgeKind] ?? { out: kind, in: kind, dash: '2 4', width: 1 };

/** Muestra de una arista para leyendas y selectores: una línea corta con su patrón. */
export function EdgeSwatch({ kind, className }: { kind: string; className?: string }) {
  const m = edgeMeta(kind);
  return (
    <svg viewBox="0 0 34 6" aria-hidden className={cn('h-1.5 w-[34px] shrink-0', className)}>
      <line x1="1" y1="3" x2="33" y2="3" className="stroke-foreground/70" strokeWidth={m.width + 0.3} strokeDasharray={m.dash} strokeLinecap="round" />
    </svg>
  );
}

export const REQUEST_KIND_LABEL: Record<ZeusRequestKind, string> = {
  access: 'Acceso',
  permission: 'Permiso',
  review: 'Revisión',
  change: 'Cambio',
  other: 'Otro',
};

export const REQUEST_STATUS: Record<ZeusRequestStatus, { label: string; variant: BadgeVariant }> = {
  pending: { label: 'Pendiente', variant: 'human' },
  approved: { label: 'Aprobada', variant: 'ok' },
  denied: { label: 'Denegada', variant: 'bad' },
  cancelled: { label: 'Cancelada', variant: 'secondary' },
};

const VIA_LABEL: Record<string, string> = { mcp: 'MCP', web: 'la web', cli: 'el CLI', git: 'git', runner: 'su PC', system: 'zeus' };
export const viaLabel = (via: string): string => VIA_LABEL[via] ?? via;

/** "hace 12 s" · "hace 4 min" · "hace 3 h" · "hace 2 d". Con segundos, porque el mapa es en vivo. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return 'ahora';
  if (s < 60) return `hace ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

/** Fecha y hora cortas en español de México, para auditoría y revisiones. */
export function dateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// `action` es texto libre del back. Se reconoce por palabra clave (en este orden: lo más específico
// primero) y, si no cae en ninguna, se muestra tal cual en vez de inventar un verbo.
const ACTION_VERBS: Array<[RegExp, string]> = [
  [/search|busc/, 'buscó'],
  [/context|index/, 'pidió el índice de'],
  [/related|neighbo/, 'recorrió los vecinos de'],
  [/unlink|edge[._]?(delete|remove)/, 'desconectó'],
  [/link|edge/, 'conectó'],
  [/archive|delete|remove/, 'archivó'],
  [/create|insert|new/, 'creó'],
  [/write|update|edit|patch/, 'editó'],
  [/resolve|approve|deny/, 'resolvió una solicitud sobre'],
  [/request/, 'abrió una solicitud sobre'],
  [/message|send/, 'envió un mensaje sobre'],
  [/rotate/, 'rotó la llave de'],
  [/grant/, 'dio acceso a'],
  [/revoke/, 'revocó'],
  [/push|secret[._]?(set|write)/, 'subió variables de'],
  [/pull|env|vault|secret/, 'consultó las variables de'],
  [/sync|ingest|sweep/, 'sincronizó'],
  [/claim/, 'tomó'],
  [/release/, 'soltó'],
  [/token/, 'gestionó un token de'],
  [/get|read|view|open|fetch/, 'consultó'],
];

export function actionVerb(action: string): string {
  const a = action.toLowerCase();
  for (const [re, verb] of ACTION_VERBS) if (re.test(a)) return verb;
  return action.replace(/[._]/g, ' ');
}

/** "Ana consultó ADR-0007 por MCP": frase del ticker. `title` es el del nodo si está en el mapa. */
export function describeActivity(ev: ZeusActivityEvent, title: string | null): { who: string; verb: string; what: string | null; via: string } {
  const who = ev.devName ?? (ev.actor === 'git' ? 'git' : ev.actor === 'runner' ? 'Un runner' : 'zeus');
  const detailTitle = typeof ev.detail?.title === 'string' ? ev.detail.title : typeof ev.detail?.q === 'string' ? `"${ev.detail.q}"` : null;
  return { who, verb: actionVerb(ev.action), what: title ?? detailTitle, via: viaLabel(ev.actor) };
}

/** Punto "en línea": late si hay un runner vivo. */
export function OnlineDot({ online, className }: { online: boolean; className?: string }) {
  return (
    <span
      className={cn('inline-block size-2 shrink-0 rounded-full', online ? 'animate-pulse bg-green' : 'bg-toggle-off', className)}
      title={online ? 'En línea' : 'Sin conexión'}
      aria-label={online ? 'En línea' : 'Sin conexión'}
    />
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = 'Copiar', className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn('h-7 gap-1.5 px-2 text-xs', done && 'text-green', className)}
      onClick={async () => {
        if (!(await copyText(text))) return;
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? <Check /> : <Copy />}
      {done ? 'Copiado' : label}
    </Button>
  );
}

/** Instalador del CLI de zeus (paquete público en npm, código en `cli/` del repo). Requiere Node 20+. */
export const CLI_INSTALL = 'npm i -g @hyperlabs-ai/zeus';

/** Bloque de terminal (oscuro en ambos temas) con su botón de copiar. */
export function CommandBlock({ command, label, className }: { command: string; label?: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-md bg-terminal text-terminal-foreground', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-terminal-muted/20 py-1 pl-3.5 pr-1.5">
        <span className="label-caps truncate text-terminal-muted">{label ?? 'Terminal'}</span>
        <CopyButton text={command} className="text-terminal-muted hover:bg-terminal-muted/15 hover:text-terminal-foreground" />
      </div>
      <pre className="scroll-thin overflow-x-auto whitespace-pre-wrap break-all px-3.5 py-3 font-mono text-[11.5px] leading-relaxed">{command}</pre>
    </div>
  );
}

/** `ZeusMe` compartido por toda la sección (insignias de las pestañas, permisos de admin, URLs). */
export function useZeusMe() {
  return useApi<ZeusMe>(() => zeusApi.me(), [], { key: '/zeus/me', ttl: 20_000 });
}

/** Bloque de sección dentro de una pestaña: título chico + meta a la derecha. */
export function BlockTitle({ title, meta, children }: { title: ReactNode; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className="text-sm font-semibold tracking-[-0.01em]">{title}</h2>
        {meta != null && <span className="label-caps tabular-nums">{meta}</span>}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- piezas de tablero

/** Título de un bloque de riel o panel: etiqueta en mayúsculas + meta a la derecha. */
export function RailTitle({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="label-caps text-muted-foreground">{children}</h3>
      {meta}
    </div>
  );
}

/**
 * Cifra grande con su etiqueta. Se usa en rejillas `grid gap-px overflow-hidden rounded-lg border bg-border`:
 * las celdas quedan separadas por una hairline, como un tablero de instrumentos.
 */
export function Figure({ value, label, accent }: { value: ReactNode; label: string; accent?: boolean }) {
  return (
    <div className="grid gap-1 bg-card px-3.5 py-3">
      <span className={cn('text-[26px] font-semibold leading-none tracking-[-0.04em] tabular-nums', accent && 'text-orange')}>{value}</span>
      <span className="label-caps text-[10px]">{label}</span>
    </div>
  );
}

/** Fila de conteo: punto de color, etiqueta y número. El cero se atenúa. */
export function Tally({ dot, label, value }: { dot: string; label: string; value: number }) {
  return (
    <li className={cn('flex items-center gap-2.5 text-[13px]', value === 0 && 'text-faint')}>
      <span className={cn('size-2 shrink-0 rounded-full', dot)} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </li>
  );
}
