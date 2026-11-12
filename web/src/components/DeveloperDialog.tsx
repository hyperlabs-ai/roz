import { useEffect, useState } from 'react';
import { Loader2, Mail, User } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorCard } from '@/components/bits';
import { IntegrationIcon } from '@/components/brand';
import { apiGet, apiSend, type DeveloperCredentials } from '@/lib/api';
import { cn } from '@/lib/utils';

const AVAILABILITY = [
  { value: '1', label: 'Completa', dot: 'bg-green' },
  { value: '0.5', label: 'Media', dot: 'bg-yellow' },
  { value: '0', label: 'Ninguna', dot: 'bg-toggle-off' },
];

const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/**
 * Alta / edición de developer con las credenciales que arrancan su flujo: GitHub (atribución de
 * commits y PRs) y email (notificaciones). Si se pasa `devId`, abre en modo edición (precarga y
 * PATCH); si no, crea (POST). Al guardar, el backend re-atribuye el trabajo huérfano que coincida
 * con su identidad de GitHub.
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
  /** Recibe lo que devolvió el backend, para que el padre sustituya/inserte esa fila. */
  onSaved: (developer: { id: string; name: string }, mode: 'create' | 'update') => void;
}) {
  const editing = !!devId;
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [githubLogin, setGithubLogin] = useState('');
  const [githubEmail, setGithubEmail] = useState('');
  const [availability, setAvailability] = useState('1');
  const [active, setActive] = useState('true');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // Reset del formulario al abrir.
    setName(''); setEmail(''); setGithubLogin(''); setGithubEmail(''); setAvailability('1'); setActive('true');
    if (!devId) return;
    setLoading(true);
    setLoadError(null);
    apiGet<{ developer: DeveloperCredentials }>(`/developers/${devId}/credentials`)
      .then(({ developer: d }) => {
        setName(d.name ?? '');
        setEmail(d.email ?? '');
        setGithubLogin(d.githubLogin ?? '');
        setGithubEmail(d.githubEmail ?? '');
        setAvailability(String(d.availability ?? 1));
        setActive(String(d.active));
      })
      // Sin este catch la promesa quedaba rechazada sin manejar y el formulario se mostraba EN
      // BLANCO, indistinguible de un dev sin datos: guardarlo así le habría borrado sus credenciales.
      .catch((e: unknown) => setLoadError(String((e as Error)?.message ?? e)))
      .finally(() => setLoading(false));
  }, [open, devId]);

  const emailBad = !!email.trim() && !looksLikeEmail(email);
  const ghEmailBad = !!githubEmail.trim() && !looksLikeEmail(githubEmail);
  const canSave = !!name.trim() && !emailBad && !ghEmailBad && !busy && !loading;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    const body = {
      name: name.trim(),
      email: email.trim() || null,
      githubLogin: githubLogin.trim() || null,
      githubEmail: githubEmail.trim() || null,
      availability: Number(availability),
      ...(editing ? { active: active === 'true' } : {}),
    };
    try {
      if (editing) {
        const { developer } = await apiSend<{ developer: { id: string; name: string } }>('PATCH', `/developers/${devId}`, body);
        toast.success('Credenciales actualizadas', { description: developer.name });
        onOpenChange(false);
        onSaved(developer, 'update');
      } else {
        const { developer } = await apiSend<{ developer: { id: string; name: string } }>('POST', '/developers', body);
        toast.success('Developer creado', { description: developer.name });
        onOpenChange(false);
        onSaved(developer, 'create');
      }
    } catch (e: any) {
      toast.error(editing ? 'No se pudo guardar' : 'No se pudo crear', { description: String(e.message ?? e) });
    }
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader eyebrow={editing ? 'Developer · credenciales' : 'Equipo · alta'}>
          <DialogTitle>{editing ? 'Editar developer' : 'Nuevo developer'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Corrige sus credenciales. Al guardar, se le re-atribuye el trabajo que había entrado sin dueño (commits y PRs que coincidan con su GitHub).'
              : 'Registra a un developer con las credenciales que arrancan su flujo: GitHub (atribución de commits y PRs) y email (notificaciones).'}
          </DialogDescription>
        </DialogHeader>

        <form
          id="dev-form"
          className="grid gap-4"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
        >
          {/* Si la precarga falló, se dice: un formulario vacío parece un dev sin datos, y guardarlo
              así le borraría sus credenciales. */}
          {loadError && (
            <ErrorCard message={`No se pudieron traer sus credenciales (${loadError}). Ciérralo y vuelve a abrirlo.`} />
          )}

          <fieldset disabled={loading} className={cn('grid min-w-0 gap-4 transition-opacity', loading && 'opacity-50')}>
            <Field label="Nombre" htmlFor="dev-name" required>
              <Input
                id="dev-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Fernando Dévora"
                autoFocus={!editing}
                leading={<User />}
              />
            </Field>

            <Field
              label="Correo"
              htmlFor="dev-email"
              hint="Aquí le llegan los avisos de roz."
              error={emailBad ? 'No parece un correo válido.' : undefined}
            >
              <Input
                id="dev-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="dev@empresa.com"
                invalid={emailBad}
                leading={<Mail />}
              />
            </Field>

            <div className="rounded-lg border bg-sidebar p-3">
              <div className="mb-3 flex h-6 items-center gap-2">
                <IntegrationIcon name="github" size="sm" />
                <span className="text-[13px] font-medium">Identidad en GitHub</span>
                {githubLogin.trim() && (
                  <img
                    key={githubLogin.trim()}
                    src={`https://github.com/${encodeURIComponent(githubLogin.trim())}.png?size=48`}
                    alt=""
                    className="ml-auto size-6 rounded-full bg-panel"
                    onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                  />
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Usuario" htmlFor="dev-gh-login">
                  <Input
                    id="dev-gh-login"
                    value={githubLogin}
                    onChange={(e) => setGithubLogin(e.target.value.replace(/^@/, ''))}
                    placeholder="nitrofd"
                    className="font-mono text-[13px]"
                    leading="@"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </Field>
                <Field
                  label="Correo de commits"
                  htmlFor="dev-gh-email"
                  error={ghEmailBad ? 'No parece un correo válido.' : undefined}
                >
                  <Input
                    id="dev-gh-email"
                    type="email"
                    value={githubEmail}
                    onChange={(e) => setGithubEmail(e.target.value)}
                    placeholder="commits@empresa.com"
                    className="font-mono text-[13px]"
                    invalid={ghEmailBad}
                    spellCheck={false}
                  />
                </Field>
              </div>
              <p className="mt-2.5 text-[11.5px] leading-snug text-faint">
                Sus commits se atribuyen por correo (lo más confiable) y, si no, por usuario. Lo ideal es poner los dos.
              </p>
            </div>

            <Field label="Disponibilidad">
              <div role="radiogroup" aria-label="Disponibilidad" className="grid grid-cols-3 gap-1 rounded-md bg-panel p-1">
                {AVAILABILITY.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={availability === o.value}
                    onClick={() => setAvailability(o.value)}
                    className={cn(
                      'flex h-8 items-center justify-center gap-1.5 rounded-[5px] text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      availability === o.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <span className={cn('size-1.5 rounded-full', o.dot)} />
                    {o.label}
                  </button>
                ))}
              </div>
            </Field>

            {editing && (
              <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">Activo en el equipo</span>
                  <span className="block text-[11.5px] text-faint">
                    {active === 'true' ? 'Recibe tareas y aparece en los tableros.' : 'No recibe tareas ni avisos; su historial se conserva.'}
                  </span>
                </span>
                <Switch aria-label="Activo en el equipo" checked={active === 'true'} onCheckedChange={(v) => setActive(String(v))} />
              </div>
            )}
          </fieldset>
        </form>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button type="submit" form="dev-form" disabled={!canSave}>
            {busy && <Loader2 className="animate-spin" />}
            {editing ? 'Guardar cambios' : 'Crear developer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
