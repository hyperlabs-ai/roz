// env ls / pull / push / set / rm / status / diff / history / restore: lo que hace cualquier dev con
// acceso. Los valores se descifran y cifran aquí; a zeus solo viaja texto cifrado, y a la pantalla
// solo nombres (salvo `pull --stdout`, que es explícito).
import path from 'node:path';
import { CliError, UsageError, confirmOrAbort, type Ctx } from '../context.js';
import { MAX_SECRET_VALUE_BYTES, VaultCryptoError, decryptSecret, encryptSecret, isValidSecretName, secretAad, zeroize } from '../crypto.js';
import { LOCAL_END, LOCAL_START, diffNames, parseDotenv, serializeDotenv } from '../dotenv.js';
import { findZeusFiles, headerLines, locateEnvFile, readHeader, type ZeusHeader } from '../envfile.js';
import { loadDeviceKey } from '../store.js';
import type { CipherEntry, VaultEnv, VaultRevision } from '../types.js';
import {
  decryptAll,
  label,
  openEnv,
  parse,
  printDiff,
  requireKey,
  resolveTarget,
  staleToCliError,
  type RegisteredKey,
  type Target,
} from './vault.js';

const NAME_RULE = 'letras, números y guion bajo, sin empezar con número, hasta 128 caracteres';

function warnStale(ctx: Ctx, t: Target, stale: string[]): void {
  if (stale.length === 0) return;
  ctx.log(
    `aviso: ${stale.length} secreto(s) de ${label(t)} quedaron cifrados con una llave anterior y no se pueden leer: ${stale.join(', ')}. Vuelve a subirlos con \`zeus env set\`.`,
  );
}

/** Fecha corta y legible ("2026-11-17 10:02"), en UTC para que sea igual en todas las PCs. */
const when = (iso: string | null | undefined): string => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '');

/** Versiones vigentes de las variables que sí se pudieron leer. */
function remoteVersions(remote: VaultEnv, readable: ReadonlyMap<string, string>): Map<string, number> {
  return new Map(remote.secrets.filter((s) => readable.has(s.name)).map((s) => [s.name, s.version]));
}

/** Reemplaza SOLO la línea de versiones de la cabecera, sin tocar nada más del archivo. */
function withVersions(text: string, versions: ReadonlyMap<string, number>): string | null {
  const pairs = [...versions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([n, v]) => `${n}=${v}`);
  const line = `# zeus:versions ${pairs.join(' ')}`.trimEnd();
  const re = /^#\s*zeus:versions[ \t]*.*$/m;
  return re.test(text) ? text.replace(re, line) : null;
}

// ---------------------------------------------------------------- ls

