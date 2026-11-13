/**
 * Sube los emojis de aplicación de roz (Application Emojis de Discord) que usan los mensajes de /roz:
 * roz_vercel, roz_railway, roz_supabase, roz_github, roz_linear y roz_bot. Idempotente: solo sube los
 * que la app todavía no tiene (por nombre); nunca borra ni reemplaza.
 *
 *   npm run discord:emojis              # sube los que falten
 *   npm run discord:emojis -- --check   # solo dice cuáles faltan (no escribe)
 *
 * Los PNG (128x128, fondo transparente) están en assets/discord/emojis/: se generaron una vez
 * desde web/public/integrations/*.svg (Vercel, Railway y GitHub en blanco para que se vean sobre el
 * fondo oscuro de Discord) y web/public/brand/roz-bot.svg. Para regenerarlos, rasteriza esos SVG a
 * 128 px con cualquier herramienta (p. ej. @resvg/resvg-js instalado FUERA del repo) y reemplaza los
 * archivos; para que Discord tome uno nuevo hay que borrar el emoji viejo en el Developer Portal.
 *
 * Necesita DISCORD_BOT_TOKEN y DISCORD_CLIENT_ID (Application ID). En runtime roz los resuelve por
 * nombre (src/discord/commands/emojis.ts) y, si falta alguno, ese ícono cae a texto plano.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_EMOJI_NAMES } from '../src/discord/commands/emojis.js';

const API = (process.env.DISCORD_API_URL || 'https://discord.com/api/v10').replace(/\/$/, '');
const token = process.env.DISCORD_BOT_TOKEN ?? '';
const appId = process.env.DISCORD_CLIENT_ID ?? '';
const dryRun = process.argv.includes('--check');
const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/discord/emojis');
/** Tope de Discord para la imagen de un emoji. */
const MAX_BYTES = 256 * 1024;

interface AppEmoji {
  id: string;
  name: string;
}

async function discord<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bot ${token}`,
        'user-agent': 'DiscordBot (https://github.com/hyperlabs-ai/roz, 1.0)',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 3) {
      const info = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const wait = info.retry_after ?? (Number(res.headers.get('retry-after')) || 2);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      // Sin el token: solo el método, la ruta y lo que respondió Discord.
      throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }
}

async function main(): Promise<void> {
  if (!token || !appId) {
    console.error('Faltan DISCORD_BOT_TOKEN y/o DISCORD_CLIENT_ID en el entorno (.env).');
    process.exit(1);
  }
  const res = await discord<{ items?: AppEmoji[] } | AppEmoji[]>('GET', `/applications/${appId}/emojis`);
  const existing = new Map((Array.isArray(res) ? res : (res.items ?? [])).map((e) => [e.name, e.id]));

  let uploaded = 0;
  for (const name of APP_EMOJI_NAMES) {
    if (existing.has(name)) {
      console.log(`· ${name}: ya existe (${existing.get(name)})`);
      continue;
    }
    const file = resolve(ASSETS, `${name}.png`);
    const png = readFileSync(file);
    if (png.length > MAX_BYTES) throw new Error(`${name}.png pesa ${png.length} bytes (máx. ${MAX_BYTES})`);
    if (dryRun) {
      console.log(`+ ${name}: falta (se subiría ${file})`);
      continue;
    }
    const created = await discord<AppEmoji>('POST', `/applications/${appId}/emojis`, {
      name,
      image: `data:image/png;base64,${png.toString('base64')}`,
    });
    uploaded++;
    console.log(`+ ${name}: subido (${created.id})`);
  }
  if (dryRun) console.log('Modo --check: no se subió nada.');
  else console.log(uploaded ? `Listo: ${uploaded} emoji(s) nuevos.` : 'Sin cambios: la app ya tiene todos los emojis.');
}

main().catch((err) => {
  console.error('No se pudieron sincronizar los emojis:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
