// env init / grant / revoke / rotate: lo que hace un admin de zeus. El servidor nunca ve la DEK:
// dar acceso es que ESTE equipo, que ya la tiene, la envuelva para la pública de otro.
import { CliError, UsageError, confirmOrAbort, type Ctx } from '../context.js';
import { VaultCryptoError, encryptSecret, fingerprint, generateDek, secretAad, unwrapDek, wrapAad, wrapDek, zeroize } from '../crypto.js';
import { loadKnownKeys, rememberKeys } from '../store.js';
import type { VaultKey, WrappedGrant } from '../types.js';
import { decryptAll, label, openEnv, parse, requireKey, resolveTarget, staleToCliError } from './vault.js';

/** Huella calculada AQUÍ con la pública; si zeus manda otra, algo anda mal y no se sigue. */
function localFingerprint(key: VaultKey): string {
  let fp: string;
  try {
    fp = fingerprint(key.publicKey);
  } catch (err) {
    if (err instanceof VaultCryptoError) throw new CliError(`la llave ${key.id} (${key.devName}) no es válida: ${err.message}`);
    throw err;
  }
  if (key.fingerprint && key.fingerprint !== fp) {
    throw new CliError(`la huella que reporta zeus para la llave ${key.id} (${key.devName}) no corresponde a su llave pública; no se continuó`);
  }
  return fp;
}

// ---------------------------------------------------------------- init

export async function envInit(ctx: Ctx, args: string[]): Promise<number> {
  const { positionals } = parse(args, {});
  if (positionals.length > 2) throw new UsageError('uso: zeus env init <proyecto> [entorno]');
  const key = await requireKey(ctx);
  const t = await resolveTarget(ctx, positionals[0], positionals[1]);
  if (t.exists) throw new CliError(`${label(t)} ya existe. Para entrar pide acceso (\`zeus env grant\`); para cambiar su llave, \`zeus env rotate\`.`);

  const dek = generateDek();
  let wrappedDek: string;
  try {
    wrappedDek = wrapDek(dek, key.publicKey, wrapAad(t.projectKey, t.env, 1));
  } finally {
    zeroize(dek);
  }
  const res = await ctx.api.createEnv({ projectKey: t.projectKey, env: t.env, keyId: key.keyId, wrappedDek });
  if (res.dekVersion !== 1) {
    throw new CliError(`zeus creó ${label(t)} con la versión de llave ${res.dekVersion} y se esperaba 1: el entorno no se puede abrir; avísale a quien mantiene zeus`);
  }
  // El proyecto y el entorno entran en el cifrado tal cual se escribieron. Si zeus los guardó con
  // otra forma (mayúsculas, p. ej.), nadie podría abrir la llave: mejor saberlo ahora, vacío.
  const after = await resolveTarget(ctx, t.projectKey, t.env);
  if (after.exists && (after.projectKey !== t.projectKey || after.env !== t.env)) {
    throw new CliError(
      `zeus guardó el entorno como ${label(after)} y se cifró como ${label(t)}: así no se puede abrir. Pide que lo borren y créalo de nuevo con \`zeus env init ${after.projectKey} ${after.env}\`.`,
    );
  }
  await rememberKeys(ctx.fs, ctx.home, [{ keyId: key.keyId, fingerprint: key.fingerprint }]);
  ctx.out(`${label(t)} creado; este equipo (${key.name}) es el primero con acceso.`);
  ctx.out(`siguiente: \`zeus env push ${t.projectKey} ${t.env}\` para subir tu .env y \`zeus env grant ${t.projectKey} ${t.env} --to <dev>\` para dar acceso.`);
  return 0;
}

// ---------------------------------------------------------------- grant

const describeKey = (k: VaultKey, fp: string): string => `${k.devName} · equipo "${k.name}" · huella ${fp} · id ${k.id}`;

/** Llaves a las que apunta `--to`: un id de llave, o las de un dev (por id, nombre o correo). */
export function selectKeys(keys: VaultKey[], to: string): { keys: VaultKey[]; byKeyId: boolean } {
  const wanted = to.trim();
  const lower = wanted.toLowerCase();
  const byId = keys.find((k) => k.id === wanted);
  if (byId) return { keys: [byId], byKeyId: true };

  let matches: VaultKey[];
  if (wanted.includes('@')) {
    if (!keys.some((k) => k.devEmail)) {
      throw new CliError(`este zeus no manda el correo de cada llave: usa el nombre del dev o el id de su llave (\`zeus key show\` en su equipo) en --to`);
    }
    matches = keys.filter((k) => k.devEmail?.toLowerCase() === lower);
  } else {
    matches = keys.filter((k) => k.devId === wanted || k.devName.toLowerCase() === lower);
    if (matches.length === 0) matches = keys.filter((k) => k.devName.toLowerCase().includes(lower));
  }
  const devs = new Map(matches.map((k) => [k.devId, k.devName]));
  if (devs.size === 0) throw new CliError(`nadie con llave registrada coincide con "${to}". La persona debe correr \`zeus key init\` primero.`);
  if (devs.size > 1) throw new CliError(`"${to}" coincide con varias personas (${[...devs.values()].join(', ')}): sé más específico o usa el id de la llave`);
  return { keys: matches, byKeyId: false };
}

