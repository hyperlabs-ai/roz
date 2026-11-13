// Diagrama de cómo viaja un secreto: la PC del dev cifra, zeus guarda solo texto cifrado y la PC de
// otro dev descifra con su propia llave. Cada nodo lleva encima las cifras vivas de lo que le toca.
// Las tres variables del dibujo son ilustración del mecanismo: aquí nunca se pinta un nombre real.
import type { ReactNode } from 'react';
import { ChevronRight, EyeOff, KeyRound, Laptop, Lock, LockOpen, Server, ShieldAlert } from 'lucide-react';
import { RefreshButton } from '@/components/bits';
import { cn } from '@/lib/utils';
import type { ZeusMe, ZeusVaultOverview } from '@/lib/zeus';

const SAMPLE = ['API_KEY', 'DATABASE_URL', 'WEBHOOK_SECRET'];
const DOTS = 44;

/** Opacidad estable por (fila, punto): el "ruido" del texto cifrado no cambia entre renders. */
function noise(row: number, i: number): number {
  const x = Math.sin((row + 1) * 97.13 + (i + 1) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function PlainRows() {
  return (
    <div className="grid gap-1.5">
      {SAMPLE.map((name) => (
        <div key={name} className="flex min-w-0 items-center gap-1 font-mono text-[11px] leading-none">
          <span className="truncate text-muted-foreground">{name}</span>
          <span className="text-faint">=</span>
          <span className="rounded-[3px] bg-green-soft px-1 py-0.5 text-green">valor</span>
        </div>
      ))}
    </div>
  );
}

function CipherRows() {
  return (
    <div className="grid gap-1.5">
      {SAMPLE.map((name, row) => (
        <div key={name} className="flex min-w-0 items-center gap-2 font-mono text-[11px] leading-none">
          <span className="w-[104px] shrink-0 truncate text-muted-foreground">{name}</span>
          <span aria-hidden className="flex h-[15px] min-w-0 flex-1 items-center gap-[3px] overflow-hidden">
            {Array.from({ length: DOTS }, (_, i) => {
              const v = noise(row, i);
              return <span key={i} className={cn('size-[5px] shrink-0 rounded-[1px]', v > 0.82 ? 'bg-orange' : 'bg-foreground')} style={{ opacity: v > 0.82 ? 0.9 : 0.12 + v * 0.5 }} />;
            })}
          </span>
        </div>
      ))}
    </div>
  );
}

function Stat({ value, label, warn }: { value: ReactNode; label: string; warn?: boolean }) {
  return (
    <div className="grid gap-1 bg-card px-3 py-2.5">
      <span className={cn('text-[24px] font-semibold leading-none tracking-[-0.04em] tabular-nums', warn && 'text-yellow')}>{value}</span>
      <span className="label-caps truncate text-[9.5px]">{label}</span>
    </div>
  );
}

function Node({
  icon,
  title,
  role,
  note,
  core = false,
  stats,
  children,
  className,
}: {
  icon: ReactNode;
  title: string;
  role: string;
  note: ReactNode;
  core?: boolean;
  stats: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card', core && 'vault-core border-transparent', className)}>
      <div className="flex items-center gap-2.5 px-3 pb-2.5 pt-3">
        <span className={cn('grid size-8 shrink-0 place-items-center rounded-md [&_svg]:size-4', core ? 'bg-orange text-white' : 'bg-panel text-foreground')}>{icon}</span>
        <span className="grid min-w-0">
          <span className="truncate text-[13.5px] font-semibold leading-tight tracking-[-0.01em]">{title}</span>
          <span className={cn('label-caps truncate text-[10px]', core && 'text-orange')}>{role}</span>
        </span>
      </div>
      <div className="mx-3 flex-1 rounded-md border border-dashed border-border bg-background/60 p-2.5">{children}</div>
      <div className="flex items-center gap-1.5 px-3 py-2.5 text-[11.5px] leading-tight text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">{note}</div>
      <div className="grid auto-cols-fr grid-flow-col gap-px border-t bg-border">{stats}</div>
    </div>
  );
}

function Wire({ label, command }: { label: string; command: string }) {
  return (
    <div className="flex min-w-[150px] flex-1 flex-col items-center justify-center gap-2.5">
      <span className="label-caps inline-flex items-center gap-1 whitespace-nowrap rounded-full border bg-card px-2 py-1 text-[9.5px] text-foreground/85">
        <Lock className="size-3 text-orange" />
        {label}
      </span>
      <div className="flex w-full items-center">
        <span className="vault-wire flex-1" />
        <ChevronRight className="-ml-1.5 size-4 shrink-0 text-foreground/60" />
      </div>
      <code className="whitespace-nowrap font-mono text-[10.5px] text-faint">{command}</code>
    </div>
  );
}

export function VaultDiagram({
  data,
  me,
  refetching,
  onRefresh,
  className,
}: {
  data: ZeusVaultOverview | null;
  me: ZeusMe | null;
  refetching: boolean;
  onRefresh: () => void;
  className?: string;
}) {
  const n = (v: number): ReactNode => (data ? v : '–');
  const activeKeys = (data?.keys ?? []).filter((k) => !k.revokedAt);
  const mine = activeKeys.filter((k) => k.devId === me?.devId).length;
  const envs = data?.envs ?? [];
  const variables = envs.reduce((s, e) => s + e.secrets.length, 0);
  const rotation = envs.filter((e) => e.needsRotation).length;
  const grants = envs.reduce((s, e) => s + e.grants.length, 0);
  const people = new Set(envs.flatMap((e) => e.grants.map((g) => g.devId))).size;

  return (
    <section className={cn('zeus-stage relative overflow-hidden rounded-lg border bg-background text-foreground', className)} aria-label="Cómo viaja un secreto">
      <div className="flex items-center justify-between gap-3 px-4 pt-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h2 className="label-caps text-foreground/85">Cómo viaja un secreto</h2>
          <span className="text-[12px] text-muted-foreground">Se cifra en tu máquina. zeus guarda algo que no puede leer.</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {rotation > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-soft px-2 py-0.5 text-[11px] font-medium text-yellow-ink">
              <ShieldAlert className="size-3" /> {rotation} por rotar
            </span>
          )}
          <RefreshButton busy={refetching} onClick={onRefresh} />
        </div>
      </div>

      <div className="scroll-none overflow-x-auto">
        <div className="flex min-w-[1100px] items-stretch gap-3 px-4 pb-4 pt-3">
          <Node
            className="flex-1 basis-[236px] lg:max-w-[330px]"
            icon={<Laptop />}
            title="Tu PC"
            role="Cifra"
            note={<><KeyRound /> Tu llave privada nunca sale de aquí</>}
            stats={
              <>
                <Stat value={n(activeKeys.length)} label="Llaves vigentes" />
                <Stat value={n(mine)} label="Tuyas" />
              </>
            }
          >
            <PlainRows />
          </Node>

          <Wire label="Texto cifrado" command="zeus env push" />

          <Node
            core
            className="flex-[1.25] basis-[296px] lg:max-w-[420px]"
            icon={<Server />}
            title="zeus"
            role="Solo guarda cifrado"
            note={<><EyeOff className="text-orange" /> No puede leerlo: ni el servidor ni esta página</>}
            stats={
              <>
                <Stat value={n(envs.length)} label="Entornos" />
                <Stat value={n(variables)} label="Variables" />
                <Stat value={n(rotation)} label="Por rotar" warn={rotation > 0} />
              </>
            }
          >
            <CipherRows />
          </Node>

          <Wire label="Llave envuelta para él" command="zeus env pull" />

          <Node
            className="flex-1 basis-[236px] lg:max-w-[330px]"
            icon={<Laptop />}
            title="PC de otro dev"
            role="Descifra"
            note={<><LockOpen /> Lo abre con su propia llave privada</>}
            stats={
              <>
                <Stat value={n(grants)} label="Accesos dados" />
                <Stat value={n(people)} label="Personas" />
              </>
            }
          >
            <PlainRows />
          </Node>
        </div>
      </div>
    </section>
  );
}
