// Web Push del lado del cliente: pide permiso, se suscribe con el service worker usando la llave
// VAPID pública del servidor, y registra/borra la suscripción en la API. El envío vive en el
// backend (src/notify/push.ts); aquí solo gestionamos la suscripción de ESTE dispositivo.
import { apiGet, apiSend } from './api';

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// La applicationServerKey debe ser un Uint8Array; la VAPID pública viene en base64url.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const arr = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// Asegura un service worker activo (lo registra al vuelo si aún no existe — p. ej. en dev).
async function ensureRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (!existing) await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function enablePush(): Promise<void> {
  if (!isPushSupported()) throw new Error('Este dispositivo no soporta notificaciones push.');

  const { publicKey, enabled } = await apiGet<{ publicKey: string; enabled: boolean }>('/push/public-key');
  if (!enabled || !publicKey) throw new Error('El servidor aún no tiene configuradas las notificaciones (VAPID).');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permiso de notificaciones denegado.');

  const reg = await ensureRegistration();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  await apiSend('POST', '/push/subscribe', { subscription: sub.toJSON(), userAgent: navigator.userAgent });
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const { endpoint } = sub;
  await sub.unsubscribe().catch(() => {});
  await apiSend('POST', '/push/unsubscribe', { endpoint }).catch(() => {});
}
