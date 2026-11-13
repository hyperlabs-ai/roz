// run: corre un comando con los secretos como variables de entorno, sin escribirlos a disco.
import { UsageError, type Ctx } from '../context.js';
import { zeroize } from '../crypto.js';
import { decryptAll, label, openEnv, requireKey, resolveTarget } from './vault.js';

const USAGE = 'uso: zeus run <proyecto> [entorno] -- <comando> [argumentos…]';

export async function run(ctx: Ctx, args: string[]): Promise<number> {
  const sep = args.indexOf('--');
  const before = sep === -1 ? args : args.slice(0, sep);
  const command = sep === -1 ? [] : args.slice(sep + 1);
  const bin = command[0];
  if (!bin || before.length < 1 || before.length > 2 || before.some((a) => a.startsWith('-'))) throw new UsageError(USAGE);

  const key = await requireKey(ctx);
  const t = await resolveTarget(ctx, before[0], before[1]);
  const { remote, dek } = await openEnv(ctx, key, t);
  let values: Map<string, string>;
  try {
    const res = decryptAll(t, remote, dek);
    values = res.values;
    if (res.stale.length > 0) ctx.log(`aviso: ${label(t)} tiene secretos ilegibles (llave anterior) que no se inyectan: ${res.stale.join(', ')}`);
  } finally {
    zeroize(dek);
  }
  // Los secretos viajan por el entorno del proceso hijo, nunca por sus argumentos.
  return ctx.spawn(bin, command.slice(1), { ...ctx.env, ...Object.fromEntries(values) });
}
