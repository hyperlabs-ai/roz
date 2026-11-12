import { Mail, RotateCcw } from 'lucide-react';
import { ROZ_MONOGRAM_PATH } from '@/components/RozLogo';
import { IntegrationIcon, type IntegrationName } from '@/components/brand';
import { useTheme } from '@/components/theme';
import { cn } from '@/lib/utils';

/*
 * Flujo completo de la landing: doce pasos en serpentina de dos filas (ida arriba, vuelta abajo), sin
 * carriles. El color del nodo dice QUIÉN actúa (humano, roz, agente, código, producción) y el ícono
 * dice DÓNDE pasa. Dos retornos cierran el ciclo: el de incidentes (deploy → dedup) y el de la
 * siguiente junta (update → junta). En pantallas chicas el mismo dato se pinta como lista vertical.
 */

type Actor = 'human' | 'roz' | 'agent' | 'code' | 'prod';
type StepIcon = IntegrationName | 'roz' | 'mail';

const STEPS: { t: string; s: string; actor: Actor; icon: StepIcon }[] = [
  { t: 'Junta', s: 'Granola o manual', actor: 'human', icon: 'granola' },
  { t: 'Contexto', s: 'proyecto por regla', actor: 'roz', icon: 'roz' },
  { t: 'Extracción', s: 'LLM con schema', actor: 'roz', icon: 'claude' },
  { t: 'Dedup y riesgo', s: 'sin duplicar nada', actor: 'roz', icon: 'roz' },
  { t: 'Triage', s: 'un humano acepta', actor: 'human', icon: 'linear' },
  { t: 'Delegar', s: 'el dev lo pasa a roz', actor: 'human', icon: 'linear' },
  { t: 'Despacho', s: 'a la cola del dev', actor: 'roz', icon: 'roz' },
  { t: 'Implementa', s: 'worktree + MCP', actor: 'agent', icon: 'claude' },
  { t: 'PR + CI', s: 'revisor y humano', actor: 'code', icon: 'github' },
  { t: 'Deploy', s: 'a producción', actor: 'prod', icon: 'vercel' },
  { t: 'Registro', s: 'atribución del trabajo', actor: 'roz', icon: 'roz' },
  { t: 'Update', s: 'al cliente', actor: 'human', icon: 'mail' },
];

const ACTORS: Record<Actor, { label: string; dot: string; box: string; title: string; sub: string; num: string; numText: string }> = {
  human: { label: 'Humano', dot: 'bg-yellow', box: 'fill-card stroke-yellow', title: 'fill-foreground', sub: 'fill-muted-foreground', num: 'fill-yellow-soft', numText: 'fill-yellow-ink' },
  roz: { label: 'roz', dot: 'bg-orange', box: 'fill-orange stroke-orange', title: 'fill-white', sub: 'fill-white/85', num: 'fill-white/20', numText: 'fill-white' },
  agent: { label: 'Agente', dot: 'bg-purple-deep', box: 'fill-card stroke-purple-deep', title: 'fill-foreground', sub: 'fill-muted-foreground', num: 'fill-lavender', numText: 'fill-purple-deep' },
  code: { label: 'GitHub · CI', dot: 'bg-ink', box: 'fill-card stroke-foreground', title: 'fill-foreground', sub: 'fill-muted-foreground', num: 'fill-panel', numText: 'fill-foreground' },
  prod: { label: 'Producción', dot: 'bg-green', box: 'fill-card stroke-green', title: 'fill-foreground', sub: 'fill-muted-foreground', num: 'fill-green-soft', numText: 'fill-green' },
};

/* Geometría de la versión ancha: 6 columnas × 2 filas. */
const W = 160;
const H = 92;
const GAP = 28;
const X0 = 14;
const ROW_Y = [8, 196];
const VB_W = X0 * 2 + W * 6 + GAP * 5; // 1128
const VB_H = ROW_Y[1] + H + 8; // 296
const colX = (c: number) => X0 + c * (W + GAP);
/** Paso i (0–11) → columna y fila: la fila de abajo corre de derecha a izquierda. */
const place = (i: number) => (i < 6 ? { c: i, r: 0 } : { c: 11 - i, r: 1 });

