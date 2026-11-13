// Diálogo de una persona del organigrama: a quién reporta y si administra zeus (solo admins).
import { useEffect, useMemo, useState } from 'react';
import { Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { invalidate } from '@/lib/store';
import { useAction } from '@/lib/useAction';
import { zeusApi, type ZeusOrgMember } from '@/lib/zeus';
import { GRAPH_KEY, ME_KEY, ORG_KEY } from './hooks';
import { descendants, find, type TreeNode } from './org-tree';

const NOBODY = '__nadie__';

export function MemberDialog({
  member,
  members,
  tree,
  me,
  onClose,
}: {
  member: ZeusOrgMember | null;
  members: ZeusOrgMember[];
  tree: TreeNode[];
  me: string | null;
  onClose: () => void;
}) {
  const act = useAction();
  const [reportsTo, setReportsTo] = useState<string>(NOBODY);
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    if (!member) return;
    setReportsTo(member.reportsTo ?? NOBODY);
    setAdmin(member.zeusAdmin);
  }, [member]);

  const options = useMemo<ComboboxOption[]>(() => {
    if (!member) return [];
    // Ni ella misma ni nadie que le reporte (directa o indirectamente): eso cerraría un ciclo.
    const node = find(tree, member.devId);
    const banned = node ? descendants(node) : new Set<string>();
    banned.add(member.devId);
    return [
      { value: NOBODY, label: 'Nadie (nivel más alto)' },
      ...members
        .filter((m) => !banned.has(m.devId) && (m.active || m.devId === member.reportsTo))
        .map((m) => ({ value: m.devId, label: m.name, hint: m.role }))
        .sort((a, b) => a.label.localeCompare(b.label, 'es')),
    ];
  }, [member, members, tree]);

  if (!member) return null;
  const busy = act.busy(`member:${member.devId}`);
  const nextReports = reportsTo === NOBODY ? null : reportsTo;
  const dirty = nextReports !== member.reportsTo || admin !== member.zeusAdmin;
  const droppingSelf = member.devId === me && member.zeusAdmin && !admin;

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader eyebrow="Zeus · organización">
          <DialogTitle>{member.name}</DialogTitle>
          <DialogDescription>{member.role || 'Sin rol'}{member.email ? ` · ${member.email}` : ''}</DialogDescription>
        </DialogHeader>
        <Field label="Reporta a" htmlFor="zo-reports" hint="Las solicitudes sin dueño ni líder de proyecto se envían a esta persona.">
          <Combobox id="zo-reports" value={reportsTo} onChange={setReportsTo} options={options} searchPlaceholder="Buscar persona…" emptyText="Nadie con ese nombre" />
        </Field>
        <label htmlFor="zo-admin" className="flex cursor-pointer items-start gap-3 rounded-md border bg-sidebar px-3.5 py-3">
          <Switch id="zo-admin" checked={admin} onCheckedChange={setAdmin} className="mt-0.5" />
          <span className="grid gap-0.5">
            <span className="text-[13px] font-medium">Administra zeus</span>
            <span className="text-xs text-muted-foreground">
              Puede editar el organigrama, resolver cualquier solicitud, revocar llaves de la bóveda y dar o quitar acceso a los entornos.
            </span>
          </span>
        </label>
        {droppingSelf && (
          <p className="flex items-start gap-2 rounded-md bg-yellow-soft px-3 py-2 text-xs text-yellow-ink">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            Te vas a quitar el rol a ti mismo: después no podrás volver a dártelo; tendrá que hacerlo otro admin.
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button
            disabled={!dirty || busy}
            onClick={() =>
              void act.run(
                `member:${member.devId}`,
                () =>
                  zeusApi.updateMember(member.devId, {
                    ...(nextReports !== member.reportsTo ? { reportsTo: nextReports } : {}),
                    ...(admin !== member.zeusAdmin ? { zeusAdmin: admin } : {}),
                  }),
                {
                  success: 'Organigrama actualizado',
                  error: 'No se pudo guardar',
                  onDone: () => {
                    invalidate(ORG_KEY);
                    invalidate(ME_KEY);
                    // `reports_to` es una arista derivada del mapa.
                    invalidate(GRAPH_KEY);
                    onClose();
                  },
                },
              )
            }
          >
            {busy && <Loader2 className="animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
