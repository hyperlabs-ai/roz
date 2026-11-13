// "La estantería": la matriz proyectos × tipos de la pestaña Documentos. Cada celda dibuja sus
// documentos como puntos con el tono del tipo; los bordes llevan los totales. Clic en una celda fija
// proyecto + tipo; clic en la etiqueta de una fila o en la cabecera de una columna fija solo eso.
//
// La matriz mide su propio ancho: de ahí salen cuántos puntos caben por renglón, el tope por celda
// ("+N") y si pasa a la versión compacta (solo la cifra), que es la que convive con el lector.
import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Building2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ZeusNodeStatus } from '@/lib/zeus';
import { kindMeta } from './zeus-ui';
import './docs.css';

export const ORG = 'org';

export interface ShelfDoc {
  id: string;
  kind: string;
  projectId: string | null;
  status: ZeusNodeStatus;
  pinned: boolean;
}

export interface ShelfRow {
  /** uuid del proyecto, u `ORG` para lo que es de toda la organización. */
  key: string;
  label: string;
}

export interface ShelfPick {
  p: string | null;
  k: string | null;
}

/**
 * Escalas de la rejilla de puntos, de la más holgada a la más apretada: tamaño del punto, paso
 * (punto + aire) y renglones máximos por celda. Se usa la primera con la que la matriz cabe entera
 * en su alto; si ninguna cabe, la última, y el cuerpo hace scroll.
 */
const SCALES = [
  { dot: 8, pitch: 11, max: 6 },
  { dot: 7, pitch: 10, max: 6 },
  { dot: 6, pitch: 9, max: 6 },
  { dot: 6, pitch: 9, max: 4 },
  { dot: 6, pitch: 9, max: 3 },
] as const;
const ROW_MIN = 28;
/** Ancho mínimo de la matriz; por debajo (móvil) hace scroll horizontal. */
const MIN_W = 440;
const HEAD_H = 48;
const FOOT_H = 44;
const linesFor = (count: number, perLine: number, max: number): number => Math.min(max, Math.max(1, Math.ceil(count / perLine)));
/** Alto de una fila con su hairline: los renglones de puntos más 6 px de aire arriba y abajo. */
const rowHeight = (lines: number, dot: number, pitch: number): number => Math.max(ROW_MIN, lines * pitch - (pitch - dot) + 13);

/** Estado de un documento → cómo se dibuja su punto. */
const glyph = (status: ZeusNodeStatus): 'draft' | 'off' | undefined => (status === 'draft' ? 'draft' : status === 'active' ? undefined : 'off');
const rank = (d: ShelfDoc): number => (d.status === 'active' ? (d.pinned ? 0 : 1) : d.status === 'draft' ? 2 : 3);

export function DocGlyph({ kind, status, pinned, large, className }: { kind: string; status: ZeusNodeStatus; pinned: boolean; large?: boolean; className?: string }) {
  return <span aria-hidden className={cn('bib-dot', kindMeta(kind).tone.dot, className)} data-size={large ? 'lg' : undefined} data-pin={pinned ? 1 : undefined} data-st={glyph(status)} />;
}