const DARK_VARIANT = new Set<IntegrationName>(['github', 'anthropic', 'vercel', 'railway', 'resend', 'orwel', 'hyperops']);
function useIconSrc() {
  const { resolved } = useTheme();
  return (name: IntegrationName) => {
    const file = DARK_VARIANT.has(name) && resolved === 'dark' ? `${name}-light` : name;
    return `/integrations/${file}.${name === 'granola' ? 'png' : 'svg'}`;
  };
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted-foreground">
      {(Object.keys(ACTORS) as Actor[]).map((a) => (
        <span key={a} className="flex items-center gap-2">
          <i className={cn('size-2.5 rounded-[3px]', ACTORS[a].dot)} />
          {ACTORS[a].label}
        </span>
      ))}
      <span className="flex items-center gap-2 text-red">
        <i className="h-0 w-5 border-t-2 border-dashed border-red" />
        Ciclo de incidentes
      </span>
    </div>
  );
}

function WideDiagram() {
  const icon = useIconSrc();
  const cy = [ROW_Y[0] + H / 2, ROW_Y[1] + H / 2];
  const xFirst = colX(0) + W / 2;
  const xLast = colX(5) + W / 2;
  const route = `M${xFirst} ${cy[0]} H${xLast} V${cy[1]} H${xFirst}`;
  // Retorno de incidentes: sale por arriba del Deploy (paso 10) y entra por abajo a Dedup (paso 4).
  const deployX = colX(place(9).c) + W / 2;
  const dedupX = colX(place(3).c) + W / 2;
  const midY = (ROW_Y[0] + H + ROW_Y[1]) / 2;
  const incident = `M${deployX} ${ROW_Y[1] - 2} C${deployX} ${midY - 6} ${dedupX} ${midY + 6} ${dedupX} ${ROW_Y[0] + H + 9}`;

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      role="img"
      className="hidden h-auto w-full lg:block"
      aria-label="Doce pasos: junta, contexto, extracción, dedup y riesgo, triage, delegar, despacho, implementación, PR y CI, deploy, registro y update al cliente. Un error en producción vuelve a entrar en dedup."
    >
      <defs>
        <marker id="lp-fl-red" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L10 5L0 10z" className="fill-red" />
        </marker>
        <marker id="lp-fl-yel" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L10 5L0 10z" className="fill-yellow-ink" />
        </marker>
      </defs>

      {/* Ruta principal: una sola línea bajo los nodos; el punto viaja por ella. */}
      <path id="lp-fl-route" d={route} className="fill-none stroke-foreground/35" strokeWidth={2} strokeLinejoin="round" />
      <path d={route} className="lp-flow fill-none stroke-orange" strokeWidth={2} strokeLinejoin="round" />
      <circle r="5" className="lp-travel fill-orange">
        <animateMotion dur="14s" repeatCount="indefinite" path={route} />
      </circle>

      {/* Puntas de flecha en cada hueco entre nodos. */}
      <g className="fill-foreground">
        {[0, 1, 2, 3, 4].map((c) => {
          const x = colX(c) + W + GAP / 2;
          return (
            <g key={c}>
              <path d={`M${x - 4} ${cy[0] - 5.5} L${x + 5} ${cy[0]} L${x - 4} ${cy[0] + 5.5}z`} />
              <path d={`M${x + 4} ${cy[1] - 5.5} L${x - 5} ${cy[1]} L${x + 4} ${cy[1] + 5.5}z`} />
            </g>
          );
        })}
        <path d={`M${xLast - 5.5} ${midY - 4} L${xLast} ${midY + 5} L${xLast + 5.5} ${midY - 4}z`} />
      </g>

      {/* Retorno: la siguiente junta. */}
      <path
        d={`M${xFirst} ${ROW_Y[1] - 2} V${ROW_Y[0] + H + 9}`}
        className="fill-none stroke-yellow-ink"
        strokeWidth={1.8}
        strokeDasharray="5 5"
        markerEnd="url(#lp-fl-yel)"
      />
      <g>
        <rect x={xFirst + 12} y={midY - 12} width="118" height="24" rx="12" className="fill-yellow-soft" />
        <text x={xFirst + 71} y={midY + 4} fontSize="11.5" fontWeight="600" textAnchor="middle" className="fill-yellow-ink">
          siguiente junta
        </text>
      </g>

      {/* Retorno: ciclo de incidentes. */}
      <path d={incident} className="lp-dash fill-none stroke-red" strokeWidth={2} markerEnd="url(#lp-fl-red)" />
      <g>
        <rect x={(deployX + dedupX) / 2 - 139} y={midY - 14} width="278" height="28" rx="14" className="fill-card stroke-red" />
        <circle cx={(deployX + dedupX) / 2 - 122} cy={midY} r="4" className="lp-pulse fill-red" />
        <text x={(deployX + dedupX) / 2 + 6} y={midY + 4} fontSize="12" fontWeight="600" textAnchor="middle" className="fill-red">
          Error en producción: vuelve a entrar solo
        </text>
      </g>

      {/* Nodos. */}
      {STEPS.map((s, i) => {
        const { c, r } = place(i);
        const x = colX(c);
        const y = ROW_Y[r];
        const a = ACTORS[s.actor];
        const onOrange = s.actor === 'roz';
        return (
          <g key={s.t}>
            <rect x={x} y={y} width={W} height={H} rx="12" className={a.box} strokeWidth={1.6} />
            <rect x={x + 12} y={y + 12} width="34" height="34" rx="8" className={cn(onOrange ? 'fill-white' : 'fill-card stroke-border')} />
            {s.icon === 'roz' ? (
              <path
                d={ROZ_MONOGRAM_PATH}
                transform={`translate(${x + 12} ${y + 12}) scale(0.7083)`}
                className="fill-none stroke-orange"
                strokeWidth={4.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : s.icon === 'mail' ? (
              <g transform={`translate(${x + 19} ${y + 19})`} className="fill-none stroke-foreground" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="3" width="18" height="14" rx="2.5" />
                <path d="M1.5 5.5 10 11.5l8.5-6" />
              </g>
            ) : (
              <image
                href={onOrange && s.icon === 'claude' ? '/integrations/claude.svg' : icon(s.icon)}
                x={x + 19}
                y={y + 19}
                width="20"
                height="20"
              />
            )}
            <rect x={x + W - 46} y={y + 14} width="34" height="22" rx="11" className={a.num} />
            <text x={x + W - 29} y={y + 29.5} fontSize="11.5" fontWeight="700" textAnchor="middle" className={cn('tabular-nums', a.numText)}>
              {String(i + 1).padStart(2, '0')}
            </text>
            <text x={x + 12} y={y + 66} fontSize="15" fontWeight="600" letterSpacing="-0.02em" className={a.title}>
              {s.t}
            </text>
            <text x={x + 12} y={y + 82} fontSize="11.5" className={a.sub}>
              {s.s}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function StackedDiagram() {
  return (
    <ol className="grid gap-2 sm:grid-cols-2 lg:hidden">
      {STEPS.map((s, i) => {
        const a = ACTORS[s.actor];
        const onOrange = s.actor === 'roz';
        return (
          <li key={s.t} className="grid gap-2">
            <div
              className={cn(
                'flex items-center gap-3 rounded-lg border px-3 py-2.5',
                onOrange ? 'border-orange bg-orange text-white' : 'bg-card',
              )}
            >
              <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', onOrange ? 'bg-white' : 'border bg-card')}>
                {s.icon === 'roz' ? (
                  <svg viewBox="0 0 48 48" className="size-6">
                    <path d={ROZ_MONOGRAM_PATH} className="fill-none stroke-orange" strokeWidth={4.8} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : s.icon === 'mail' ? (
                  <Mail className="size-[18px] text-foreground" />
                ) : (
                  <IntegrationIcon name={s.icon} size="sm" className="size-5" />
                )}
              </span>
              <span className="grid min-w-0 leading-tight">
                <b className="text-[15px] font-semibold tracking-[-0.02em]">{s.t}</b>
                <span className={cn('text-xs', onOrange ? 'text-white/85' : 'text-muted-foreground')}>{s.s}</span>
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-2">
                {!onOrange && <i className={cn('size-2 rounded-[3px]', a.dot)} />}
                <span className={cn('text-xs font-bold tabular-nums', onOrange ? 'text-white' : 'text-faint')}>{String(i + 1).padStart(2, '0')}</span>
              </span>
            </div>
            {i === 9 && (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-red px-3 py-2 text-[13px] font-medium text-red">
                <RotateCcw className="size-4 shrink-0" />
                Error en producción: vuelve a entrar solo en el paso 04
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function FlowDiagram() {
  return (
    <div className="grid gap-5">
      <Legend />
      <WideDiagram />
      <StackedDiagram />
    </div>
  );
}
