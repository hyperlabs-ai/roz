// /conectar: aprobar el equipo que corrió `zeus setup` (login por navegador, src/zeus/device-auth.ts).
// La terminal imprime un código y abre esta página con ?code=…; aquí, con tu sesión, compruebas que
// el código y el nombre del equipo son los de TU terminal y apruebas. Al aprobar, zeus le entrega a
// ese CLI (una sola vez) un token a tu nombre. Página sobria y sin el chrome del dashboard: es un
// paso de seguridad, no una sección.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Laptop, Loader2, ShieldAlert, X } from 'lucide-react';
import { ErrorCard, SuccessCheck } from '@/components/bits';
import { Eyebrow } from '@/components/brand';
import { RozLogo } from '@/components/RozLogo';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { R } from '@/lib/routes';
import { useAction } from '@/lib/useAction';
import { useApi } from '@/lib/useApi';
import { usePoll } from '@/lib/usePoll';
import { cn } from '@/lib/utils';
import { zeusApi, type ZeusDeviceRequest } from '@/lib/zeus';

const PLATFORM: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/** "bcdf2345" → "BCDF-2345" mientras se escribe. */
function formatCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

/** Segundos que faltan, al segundo. */
function useRemaining(iso: string | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [iso]);
  return iso ? Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000)) : null;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-5">
      <div className="animate-scale-in w-full max-w-md">
        <div className="mb-5 flex items-center gap-2.5">
          <RozLogo className="size-9 rounded-lg ring-1 ring-border" />
          <div className="leading-tight">
            <div className="title-tight text-lg">zeus</div>
            <div className="label-caps text-faint">Conectar un equipo</div>
          </div>
        </div>
        <Card>{children}</Card>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          ¿Buscas tus tokens?{' '}
          <Link to={R.mcp} className="font-medium text-foreground underline-offset-4 hover:underline">zeus → MCP</Link>
        </p>
      </div>
    </div>
  );
}

function Header({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="border-b px-7 pb-5 pt-6">
      <Eyebrow>zeus setup</Eyebrow>
      <h1 className="title-tight mt-3 text-2xl">{title}</h1>
      {children && <p className="mt-1 text-sm text-muted-foreground">{children}</p>}
    </div>
  );
}

/** Sin código en la URL (o uno equivocado): se escribe el de la terminal. */
function CodeForm({ initial, error }: { initial?: string; error?: string | null }) {
  const [, setParams] = useSearchParams();
  const [code, setCode] = useState(initial ?? '');
  const ok = code.replace('-', '').length === 8;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ok) setParams({ code });
  };
  return (
    <>
      <Header title="Escribe el código">Es el que imprimió <code className="font-mono text-[13px]">zeus setup</code> en tu terminal.</Header>
      <form onSubmit={submit} className="grid gap-4 p-7 pt-5">
        <div className="grid gap-1.5">
          <Label htmlFor="device-code">Código</Label>
          <Input
            id="device-code"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(formatCode(e.target.value))}
            placeholder="BCDF-2345"
            className="font-mono text-lg tracking-[0.2em]"
          />
        </div>
        {error && <ErrorCard message={error} />}
        <Button type="submit" disabled={!ok}>Continuar</Button>
      </form>
    </>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-3 py-1.5">
      <dt className="label-caps text-faint">{label}</dt>
      <dd className="min-w-0 truncate text-[13px]">{children}</dd>
    </div>
  );
}

