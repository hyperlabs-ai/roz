// /autorizar: aprobar un conector de claude.ai (o de otro cliente MCP) por OAuth (src/zeus/oauth.ts).
// Claude manda aquí a la persona con ?client_id&redirect_uri&code_challenge&state…; con su sesión ve
// qué conector pide entrar y a qué dominio vuelve, y aprueba o rechaza. Al aprobar, el navegador vuelve
// al conector con un código de un solo uso que el conector cambia por un token a nombre de quien aprobó.
// Mismo trato que /conectar: página sobria, sin el chrome del dashboard.
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BadgeCheck, Loader2, ShieldAlert, Unplug } from 'lucide-react';
import { ErrorCard } from '@/components/bits';
import { Eyebrow } from '@/components/brand';
import { RozLogo } from '@/components/RozLogo';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { R } from '@/lib/routes';
import { useAction } from '@/lib/useAction';
import { useApi } from '@/lib/useApi';
import { zeusApi, type ZeusOAuthRequest } from '@/lib/zeus';

const KEYS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-5">
      <div className="animate-scale-in w-full max-w-md">
        <div className="mb-5 flex items-center gap-2.5">
          <RozLogo className="size-9 rounded-lg ring-1 ring-border" />
          <div className="leading-tight">
            <div className="title-tight text-lg">zeus</div>
            <div className="label-caps text-faint">Conectar un conector</div>
          </div>
        </div>
        <Card>{children}</Card>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Tus conexiones y tokens están en{' '}
          <Link to={R.mcp} className="font-medium text-foreground underline-offset-4 hover:underline">zeus → MCP</Link>
        </p>
      </div>
    </div>
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

function Request({ req, params }: { req: ZeusOAuthRequest; params: Record<string, string> }) {
  const act = useAction();
  const [leaving, setLeaving] = useState<'approve' | 'deny' | null>(null);
  const busy = act.busy('approve') || act.busy('deny') || leaving != null;
  const decide = (decision: 'approve' | 'deny') =>
    void act.run(decision, () => zeusApi.decideOAuth(params, decision), {
      success: false,
      error: decision === 'approve' ? 'No se pudo aprobar' : 'No se pudo rechazar',
      onDone: (r) => {
        setLeaving(decision);
        window.location.assign(r.redirectTo);
      },
    });

  if (leaving) {
    return (
      <div className="grid justify-items-center gap-3 px-7 py-12 text-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Volviendo a {req.clientName}…</p>
      </div>
    );
  }

  return (
    <>
      <div className="border-b px-7 pb-5 pt-6">
        <Eyebrow>Conector MCP</Eyebrow>
        <h1 className="title-tight mt-3 text-2xl">¿Conectar {req.clientName} a zeus?</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Podrá usar zeus con tu cuenta: leer el contexto del equipo, tu bandeja y tus tickets, y mandar mensajes. Todo lo que haga queda a tu nombre.
        </p>
      </div>
      <div className="grid gap-5 p-7 pt-5">
        <dl className="divide-y divide-dashed">
          <Detail label="Conector">
            <span className="font-medium">{req.clientName}</span>
          </Detail>
          <Detail label="Vuelve a">
            <span className="inline-flex items-center gap-1.5 font-mono text-[12px]">
              {req.redirectHost}
              {req.verified && <BadgeCheck className="size-3.5 text-green" aria-label="Claude" />}
            </span>
          </Detail>
          {req.reconnect && <Detail label="Antes">Ya estaba conectado: se reemplaza su acceso anterior.</Detail>}
        </dl>

        {!req.verified && (
          <p className="flex items-start gap-2 rounded-md bg-yellow-soft px-3 py-2 text-xs text-yellow-ink">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            Este conector no vuelve a Claude (claude.ai). Apruébalo solo si TÚ lo estás agregando ahora y reconoces <span className="font-mono">{req.redirectHost}</span>.
          </p>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => decide('deny')}>
            {act.busy('deny') && <Loader2 className="animate-spin" />}
            Rechazar
          </Button>
          <Button disabled={busy} onClick={() => decide('approve')}>
            {act.busy('approve') && <Loader2 className="animate-spin" />}
            Aprobar y conectar
          </Button>
        </div>
      </div>
    </>
  );
}

export default function Authorize() {
  const [search] = useSearchParams();
  const params = useMemo(() => {
    const out: Record<string, string> = {};
    for (const k of KEYS) {
      const v = search.get(k);
      if (v != null) out[k] = v;
    }
    return out;
  }, [search]);
  const key = JSON.stringify(params);
  const res = useApi<ZeusOAuthRequest>(() => zeusApi.oauthRequest(params), [key]);

  if (res.error) {
    return (
      <Shell>
        <div className="grid gap-4 px-7 py-7">
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-full bg-panel text-muted-foreground"><Unplug className="size-4" /></span>
            <h1 className="title-tight text-lg">No se puede conectar</h1>
          </div>
          <ErrorCard message={res.error} />
          <p className="text-xs text-muted-foreground">Vuelve a Claude y agrega el conector otra vez.</p>
        </div>
      </Shell>
    );
  }
  if (!res.data) {
    return (
      <Shell>
        <div className="grid place-items-center px-7 py-14 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      </Shell>
    );
  }
  return <Shell><Request req={res.data} params={params} /></Shell>;
}
