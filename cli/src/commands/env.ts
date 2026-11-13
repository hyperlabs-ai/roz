// env ls / pull / push / set / rm: lo que hace cualquier dev con acceso. Los valores se descifran
// y cifran aquí; a zeus solo viaja texto cifrado, y a la pantalla solo nombres.
import path from 'node:path';
import { CliError, UsageError, confirmOrAbort, type Ctx } from '../context.js';
import { MAX_SECRET_VALUE_BYTES, encryptSecret, isValidSecretName, secretAad, zeroize } from '../crypto.js';
import { LOCAL_END, LOCAL_START, diffNames, parseDotenv, serializeDotenv } from '../dotenv.js';
import { loadDeviceKey } from '../store.js';
import type { CipherEntry } from '../types.js';
import { decryptAll, label, openEnv, parse, printDiff, requireKey, resolveTarget, staleToCliError, type Target } from './vault.js';

const NAME_RULE = 'letras, números y guion bajo, sin empezar con número, hasta 128 caracteres';

function warnStale(ctx: Ctx, t: Target, stale: string[]): void {
  if (stale.length === 0) return;
  ctx.log(
    `aviso: ${stale.length} secreto(s) de ${label(t)} quedaron cifrados con una llave anterior y no se pueden leer: ${stale.join(', ')}. Vuelve a subirlos con \`zeus env set\`.`,
  );
}

// ---------------------------------------------------------------- ls

export async function envLs(ctx: Ctx): Promise<number> {
  const { projects } = await ctx.api.listProjects();
  const key = await loadDeviceKey(ctx.fs, ctx.home);
  const rows = projects.flatMap((p) => p.envs.map((e) => ({ p, e })));
  if (rows.length === 0) {
    ctx.out('la bóveda no tiene entornos todavía. Un admin crea el primero con `zeus env init <proyecto> [entorno]`.');
    return 0;
  }
  const width = Math.max(...rows.map((r) => `${r.p.key}/${r.e.name}`.length));
  for (const { p, e } of rows) {
    ctx.out(`${`${p.key}/${e.name}`.padEnd(width)}  ${e.hasGrant ? 'con acceso' : 'sin acceso'}  llave v${e.dekVersion}  ${p.name}`);
  }
  if (!key?.keyId) ctx.log('este equipo aún no tiene llave registrada: corre `zeus key init`.');
  else if (rows.some((r) => !r.e.hasGrant)) {
    ctx.log(`para pedir acceso: léele tu huella (${key.fingerprint}) a un admin; él corre \`zeus env grant <proyecto> <entorno> --to ${key.keyId}\`.`);
  }
  return 0;
}

// ---------------------------------------------------------------- pull