function Outcome({ tone, icon, title, children }: { tone: 'ok' | 'muted'; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-3 px-7 py-9 text-center">
      <span className={cn('grid size-11 place-items-center rounded-full', tone === 'ok' ? 'bg-green-soft text-green' : 'bg-panel text-muted-foreground')}>{icon}</span>
      <h1 className="title-tight text-xl">{title}</h1>
      <p className="max-w-xs text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function Request({ req, onChange }: { req: ZeusDeviceRequest; onChange: (r: ZeusDeviceRequest) => void }) {
  const act = useAction();
  const remaining = useRemaining(req.status === 'pending' ? req.expiresAt : undefined);
  const expired = req.status === 'expired' || (req.status === 'pending' && remaining === 0);
  const busy = act.busy('approve') || act.busy('deny');

  if (expired) {
    return (
      <Outcome tone="muted" icon={<X className="size-5" />} title="Esta solicitud venció">
        Duran 10 minutos. Corre <code className="font-mono text-[12.5px] text-foreground">zeus setup</code> otra vez y aprueba el código nuevo.
      </Outcome>
    );
  }
  if (req.status === 'denied') {
    return (
      <Outcome tone="muted" icon={<X className="size-5" />} title="Rechazada">
        No se entregó ningún token a {req.clientName}. Si fue un error, corre <code className="font-mono text-[12.5px] text-foreground">zeus setup</code> otra vez.
      </Outcome>
    );
  }
  if (req.status === 'approved' || req.status === 'delivered') {
    return (
      <Outcome tone="ok" icon={<SuccessCheck hero className="size-5" />} title={`${req.clientName} quedó conectado`}>
        {req.status === 'delivered'
          ? 'La terminal ya recibió su token y sigue sola con la llave y Claude Code. Puedes cerrar esta pestaña.'
          : 'Vuelve a la terminal: en unos segundos recibe su token y sigue sola con la llave y Claude Code.'}
      </Outcome>
    );
  }

  const mm = remaining != null ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : '–';
  return (
    <>
      <Header title="¿Conectar este equipo?">Al aprobar, ese equipo queda conectado a zeus con tu cuenta: todo lo que haga queda a tu nombre.</Header>
      <div className="grid gap-5 p-7 pt-5">
        <div className="grid justify-items-center gap-1.5 rounded-lg bg-panel px-4 py-4">
          <span className="label-caps text-faint">Código</span>
          <span className="font-mono text-[28px] font-semibold tracking-[0.18em]">{req.userCode}</span>
          <span className="text-[12px] text-muted-foreground">Compáralo con el de tu terminal · vence en <span className="tabular-nums">{mm}</span></span>
        </div>

        <dl className="divide-y divide-dashed">
          <Detail label="Equipo">
            <span className="inline-flex items-center gap-1.5 font-medium"><Laptop className="size-3.5 text-muted-foreground" />{req.clientName}</span>
          </Detail>
          {req.clientPlatform && <Detail label="Sistema">{PLATFORM[req.clientPlatform] ?? req.clientPlatform}{req.clientVersion ? ` · CLI ${req.clientVersion}` : ''}</Detail>}
          {req.clientIp && <Detail label="Desde"><span className="font-mono text-[12px]">{req.clientIp}</span></Detail>}
        </dl>

        <p className="flex items-start gap-2 rounded-md bg-yellow-soft px-3 py-2 text-xs text-yellow-ink">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          Aprueba solo si TÚ corriste <code className="font-mono">zeus setup</code> hace un momento y el código coincide. Si alguien te mandó este enlace, recházalo.
        </p>

        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void act.run('deny', () => zeusApi.denyDevice(req.userCode), { success: false, error: 'No se pudo rechazar', onDone: onChange })}
          >
            {act.busy('deny') && <Loader2 className="animate-spin" />}
            Rechazar
          </Button>
          <Button
            disabled={busy}
            onClick={() => void act.run('approve', () => zeusApi.approveDevice(req.userCode), { success: false, error: 'No se pudo aprobar', onDone: onChange })}
          >
            {act.busy('approve') && <Loader2 className="animate-spin" />}
            Aprobar y conectar
          </Button>
        </div>
      </div>
    </>
  );
}

export default function Connect() {
  const [params] = useSearchParams();
  const code = formatCode(params.get('code') ?? '');
  const valid = code.replace('-', '').length === 8;
  const res = useApi<ZeusDeviceRequest | null>(() => (valid ? zeusApi.deviceRequest(code) : Promise.resolve(null)), [code]);
  // Lo que respondió aprobar o rechazar, hasta que la lectura del servidor lo alcance.
  const [local, setLocal] = useState<ZeusDeviceRequest | null>(null);
  useEffect(() => setLocal(null), [code]);
  const req = res.data && res.data.status !== 'pending' ? res.data : (local ?? res.data);
  // Aprobada: se sigue mirando hasta que la terminal cobre su token ("entregado").
  usePoll(res.reload, req?.status === 'approved' ? 3000 : null, { onFocus: 'always' });

  if (!valid) return <Shell><CodeForm initial={code} /></Shell>;
  if (res.error && !req) return <Shell><CodeForm initial={code} error={res.error} /></Shell>;
  if (!req) {
    return (
      <Shell>
        <div className="grid place-items-center px-7 py-14 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      </Shell>
    );
  }
  return <Shell><Request req={req} onChange={setLocal} /></Shell>;
}
