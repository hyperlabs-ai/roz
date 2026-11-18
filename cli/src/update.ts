// ¿Hay un CLI más nuevo? Una consulta a npm al día como mucho (se guarda en ~/.zeus/update.json),
// con poco tiempo de espera: si npm no responde, se sigue sin aviso y no se vuelve a intentar hasta
// el día siguiente. Solo se consulta el registro público de npm; no viaja nada de la persona.
// ZEUS_NO_UPDATE_CHECK=1 lo apaga.
import path from 'node:path';
import type { Ctx } from './context.js';
import { VERSION } from './version.js';

export const PACKAGE = '@hyperlabs-ai/zeus';
export const UPDATE_COMMAND = `npm i -g ${PACKAGE}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const WAIT_MS = 1500;

interface Cache {
  checkedAt: string;
  latest: string | null;
}

/** true si `a` es una versión mayor que `b` (x.y.z; lo que no sea número cuenta como 0). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** La última versión publicada, de la caché del día o de npm. null si no se sabe. */
export async function latestCliVersion(ctx: Ctx, now: Date = new Date()): Promise<string | null> {
  if (ctx.env.ZEUS_NO_UPDATE_CHECK === '1' || !ctx.latestVersion) return null;
  const file = path.join(ctx.home, 'update.json');
  let cache: Cache | null = null;
  try {
    const text = await ctx.fs.read(file);
    cache = text ? (JSON.parse(text) as Cache) : null;
  } catch {
    cache = null;
  }
  const age = cache ? now.getTime() - Date.parse(cache.checkedAt) : Number.POSITIVE_INFINITY;
  if (cache && age >= 0 && age < DAY_MS) return cache.latest;

  let latest = cache?.latest ?? null;
  try {
    const fetched = await Promise.race([ctx.latestVersion(PACKAGE), new Promise<null>((r) => setTimeout(() => r(null), WAIT_MS).unref?.())]);
    if (fetched && /^\d+\.\d+\.\d+/.test(fetched)) latest = fetched;
  } catch {
    // Sin red o npm caído: se queda lo que se sabía.
  }
  try {
    await ctx.fs.mkdirPrivate(ctx.home);
    await ctx.fs.write(file, JSON.stringify({ checkedAt: now.toISOString(), latest } satisfies Cache) + '\n', 0o600);
  } catch {
    // No poder guardar la caché no es motivo para fallar el comando.
  }
  return latest;
}

/** Una línea para la persona (y para Claude) si este CLI quedó atrás; null si está al día. */
export async function updateNotice(ctx: Ctx, current: string = VERSION): Promise<string | null> {
  const latest = await latestCliVersion(ctx).catch(() => null);
  if (!latest || !isNewer(latest, current)) return null;
  return `hay una versión nueva del CLI de zeus: ${latest} (tienes ${current}). Actualiza con \`${UPDATE_COMMAND}\``;
}