export async function envGrant(ctx: Ctx, args: string[]): Promise<number> {
  const { values: opts, positionals } = parse(args, {
    to: { type: 'string' },
    'all-devices': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
  });
  if (positionals.length > 2 || !opts.to) throw new UsageError('uso: zeus env grant <proyecto> [entorno] --to <dev, correo o id de llave> [--all-devices]');

  const key = await requireKey(ctx);
  const t = await resolveTarget(ctx, positionals[0], positionals[1]);
  const { remote, dek } = await openEnv(ctx, key, t);
  try {
    const selected = selectKeys((await ctx.api.listKeys(true)).keys, opts.to);
    const active = selected.keys.filter((k) => !k.revokedAt);
    if (active.length === 0) throw new CliError(`las llaves de "${opts.to}" están revocadas: la persona debe correr \`zeus key init --force\``);
    const fps = new Map(active.map((k) => [k.id, localFingerprint(k)]));
    const fpOf = (k: VaultKey): string => fps.get(k.id) ?? '';
    if (!selected.byKeyId && active.length > 1 && !opts['all-devices']) {
      for (const k of active) ctx.log(`  ${describeKey(k, fpOf(k))}`);
      throw new CliError(`${active[0]?.devName} tiene ${active.length} equipos: elige uno con --to <id de llave> o todos con --all-devices`);
    }

    const granted = new Set(remote.grants.map((g) => g.keyId));
    const targets = active.filter((k) => !granted.has(k.id));
    for (const k of active.filter((x) => granted.has(x.id))) ctx.log(`ya tiene acceso: ${describeKey(k, fpOf(k))}`);
    if (targets.length === 0) {
      ctx.out(`nada que hacer: ${label(t)} ya está compartido con esos equipos`);
      return 0;
    }

    ctx.log(`Vas a dar acceso a ${label(t)} (todos sus secretos) a:`);
    for (const k of targets) ctx.log(`  ${describeKey(k, fpOf(k))}`);
    const who = targets[0]?.devName ?? 'la persona';
    await confirmOrAbort(
      ctx,
      `¿${who} te leyó ${targets.length === 1 ? 'esta huella' : 'estas huellas'} por un canal distinto a zeus (en persona o por llamada) y coincide${targets.length === 1 ? '' : 'n'}?`,
      opts.yes ?? false,
    );

    const aad = wrapAad(t.projectKey, t.env, remote.dekVersion);
    const grants: WrappedGrant[] = targets.map((k) => ({ keyId: k.id, wrappedDek: wrapDek(dek, k.publicKey, aad) }));
    const res = await ctx.api.grant(t.projectKey, t.env, { keyId: key.keyId, grants });
    await rememberKeys(ctx.fs, ctx.home, targets.map((k) => ({ keyId: k.id, fingerprint: fpOf(k) })));
    ctx.out(`${label(t)}: acceso dado a ${res.granted} equipo(s) de ${who}. Ya puede correr \`zeus env pull ${t.projectKey} ${t.env}\`.`);
    return 0;
  } finally {
    zeroize(dek);
  }
}

// ---------------------------------------------------------------- revoke

export async function envRevoke(ctx: Ctx, args: string[]): Promise<number> {
  const { values: opts, positionals } = parse(args, { key: { type: 'string' }, yes: { type: 'boolean', short: 'y' } });
  if (positionals.length > 2 || !opts.key) throw new UsageError('uso: zeus env revoke <proyecto> [entorno] --key <id de llave>');
  const t = await resolveTarget(ctx, positionals[0], positionals[1]);
  await confirmOrAbort(ctx, `¿Quitar el acceso de la llave ${opts.key} a ${label(t)}?`, opts.yes ?? false);
  await ctx.api.revokeGrant(t.projectKey, t.env, opts.key);
  ctx.out(`${label(t)}: acceso quitado a la llave ${opts.key}.`);
  ctx.log('OJO: esa persona ya vio los valores (y puede tener copia). Quitarle el acceso solo evita que baje los nuevos.');
  ctx.log(`Lo que de verdad lo arregla: \`zeus env rotate ${t.projectKey} ${t.env}\` Y cambiar en su proveedor (Supabase, Stripe, etc.) los secretos que importen.`);
  return 0;
}

// ---------------------------------------------------------------- rotate

