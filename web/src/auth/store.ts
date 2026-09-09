// Sesión de Supabase FUERA de React, con `useSyncExternalStore`. Sin dependencias nuevas.
//
// Por qué no un contexto con `useState`: supabase-js registra su propio `visibilitychange` y, al
// volver a la pestaña, corre `_recoverAndRefresh()`. Ese camino puede emitir `SIGNED_OUT` por un
// fallo TRANSITORIO (el refresh token venció mientras la laptop dormía, o dos pestañas se pelearon
// el mismo token). Con la sesión en un contexto, ese `SIGNED_OUT` viajaba hasta `RequireAuth`, que
// intercambiaba el <Outlet/> por <Login/> — o sea, DESMONTABA el dashboard entero, y al reentrar
// cada página cargaba desde cero. Eso es exactamente el "me cambio de pestaña y regreso y se
// recarga todo" que se reportó. El commit 3d8bf69 cerró el caso `SIGNED_IN` con el mismo token;
// este archivo cierra el resto.
//
// Reglas que implementa (las mismas de hyperflow-app/src/store/auth-store.ts:523-566):
//   · `TOKEN_REFRESHED` se trata como `SIGNED_IN`, y se ignora si el token no cambió de verdad.
//   · `USER_UPDATED` se propaga SIEMPRE (el dedupe por token lo descartaba y el email quedaba viejo).
//   · `SIGNED_OUT` solo es un cierre real si LO PEDIMOS nosotros o si otra pestaña borró la sesión;
//     cualquier otro se trata como transitorio y se intenta recuperar en silencio.
//   · El access_token se empuja a `lib/api.ts`, para no llamar a `getSession()` en cada petición.
import { useSyncExternalStore } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, STORAGE_KEY } from '../lib/supabase';
import { setAuthToken } from '../lib/api';

export interface AuthSnapshot {
  session: Session | null;
  /** Todavía resolviendo la sesión guardada (primer arranque). */
  loading: boolean;
  /** Se perdió el token y se está intentando recuperar SIN echar al usuario. */
  recovering: boolean;
}

// El snapshot se REEMPLAZA en cada cambio, nunca se muta: `useSyncExternalStore` compara por
// identidad y una mutación en sitio no notificaría (o entraría en bucle si además se recreara).
let snapshot: AuthSnapshot = { session: null, loading: true, recovering: false };
const subs = new Set<() => void>();