function parseJsonVars(text: string): Map<string, string> | null {
  try {
    const obj: unknown = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return new Map(Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  } catch {
    return null;
  }
}

export async function envPull(ctx: Ctx, args: string[]): Promise<number> {
  const { values: opts, positionals } = parse(args, {
    out: { type: 'string' },
    stdout: { type: 'boolean' },
    format: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
  });
  if (positionals.length > 2) throw new UsageError('uso: zeus env pull <proyecto> [entorno] [--out <ruta>] [--stdout] [--format dotenv|json] [--yes]');
  const format = opts.format ?? 'dotenv';
  if (format !== 'dotenv' && format !== 'json') throw new UsageError('--format debe ser dotenv o json');
  if (opts.stdout && opts.out) throw new UsageError('usa --out o --stdout, no los dos');

  const key = await requireKey(ctx);
  const t = await resolveTarget(ctx, positionals[0], positionals[1]);
  const { remote, dek } = await openEnv(ctx, key, t);
  let values: Map<string, string>;
  try {
    const res = decryptAll(t, remote, dek);
    values = res.values;
    warnStale(ctx, t, res.stale);
  } finally {
    zeroize(dek);
  }

  const asJson = (): string => JSON.stringify(Object.fromEntries(values), null, 2) + '\n';
  if (opts.stdout) {
    ctx.out((format === 'json' ? asJson() : serializeDotenv(values)).replace(/\n$/, ''));
    return 0;
  }

  const target = path.resolve(ctx.cwd, opts.out ?? (format === 'json' ? '.env.json' : '.env'));
  const existing = await ctx.fs.read(target);
  let content: string;
  let current: Map<string, string> | null = null;
  if (format === 'json') {
    content = asJson();
    if (existing != null) current = parseJsonVars(existing) ?? new Map();
  } else {
    const parsed = existing != null ? parseDotenv(existing) : null;
    current = parsed?.vars ?? null;
    content = serializeDotenv(values, {
      header: [
        `zeus: ${label(t)}. Esta parte se reescribe en cada \`zeus env pull\`; no la edites a mano.`,
        `Lo propio de tu máquina va entre "${LOCAL_START}" y "${LOCAL_END}": eso se conserva y nunca se sube.`,
      ],
      localBlock: parsed?.localBlock ?? null,
    });
  }

  if (existing != null && current) {
    const diff = diffNames(current, values);
    if (diff.added.length + diff.changed.length + diff.removed.length === 0) {
      ctx.out(`${target} ya está al día con ${label(t)} (${values.size} variables)`);
      return 0;
    }
    ctx.log(`${target} cambia así (solo nombres):`);
    printDiff(ctx, [
      { sign: '+', names: diff.added, note: 'nueva' },
      { sign: '~', names: diff.changed, note: 'cambia de valor' },
      { sign: '-', names: diff.removed, note: 'no está en la bóveda: se quita del archivo' },
    ]);
    if (diff.removed.length > 0 && format === 'dotenv') {
      ctx.log(`  para conservar variables solo tuyas, ponlas entre "${LOCAL_START}" y "${LOCAL_END}".`);
    }
    await confirmOrAbort(ctx, `¿Sobrescribir ${target}?`, opts.yes ?? false);
    await ctx.fs.write(`${target}.bak`, existing, 0o600);
  }

  await ctx.fs.write(target, content, 0o600);
  ctx.out(`${values.size} variables de ${label(t)} escritas en ${target}${existing != null ? ` (anterior en ${target}.bak)` : ''}`);
  return 0;
}

// ---------------------------------------------------------------- push

function checkEntry(name: string, value: string): string | null {
  if (!isValidSecretName(name)) return `${name}: nombre inválido (${NAME_RULE})`;
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_SECRET_VALUE_BYTES) return `${name}: el valor mide ${bytes} bytes; el máximo es 64 KiB`;
  return null;
}

function encryptEntries(t: Target, dek: Buffer, dekVersion: number, names: string[], source: ReadonlyMap<string, string>): CipherEntry[] {
  return names.map((name) => ({
    name,
    ciphertext: encryptSecret(dek, source.get(name) ?? '', secretAad(t.projectKey, t.env, name, dekVersion)),
  }));
}

export async function envPush(ctx: Ctx, args: string[]): Promise<number> {
  const { values: opts, positionals } = parse(args, {
    from: { type: 'string' },
    prune: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
  });
  if (positionals.length > 2) throw new UsageError('uso: zeus env push <proyecto> [entorno] [--from <ruta>] [--prune] [--yes]');

  const file = path.resolve(ctx.cwd, opts.from ?? '.env');
  const text = await ctx.fs.read(file);
  if (text == null) throw new CliError(`no existe ${file} (indica otro archivo con --from)`);
  const parsed = parseDotenv(text);
  if (parsed.problems.length > 0) {
    // Subir un archivo leído a medias podría pisar secretos buenos con valores cortados.
    const lines = parsed.problems.map((p) => `línea ${p.line}: ${p.message}`).join('; ');
    throw new CliError(`${file} tiene líneas que no se pudieron leer y no se subió nada — ${lines}`);
  }
  const local = parsed.vars;
  const invalid = [...local].map(([n, v]) => checkEntry(n, v)).filter((m): m is string => m != null);
  if (invalid.length > 0) throw new CliError(`no se subió nada — ${invalid.join('; ')}`);

  const key = await requireKey(ctx);
  const t = await resolveTarget(ctx, positionals[0], positionals[1]);
  const { remote, dek } = await openEnv(ctx, key, t);
  try {
    const { values: current, stale } = decryptAll(t, remote, dek);
    const diff = diffNames(current, local);
    // Los que ya no se pueden leer cuentan como "en la bóveda": si están en el archivo se vuelven a
    // cifrar con la llave vigente; si no, solo --prune los borra.
    const staleMissing = stale.filter((n) => !local.has(n));
    const onlyRemote = [...diff.removed, ...staleMissing].sort();
    const toSet = [...diff.added, ...diff.changed].sort();
    const toDelete = opts.prune ? onlyRemote : [];

    if (toSet.length + toDelete.length === 0) {
      ctx.out(`${label(t)} ya tiene lo mismo que ${file} (${diff.same.length} variables)`);
      if (onlyRemote.length > 0) ctx.log(`  solo en la bóveda, no se tocan (--prune las borra): ${onlyRemote.join(', ')}`);
      return 0;
    }

    ctx.log(`${label(t)} cambia así (solo nombres):`);
    printDiff(ctx, [
      { sign: '+', names: diff.added, note: stale.length ? 'nueva o vuelta a cifrar' : 'nueva' },
      { sign: '~', names: diff.changed, note: 'cambia de valor' },
      opts.prune
        ? { sign: '-', names: onlyRemote, note: 'se BORRA de la bóveda' }
        : { sign: '=', names: onlyRemote, note: 'solo en la bóveda: no se toca; --prune la borra' },
    ]);
    if (parsed.localNames.length > 0) ctx.log(`  no se suben (bloque local): ${parsed.localNames.join(', ')}`);
    await confirmOrAbort(ctx, `¿Subir estos cambios a ${label(t)}? Los verá todo el que tenga acceso.`, opts.yes ?? false);

    const set = encryptEntries(t, dek, remote.dekVersion, toSet, local);
    const res = await ctx.api
      .putSecrets(t.projectKey, t.env, { keyId: key.keyId, dekVersion: remote.dekVersion, set, delete: toDelete })
      .catch((err: unknown) => staleToCliError(err, t));
    ctx.out(`${label(t)}: ${res.written} escritas, ${res.deleted} borradas`);
    return 0;
  } finally {
    zeroize(dek);
  }
}

