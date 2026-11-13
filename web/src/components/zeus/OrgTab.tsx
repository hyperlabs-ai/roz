// Pestaña "Organización": dos superficies lado a lado. A la izquierda el organigrama dibujado como
// árbol por `reportsTo` (es lo que zeus usa para enrutar una solicitud al jefe directo) y, en el mismo
// panel, la bandeja de quienes todavía no tienen jefe asignado. A la derecha, la matriz de quién está
// en qué proyecto. Si eres admin de zeus, desde aquí se corrige.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Crown, Maximize2, ShieldAlert, Loader2, UserPlus, ZoomIn, ZoomOut } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ErrorCard, RefreshButton } from '@/components/bits';
import { PersonAvatar } from '@/components/avatars';
import { BalancedGrid } from '@/components/grid';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { invalidate } from '@/lib/store';
import { useAction } from '@/lib/useAction';
import { useIsMobile } from '@/lib/useIsMobile';
import { cn } from '@/lib/utils';
import { zeusApi, type ZeusMe, type ZeusOrgMember } from '@/lib/zeus';
import { ME_KEY, ORG_KEY, useZeusOrg } from './hooks';
import { MemberDialog } from './OrgDialogs';
import { OrgMatrix, roleLabel } from './OrgMatrix';
import { buildOrgTree, type TreeNode } from './org-tree';
import { Figure, RailTitle } from './zeus-ui';
import './zeus.css';

export { buildOrgTree };

const EDIT_HINT = 'Cambiar a quién reporta o si administra zeus';

interface NodeProps {
  member: ZeusOrgMember;
  isMe: boolean;
  canEdit: boolean;
  onEdit: () => void;
}

