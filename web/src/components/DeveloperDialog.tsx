import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiGet, apiSend, type LinearUserOption, type DeveloperCredentials } from '@/lib/api';
import { cn } from '@/lib/utils';

const NONE = '__none__'; // centinela del Select cuando no se eligió usuario de Linear

/**
 * Alta / edición de developer con todas las credenciales que arrancan su flujo: GitHub (atribución
 * de commits y PRs), Linear (asignación de tickets) y email (notificaciones). Si se pasa `devId`,
 * abre en modo edición (precarga y PATCH); si no, crea (POST). Al guardar, el backend re-atribuye
 * el trabajo huérfano que coincida con su identidad de GitHub.
 */
export function DeveloperDialog({
  devId,
  open,
  onOpenChange,
  onSaved,
}: {
  devId?: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const editing = !!devId;
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [githubLogin, setGithubLogin] = useState('');
  const [githubEmail, setGithubEmail] = useState('');
  const [linearUserId, setLinearUserId] = useState<string>(NONE);
  const [availability, setAvailability] = useState('1');
  const [active, setActive] = useState('true');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  // Miembros de Linear para el selector (el linear_user_id es un uuid; se elige de la lista).
  const [linearUsers, setLinearUsers] = useState<LinearUserOption[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // Reset del formulario al abrir.
    setName(''); setEmail(''); setGithubLogin(''); setGithubEmail(''); setLinearUserId(NONE); setAvailability('1'); setActive('true');
    setUsersError(null);
    setLoading(true);

    const usersP = apiGet<{ users: LinearUserOption[] }>('/linear/users')
      .then((r) => setLinearUsers(r.users))
      .catch((e) => setUsersError(String(e.message ?? e)));

    const devP = devId
      ? apiGet<{ developer: DeveloperCredentials }>(`/developers/${devId}/credentials`).then(({ developer: d }) => {
          setName(d.name ?? '');
          setEmail(d.email ?? '');
          setGithubLogin(d.githubLogin ?? '');
          setGithubEmail(d.githubEmail ?? '');
          setLinearUserId(d.linearUserId ?? NONE);
          setAvailability(String(d.availability ?? 1));
          setActive(String(d.active));
        })
      : Promise.resolve();

    Promise.all([usersP, devP]).finally(() => setLoading(false));
  }, [open, devId]);

  // Al elegir un usuario de Linear, prellena nombre/email si están vacíos (atajo, editable).
  function pickLinearUser(id: string) {
    setLinearUserId(id);
    const u = linearUsers.find((x) => x.id === id);
    if (!u) return;
    setName((prev) => prev || u.displayName || u.name);
    if (u.email) setEmail((prev) => prev || u.email!);
  }

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    const body = {
      name: name.trim(),
      email: email.trim() || null,
      githubLogin: githubLogin.trim() || null,
      githubEmail: githubEmail.trim() || null,
      linearUserId: linearUserId === NONE ? null : linearUserId,
      availability: Number(availability),
      ...(editing ? { active: active === 'true' } : {}),
    };
    try {
      if (editing) {
        const { developer } = await apiSend<{ developer: { id: string; name: string } }>('PATCH', `/developers/${devId}`, body);
        toast.success('Credenciales actualizadas', { description: developer.name });
      } else {
        const { developer } = await apiSend<{ developer: { id: string; name: string } }>('POST', '/developers', body);
        toast.success('Developer creado', { description: developer.name });
      }
      onOpenChange(false);
      onSaved();
    } catch (e: any) {
      toast.error(editing ? 'No se pudo guardar' : 'No se pudo crear', { description: String(e.message ?? e) });
    }
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar developer' : 'Nuevo developer'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Corrige sus credenciales. Al guardar, se le re-atribuye el trabajo que había entrado sin dueño (commits y PRs que coincidan con su GitHub).'
              : 'Registra a un developer con las credenciales que arrancan su flujo: GitHub (atribución de commits y PRs), Linear (asignación de tickets) y email (notificaciones).'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="dev-linear">Usuario de Linear</Label>
            <Select value={linearUserId} onValueChange={pickLinearUser} disabled={loading}>
              <SelectTrigger id="dev-linear">
                <SelectValue placeholder={loading ? 'Cargando…' : 'Selecciona un miembro de Linear'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>— Sin vincular —</SelectItem>
                {linearUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.displayName || u.name}{u.email ? ` · ${u.email}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {usersError
                ? `No se pudo cargar Linear: ${usersError}`
                : 'Vincula su cuenta de Linear para que roz le asigne tickets y mapee sus issues.'}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="dev-name">Nombre</Label>
            <Input id="dev-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="ej. Fernando Dévora" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="dev-email">Email (notificaciones)</Label>
            <Input id="dev-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="fer@hyperdigital.mx" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="dev-gh-login">Login de GitHub</Label>
              <Input id="dev-gh-login" value={githubLogin} onChange={(e) => setGithubLogin(e.target.value)} placeholder="nitrofd" className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dev-gh-email">Email de GitHub</Label>
              <Input id="dev-gh-email" type="email" value={githubEmail} onChange={(e) => setGithubEmail(e.target.value)} placeholder="commits@…" className="font-mono" />
            </div>
          </div>
          <p className="-mt-1 text-xs text-muted-foreground">
            Sus commits se atribuyen por email (lo más confiable) y, si no, por login. Idealmente pon ambos.
          </p>

          <div className={cn('grid gap-3', editing ? 'grid-cols-2' : 'grid-cols-1')}>
            <div className="space-y-1.5">
              <Label htmlFor="dev-availability">Disponibilidad</Label>
              <Select value={availability} onValueChange={setAvailability}>
                <SelectTrigger id="dev-availability"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Disponible (100%)</SelectItem>
                  <SelectItem value="0.5">Media (50%)</SelectItem>
                  <SelectItem value="0">No disponible</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {editing && (
              <div className="space-y-1.5">
                <Label htmlFor="dev-active">Estado</Label>
                <Select value={active} onValueChange={setActive}>
                  <SelectTrigger id="dev-active"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Activo</SelectItem>
                    <SelectItem value="false">Inactivo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={save} disabled={busy || loading || !name.trim()}>
            {busy ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear developer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