// ---------------------------------------------------------------- set / rm

export async function envSet(ctx: Ctx, args: string[]): Promise<number> {
  const { values: opts, positionals } = parse(args, { empty: { type: 'boolean' } });
  const [projectArg, envArg, name] = positionals;
  if (positionals.length !== 3 || !name) {
    // Un cuarto argumento sería el valor: no se acepta para que no quede en el historial del shell.
    throw new UsageError('uso: zeus env set <proyecto> <entorno> NOMBRE   (el valor se lee de stdin o se pregunta sin eco, nunca como argumento)');
  }
  if (!isValidSecretName(name)) throw new UsageError(`nombre inválido: ${name} (${NAME_RULE})`);

  const key = await requireKey(ctx);
  const t = await resolveTarget(ctx, projectArg, envArg);
  const value = await ctx.prompt.secret(`Valor de ${name} (no se muestra): `);
  if (value === '' && !opts.empty) throw new CliError('el valor llegó vacío y no se cambió nada (si de verdad va vacío, agrega --empty)');
  const problem = checkEntry(name, value);
  if (problem) throw new CliError(problem);

  const { remote, dek } = await openEnv(ctx, key, t);
  try {
    const existed = remote.secrets.some((s) => s.name === name);
    const set = encryptEntries(t, dek, remote.dekVersion, [name], new Map([[name, value]]));
    await ctx.api
      .putSecrets(t.projectKey, t.env, { keyId: key.keyId, dekVersion: remote.dekVersion, set, delete: [] })
      .catch((err: unknown) => staleToCliError(err, t));
    ctx.out(`${label(t)}: ${name} ${existed ? 'actualizada' : 'creada'}`);
    return 0;
  } finally {
    zeroize(dek);
  }
}

export async function envRm(ctx: Ctx, args: string[]): Promise<number> {
  const { values: opts, positionals } = parse(args, { yes: { type: 'boolean', short: 'y' } });
  const [projectArg, envArg, name] = positionals;
  if (positionals.length !== 3 || !name) throw new UsageError('uso: zeus env rm <proyecto> <entorno> NOMBRE [--yes]');

  const key = await requireKey(ctx);
  const t = await resolveTarget(ctx, projectArg, envArg);
  // No hace falta descifrar nada para borrar; solo la versión vigente de la llave.
  const remote = await ctx.api.getEnv(t.projectKey, t.env, key.keyId);
  if (!remote.secrets.some((s) => s.name === name)) throw new CliError(`${label(t)} no tiene ${name}`);
  await confirmOrAbort(ctx, `¿Borrar ${name} de ${label(t)} para todos?`, opts.yes ?? false);
  await ctx.api
    .putSecrets(t.projectKey, t.env, { keyId: key.keyId, dekVersion: remote.dekVersion, set: [], delete: [name] })
    .catch((err: unknown) => staleToCliError(err, t));
  ctx.out(`${label(t)}: ${name} borrada`);
  return 0;
}
