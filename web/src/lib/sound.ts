// Sonidos de roz. Tres, uno por intención (archivos en web/public/sounds):
//   · notification → lo que LLEGA al dispositivo: el push y los mensajes del chat que te avisan
//                    (menciones, MDs). Lo dispara el chat en tiempo real y el service worker.
//   · action       → algo que hiciste salió bien (crear una tarea, un ticket, guardar…): toast.success.
//   · error        → algo falló: toast.error.
//
// Web Audio y no <audio>: suena al instante (el buffer ya está decodificado), varios sonidos pueden
// encimarse sin cortarse, y Safari no exige respuestas con Range como con <audio>. A cambio hay que
// "desbloquear" el AudioContext con un gesto del usuario (política de autoplay): ver installSounds.
//
// La preferencia (sonidos sí / no) es de ESTE dispositivo y vive en localStorage.

export type Sound = 'notification' | 'action' | 'error';

const SRC: Record<Sound, string> = {
  notification: '/sounds/notificacion.mp3',
  action: '/sounds/accion.mp3',
  error: '/sounds/error.mp3',
};

// ---- Preferencia ----

const STORAGE_KEY = 'roz:sounds';

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

let enabled = readEnabled();
const prefListeners = new Set<() => void>();

export function soundsEnabled(): boolean {
  return enabled;
}

export function setSoundsEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    /* sin storage (modo privado): vale para esta sesión */
  }
  prefListeners.forEach((fn) => fn());
}

/** Para useSyncExternalStore. */
export function subscribeSounds(fn: () => void): () => void {
  prefListeners.add(fn);
  return () => prefListeners.delete(fn);
}

// ---- Audio ----

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

let ctx: AudioContext | null = null;
const buffers = new Map<Sound, Promise<AudioBuffer | null>>();

function context(): AudioContext | null {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    return null;
  }
  return ctx;
}

function load(kind: Sound): Promise<AudioBuffer | null> {
  let p = buffers.get(kind);
  if (!p) {
    const c = context();
    if (!c) return Promise.resolve(null);
    p = fetch(SRC[kind])
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((data) => c.decodeAudioData(data))
      .catch(() => {
        buffers.delete(kind); // que el siguiente intento vuelva a pedirlo
        return null;
      });
    buffers.set(kind, p);
  }
  return p;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** ¿Puede sonar ya? Si el contexto está suspendido intenta reanudarlo: funciona si la página ya
 *  tuvo un gesto (o es una PWA instalada en escritorio). Sin permiso, `resume()` se queda colgada
 *  para siempre, de ahí la carrera con un timeout. */
async function ready(c: AudioContext): Promise<boolean> {
  if (c.state === 'running') return true;
  try {
    await Promise.race([c.resume(), wait(200)]);
  } catch {
    /* noop */
  }
  return (c.state as string) === 'running';
}

// Llave → resultado del intento. El mismo mensaje del chat llega por tiempo real Y por push: con la
// misma llave suena una sola vez, y el segundo camino se entera de que ya sonó.
const byKey = new Map<string, { at: number; played: Promise<boolean> }>();
const KEY_TTL = 30_000;
// Una ráfaga (cinco toasts seguidos, un hilo que se llena) suena una vez, no cinco encimadas.
const lastByKind = new Map<Sound, number>();
const BURST_MS = 300;

async function play(kind: Sound): Promise<boolean> {
  const c = context();
  if (!c || !(await ready(c))) return false;
  const buf = await load(kind);
  if (!buf) return false;
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(c.destination);
  src.start();
  return true;
}

/**
 * Reproduce un sonido. Devuelve si quedó audible (ahora, o hace poco con la misma `key`). Nunca
 * lanza. Con los sonidos apagados en este dispositivo no suena y devuelve false.
 */
export function playSound(kind: Sound, opts: { key?: string } = {}): Promise<boolean> {
  if (!enabled) return Promise.resolve(false);
  const now = Date.now();

  for (const [k, v] of byKey) if (now - v.at > KEY_TTL) byKey.delete(k);
  if (opts.key) {
    const prev = byKey.get(opts.key);
    if (prev) return prev.played;
  }
  if (now - (lastByKind.get(kind) ?? 0) < BURST_MS) return Promise.resolve(true);
  lastByKind.set(kind, now);

  const played = play(kind).catch(() => false);
  if (opts.key) byKey.set(opts.key, { at: now, played });
  return played;
}

// ---- Instalación ----

let installed = false;

/**
 * Una vez, al arrancar la app:
 *  1. Desbloquea el audio con el primer gesto (clic, tecla, toque) y precarga los tres sonidos, para
 *     que el primero no tarde lo que tarda bajarlo y decodificarlo.
 *  2. Atiende al service worker: cuando llega un push y hay una ventana de roz abierta, el SW le pide
 *     que suene `notification` y espera la respuesta. Si sonó, muestra el aviso del sistema en
 *     silencio (si no, se oirían dos); si no contesta (pestaña congelada en el teléfono), deja que
 *     suene el del sistema.
 */
export function installSounds(): void {
  if (installed) return;
  installed = true;

  const events = ['pointerdown', 'keydown', 'touchend'] as const;
  const unlock = () => {
    const c = context();
    if (!c) return;
    // iOS: el desbloqueo requiere reproducir algo DENTRO del gesto; un buffer mudo de una muestra.
    try {
      const s = c.createBufferSource();
      s.buffer = c.createBuffer(1, 1, 22050);
      s.connect(c.destination);
      s.start();
    } catch {
      /* noop */
    }
    void c.resume().then(() => {
      if (c.state === 'running') events.forEach((e) => window.removeEventListener(e, unlock, true));
    }).catch(() => {});
    (Object.keys(SRC) as Sound[]).forEach((k) => void load(k));
  };
  events.forEach((e) => window.addEventListener(e, unlock, { capture: true, passive: true }));

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
      const msg = e.data as { type?: string; sound?: Sound; key?: string } | null;
      if (msg?.type !== 'play-sound') return;
      const port = e.ports[0];
      // Sonidos apagados aquí = la app abierta no hace ruido: el aviso del sistema sale en silencio.
      if (!enabled) {
        port?.postMessage({ handled: true });
        return;
      }
      void playSound(msg.sound ?? 'notification', { key: msg.key }).then((handled) => port?.postMessage({ handled }));
    });
  }
}
