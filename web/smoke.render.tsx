// Prueba de humo de render:  npm run smoke  (desde web/)
//
// Existe porque los tres gates del repo NO cazan esta clase de fallo. `tsc` no ve que un objeto de
// forwardRef acabe en posición de hijo (un icono de lucide pasado como prop lo hizo, y la app
// reventó en runtime con "Objects are not valid as a React child"); `vite build` tampoco; y los
// tests de vitest son del backend, sin un solo render de React.
//
// Renderiza cada pieza a markup estático con `react-dom/server`, incluidos los casos degenerados
// (serie vacía, todo en cero, un único valor), y falla si aparece `$$typeof` o un `NaN` en la
// salida. No necesita DOM: `renderToStaticMarkup` corre en node.
//
// Los avisos de recharts sobre `width(-1)`/`height(-1)` son esperados: en SSR no hay layout y
// `ResponsiveContainer` mide 0. No indican un defecto.
//
// Nota: `vite-node` viene del vitest de la RAÍZ, no de web/. Si desapareciera, este script deja de
// correr sin afectar al build (tsconfig incluye solo `src`, así que `tsc` ni lo mira).
import { renderToStaticMarkup } from 'react-dom/server';
import { Zap, GitCommitHorizontal } from 'lucide-react';
import { MetricCard } from '@/components/MetricCard';
import { PresencePanel } from '@/components/PresencePanel';
import {
  Collapse, ErrorCard, IconSwap, MatrixLoader, ProgressBar, SegmentMeter, SkillChip,
  SkillMeter, SuccessCheck, ThinkingText, LineDelta, AvatarStack, RefreshButton,
} from '@/components/bits';
import {
  AreaTrend, Columns, Donut, RadialGauge, Sparkline, StackedBar,
  HeatCell, HeatLegend, ChartTooltip,
} from '@/components/charts';
import { SizeDistBar, SizeDistPanel } from '@/components/CommitSizeDist';
// La app entera va envuelta en TooltipProvider (main.tsx:46); aquí hay que reponerlo o los
// componentes que usan Tooltip fallan por el contexto, no por un defecto propio.
import { TooltipProvider } from '@/components/ui/tooltip';

const metric = { value: 10, compare: 8, changePct: 25, direction: 'up' as const };
const cols = [
  { label: 'Marvin', value: 60 },
  { label: 'Hyperflow', value: 40 },
  { label: 'Proppie', value: 28 },
  { label: 'Sin actividad', value: 0 },
];
const people = [
  { label: 'Manuel', value: 12, avatarUrl: null, sub: '12 tickets' },
  { label: 'Sebas', value: 7, avatarUrl: null, sub: '7 tickets' },
];
const pie = [
  { label: 'Cliente', value: 60, color: 'hsl(var(--chart-1))' },
  { label: 'Interno', value: 40, color: 'hsl(var(--chart-4))' },
];
const dist = [
  { key: 'micro' as const, commits: 10, lines: 120 },
  { key: 'chico' as const, commits: 5, lines: 800 },
  { key: 'mediano' as const, commits: 2, lines: 1500 },
  { key: 'grande' as const, commits: 1, lines: 9000 },
];
const trend = [
  { date: '2026-06-18', commits: 3, ticketsResolved: 1 },
  { date: '2026-06-19', commits: 5, ticketsResolved: 2 },
];

