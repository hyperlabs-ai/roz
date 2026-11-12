import { SegmentMeter } from '@/components/bits';
import { LEVEL_LABEL } from '@/components/skills/levels';
import { cn } from '@/lib/utils';

/** Cuántas pistas hay como máximo. Va de la mano con `SLOT_VISIBILITY` y con `SKILL_GRID`. */
export const SKILL_SLOTS = 5;

/** Rejilla de las pistas: 2 de base, 3 desde `2xl`, 5 desde 1800px. La usa también el esqueleto. */
export const SKILL_GRID = 'grid grid-cols-2 gap-2 xl:gap-3 2xl:grid-cols-3 min-[1800px]:grid-cols-5';

/**
 * Visibilidad por posición. La rejilla y la visibilidad cambian juntas, así que nunca queda una
 * pista vacía de más ni una skill partida a un segundo renglón.
 */
export const SLOT_VISIBILITY = ['', '', 'hidden 2xl:flex', 'hidden min-[1800px]:flex', 'hidden min-[1800px]:flex'];

/**
 * Skills de una persona como medidores en UNA fila de pistas fijas (para la fila del listado).
 *
 * Eran chips de ancho libre, que se amontonaban a la izquierda y dejaban media tarjeta vacía. Con
 * pistas fijas el bloque ocupa su columna entera y, sobre todo, es idéntico de una persona a otra:
 * a quien le faltan skills se le dibujan las pistas vacías (punteadas), así las filas del listado
 * quedan alineadas aunque falten datos.
 */
export function SkillTiles({ skills, className }: { skills: { tag: string; level: number }[]; className?: string }) {
  const sorted = [...skills].sort((a, b) => b.level - a.level).slice(0, SKILL_SLOTS);

  if (!sorted.length) {
    return (
      <div className={cn('grid min-h-[66px] place-items-center rounded-md border border-dashed text-[12px] text-faint', className)}>
        Sin skills registradas
      </div>
    );
  }

  return (
    <div className={cn(SKILL_GRID, className)}>
      {Array.from({ length: SKILL_SLOTS }, (_, i) => {
        const s = sorted[i];
        if (!s) return <div key={i} aria-hidden className={cn('min-h-[66px] rounded-md border border-dashed', SLOT_VISIBILITY[i] || 'flex')} />;
        const lvl = Math.max(0, Math.min(5, s.level));
        return (
          <div
            key={s.tag}
            title={`${s.tag} · ${LEVEL_LABEL[lvl]}`}
            className={cn('min-h-[66px] min-w-0 flex-col justify-between gap-2 rounded-md border p-2.5', SLOT_VISIBILITY[i] || 'flex')}
          >
            <div className="truncate text-[13px] font-semibold leading-tight tracking-[-0.01em]">{s.tag}</div>
            <div>
              <SegmentMeter value={lvl} max={5} />
              <div className="mt-1.5 flex items-baseline justify-between gap-2 text-[11px] leading-none">
                <span className="truncate text-muted-foreground">{LEVEL_LABEL[lvl]}</span>
                <span className="shrink-0 tabular-nums text-faint">{lvl}/5</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
