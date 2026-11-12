// Subida de adjuntos del chat de Discord (contrato §B.6): URL firmada de SUBIDA al bucket privado
// → PUT directo a Storage con progreso → confirmación (el backend guarda el tamaño REAL). Al enviar
// el mensaje, roz los descarga de Storage y los manda a Discord en el mismo webhook.
import { discordApi, type DiscordUploadView } from '@/lib/api';

function put(url: string, file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('x-upsert', 'false');
    const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
    if (anon) xhr.setRequestHeader('apikey', anon);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `Storage respondió ${xhr.status}`;
      try {
        const body = JSON.parse(xhr.responseText) as { message?: string; error?: string };
        message = body.message ?? body.error ?? message;
      } catch {
        /* cuerpo no JSON */
      }
      if (xhr.status === 413 || /exceeded the maximum allowed size|too large/i.test(message)) {
        message = 'El archivo supera el límite permitido';
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('Sin conexión con el almacenamiento'));
    xhr.onabort = () => reject(new DOMException('Subida cancelada', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    // Mismo formato que `uploadToSignedUrl` de storage-js (lib/chat.ts hace lo mismo).
    const form = new FormData();
    form.append('cacheControl', '3600');
    form.append('', file);
    xhr.send(form);
  });
}

/** Sube un archivo para un canal y devuelve el `upload` completado (su id viaja en `uploadIds`). */
export async function uploadDiscordFile(
  channelId: string,
  file: File,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<DiscordUploadView> {
  const ticket = await discordApi.startUpload(channelId, {
    name: file.name || 'archivo',
    size: file.size,
    contentType: file.type || null,
  });
  await put(ticket.uploadUrl, file, opts.onProgress, opts.signal);
  const { upload } = await discordApi.completeUpload(ticket.upload.id);
  return upload;
}