const Cell = memo(function Cell({
  docs,
  kind,
  label,
  perLine,
  pitch,
  cap,
  compact,
  lit,
  openId,
  sel,
  out,
  line,
  hot,
  onPick,
  onHot,
}: {
  docs: ShelfDoc[];
  kind: string;
  label: string;
  perLine: number;
  pitch: number;
  /** Puntos que caben en la celda; lo que pase se resume en "+N". */
  cap: number;
  compact: boolean;
  lit: Set<string> | null;
  openId: string | null;
  /** 0 = fuera del filtro · 1 = en la fila o columna fijada · 2 = es la celda fijada. */
  sel: 0 | 1 | 2;
  out: boolean;
  line: boolean;
  hot: boolean;
  onPick: () => void;
  onHot: () => void;
}) {
  const tone = kindMeta(kind).tone;
  const shown = lit ? docs.reduce((n, d) => n + (lit.has(d.id) ? 1 : 0), 0) : docs.length;
  // El "+N" ocupa el lugar de tres puntos al final del último renglón.
  const visible = docs.length > cap ? docs.slice(0, cap - 3) : docs;
  const rest = docs.length - visible.length;
  return (
    <button
      type="button"
      onClick={onPick}
      onPointerEnter={onHot}
      onFocus={onHot}
      data-sel={sel || undefined}
      data-out={out ? 1 : undefined}
      data-line={line ? 1 : undefined}
      data-hot={hot ? 1 : undefined}
      aria-pressed={sel === 2}
      aria-label={`${label}: ${docs.length} ${docs.length === 1 ? 'documento' : 'documentos'}`}
      className={cn('bib-cell flex min-w-0 items-center border-l border-foreground/[.07] text-left', compact ? 'justify-center gap-1.5 px-1' : 'gap-1.5 px-2 py-1.5')}
    >
      {docs.length === 0 ? (
        <span className="bib-dot" data-void="1" />
      ) : compact ? (
        <>
          <span className={cn('bib-dot', tone.dot)} data-dim={shown === 0 ? 1 : undefined} />
          <span className={cn('text-[12px] font-semibold tabular-nums', shown === 0 && 'text-faint')}>{shown}</span>
        </>
      ) : (
        <>
          <span className="flex shrink-0 flex-wrap content-center items-center gap-[3px]" style={{ width: perLine * pitch - 3 }}>
            {visible.map((d) => (
              <span
                key={d.id}
                className={cn('bib-dot', tone.dot)}
                data-pin={d.pinned ? 1 : undefined}
                data-st={glyph(d.status)}
                data-dim={lit && !lit.has(d.id) ? 1 : undefined}
                data-open={d.id === openId ? 1 : undefined}
              />
            ))}
            {rest > 0 && <span className="text-[9.5px] font-semibold leading-[6px] tabular-nums text-muted-foreground" style={{ width: pitch * 3 - 3 }}>+{rest}</span>}
          </span>
          <span className={cn('min-w-0 flex-1 text-right text-[13px] font-semibold leading-none tabular-nums', shown === 0 && 'text-faint')}>{shown}</span>
        </>
      )}
    </button>
  );
});

