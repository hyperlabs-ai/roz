// El recorrido de una solicitud, dibujado: quien pide → dueño del recurso → líder del proyecto → jefe
// directo → admin de zeus. Zeus prueba cada escalón en orden y se queda en el primero que exista (y que
// no sea quien la pidió). En reposo enseña la regla y cuántas abiertas hay en cada escalón; con una
// solicitud en foco marca hasta dónde llegó y con quién.
import { ChevronRight, FolderGit2, Link2, ShieldCheck, User, UserCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ZeusRequest } from '@/lib/zeus';
import './inbox.css';

export type RouteStep = 1 | 2 | 3 | 4;

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * En qué escalón cayó una solicitud. El contrato solo trae el motivo en texto (`routedBecause`), así
 * que se reconoce por sus palabras; si el back cambia la frase, no se marca ninguno (null) en vez de
 * marcar uno equivocado.
 */
export function routeStep(because: string | null): RouteStep | null {
  const b = plain(because ?? '');
  if (!b) return null;
  if (/no hay dueno, jefe/.test(b)) return 4;
  if (/dueno de |directamente con/.test(b)) return 1;
  if (/lleva ese proyecto|lider/.test(b)) return 2;
  if (/jefe/.test(b)) return 3;
  if (/administra/.test(b)) return 4;
  return null;
}

const STEPS: Array<{ step: RouteStep; icon: typeof User; title: string; caption: string }> = [
  { step: 1, icon: Link2, title: 'Dueño del recurso', caption: 'Si pides algo que tiene dueño, va directo con esa persona.' },
  { step: 2, icon: FolderGit2, title: 'Líder del proyecto', caption: 'Si el recurso es de un proyecto, con quien lo lleva.' },
  { step: 3, icon: UserCheck, title: 'Jefe directo', caption: 'La persona a quien reporta quien pide.' },
  { step: 4, icon: ShieldCheck, title: 'Admin de zeus', caption: 'Último escalón: quien administra zeus.' },
];

export function RouteDiagram({
  focus,
  mine,
  counts,
  className,
}: {
  /** Solicitud bajo el cursor o con foco: el diagrama marca su recorrido. */
  focus: ZeusRequest | null;
  /** La solicitud en foco la abrí yo (cambia cómo se nombra el origen). */
  mine: boolean;
  /** Solicitudes abiertas por escalón (las que te tocan y las tuyas). */
  counts: Record<RouteStep, number>;
  className?: string;
}) {
  const hit = focus ? routeStep(focus.routedBecause) : null;
  const lit = hit != null;

  return (
    <ol className={cn('zeus-route grid min-w-[720px] grid-cols-[repeat(4,minmax(0,1fr))_minmax(150px,0.6fr)]', className)} data-lit={lit ? '1' : undefined} aria-label="Recorrido de una solicitud">
      <li className="grid min-w-0 content-start gap-2.5" data-state={lit ? 'pass' : undefined}>
        <div className="flex items-center">
          <span className="zeus-route-node"><User className="size-[18px]" /></span>
          <span className="zeus-route-line">
            <span className="zeus-route-tag">zeus enruta</span>
            <ChevronRight className="zeus-route-tip" />
          </span>
        </div>
        <div className="grid gap-0.5 pr-4">
          <span className="label-caps text-[10px]">Origen</span>
          <span className="truncate text-sm font-semibold tracking-[-0.01em]">{focus ? (mine ? 'Tú la pediste' : `La pidió ${focus.requesterName}`) : 'Quien pide'}</span>
          <span className="text-[11.5px] leading-snug text-muted-foreground">Nunca le llega a quien la pidió.</span>
        </div>
      </li>

      {STEPS.map((s, i) => {
        const state = !lit ? undefined : s.step < hit ? 'pass' : s.step === hit ? 'hit' : 'off';
        const last = i === STEPS.length - 1;
        const n = counts[s.step];
        return (
          <li key={s.step} className="grid min-w-0 content-start gap-2.5" data-state={state}>
            <div className="flex items-center">
              <span className="zeus-route-node">
                <s.icon className="size-[18px]" />
                {!lit && n > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 grid h-[17px] min-w-[17px] place-items-center rounded-full bg-orange px-1 text-[10px] font-semibold tabular-nums text-white" title={`${n} ${n === 1 ? 'abierta' : 'abiertas'} en este escalón`}>
                    {n}
                  </span>
                )}
              </span>
              {!last && (
                <span className="zeus-route-line">
                  <span className="zeus-route-tag">si no hay</span>
                  <ChevronRight className="zeus-route-tip" />
                </span>
              )}
            </div>
            <div className="grid gap-0.5 pr-4">
              <span className="label-caps text-[10px] tabular-nums">Escalón {s.step}</span>
              <span className="zeus-route-title truncate text-sm font-semibold tracking-[-0.01em]">{s.title}</span>
              <span className="text-[11.5px] leading-snug text-muted-foreground">
                {state === 'hit' ? (
                  <>Aquí se quedó: decide <b className="font-semibold text-foreground">{focus!.approverName ?? 'cualquier admin de zeus'}</b>.</>
                ) : (
                  s.caption
                )}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