export async function envLs(ctx: Ctx, args: string[] = []): Promise<number> {
  const { values: opts } = parse(args, { json: { type: 'boolean' } });
  const { projects } = await ctx.api.listProjects();
  const key = await loadDeviceKey(ctx.fs, ctx.home);
  const rows = projects.flatMap((p) => p.envs.map((e) => ({ p, e })));
  if (opts.json) {
    ctx.out(JSON.stringify(rows.map(({ p, e }) => ({ project: p.key, env: e.name, hasAccess: e.hasGrant, needsRotation: !!e.needsRotation, keyVersion: e.dekVersion }))));
    return 0;
  }
  if (rows.length === 0) {
    ctx.out('la bóveda no tiene entornos todavía. Un admin crea el primero con `zeus env init <proyecto> [entorno]`.');
    return 0;
  }
  const width = Math.max(...rows.map((r) => `${r.p.key}/${r.e.name}`.length));
  for (const { p, e } of rows) {
    ctx.out(
      `${`${p.key}/${e.name}`.padEnd(width)}  ${e.hasGrant ? 'con acceso' : 'sin acceso'}  llave v${e.dekVersion}${e.needsRotation ? '  POR ROTAR' : ''}  ${p.name}`,
    );
  }
  if (!key?.keyId) ctx.log('este equipo aún no tiene llave registrada: corre `zeus key init`.');
  else if (rows.some((r) => !r.e.hasGrant)) {
    ctx.log(`para pedir acceso: léele tu huella (${key.fingerprint}) a un admin; él corre \`zeus env grant <proyecto> <entorno> --to ${key.keyId}\`.`);
  }
  if (rows.some((r) => r.e.needsRotation && r.e.hasGrant)) {
    ctx.log('POR ROTAR: alguien perdió el acceso a esos entornos. Un admin corre `zeus env rotate --all`.');
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

/** Variables que la persona cambió en su archivo y no subió (la bóveda sigue en la versión que bajó). */
function localEdits(header: ZeusHeader | null, t: Target, local: ReadonlyMap<string, string>, remote: VaultEnv, values: ReadonlyMap<string, string>): string[] {
  if (!header || header.projectKey.toLowerCase() !== t.projectKey.toLowerCase() || header.env !== t.env) return [];
  return remote.secrets
    .filter((s) => values.has(s.name) && local.has(s.name) && local.get(s.name) !== values.get(s.name) && header.versions.get(s.name) === s.version)
    .map((s) => s.name)
    .sort();
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

  // Cada entorno a su archivo: development → .env, production → .env.production (o el que ya diga
  // venir de ese entorno en su cabecera).
  const target = opts.out ? path.resolve(ctx.cwd, opts.out) : format === 'json' ? path.resolve(ctx.cwd, '.env.json') : await locateEnvFile(ctx.fs, ctx.cwd, t.projectKey, t.env);
  const existing = await ctx.fs.read(target);
  const versions = remoteVersions(remote, values);
  let content: string;
  let current: Map<string, string> | null = null;
  let edits: string[] = [];
  if (format === 'json') {
    content = asJson();
    if (existing != null) current = parseJsonVars(existing) ?? new Map();
  } else {
    const parsed = existing != null ? parseDotenv(existing) : null;
    current = parsed?.vars ?? null;
    if (existing != null && current) {
      const header = readHeader(existing);
      if (header && (header.projectKey.toLowerCase() !== t.projectKey.toLowerCase() || header.env !== t.env)) {
        // Bajar prod encima del .env de local (o al revés) es justo lo que no debe pasar sin querer.
        ctx.log(`OJO: ${target} viene de ${header.projectKey}/${header.env}, no de ${label(t)}.`);
        await confirmOrAbort(ctx, `¿Reemplazarlo con ${label(t)}?`, opts.yes ?? false);
      }
      edits = localEdits(header, t, current, remote, values);
    }
    content = serializeDotenv(values, {
      header: headerLines(t.projectKey, t.env, versions, LOCAL_START, LOCAL_END),
      localBlock: parsed?.localBlock ?? null,
    });
  }

  if (existing != null && current) {
    const diff = diffNames(current, values);
    if (diff.added.length + diff.changed.length + diff.removed.length === 0) {
      // Mismos valores; si solo cambió la cabecera (versiones), se actualiza sin preguntar.
      if (format === 'dotenv' && existing !== content) await ctx.fs.write(target, content, 0o600);
      ctx.out(`${target} ya está al día con ${label(t)} (${values.size} variables)`);
      return 0;
    }
    ctx.log(`${target} cambia así (solo nombres):`);
    printDiff(ctx, [
      { sign: '+', names: diff.added, note: 'nueva' },
      { sign: '~', names: diff.changed.filter((n) => !edits.includes(n)), note: 'cambia de valor' },
      { sign: '~', names: edits, note: 'LA CAMBIASTE AQUÍ Y NO LA SUBISTE: se pisa (súbela antes con `zeus env push`)' },
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

/** Tras subir, el archivo queda "al día": su cabecera toma las versiones nuevas de la bóveda. */
async function refreshHeader(ctx: Ctx, key: RegisteredKey, t: Target, file: string): Promise<void> {
  const text = await ctx.fs.read(file);
  const header = text != null ? readHeader(text) : null;
  if (!text || !header || header.projectKey.toLowerCase() !== t.projectKey.toLowerCase() || header.env !== t.env) return;
  const remote = await ctx.api.getEnv(t.projectKey, t.env, key.keyId);
  const local = parseDotenv(text).vars;
  // Solo las que coinciden con la bóveda; el resto conserva la versión que tenía.
  const next = new Map(header.versions);
  for (const s of remote.secrets) if (local.has(s.name) && s.dekVersion === remote.dekVersion) next.set(s.name, s.version);
  for (const n of [...next.keys()]) if (!remote.secrets.some((s) => s.name === n)) next.delete(n);
  const updated = withVersions(text, next);
  if (updated && updated !== text) await ctx.fs.write(file, updated, 0o600);
}

export async function envPush(ctx: Ctx, args: string[]): Promise<number> {
  const { values: opts, positionals } = parse(args, {
    from: { type: 'string' },
    prune: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
  });
  if (positionals.length > 2) throw new UsageError('uso: zeus env push <proyecto> [entorno] [--from <ruta>] [--prune] [--yes]');

  const key = await requireKey(ctx);
  const t = await resolveTarget(ctx, positionals[0], positionals[1]);
  const file = opts.from ? path.resolve(ctx.cwd, opts.from) : await locateEnvFile(ctx.fs, ctx.cwd, t.projectKey, t.env);
  const text = await ctx.fs.read(file);
  if (text == null) throw new CliError(`no existe ${file} (indica otro archivo con --from)`);
  const header = readHeader(text);
  if (header && (header.projectKey.toLowerCase() !== t.projectKey.toLowerCase() || header.env !== t.env)) {
    ctx.log(`OJO: ${file} se bajó de ${header.projectKey}/${header.env} y lo vas a subir a ${label(t)}.`);
    await confirmOrAbort(ctx, `¿Seguro que quieres subirlo a ${label(t)}?`, opts.yes ?? false);
  }
  const parsed = parseDotenv(text);
  if (parsed.problems.length > 0) {
    // Subir un archivo leído a medias podría pisar secretos buenos con valores cortados.
    const lines = parsed.problems.map((p) => `línea ${p.line}: ${p.message}`).join('; ');
    throw new CliError(`${file} tiene líneas que no se pudieron leer y no se subió nada — ${lines}`);
  }
  const local = parsed.vars;
  const invalid = [...local].map(([n, v]) => checkEntry(n, v)).filter((m): m is string => m != null);
  if (invalid.length > 0) throw new CliError(`no se subió nada — ${invalid.join('; ')}`);

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

    // Si alguien cambió una variable DESPUÉS de que este archivo se bajó, subirlo la pisaría.
    const overwritten =
      header && header.projectKey.toLowerCase() === t.projectKey.toLowerCase() && header.env === t.env
        ? diff.changed.filter((n) => {
            const s = remote.secrets.find((x) => x.name === n);
            const had = header.versions.get(n);
            return s != null && had != null && s.version > had;
          })
        : [];

    ctx.log(`${label(t)} cambia así (solo nombres):`);
    printDiff(ctx, [
      { sign: '+', names: diff.added, note: stale.length ? 'nueva o vuelta a cifrar' : 'nueva' },
      { sign: '~', names: diff.changed.filter((n) => !overwritten.includes(n)), note: 'cambia de valor' },
      { sign: '~', names: overwritten, note: 'OTRA PERSONA LA CAMBIÓ después de tu último pull: la pisarías' },
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
    await refreshHeader(ctx, key, t, file).catch(() => undefined);
    return 0;
  } finally {
    zeroize(dek);
  }
}

// ---------------------------------------------------------------- set / rm

/** De dónde sale el valor de `env set`: portapapeles, archivo, o prompt sin eco / stdin. */
async function readValue(ctx: Ctx, name: string, opts: { 'from-clipboard'?: boolean; 'from-file'?: string }): Promise<string> {
  if (opts['from-clipboard'] && opts['from-file']) throw new UsageError('usa --from-clipboard o --from-file, no los dos');
  if (opts['from-clipboard']) {
    try {
      return await ctx.clipboard();
    } catch (err) {
      throw new CliError(err instanceof Error ? err.message : String(err));
    }
  }
  if (opts['from-file']) {
    const file = path.resolve(ctx.cwd, opts['from-file']);
    const text = await ctx.fs.read(file);
    if (text == null) throw new CliError(`no existe ${file}`);
    // Un solo salto final es del editor, no del valor (igual que con stdin).
    return text.replace(/\r?\n$/, '');
  }
  return ctx.prompt.secret(`Valor de ${name} (no se muestra): `);
}

export async function envSet(ctx: Ctx, args: string[]): Promise<number> {
  const { values: opts, positionals } = parse(args, {
    empty: { type: 'boolean' },
    'from-clipboard': { type: 'boolean' },
    'from-file': { type: 'string' },
  });
  const [projectArg, envArg, name] = positionals;
  if (positionals.length !== 3 || !name) {
    // Un cuarto argumento sería el valor: no se acepta para que no quede en el historial del shell.
    throw new UsageError(
      'uso: zeus env set <proyecto> <entorno> NOMBRE [--from-clipboard | --from-file <ruta>]   (sin esas banderas el valor se lee de stdin o se pregunta sin eco; nunca como argumento)',
    );
  }
  if (!isValidSecretName(name)) throw new UsageError(`nombre inválido: ${name} (${NAME_RULE})`);

  const key = await requireKey(ctx);
  const t = await resolveTarget(ctx, projectArg, envArg);
  const value = await readValue(ctx, name, opts);
  if (value === '' && !opts.empty) throw new CliError('el valor llegó vacío y no se cambió nada (si de verdad va vacío, agrega --empty)');
  const problem = checkEntry(name, value);
  if (problem) throw new CliError(problem);

  const { remote, dek } = await openEnv(ctx, key, t);
  try {
    const prev = remote.secrets.find((s) => s.name === name);
    const set = encryptEntries(t, dek, remote.dekVersion, [name], new Map([[name, value]]));
    await ctx.api
      .putSecrets(t.projectKey, t.env, { keyId: key.keyId, dekVersion: remote.dekVersion, set, delete: [] })
      .catch((err: unknown) => staleToCliError(err, t));
    ctx.out(`${label(t)}: ${name} ${prev ? `actualizada (v${prev.version} → v${prev.version + 1})` : 'creada'}. A quien tiene acceso le llega el aviso.`);
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
  await confirmOrAbort(ctx, `¿Borrar ${name} de ${label(t)} para todos? (queda en el historial: \`zeus env restore\` la regresa)`, opts.yes ?? false);
  await ctx.api
    .putSecrets(t.projectKey, t.env, { keyId: key.keyId, dekVersion: remote.dekVersion, set: [], delete: [name] })
    .catch((err: unknown) => staleToCliError(err, t));
  ctx.out(`${label(t)}: ${name} borrada`);
  return 0;
}

// ---------------------------------------------------------------- status

export interface StatusRow {
  name: string;
  version: number | null;
  by: string | null;
  at: string | null;
}

export interface FileStatus {
  file: string;
  projectKey: string;
  env: string;
  /** En la bóveda y no en el archivo. */
  missing: StatusRow[];
  /** La bóveda tiene una versión más nueva que la que bajaste. */
  outdated: Array<StatusRow & { yours: number | null }>;
  /** Las cambiaste en el archivo y no las subiste. */
  localEdits: string[];
  /** En el archivo, nunca en la bóveda: candidatas a subir (o al bloque local). */
  localOnly: string[];
  /** Estaban en la bóveda cuando bajaste y ya no. */
  removedRemote: string[];
  /** Iguales. */
  upToDate: number;
  /** Las pide .env.example y la bóveda no las tiene. */
  requiredMissing: string[];
  needsRotation: boolean;
  error: string | null;
}

const isClean = (s: FileStatus): boolean =>
  !s.error && s.missing.length + s.outdated.length + s.localEdits.length + s.localOnly.length + s.removedRemote.length + s.requiredMissing.length === 0;

/** Compara un archivo con su entorno en la bóveda. Solo nombres; nunca devuelve valores. */
export async function fileStatus(ctx: Ctx, key: RegisteredKey, file: string, t: Target, example: ReadonlySet<string> | null): Promise<FileStatus> {
  const base: FileStatus = {
    file,
    projectKey: t.projectKey,
    env: t.env,
    missing: [],
    outdated: [],
    localEdits: [],
    localOnly: [],
    removedRemote: [],
    upToDate: 0,
    requiredMissing: [],
    needsRotation: false,
    error: null,
  };
  const text = (await ctx.fs.read(file)) ?? '';
  const parsed = parseDotenv(text);
  const header = readHeader(text);
  const mine = header && header.projectKey.toLowerCase() === t.projectKey.toLowerCase() && header.env === t.env ? header : null;
  let opened: { remote: VaultEnv; dek: Buffer };
  try {
    opened = await openEnv(ctx, key, t);
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
  const { remote, dek } = opened;
  let values: Map<string, string>;
  try {
    values = decryptAll(t, remote, dek).values;
  } finally {
    zeroize(dek);
  }
  const local = parsed.vars;
  const localBlock = new Set(parsed.localNames);
  const row = (name: string): StatusRow => {
    const s = remote.secrets.find((x) => x.name === name);
    return { name, version: s?.version ?? null, by: s?.updatedByName ?? null, at: s?.updatedAt ?? null };
  };
  for (const [name, value] of values) {
    if (localBlock.has(name) && !local.has(name)) continue; // la sobrescribe a propósito en su bloque local
    if (!local.has(name)) base.missing.push(row(name));
    else if (local.get(name) === value) base.upToDate++;
    else {
      const s = remote.secrets.find((x) => x.name === name);
      const had = mine?.versions.get(name) ?? null;
      if (had != null && s && had === s.version) base.localEdits.push(name);
      else base.outdated.push({ ...row(name), yours: had });
    }
  }
  for (const name of local.keys()) {
    if (values.has(name)) continue;
    if (remote.secrets.some((s) => s.name === name)) continue; // ilegible (llave anterior): ya avisa pull
    if (mine?.versions.has(name)) base.removedRemote.push(name);
    else base.localOnly.push(name);
  }
  if (example) for (const name of example) if (!remote.secrets.some((s) => s.name === name)) base.requiredMissing.push(name);
  base.needsRotation = !!remote.needsRotation;
  for (const list of [base.localEdits, base.localOnly, base.removedRemote, base.requiredMissing]) list.sort();
  return base;
}

function printStatus(ctx: Ctx, s: FileStatus): void {
  const name = path.relative(ctx.cwd, s.file) || s.file;
  ctx.out(`${name}  ←  ${s.projectKey}/${s.env}`);
  if (s.error) {
    ctx.out(`  ✗ ${s.error}`);
    return;
  }
  const meta = (r: StatusRow) => [r.version != null ? `v${r.version}` : '', r.by ?? '', when(r.at)].filter(Boolean).join(', ');
  for (const r of s.missing) ctx.out(`  + ${r.name}  falta en tu archivo (${meta(r)})`);
  for (const r of s.outdated) {
    ctx.out(`  ~ ${r.name}  desactualizada: ${r.yours != null ? `tienes v${r.yours}, ` : ''}la bóveda tiene ${meta(r)}`);
  }
  for (const n of s.localEdits) ctx.out(`  ↑ ${n}  la cambiaste aquí y no la subiste`);
  for (const n of s.localOnly) ctx.out(`  ? ${n}  solo en tu archivo (súbela o pásala al bloque local)`);
  for (const n of s.removedRemote) ctx.out(`  - ${n}  ya no está en la bóveda`);
  for (const n of s.requiredMissing) ctx.out(`  ! ${n}  la pide .env.example y no está en la bóveda`);
  if (s.needsRotation) ctx.out('  ! el entorno está POR ROTAR (alguien perdió el acceso): un admin corre `zeus env rotate`');
  if (isClean(s)) {
    ctx.out(`  ✓ al día (${s.upToDate} variables)`);
    return;
  }
  const hints: string[] = [];
  if (s.missing.length || s.outdated.length || s.removedRemote.length) hints.push(`zeus env pull ${s.projectKey} ${s.env}`);
  if (s.localEdits.length || s.localOnly.length) hints.push(`zeus env push ${s.projectKey} ${s.env}`);
  if (hints.length) ctx.out(`  → ${hints.join('   ·   ')}`);
}

async function exampleNames(ctx: Ctx): Promise<Set<string> | null> {
  for (const name of ['.env.example', '.env.sample', '.env.template']) {
    const text = await ctx.fs.read(path.join(ctx.cwd, name));
    if (text != null) return new Set([...parseDotenv(text).vars.keys()]);
  }
  return null;
}

/** Los archivos de esta carpeta que bajó zeus, ya comparados con la bóveda. */
export async function folderStatus(ctx: Ctx, key: RegisteredKey): Promise<FileStatus[]> {
  const found = await findZeusFiles(ctx.fs, ctx.cwd);
  const example = await exampleNames(ctx);
  const out: FileStatus[] = [];
  for (const f of found) {
    const t = await resolveTarget(ctx, f.header.projectKey, f.header.env);
    // .env.example describe el entorno de trabajo, no prod: solo se exige al de development.
    out.push(await fileStatus(ctx, key, f.file, t, t.env === 'development' ? example : null));
  }
  return out;
}

export async function envStatus(ctx: Ctx, args: string[]): Promise<number> {
  const { values: opts, positionals } = parse(args, { file: { type: 'string' }, json: { type: 'boolean' } });
  if (positionals.length > 2) throw new UsageError('uso: zeus env status [<proyecto> [entorno]] [--file <ruta>] [--json]');
  const key = await requireKey(ctx);

  let results: FileStatus[];
  if (positionals.length === 0 && !opts.file) {
    results = await folderStatus(ctx, key);
    if (results.length === 0) {
      if (opts.json) ctx.out('[]');
      else ctx.out('no hay archivos .env de zeus en esta carpeta. Baja uno con `zeus env pull <proyecto> [entorno]` (development → .env, production → .env.production).');
      return 0;
    }
  } else {
    let t: Target;
    let file: string;
    if (positionals.length === 0) {
      file = path.resolve(ctx.cwd, opts.file!);
      const text = await ctx.fs.read(file);
      const header = text != null ? readHeader(text) : null;
      if (!header) throw new CliError(`${file} no tiene cabecera de zeus: di de qué proyecto y entorno es (\`zeus env status <proyecto> <entorno> --file ${opts.file}\`)`);
      t = await resolveTarget(ctx, header.projectKey, header.env);
    } else {
      t = await resolveTarget(ctx, positionals[0], positionals[1]);
      file = opts.file ? path.resolve(ctx.cwd, opts.file) : await locateEnvFile(ctx.fs, ctx.cwd, t.projectKey, t.env);
    }
    if ((await ctx.fs.read(file)) == null) {
      if (opts.json) ctx.out(JSON.stringify([{ file, projectKey: t.projectKey, env: t.env, error: 'no existe' }]));
      else ctx.out(`${file} no existe: \`zeus env pull ${t.projectKey} ${t.env}\` lo crea`);
      return 0;
    }
    results = [await fileStatus(ctx, key, file, t, t.env === 'development' ? await exampleNames(ctx) : null)];
  }

  if (opts.json) ctx.out(JSON.stringify(results));
  else results.forEach((r, i) => {
    if (i) ctx.out('');
    printStatus(ctx, r);
  });
  return 0;
}

// ---------------------------------------------------------------- diff entre entornos

export async function envDiff(ctx: Ctx, args: string[]): Promise<number> {
  const { values: opts, positionals } = parse(args, { json: { type: 'boolean' } });
  if (positionals.length !== 3) throw new UsageError('uso: zeus env diff <proyecto> <entorno A> <entorno B> [--json]   (p. ej. zeus env diff orwel local prod)');
  const key = await requireKey(ctx);
  const a = await resolveTarget(ctx, positionals[0], positionals[1]);
  const b = await resolveTarget(ctx, positionals[0], positionals[2]);
  if (a.env === b.env) throw new UsageError('son el mismo entorno');
  const read = async (t: Target): Promise<Map<string, string>> => {
    const { remote, dek } = await openEnv(ctx, key, t);
    try {
      return decryptAll(t, remote, dek).values;
    } finally {
      zeroize(dek);
    }
  };
  const [va, vb] = [await read(a), await read(b)];
  const d = diffNames(va, vb);
  // diffNames(a, b): "added" = solo en B, "removed" = solo en A.
  const result = { a: label(a), b: label(b), onlyA: d.removed, onlyB: d.added, different: d.changed, same: d.same };
  if (opts.json) {
    ctx.out(JSON.stringify(result));
    return 0;
  }
  ctx.out(`${label(a)}  vs  ${label(b)}   (solo nombres)`);
  for (const n of result.onlyA) ctx.out(`  < ${n}  solo en ${a.env}`);
  for (const n of result.onlyB) ctx.out(`  > ${n}  solo en ${b.env}`);
  for (const n of result.different) ctx.out(`  ≠ ${n}  valor distinto`);
  ctx.out(`  = ${result.same.length} con el mismo valor${result.same.length ? ` (${result.same.join(', ')})` : ''}`);
  if (result.same.length) ctx.log('  ojo: un secreto con el MISMO valor en dos entornos suele ser un error (p. ej. la llave de prod usada en local).');
  return 0;
}

// ---------------------------------------------------------------- historial

interface DecryptedRevision extends VaultRevision {
  value: string | null;
  readable: boolean;
}

function decryptRevisions(t: Target, revisions: VaultRevision[], dekVersion: number, dek: Buffer): DecryptedRevision[] {
  return revisions.map((r) => {
    if (r.ciphertext == null) return { ...r, value: null, readable: true };
    if (r.dekVersion !== dekVersion) return { ...r, value: null, readable: false };
    try {
      return { ...r, value: decryptSecret(dek, r.ciphertext, secretAad(t.projectKey, t.env, r.name, r.dekVersion)), readable: true };
    } catch (err) {
      if (err instanceof VaultCryptoError) return { ...r, value: null, readable: false };
      throw err;
    }
  });
}

async function openHistory(ctx: Ctx, key: RegisteredKey, t: Target, name?: string): Promise<DecryptedRevision[]> {
  const { remote, dek } = await openEnv(ctx, key, t);
  try {
    const h = await ctx.api.history(t.projectKey, t.env, key.keyId, name);
    return decryptRevisions(t, h.revisions, remote.dekVersion, dek);
  } finally {
    zeroize(dek);
  }
}

export async function envHistory(ctx: Ctx, args: string[]): Promise<number> {
  const { values: opts, positionals } = parse(args, { json: { type: 'boolean' } });
  if (positionals.length < 2 || positionals.length > 3) throw new UsageError('uso: zeus env history <proyecto> <entorno> [NOMBRE] [--json]');
  const name = positionals[2];
  if (name && !isValidSecretName(name)) throw new UsageError(`nombre inválido: ${name}`);
  const key = await requireKey(ctx);
  const t = await resolveTarget(ctx, positionals[0], positionals[1]);
  const revs = await openHistory(ctx, key, t, name);

  // Nunca valores: solo qué versiones tienen el mismo valor entre sí ("= v2").
  const rows = revs.map((r) => {
    const twin = r.value != null ? revs.find((o) => o.name === r.name && o.version < r.version && o.value === r.value) : undefined;
    return {
      name: r.name,
      version: r.version,
      current: r.current,
      deleted: r.ciphertext == null,
      readable: r.readable,
      setAt: r.setAt,
      setBy: r.setByName,
      sameValueAs: twin?.version ?? null,
    };
  });
  if (opts.json) {
    ctx.out(JSON.stringify(rows));
    return 0;
  }
  if (rows.length === 0) {
    ctx.out(name ? `${label(t)} no tiene historial de ${name}` : `${label(t)} no tiene variables`);
    return 0;
  }
  let lastName = '';
  for (const r of rows) {
    if (r.name !== lastName) {
      ctx.out(r.name);
      lastName = r.name;
    }
    const tag = r.current ? 'actual ' : r.deleted ? 'borrada' : !r.readable ? 'ilegible' : '       ';
    ctx.out(`  v${String(r.version).padEnd(3)} ${tag}  ${when(r.setAt).padEnd(20)}  ${(r.setBy ?? '—').padEnd(14)}${r.sameValueAs != null ? `  mismo valor que v${r.sameValueAs}` : ''}`);
  }
  ctx.log(`para volver a una versión: zeus env restore ${t.projectKey} ${t.env} NOMBRE --version N`);
  return 0;
}

export async function envRestore(ctx: Ctx, args: string[]): Promise<number> {
  const { values: opts, positionals } = parse(args, { version: { type: 'string' }, yes: { type: 'boolean', short: 'y' } });
  const [projectArg, envArg, name] = positionals;
  const version = Number(opts.version);
  if (positionals.length !== 3 || !name || !Number.isInteger(version) || version < 1) {
    throw new UsageError('uso: zeus env restore <proyecto> <entorno> NOMBRE --version N [--yes]   (las versiones: zeus env history)');
  }
  const key = await requireKey(ctx);
  const t = await resolveTarget(ctx, projectArg, envArg);
  const revs = await openHistory(ctx, key, t, name);
  const target = revs.find((r) => r.version === version);
  if (!target) throw new CliError(`${label(t)} no tiene la versión ${version} de ${name} (ve las que hay con \`zeus env history ${t.projectKey} ${t.env} ${name}\`)`);
  if (target.current) {
    ctx.out(`${name} ya está en la v${version}`);
    return 0;
  }
  if (target.ciphertext == null) throw new CliError(`en la v${version} ${name} estaba borrada; para borrarla usa \`zeus env rm\``);
  if (!target.readable || target.value == null) throw new CliError(`la v${version} de ${name} quedó cifrada con una llave anterior y ya no se puede leer`);
  const value = target.value;

  const cur = revs.find((r) => r.current);
  await confirmOrAbort(
    ctx,
    `¿Regresar ${name} de ${label(t)} al valor de la v${version} (${target.setByName ?? 'alguien'}, ${when(target.setAt)})? Queda como v${(cur?.version ?? Math.max(...revs.map((r) => r.version))) + 1}.`,
    opts.yes ?? false,
  );
  const { remote, dek } = await openEnv(ctx, key, t);
  try {
    const set = encryptEntries(t, dek, remote.dekVersion, [name], new Map([[name, value]]));
    await ctx.api
      .putSecrets(t.projectKey, t.env, { keyId: key.keyId, dekVersion: remote.dekVersion, set, delete: [] })
      .catch((err: unknown) => staleToCliError(err, t));
  } finally {
    zeroize(dek);
  }
  ctx.out(`${label(t)}: ${name} regresó al valor de la v${version}`);
  return 0;
}
