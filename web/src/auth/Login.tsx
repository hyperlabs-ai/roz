import { useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorCard } from '@/components/bits';
import { RozLogo } from '@/components/RozLogo';

// Dominios permitidos (coma-separados) vía VITE_ALLOWED_EMAIL_DOMAINS. Vacío = sin pre-filtro
// en el cliente; el backend igual valida el dominio (DASHBOARD_ALLOWED_DOMAINS).
const ALLOWED = (import.meta.env.VITE_ALLOWED_EMAIL_DOMAINS ?? '')
  .split(',')
  .map((d: string) => d.trim().toLowerCase())
  .filter(Boolean);

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const domain = email.trim().toLowerCase().split('@')[1];
    if (ALLOWED.length && (!domain || !ALLOWED.includes(domain))) {
      setError(`Solo correos de: ${ALLOWED.map((d: string) => '@' + d).join(', ')}`);
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    setBusy(false);
    if (error) setError(error.message);
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-5">
      {/* Fondo sutil: un resplandor de marca difuso, coherente en light y dark */}
      <div className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[36rem] w-[36rem] -translate-x-1/2 -translate-y-1/3 rounded-full bg-primary/10 blur-3xl" aria-hidden />
      <div className="animate-scale-in w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <RozLogo className="size-11 rounded-xl ring-1 ring-border" />
          <div className="leading-tight">
            <div className="text-lg font-extrabold tracking-wide">ROZ</div>
            <div className="text-xs text-muted-foreground">Desarrollo</div>
          </div>
        </div>
        <Card className="shadow-lg">
          <CardContent className="p-7">
            <h1 className="text-xl font-semibold tracking-tight">Inicia sesión</h1>
            <p className="mb-6 mt-1 text-sm text-muted-foreground">Con tu cuenta del equipo.</p>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">Correo</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@empresa.com" required autoFocus />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pass">Contraseña</Label>
                <Input id="pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              {error && <ErrorCard message={error} />}
              <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
