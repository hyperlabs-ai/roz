import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { IntegrationIcon } from '@/components/brand';
import { ProjectIcon } from '@/components/avatars';
import type { Mirror } from '@/lib/useMirror';
import { apiSend, type InfraProject, type ServiceProvider } from '@/lib/api';
import { cn } from '@/lib/utils';
import { PROVIDER, PROVIDER_ORDER, serviceTitle, type ServiceRow } from './infra-ui';

const REF_HINT: Record<ServiceProvider, string> = {
  vercel: 'Project ID de Vercel (prj_…)',
  railway: 'Service ID de Railway (UUID del servicio, no del proyecto)',
  supabase: 'Project ref de Supabase (el ref corto, no la URL)',
};

// Team de Vercel por defecto (editable). La mayoría de los proyectos viven bajo este team.
const VERCEL_DEFAULT_TEAM = 'team_0lS30dpDZz11G10eqcdLJ9VZ';
const defaultExtra = (p: ServiceProvider) => (p === 'vercel' ? VERCEL_DEFAULT_TEAM : '');

/** Vincular un servicio externo a un proyecto, o editar uno ya vinculado. */
export function ServiceDialog({
  projectId,
  projects,
  service,
  open,
  onOpenChange,
  services,
}: {
  /** Proyecto fijo (bloque de un proyecto, o edición). */
  projectId?: string;
  /** Sin proyecto fijo, se elige aquí dentro. */
  projects?: InfraProject[];
  service?: ServiceRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  services: Mirror<ServiceRow>;
}) {
  const editing = !!service;
  const [pid, setPid] = useState(projectId ?? '');
  const [provider, setProvider] = useState<ServiceProvider>('vercel');
  const [externalRef, setExternalRef] = useState('');
  const [label, setLabel] = useState('');
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset al ABRIR, con dep en el ID del servicio y nunca en el objeto: la fila se renueva en cada
  // revalidación de /infra y depender de ella reescribía el formulario mientras escribías.
  useEffect(() => {
    if (!open) return;
    const p = service?.provider ?? 'vercel';
    setPid(projectId ?? service?.projectId ?? '');
    setProvider(p);
    setExternalRef(service?.externalRef ?? '');
    setLabel(service?.label ?? '');
    if (service) {
      const cfg = service.config ?? {};
      setExtra(((cfg.teamId as string) || (cfg.environmentId as string) || '') as string);
    } else {
      setExtra(defaultExtra(p));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, service?.id, projectId]);

  function changeProvider(v: ServiceProvider) {
    setProvider(v);
    setExtra(defaultExtra(v));
  }

  async function save() {
    const ref = externalRef.trim();
    if (!ref || !pid) return;
    setBusy(true);
    const config: Record<string, string> = {};
    if (extra.trim()) {
      if (provider === 'vercel') config.teamId = extra.trim();
      else if (provider === 'railway') config.environmentId = extra.trim();
    }
    const body = { provider, externalRef: ref, label: label.trim() || null, config };

    if (editing) {
      await services.patch(service!, { provider, externalRef: ref, label: body.label, config }, async () => {
        await apiSend('PATCH', `/projects/${pid}/services/${service!.id}`, body);
      }, {
        success: { title: 'Servicio actualizado', description: `${PROVIDER[provider].name} · ${ref}` },
        error: 'No se pudo guardar',
      });
    } else {
      const draft: ServiceRow = {
        id: `nuevo:${pid}:${ref}`,
        projectId: pid,
        provider,
        externalRef: ref,
        label: body.label,
        config,
        // `ok: null` = "aún sin sondear": la fila nace honesta.
        capturedAt: null,
        ok: null,
        status: 'unknown',
        providerStatus: null,
        active: null,
        deploy: null,
        metrics: null,
        details: null,
        error: null,
      };
      await services.create(draft, async () => {
        const r = await apiSend<{ service: { id: string } }>('POST', `/projects/${pid}/services`, body);
        return { ...draft, id: r.service.id };
      }, {
        success: { title: 'Servicio vinculado', description: 'Su estado llega en el próximo sondeo (hasta 15 min).' },
        error: 'No se pudo vincular',
      });
    }
    setBusy(false);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader eyebrow={editing ? 'Editar servicio' : 'Vincular servicio'}>
          <DialogTitle>{editing ? serviceTitle(service!) : 'Nuevo servicio'}</DialogTitle>
          <DialogDescription>Se sondea cada 15 min; el estado aparece en la lista al siguiente ciclo.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!projectId && !!projects?.length && (
            <div className="space-y-1.5">
              <Label htmlFor="svc-project">Proyecto</Label>
              <Select value={pid} onValueChange={setPid}>
                <SelectTrigger id="svc-project"><SelectValue placeholder="Elige un proyecto…" /></SelectTrigger>
                <SelectContent>
                  {projects.map((pr) => (
                    <SelectItem key={pr.projectId} value={pr.projectId}>
                      <span className="flex items-center gap-2"><ProjectIcon id={pr.projectId} size="xs" className="size-4" />{pr.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Proveedor: tres opciones fijas con su ícono oficial, en un segmentado. */}
          <div className="space-y-1.5">
            <Label>Proveedor</Label>
            <div role="radiogroup" className="grid grid-cols-3 gap-1 rounded-md bg-panel p-[3px]">
              {PROVIDER_ORDER.map((pr) => (
                <button
                  key={pr}
                  type="button"
                  role="radio"
                  aria-checked={provider === pr}
                  onClick={() => changeProvider(pr)}
                  className={cn(
                    'flex h-8 items-center justify-center gap-2 rounded-sm text-[13px] transition-colors',
                    provider === pr ? 'bg-card font-semibold shadow-sm' : 'font-medium text-muted-foreground hover:text-foreground',
                  )}
                >
                  <IntegrationIcon name={PROVIDER[pr].icon} size="sm" />
                  {PROVIDER[pr].name}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="svc-ref">Referencia</Label>
            <Input id="svc-ref" value={externalRef} onChange={(e) => setExternalRef(e.target.value)} placeholder={REF_HINT[provider]} className="font-mono" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="svc-label">Nombre <span className="font-normal text-muted-foreground">(opcional)</span></Label>
            <Input id="svc-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ej. frontend prod" />
          </div>
          {provider !== 'supabase' && (
            <div className="space-y-1.5">
              <Label htmlFor="svc-extra">
                {provider === 'vercel' ? 'Team ID' : 'Environment ID'} <span className="font-normal text-muted-foreground">(opcional)</span>
              </Label>
              <Input id="svc-extra" value={extra} onChange={(e) => setExtra(e.target.value)} className="font-mono" />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
          <Button onClick={save} disabled={busy || !externalRef.trim() || !pid}>
            {busy ? <><Loader2 className="animate-spin" /> Guardando…</> : editing ? 'Guardar' : 'Vincular'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Confirmación para desvincular (corta el histórico de disponibilidad). */
export function UnlinkDialog({
  service,
  open,
  onOpenChange,
  services,
  onDone,
}: {
  service: ServiceRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  services: Mirror<ServiceRow>;
  onDone?: () => void;
}) {
  const busy = services.isBusy(service.id);
  const title = serviceTitle(service);
  const unlink = () =>
    services.remove(service, () => apiSend('DELETE', `/projects/${service.projectId}/services/${service.id}`), {
      success: { title: 'Servicio desvinculado', description: `${PROVIDER[service.provider].name} · ${title}` },
      error: 'No se pudo desvincular',
    });
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>¿Desvincular {title}?</AlertDialogTitle>
          <AlertDialogDescription>
            Deja de sondearse y su historial de disponibilidad se borra. Puedes volver a vincularlo
            con la misma referencia.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
          {/* preventDefault: Radix cerraría el diálogo antes de que salga el DELETE. */}
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              void unlink().finally(() => {
                onOpenChange(false);
                onDone?.();
              });
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? <><Loader2 className="animate-spin" /> Desvinculando…</> : 'Desvincular'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