/** Nodo del árbol: avatar con su punto en línea, nombre, insignia de admin y rol. */
function PersonNode({ member, isMe, canEdit, onEdit }: NodeProps) {
  const body = (
    <>
      <PersonAvatar name={member.name} login={member.githubLogin} email={member.email} id={member.devId} presence={member.online ? 'on' : 'off'} className="size-10" />
      <span className="flex max-w-full items-center gap-1">
        <span className="truncate text-[13px] font-semibold">{member.name}</span>
        {member.zeusAdmin && <Crown className="size-3 shrink-0 text-orange" aria-label="Admin de zeus" />}
      </span>
      <span className="label-caps max-w-full truncate text-[9.5px]">{roleLabel(member.role)}{!member.active && ' · inactivo'}</span>
    </>
  );
  const cls = cn(
    'grid w-[132px] justify-items-center gap-1.5 rounded-lg border bg-card px-2.5 py-3 text-center',
    !member.active && 'opacity-60',
    isMe && 'border-orange/60',
  );
  return canEdit ? (
    <button type="button" onClick={onEdit} title={EDIT_HINT} aria-label={`Editar a ${member.name}`} className={cn(cls, 'transition-colors hover:border-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Persona en fila: para la bandeja "Sin jefe asignado" y para el árbol con sangría del teléfono. */
function PersonChip({ member, isMe, canEdit, onEdit, assign }: NodeProps & { assign?: boolean }) {
  const body = (
    <>
      <PersonAvatar name={member.name} login={member.githubLogin} email={member.email} id={member.devId} presence={member.online ? 'on' : 'off'} className="size-8" />
      <span className="grid min-w-0 flex-1 gap-px">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate text-[13px] font-semibold">{member.name}</span>
          {member.zeusAdmin && <Crown className="size-3 shrink-0 text-orange" aria-label="Admin de zeus" />}
        </span>
        <span className="label-caps truncate text-[9.5px]">{roleLabel(member.role)}{!member.active && ' · inactivo'}</span>
      </span>
      {canEdit && assign && <UserPlus className="size-3.5 shrink-0 text-faint transition-colors group-hover/chip:text-orange" />}
    </>
  );
  const cls = cn('group/chip flex h-full w-full min-w-0 items-center gap-2.5 rounded-lg border bg-card px-2.5 py-2 text-left', !member.active && 'opacity-60', isMe && 'border-orange/60');
  return canEdit ? (
    <button
      type="button"
      onClick={onEdit}
      title={assign ? 'Asignar a quién reporta' : EDIT_HINT}
      aria-label={assign ? `Asignar jefe a ${member.name}` : `Editar a ${member.name}`}
      className={cn(cls, 'transition-colors hover:border-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
    >
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

interface TreeProps {
  nodes: TreeNode[];
  me: string | null;
  canEdit: boolean;
  onEdit: (m: ZeusOrgMember) => void;
}

function Branch({ node, me, canEdit, onEdit }: Omit<TreeProps, 'nodes'> & { node: TreeNode }) {
  return (
    <li>
      <PersonNode member={node.member} isMe={node.member.devId === me} canEdit={canEdit} onEdit={() => onEdit(node.member)} />
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => <Branch key={c.member.devId} node={c} me={me} canEdit={canEdit} onEdit={onEdit} />)}
        </ul>
      )}
    </li>
  );
}

/** Mismo árbol, en vertical con sangría: en un teléfono el organigrama horizontal no cabe. */
function Indented({ nodes, me, canEdit, onEdit, depth = 0 }: TreeProps & { depth?: number }) {
  return (
    <ul className={cn('grid gap-2', depth > 0 && 'ml-3 border-l pl-3')}>
      {nodes.map((n) => (
        <li key={n.member.devId} className="grid gap-2">
          <PersonChip member={n.member} isMe={n.member.devId === me} canEdit={canEdit} onEdit={() => onEdit(n.member)} />
          {n.children.length > 0 && <Indented nodes={n.children} me={me} canEdit={canEdit} onEdit={onEdit} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 1.4;
const clamp = (v: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));

/** Lienzo del árbol: se encuadra solo al ancho disponible; con zoom propio y scroll si no cabe. */
function TreeCanvas({ nodes, me, canEdit, onEdit }: TreeProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const tree = useRef<HTMLUListElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [fit, setFit] = useState(1);
  /** null = encuadrado automático. */
  const [zoom, setZoom] = useState<number | null>(null);

  useLayoutEffect(() => {
    const w = wrap.current;
    const t = tree.current;
    if (!w || !t) return;
    const measure = () => {
      const tw = t.offsetWidth;
      const th = t.offsetHeight;
      if (!tw || !th) return;
      setSize({ w: tw, h: th });
      setFit(Math.min(1, Math.max(ZOOM_MIN, Math.min((w.clientWidth - 40) / tw, (w.clientHeight - 40) / th))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(w);
    ro.observe(t);
    return () => ro.disconnect();
  }, []);

  const scale = zoom ?? fit;
  return (
    <div className="relative min-h-[260px] flex-1 max-lg:min-h-[420px]">
      <div ref={wrap} className="scroll-thin absolute inset-0 overflow-auto">
        <div className="flex min-h-full w-max min-w-full p-5">
          <div className="m-auto" style={{ width: size.w * scale || undefined, height: size.h * scale || undefined }}>
            <ul ref={tree} className="zeus-org w-max origin-top-left gap-6" style={{ transform: `scale(${scale})` }} aria-label="Organigrama">
              {nodes.map((n) => <Branch key={n.member.devId} node={n} me={me} canEdit={canEdit} onEdit={onEdit} />)}
            </ul>
          </div>
        </div>
      </div>
      <div className="absolute bottom-3 right-3 flex items-center rounded-md border bg-card p-0.5">
        <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" onClick={() => setZoom(clamp(scale - 0.15))} disabled={scale <= ZOOM_MIN} aria-label="Alejar" title="Alejar"><ZoomOut /></Button>
        <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" onClick={() => setZoom(null)} aria-label="Encuadrar" title="Encuadrar"><Maximize2 /></Button>
        <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" onClick={() => setZoom(clamp(scale + 0.15))} disabled={scale >= ZOOM_MAX} aria-label="Acercar" title="Acercar"><ZoomIn /></Button>
      </div>
    </div>
  );
}

function GhostNode() {
  return (
    <div aria-hidden className="grid w-[116px] justify-items-center gap-1.5 rounded-lg border-[1.5px] border-dashed border-foreground/20 px-2.5 py-2.5">
      <span className="size-7 rounded-full bg-panel" />
      <span className="h-1.5 w-14 rounded-full bg-panel" />
      <span className="h-1 w-9 rounded-full bg-panel" />
    </div>
  );
}

/** Sin nadie que reporte a nadie: la silueta del árbol que se va a dibujar y cómo se llena. */
function GhostTree({ canEdit, loading }: { canEdit: boolean; loading?: boolean }) {
  return (
    <div className="grid min-h-[246px] flex-1 place-items-center px-5 py-3">
      <div className="grid justify-items-center gap-3">
        <ul className={cn('zeus-org w-max', loading && 'animate-pulse')}>
          <li>
            <GhostNode />
            <ul>
              <li><GhostNode /></li>
              <li><GhostNode /></li>
              <li><GhostNode /></li>
            </ul>
          </li>
        </ul>
        {!loading && (
          <p className="max-w-[52ch] text-center text-[12.5px] leading-normal text-muted-foreground">
            Todavía nadie reporta a nadie.{' '}
            {canEdit ? 'Asígnale jefe a cada persona desde la bandeja de abajo y el árbol se dibuja aquí.' : 'Cuando un admin de zeus asigne los jefes, el árbol se dibuja aquí.'}
          </p>
        )}
      </div>
    </div>
  );
}

export function OrgTab({ me }: { me: ZeusMe | null }) {
  const org = useZeusOrg();
  const act = useAction();
  const isMobile = useIsMobile();
  const [editing, setEditing] = useState<ZeusOrgMember | null>(null);
  const [claiming, setClaiming] = useState(false);
  // Columnas de la bandeja según el ancho real del panel (no del viewport): un nombre nunca se corta.
  const tray = useRef<HTMLDivElement>(null);
  const [trayCols, setTrayCols] = useState(2);
  useLayoutEffect(() => {
    const el = tray.current;
    if (!el) return;
    const measure = () => setTrayCols(el.clientWidth >= 760 ? 4 : el.clientWidth >= 330 ? 2 : 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Inactivos fuera, salvo que alguien activo todavía les reporte (si no, esa rama quedaría huérfana).
  const members = useMemo(() => {
    const all = org.data?.members ?? [];
    const bosses = new Set(all.filter((m) => m.active && m.reportsTo).map((m) => m.reportsTo!));
    return all.filter((m) => m.active || bosses.has(m.devId));
  }, [org.data]);
  const tree = useMemo(() => buildOrgTree(members), [members]);
  // Al árbol entra quien tiene a alguien a cargo (y su gente); quien no reporta a nadie ni tiene a
  // nadie va a la bandeja "Sin jefe asignado" en vez de alargar una fila sin fin.
  const branches = useMemo(() => tree.filter((n) => n.children.length > 0), [tree]);
  const loose = useMemo(() => tree.filter((n) => n.children.length === 0).map((n) => n.member), [tree]);
  const canEdit = !!me?.zeusAdmin;
  const needsAdmin = org.data?.needsAdmin ?? me?.needsAdmin ?? false;
  const online = members.filter((m) => m.online).length;
  const admins = members.filter((m) => m.zeusAdmin).length;
  const claimBusy = act.busy('bootstrap');
  const meId = me?.devId ?? null;
  const loading = org.loading;
  const failed = !!org.error && !org.data;
  const dash = loading || failed;

  return (
    <div className="grid gap-3">
      {needsAdmin && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-yellow/40 bg-yellow-soft px-4 py-3.5 text-yellow-ink">
          <ShieldAlert className="size-5 shrink-0" />
          <div className="grid min-w-0 flex-1 basis-64 gap-0.5">
            <p className="text-sm font-semibold">Zeus todavía no tiene quien lo administre</p>
            <p className="text-xs opacity-90">
              Sin un admin nadie puede editar el organigrama, dar acceso a los entornos de la bóveda ni resolver las solicitudes que no tienen dueño. La primera
              persona que lo tome queda como admin y puede nombrar a más. Solo se puede hacer una vez.
            </p>
          </div>
          <Button variant="dark" size="sm" onClick={() => setClaiming(true)}><Crown /> Tomar la administración de zeus</Button>
        </div>
      )}

      {org.error && <ErrorCard message={failed ? 'No se pudo cargar el organigrama.' : org.error} />}

      <div className="grid gap-3 lg:h-[calc(100dvh-var(--shell-top,196px)-var(--shell-pad-b,0px))] lg:min-h-[660px] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:grid-rows-[minmax(0,1fr)]">
        <section className="zeus-stage scroll-thin flex min-h-0 flex-col overflow-y-auto overflow-x-hidden rounded-lg border bg-background text-foreground" aria-label="Organigrama">
          <div className="grid shrink-0 gap-3 border-b p-3.5">
            <RailTitle meta={<RefreshButton busy={org.refetching} onClick={org.reload} className="-my-1.5" />}>Organigrama · quién reporta a quién</RailTitle>
            <div className="grid grid-cols-4 gap-px overflow-hidden rounded-lg border bg-border">
              <Figure value={dash ? '—' : members.length} label="Personas" />
              <Figure value={dash ? '—' : online} label="En línea" accent={online > 0} />
              <Figure value={dash ? '—' : admins} label="Admins" />
              <Figure value={dash ? '—' : loose.length} label="Sin jefe" />
            </div>
          </div>

          {dash || branches.length === 0 ? (
            <GhostTree canEdit={canEdit} loading={loading} />
          ) : isMobile ? (
            <div className="p-3.5"><Indented nodes={branches} me={meId} canEdit={canEdit} onEdit={setEditing} /></div>
          ) : (
            <TreeCanvas nodes={branches} me={meId} canEdit={canEdit} onEdit={setEditing} />
          )}

          <div ref={tray} className="grid shrink-0 gap-2.5 border-t bg-card/70 p-3.5">
            <RailTitle meta={<span className="label-caps tabular-nums">{dash ? '—' : loose.length}</span>}>Sin jefe asignado</RailTitle>
            {loading ? (
              <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${trayCols}, minmax(0, 1fr))` }}>
                {Array.from({ length: trayCols * 2 }).map((_, i) => <Skeleton key={i} className="h-[50px] rounded-lg" />)}
              </div>
            ) : loose.length === 0 ? (
              <p className="rounded-lg border-[1.5px] border-dashed border-foreground/20 px-3 py-3 text-[12.5px] text-muted-foreground">
                {failed ? 'Sin datos del organigrama.' : members.length === 0 ? 'Todavía no hay personas en el organigrama.' : 'Todas las personas tienen a quién reportar o a alguien a cargo.'}
              </p>
            ) : (
              <>
                <div className="scroll-thin -mr-2 max-h-[232px] overflow-y-auto pr-2">
                  <BalancedGrid max={{ base: trayCols }} className="gap-2">
                    {loose.map((m) => <PersonChip key={m.devId} member={m} isMe={m.devId === meId} canEdit={canEdit} onEdit={() => setEditing(m)} assign />)}
                  </BalancedGrid>
                </div>
                <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                  Sin jefe, lo que pidan y no tenga dueño ni líder de proyecto va directo a un admin de zeus.
                  {!canEdit && !needsAdmin && ' Solo un admin puede editar el organigrama.'}
                </p>
              </>
            )}
          </div>
        </section>

        {loading ? (
          <Card className="flex min-h-[420px] flex-col gap-4 overflow-hidden p-4">
            <Skeleton className="h-5 w-40" />
            <div className="grid flex-1 content-around gap-3">
              {Array.from({ length: 8 }).map((_, r) => (
                <div key={r} className="flex items-center gap-4">
                  <Skeleton className="size-7 shrink-0 rounded-full" />
                  <Skeleton className="h-3 w-24 shrink-0" />
                  <div className="flex flex-1 justify-around">{Array.from({ length: 12 }).map((__, c) => <Skeleton key={c} className="size-3 rounded-full" />)}</div>
                </div>
              ))}
            </div>
          </Card>
        ) : (
          <OrgMatrix members={members} me={meId} canEdit={canEdit} onEdit={setEditing} className="max-lg:max-h-[80dvh] max-lg:min-h-[420px]" />
        )}
      </div>

      <MemberDialog member={editing} members={members} tree={tree} me={meId} onClose={() => setEditing(null)} />

      <AlertDialog open={claiming} onOpenChange={(v) => !v && !claimBusy && setClaiming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Tomar la administración de zeus</AlertDialogTitle>
            <AlertDialogDescription>
              Quedas como admin de zeus: podrás editar el organigrama, resolver cualquier solicitud, revocar llaves de la bóveda y nombrar a otros admins. Esta
              acción solo está disponible mientras no haya ninguno; después, el rol lo da un admin desde aquí.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={claimBusy}>Volver</AlertDialogCancel>
            <AlertDialogAction
              disabled={claimBusy}
              onClick={(e) => {
                e.preventDefault();
                void act.run('bootstrap', () => zeusApi.bootstrapAdmin(), {
                  success: 'Ahora administras zeus',
                  error: 'No se pudo tomar la administración',
                  onDone: () => setClaiming(false),
                  // Si otra persona lo tomó un segundo antes, el aviso desaparece al revalidar.
                  onSettled: () => {
                    invalidate(ME_KEY);
                    invalidate(ORG_KEY);
                  },
                });
              }}
            >
              {claimBusy && <Loader2 className="animate-spin" />}
              Tomar la administración
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