const cases: [string, () => JSX.Element][] = [
  // Columnas: el componente nuevo, en todas sus formas y con los casos degenerados.
  ['Columns básico', () => <Columns data={cols} />],
  ['Columns topN + resto', () => <Columns data={cols} topN={2} />],
  ['Columns ordinal (sort=false)', () => <Columns data={cols} sort={false} hideZeros={false} />],
  ['Columns con avatares y onPick', () => <Columns data={people} onPick={() => {}} />],
  ['Columns todo en cero', () => <Columns data={[{ label: 'a', value: 0 }]} />],
  ['Columns un solo valor', () => <Columns data={[{ label: 'solo', value: 1 }]} />],
  ['Columns vacío', () => <Columns data={[]} />],
  // Modo fill: la cadena de alturas que exige (Card flex → CardContent flex-1 → gráfica).
  ['Columns fill', () => (
    <div className="flex h-96 flex-col"><div className="flex flex-1 flex-col"><Columns data={cols} fill topN={2} /></div></div>
  )],
  ['AreaTrend fill', () => (
    <div className="flex h-96 flex-col"><div className="flex flex-1 flex-col">
      <AreaTrend fill data={trend} series={[{ key: 'commits', name: 'Commits', color: 'hsl(var(--chart-1))' }]} />
    </div></div>
  )],

  ['MetricCard stack + componente', () => <MetricCard label="Commits" value={12} icon={GitCommitHorizontal} metric={metric} trend={trend} trendKey="commits" />],
  ['MetricCard row + componente', () => <MetricCard layout="row" label="Racha" value="3 días" icon={Zap} />],
  ['MetricCard center + inset', () => <MetricCard layout="center" surface="inset" label="Puntos" value={9} icon={Zap} accent />],
  ['MetricCard inline', () => <MetricCard layout="inline" surface="plain" label="servicios" value={4} />],
  ['MetricCard row + elemento', () => <MetricCard layout="row" label="Líneas" value={2400} icon={<Zap className="size-4" />} />],

  ['AreaTrend', () => <AreaTrend data={trend} series={[{ key: 'commits', name: 'Commits', color: 'hsl(var(--chart-1))' }]} />],
  ['Sparkline', () => <Sparkline data={trend} />],
  ['Donut', () => <Donut data={pie} centerLabel="commits" />],
  ['Donut leyenda al lado', () => <Donut data={pie} centerLabel="commits" layout="side" />],
  ['Donut vacío', () => <Donut data={[{ label: 'a', value: 0, color: 'red' }]} />],
  ['RadialGauge sm', () => <RadialGauge pct={100} height={52} size="sm" label="sanos" />],
  ['RadialGauge md', () => <RadialGauge pct={38} />],
  ['StackedBar', () => <StackedBar data={pie} />],
  ['HeatCell', () => <HeatCell level={3} levels={4} />],
  ['HeatCell ramp', () => <HeatCell level={2} levels={4} ramp={['bg-muted', 'a', 'b', 'c', 'd']} />],
  ['HeatLegend', () => <HeatLegend levels={4} />],
  ['ChartTooltip', () => <ChartTooltip active label="2026-06-18" total={10} payload={[{ name: 'Commits', value: 4, color: 'red' }]} />],

  ['SizeDistBar', () => <SizeDistBar dist={dist} />],
  ['SizeDistPanel', () => <SizeDistPanel dist={dist} />],

  ['IconSwap', () => <IconSwap state="b" icons={{ a: <Zap />, b: <GitCommitHorizontal /> }} />],
  ['SuccessCheck', () => <SuccessCheck />],
  ['RefreshButton', () => <RefreshButton onClick={() => {}} busy />],
  ['Collapse', () => <Collapse open><span>x</span></Collapse>],
  ['ThinkingText', () => <ThinkingText live>sincronizando</ThinkingText>],
  ['MatrixLoader', () => <MatrixLoader />],
  ['ProgressBar', () => <ProgressBar pct={40} tone="success" />],
  ['ProgressBar indeterminado', () => <ProgressBar pct={null} />],
  ['SegmentMeter', () => <SegmentMeter value={3} max={5} />],
  ['SkillChip', () => <SkillChip tag="React" level={4} />],
  ['SkillMeter', () => <SkillMeter tag="SQL" level={2} />],
  ['LineDelta', () => <LineDelta additions={24571} deletions={310} />],
  ['AvatarStack', () => <AvatarStack people={[{ name: 'Ana Pérez', avatarUrl: null }, { name: 'Beto', avatarUrl: null }, { name: 'Cé', avatarUrl: null }, { name: 'Dé', avatarUrl: null }]} />],
  ['ErrorCard', () => <ErrorCard message="algo falló" />],
  // PresencePanel devuelve null sin contexto de presencia; se incluye para probar que no revienta.
  ['PresencePanel sin datos', () => <PresencePanel devId="x" />],
  ['PresencePanel inline sin datos', () => <PresencePanel devId="x" variant="inline" />],
];

let failed = 0;
for (const [name, node] of cases) {
  try {
    const html = renderToStaticMarkup(<TooltipProvider>{node()}</TooltipProvider>);
    if (html.includes('$$typeof')) throw new Error('un componente terminó serializado como texto');
    if (html.includes('NaN')) throw new Error('salió un NaN al markup');
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FALLA ${name}\n        ${(e as Error).message}`);
  }
}
console.log(failed ? `\n${failed} de ${cases.length} fallaron` : `\n${cases.length} piezas renderizan`);
process.exit(failed ? 1 : 0);
