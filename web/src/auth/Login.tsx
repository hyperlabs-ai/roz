import { useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
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
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-primary/5 to-background p-5">
      <Card className="w-full max-w-sm">
        <CardContent className="p-7">
          <div className="mb-6 flex items-center gap-2.5">
            <RozLogo className="size-9" />
            <div className="leading-tight">
              <div className="text-base font-extrabold tracking-wide">ROZ</div>
              <div className="text-xs text-muted-foreground">Desarrollo</div>
            </div>
          </div>
          <h1 className="text-xl font-semibold">Inicia sesión</h1>
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
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