export async function envRotate(ctx: Ctx, args: string[]): Promise<number> {
  const { values: opts, positionals } = parse(args, { yes: { type: 'boolean', short: 'y' } });
  if (positionals.length > 2) throw new UsageError('uso: zeus env rotate <proyecto> [entorno]');

  const key = await requireKey(ctx);
  const t = await resolveTarget(ctx, positionals[0], positionals[1]);
  const { remote, dek: oldDek } = await openEnv(ctx, key, t);
  let values: Map<string, string>;
  try {
    const res = decryptAll(t, remote, oldDek);
    if (res.stale.length > 0) {
      throw new CliError(
        `no se puede rotar ${label(t)}: ${res.stale.join(', ')} quedaron cifrados con una llave anterior y no se pueden leer. Vuelve a subirlos (\`zeus env set\`) o bórralos (\`zeus env rm\`) y repite.`,
      );
    }
    values = res.values;
  } finally {
    zeroize(oldDek);
  }

  const byId = new Map((await ctx.api.listKeys(true)).keys.map((k) => [k.id, k]));
  const known = await loadKnownKeys(ctx.fs, ctx.home);
  const recipients: Array<{ keyId: string; publicKey: string; text: string }> = [];
  for (const g of remote.grants) {
    if (g.keyId === key.keyId) {
      // La propia sale del disco, no de lo que diga el servidor.
      recipients.push({ keyId: key.keyId, publicKey: key.publicKey, text: `${g.devName} · equipo "${key.name}" · huella ${key.fingerprint} · este equipo` });
      continue;
    }
    const k = byId.get(g.keyId);
    if (!k) throw new CliError(`${label(t)} tiene acceso para la llave ${g.keyId}, pero zeus no la lista: no se rotó nada`);
    if (k.revokedAt) {
      ctx.log(`se queda fuera (llave revocada): ${describeKey(k, k.fingerprint)}`);
      continue;
    }
    const fp = localFingerprint(k);
    if (g.fingerprint && g.fingerprint !== fp) throw new CliError(`la huella del acceso de ${k.devName} no corresponde a su llave pública; no se rotó nada`);
    const pinned = known[k.id];
    if (pinned && pinned !== fp) {
      throw new CliError(
        `la llave ${k.id} de ${k.devName} ya NO es la que verificaste en este equipo (antes ${pinned}, ahora ${fp}). No se rotó nada: avísale a quien mantiene zeus.`,
      );
    }
    recipients.push({ keyId: k.id, publicKey: k.publicKey, text: `${describeKey(k, fp)}${pinned ? '' : ' · no verificada en este equipo'}` });
  }
  if (!recipients.some((r) => r.keyId === key.keyId)) throw new CliError(`este equipo no aparece entre los accesos de ${label(t)}; no se rotó nada`);

  const newVersion = remote.dekVersion + 1;
  ctx.log(`Rotar ${label(t)}: llave v${remote.dekVersion} → v${newVersion}, ${values.size} secreto(s) se vuelven a cifrar. Conservan acceso:`);
  for (const r of recipients) ctx.log(`  ${r.text}`);
  await confirmOrAbort(ctx, '¿Rotar la llave del entorno para estos equipos?', opts.yes ?? false);

  const newDek = generateDek();
  try {
    const aad = wrapAad(t.projectKey, t.env, newVersion);
    const grants: WrappedGrant[] = recipients.map((r) => ({ keyId: r.keyId, wrappedDek: wrapDek(newDek, r.publicKey, aad) }));
    const secrets = [...values].map(([name, value]) => ({
      name,
      ciphertext: encryptSecret(newDek, value, secretAad(t.projectKey, t.env, name, newVersion)),
    }));
    // Antes de mandar nada: este equipo debe poder abrir la llave nueva, o el entorno quedaría huérfano.
    const own = grants.find((g) => g.keyId === key.keyId);
    const check = own ? unwrapDek(own.wrappedDek, key.privateKey, key.publicKey, aad) : null;
    const ok = check != null && check.equals(newDek);
    zeroize(check);
    if (!ok) throw new CliError('la verificación local de la llave nueva falló; no se rotó nada');

    const res = await ctx.api
      .rotate(t.projectKey, t.env, { keyId: key.keyId, dekVersion: newVersion, grants, secrets })
      .catch((err: unknown) => staleToCliError(err, t));
    ctx.out(`${label(t)}: llave rotada a v${res.dekVersion}; ${secrets.length} secreto(s) y ${grants.length} acceso(s) re-cifrados.`);
    ctx.log('Rotar la bóveda NO cambia los secretos en su proveedor: quien los vio los sigue conociendo.');
    ctx.log(`Cambia en el proveedor los que importen y súbelos con \`zeus env set ${t.projectKey} ${t.env} NOMBRE\`. Los demás devs: \`zeus env pull\`.`);
    return 0;
  } finally {
    zeroize(newDek);
  }
}