function emit(next: Partial<AuthSnapshot>): void {
  const merged: AuthSnapshot = { ...snapshot, ...next };
  if (
    merged.session === snapshot.session &&
    merged.loading === snapshot.loading &&
    merged.recovering === snapshot.recovering
  ) {
    return; // nada cambió: ni un render
  }
  snapshot = merged;
  for (const cb of [...subs]) cb();
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

const getSnapshot = (): AuthSnapshot => snapshot;

/** Estado de la sesión. Lo consume `AuthContext`, que le añade el perfil de /me. */
export function useAuthSnapshot(): AuthSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Solo el id del usuario. Cambia únicamente al cambiar de cuenta: sirve para invalidar cachés. */
export function useSessionUserId(): string | null {
  return useSyncExternalStore(subscribe, () => snapshot.session?.user?.id ?? null);
}

/** Lectura imperativa, fuera de React. */
export const authSnapshot = (): AuthSnapshot => snapshot;

// ---- Recuperación de un SIGNED_OUT sospechoso ----
// Backoff corto: si es un hipo del refresh se resuelve en el primer intento. Tope de 3 para no
// dejar al usuario en un "Reconectando…" eterno cuando el token está revocado de verdad.
const RECOVERY_DELAYS = [1_000, 3_000, 8_000];
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;
/** true entre nuestro propio signOut() y el evento que provoca: distingue querer salir de fallar. */
let signingOut = false;

function clearTimer(): void {
  if (recoveryTimer !== null) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
}

function scheduleRecovery(): void {
  if (recoveryTimer !== null) return;
  const delay = RECOVERY_DELAYS[Math.min(attempts, RECOVERY_DELAYS.length - 1)]!;
  recoveryTimer = setTimeout(attemptRecovery, delay);
}

async function attemptRecovery(): Promise<void> {
  recoveryTimer = null;
  if (!snapshot.recovering) return;
  // En una pestaña oculta no se reintenta: el navegador tampoco refresca y gastaríamos los tres
  // intentos contra la pared. El listener de visibilidad re-agenda al volver.
  if (typeof document !== 'undefined' && document.hidden) return;

  attempts++;
  const { data } = await supabase.auth.refreshSession().catch(() => ({ data: { session: null } }));
  if (data?.session) {
    applySession(data.session, true); // recuperado: el usuario nunca se enteró
    return;
  }
  if (attempts >= RECOVERY_DELAYS.length) {
    concludeSignedOut(); // ahora sí: sesión muerta
    return;
  }
  scheduleRecovery();
}

function startRecovery(): void {
  if (snapshot.recovering) return;
  attempts = 0;
  emit({ recovering: true, loading: false });
  scheduleRecovery();
}

/** Cierre confirmado: se limpia todo y `RequireAuth` pinta el login. */
function concludeSignedOut(): void {
  attempts = 0;
  signingOut = false;
  clearTimer();
  setAuthToken(null);
  snapshot = { session: null, loading: false, recovering: false };
  for (const cb of [...subs]) cb();
}

/**
 * Guarda una sesión. `force` la propaga aunque el token sea idéntico (USER_UPDATED, recuperación).
 * Sin `force`, un token igual NO se propaga: es el fix de 3d8bf69, que evita re-disparar /me y
 * desmontar la página al volver a la pestaña.
 */
function applySession(s: Session | null, force = false): void {
  if (!s) {
    // Sin sesión: aquí solo se refleja "anónimo". Quien decide si hay que recuperar es el handler
    // de eventos, que es el único que sabe si el SIGNED_OUT lo pedimos nosotros.
    setAuthToken(null);
    emit({ session: null, loading: false });
    return;
  }
  const prev = snapshot.session;
  const same = prev?.access_token === s.access_token && prev?.user?.id === s.user?.id;
  if (same && !force) {
    emit({ loading: false, recovering: false });
    return;
  }
  clearTimer();
  attempts = 0;
  setAuthToken(s);
  emit({ session: s, loading: false, recovering: false });
}

/** Cierre de sesión pedido por el usuario. La bandera es lo que lo distingue de un fallo. */
export async function signOut(): Promise<void> {
  signingOut = true;
  try {
    await supabase.auth.signOut();
  } finally {
    concludeSignedOut();
  }
}

// ---- Suscripción única, a nivel de módulo ----
// Fuera de React a propósito: así no se re-suscribe en cada montaje del provider ni con el doble
// render de StrictMode, y sobrevive a cualquier remonte del árbol.
supabase.auth.getSession().then(({ data }) => {
  if (data.session) applySession(data.session);
  else emit({ loading: false });
});

supabase.auth.onAuthStateChange((event, s) => {
  if (event === 'SIGNED_OUT') {
    // Lo pedimos nosotros → cierre real. Cualquier otro origen es sospechoso: puede ser el refresh
    // que falló al volver a la pestaña, y echar al usuario por eso es el bug que se está arreglando.
    if (signingOut) concludeSignedOut();
    else startRecovery();
    return;
  }
  // USER_UPDATED conserva token e id, así que el dedupe lo descartaría y el email/metadata se
  // quedarían viejos en la UI. Se fuerza.
  applySession(s, event === 'USER_UPDATED');
});

// Cierre real desde OTRA pestaña: auth-js borra su llave de localStorage. Sin esto habría que
// esperar los 3 intentos de recuperación para descubrir que la sesión ya no existe.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && e.newValue === null) concludeSignedOut();
  });
  // Al volver a la pestaña, re-agenda una recuperación pendiente (se pausó por estar oculta).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && snapshot.recovering) scheduleRecovery();
  });
}