export function DocsShelf({
  rows,
  kinds,
  docs,
  lit,
  pick,
  openId,
  loading,
  onPick,
  className,
}: {
  rows: ShelfRow[];
  kinds: string[];
  docs: ShelfDoc[];
  /** Con búsqueda o filtro de estado: los ids que siguen encendidos. `null` = todos. */
  lit: Set<string> | null;
  pick: ShelfPick;
  openId: string | null;
  loading?: boolean;
  onPick: (next: ShelfPick) => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hot, setHot] = useState<ShelfPick>({ p: null, k: null });

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Medidas: del ancho y el alto de la matriz sale todo lo demás.
  const inner = Math.max(size.w, MIN_W);
  const cols = Math.max(1, kinds.length);
  // Tres tallas: holgada, justa (etiquetas más angostas) y compacta (la celda es solo su cifra).
  const wide = (inner - 176 - 60) / cols >= 110;
  const compact = !wide && (inner - 148 - 48) / cols < 72;
  const labelW = wide ? 176 : compact ? 112 : 148;
  const totalW = wide ? 60 : compact ? 40 : 48;
  const colW = (inner - labelW - totalW) / cols;
  /** La cabecera lleva el nombre del tipo solo si cabe entero; si no, su ícono (y el nombre al pasar). */
  const named = colW >= 104;
  const template: CSSProperties = { gridTemplateColumns: `${labelW}px repeat(${kinds.length}, minmax(0, 1fr)) ${totalW}px` };

  const cells = useMemo(() => {
    const m = new Map<string, ShelfDoc[]>();
    for (const d of docs) {
      const key = `${d.projectId ?? ORG}|${d.kind}`;
      const b = m.get(key);
      if (b) b.push(d);
      else m.set(key, [d]);
    }
    for (const b of m.values()) b.sort((a, z) => rank(a) - rank(z));
    return m;
  }, [docs]);
  const none: ShelfDoc[] = useMemo(() => [], []);

  /** La celda más llena de cada fila: de ella sale cuántos renglones de puntos pide la fila. */
  const biggest = useMemo(() => rows.map((r) => kinds.reduce((n, k) => Math.max(n, cells.get(`${r.key}|${k}`)?.length ?? 0), 0)), [rows, kinds, cells]);
  const scale = useMemo(() => {
    // Sitio para los puntos: la celda menos su relleno, el aire y la cifra.
    const perLineOf = (pitch: number) => Math.max(3, Math.floor((colW - 16 - 6 - 22 + 3) / pitch));
    const room = size.h - HEAD_H - FOOT_H;
    const fits = SCALES.find((s) => biggest.reduce((sum, n) => sum + rowHeight(linesFor(n, perLineOf(s.pitch), s.max), s.dot, s.pitch), 0) <= room);
    const s = fits ?? SCALES[SCALES.length - 1]!;
    return { ...s, perLine: perLineOf(s.pitch) };
  }, [biggest, colW, size.h]);
  const { perLine, pitch } = scale;

  const count = (list: ShelfDoc[]): number => (lit ? list.reduce((n, d) => n + (lit.has(d.id) ? 1 : 0), 0) : list.length);
  const rowTotal = (p: string): number => kinds.reduce((n, k) => n + count(cells.get(`${p}|${k}`) ?? none), 0);
  const colTotal = (k: string): number => rows.reduce((n, r) => n + count(cells.get(`${r.key}|${k}`) ?? none), 0);
  const grand = kinds.reduce((n, k) => n + colTotal(k), 0);

  const hasPick = !!(pick.p || pick.k);
  const inPick = (p: string | null, k: string | null): boolean => (!pick.p || p === null || p === pick.p) && (!pick.k || k === null || k === pick.k);
  // Volver a pulsar lo ya fijado lo suelta.
  const toggle = (next: ShelfPick) => onPick(next.p === pick.p && next.k === pick.k ? { p: null, k: null } : next);

  const ghostRows = 12;

  return (
    <section
      className={cn('zeus-stage flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card text-foreground', className)}
      style={{ '--bib-d': `${scale.dot}px` } as CSSProperties}
      aria-label="Estantería: documentos por proyecto y tipo"
    >
      <div ref={box} className="scroll-thin min-h-0 flex-1 overflow-auto" onPointerLeave={() => setHot({ p: null, k: null })}>
        <div className="flex min-h-full flex-col" style={{ minWidth: MIN_W }}>
          {/* Cabecera: los tipos. */}
          <div className="sticky top-0 z-10 grid shrink-0 border-b border-foreground/15 bg-card" style={{ ...template, height: HEAD_H }}>
            <button
              type="button"
              onClick={() => onPick({ p: null, k: null })}
              data-sel={!hasPick ? 1 : undefined}
              className="bib-cell flex min-w-0 items-center px-3.5 text-left"
              title="Ver toda la biblioteca"
            >
              <span className={cn('label-caps truncate', !hasPick && 'text-orange')}>{wide ? 'Toda la biblioteca' : 'Todo'}</span>
            </button>
            {kinds.map((k) => {
              const m = kindMeta(k);
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => toggle({ p: null, k })}
                  onPointerEnter={() => setHot({ p: null, k })}
                  onFocus={() => setHot({ p: null, k })}
                  data-sel={pick.k === k ? (pick.p ? 1 : 2) : undefined}
                  data-out={hasPick && !inPick(null, k) ? 1 : undefined}
                  data-line={hot.k === k ? 1 : undefined}
                  aria-pressed={pick.k === k}
                  title={m.plural}
                  className={cn('bib-cell flex min-w-0 items-center gap-2 border-l border-foreground/[.07]', named ? (colW < 122 ? 'gap-1.5 px-2' : 'px-2') : 'justify-center px-1')}
                >
                  {named && colW < 122 ? (
                    <m.icon className={cn('size-3.5 shrink-0', m.tone.text)} />
                  ) : (
                    <span className={cn('grid size-6 shrink-0 place-items-center rounded-md', m.tone.chip)}><m.icon className="size-3.5" /></span>
                  )}
                  {named && <span className="truncate text-[12.5px] font-semibold">{m.plural}</span>}
                </button>
              );
            })}
            <span className="flex items-center justify-end border-l border-foreground/15 px-3">
              <span className="label-caps">{wide ? 'Total' : 'Σ'}</span>
            </span>
          </div>

          {/* Filas: los proyectos. Las que tienen celdas llenas piden más alto (más renglones de puntos). */}
          {loading
            ? Array.from({ length: ghostRows }, (_, i) => (
                <div key={i} className="bib-ghost grid flex-1 border-b border-foreground/[.07]" style={{ ...template, minHeight: ROW_MIN, animationDelay: `${i * 70}ms` }}>
                  <span className="flex items-center px-3.5"><span className="h-2 rounded-full bg-foreground/10" style={{ width: `${44 + ((i * 37) % 44)}%` }} /></span>
                  {kinds.map((k) => (
                    <span key={k} className={cn('flex items-center border-l border-foreground/[.07] px-2', compact && 'justify-center')}><span className="bib-dot" data-void="1" /></span>
                  ))}
                  <span className="border-l border-foreground/15" />
                </div>
              ))
            : rows.map((r, i) => {
                const lines = compact ? 1 : linesFor(biggest[i] ?? 0, perLine, scale.max);
                const total = rowTotal(r.key);
                const rowSel = pick.p === r.key;
                const rowOut = hasPick && !inPick(r.key, null);
                return (
                  <div
                    key={r.key}
                    className="bib-row grid border-b border-foreground/[.07]"
                    style={{ ...template, flex: `${lines} 0 auto`, minHeight: rowHeight(lines, scale.dot, pitch), '--i': i } as CSSProperties}
                  >
                    <button
                      type="button"
                      onClick={() => toggle({ p: r.key, k: null })}
                      onPointerEnter={() => setHot({ p: r.key, k: null })}
                      onFocus={() => setHot({ p: r.key, k: null })}
                      data-sel={rowSel ? (pick.k ? 1 : 2) : undefined}
                      data-out={rowOut ? 1 : undefined}
                      data-line={hot.p === r.key ? 1 : undefined}
                      aria-pressed={rowSel}
                      title={r.label}
                      className="bib-cell flex min-w-0 items-center gap-2 px-3.5 text-left"
                    >
                      {r.key === ORG && <Building2 className="size-3.5 shrink-0 text-muted-foreground" />}
                      <span className={cn('truncate text-[13px] font-medium', rowSel && 'text-orange', total === 0 && !rowSel && 'text-muted-foreground')}>{r.label}</span>
                    </button>
                    {kinds.map((k) => {
                      const exact = pick.p === r.key && pick.k === k;
                      const within = hasPick && inPick(r.key, k);
                      return (
                        <Cell
                          key={k}
                          docs={cells.get(`${r.key}|${k}`) ?? none}
                          kind={k}
                          label={`${r.label}, ${kindMeta(k).plural}`}
                          perLine={perLine}
                          pitch={pitch}
                          cap={perLine * scale.max}
                          compact={compact}
                          lit={lit}
                          openId={openId}
                          sel={exact ? 2 : within ? 1 : 0}
                          out={hasPick && !within}
                          line={hot.p === r.key || hot.k === k}
                          hot={hot.p === r.key && hot.k === k}
                          onPick={() => toggle({ p: r.key, k })}
                          onHot={() => setHot({ p: r.key, k })}
                        />
                      );
                    })}
                    <span
                      data-out={rowOut ? 1 : undefined}
                      data-line={hot.p === r.key ? 1 : undefined}
                      className="bib-cell flex items-center justify-end border-l border-foreground/15 px-3"
                    >
                      <span className={cn('text-[13px] font-semibold tabular-nums', total === 0 && 'text-faint', rowSel && 'text-orange')}>{total}</span>
                    </span>
                  </div>
                );
              })}

          {/* Pie: el total de cada tipo y el de todo. */}
          <div className="sticky bottom-0 z-10 mt-auto grid shrink-0 border-t border-foreground/15 bg-card" style={{ ...template, height: FOOT_H }}>
            <span className="flex items-center px-3.5"><span className="label-caps">Por tipo</span></span>
            {kinds.map((k) => {
              const n = loading ? 0 : colTotal(k);
              return (
                <span key={k} data-line={hot.k === k ? 1 : undefined} data-out={hasPick && !inPick(null, k) ? 1 : undefined} className={cn('bib-cell flex items-center border-l border-foreground/[.07]', compact ? 'justify-center px-1' : 'justify-end px-2')}>
                  <span className={cn('text-[17px] font-semibold leading-none tracking-[-0.03em] tabular-nums', n === 0 ? 'text-faint' : kindMeta(k).tone.text)}>{n}</span>
                </span>
              );
            })}
            <span className={cn('flex items-center justify-end border-l border-foreground/15', wide ? 'px-3' : 'px-2')}>
              <span className={cn('font-semibold leading-none tracking-[-0.04em] tabular-nums text-orange', wide ? 'text-[19px]' : 'text-[15px]')}>{loading ? 0 : grand}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Cómo se lee. */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-t border-foreground/15 bg-card px-3.5 py-2 text-[11px] text-muted-foreground">
        {!compact && <span className="truncate">Clic en una celda para ver sus documentos; en un proyecto o un tipo, toda su fila o columna.</span>}
        <span className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-1.5"><span className="bib-dot bg-foreground/70" /> vigente</span>
          <span className="flex items-center gap-1.5"><span className="bib-dot bg-foreground/70" data-pin="1" /> fijado</span>
          <span className="flex items-center gap-1.5"><span className="bib-dot bg-foreground/70" data-st="draft" /> borrador</span>
          <span className="flex items-center gap-1.5"><span className="bib-dot bg-foreground/70" data-st="off" /> archivado</span>
        </span>
      </div>
    </section>
  );
}
