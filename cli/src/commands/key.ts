// key init / key show: la llave X25519 de este equipo.
import { CliError, UsageError, confirmOrAbort, type Ctx } from '../context.js';
import { VaultCryptoError, fingerprint, generateDeviceKey, unwrapDek, wrapAad, wrapDek, zeroize } from '../crypto.js';
import { keyPath, loadDeviceKey, rememberKeys, saveDeviceKey, type DeviceKeyFile } from '../store.js';
import type { KeyRotateBody, VaultKey } from '../types.js';
import { parse, requireKey } from './vault.js';

export async function keyCommand(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'init') return keyInit(ctx, rest);
  if (sub === 'rotate') return keyRotate(ctx, rest);
  if (sub === 'show' || sub === undefined) return keyShow(ctx);
  throw new UsageError(`subcomando desconocido: key ${sub} (usa: key init | key rotate | key show)`);
}

/**
 * Cambia la llave de ESTE equipo sin pedirle nada a nadie: abre cada llave de entorno con la vieja,
 * la envuelve para la nueva, y zeus mueve los accesos y revoca la vieja. Si algo falla antes del
 * último paso, la vieja sigue sirviendo.
 */
export async function keyRotate(ctx: Ctx, args: string[]): Promise<number> {
  const { values } = parse(args, { compromised: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' } });
  const old = await requireKey(ctx);
  const { projects } = await ctx.api.listProjects();
  const envs = projects.flatMap((p) => p.envs.filter((e) => e.hasGrant).map((e) => ({ projectKey: p.key, env: e.name })));

  ctx.log(`Se cambia la llave de "${old.name}" (huella ${old.fingerprint}); conserva acceso a ${envs.length} entorno(s).`);
  if (values.compromised) ctx.log('Con --compromised esos entornos quedan POR ROTAR: un admin debe correr `zeus env rotate --all`.');
  await confirmOrAbort(ctx, '¿Cambiar la llave de este equipo?', values.yes ?? false);

  // La nueva primero a disco (aparte), para no perder nada si el registro o la red fallan.
  const pair = generateDeviceKey();
  const fresh: DeviceKeyFile = {
    version: 1,
    name: old.name,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    fingerprint: fingerprint(pair.publicKey),
    keyId: null,
    url: null,
    createdAt: new Date().toISOString(),
  };
  const pendingPath = `${keyPath(ctx.home)}.new`;
  await ctx.fs.write(pendingPath, JSON.stringify(fresh, null, 2) + '\n', 0o600);
  const registered = (await ctx.api.registerKey({ name: fresh.name, publicKey: fresh.publicKey })).key;
  if (registered.publicKey !== fresh.publicKey) throw new CliError('zeus registró una llave distinta a la de este equipo; no se cambió nada');

  const grants: KeyRotateBody['grants'] = [];
  for (const e of envs) {
    const remote = await ctx.api.getEnv(e.projectKey, e.env, old.keyId);
    const aad = wrapAad(e.projectKey, e.env, remote.dekVersion);
    let dek: Buffer | null = null;
    try {
      dek = unwrapDek(remote.wrappedDek, old.privateKey, old.publicKey, aad);
      grants.push({ projectKey: e.projectKey, env: e.env, dekVersion: remote.dekVersion, wrappedDek: wrapDek(dek, fresh.publicKey, aad) });
    } catch (err) {
      if (err instanceof VaultCryptoError) throw new CliError(`${e.projectKey}/${e.env}: ${err.message}; no se cambió nada`);
      throw err;
    } finally {
      zeroize(dek);
    }
  }
  const res = await ctx.api.rotateDeviceKey({ oldKeyId: old.keyId, newKeyId: registered.id, grants, compromised: values.compromised ?? false });

  const file = keyPath(ctx.home);
  const previous = await ctx.fs.read(file);
  if (previous != null) await ctx.fs.write(`${file}.old`, previous, 0o600);
  await saveDeviceKey(ctx.fs, ctx.home, { ...fresh, keyId: registered.id, url: ctx.url });
  await ctx.fs.remove(pendingPath);
  await rememberKeys(ctx.fs, ctx.home, [{ keyId: registered.id, fingerprint: fresh.fingerprint }]);
  ctx.out(`llave nueva de "${fresh.name}": huella ${fresh.fingerprint} · id ${registered.id}. ${res.moved} acceso(s) movidos; la vieja quedó revocada.`);
  ctx.log(`la vieja quedó en ${file}.old por si acaso; ya no sirve en zeus y puedes borrarla.`);
  return 0;
}

export async function keyInit(ctx: Ctx, args: string[]): Promise<number> {
  const { values } = parse(args, { name: { type: 'string' }, force: { type: 'boolean' } });
  const file = keyPath(ctx.home);
  const existing = await loadDeviceKey(ctx.fs, ctx.home);

  let key: DeviceKeyFile;
  if (existing && !values.force) {
    if (existing.keyId && existing.url === ctx.url) {
      throw new CliError(
        `este equipo ya tiene llave (huella ${existing.fingerprint}). Con --force se genera otra y este equipo PIERDE el acceso a todos los entornos hasta que un admin se lo vuelva a dar.`,
      );
    }
    // Se generó pero no se alcanzó a registrar (o es otro zeus): se registra la misma, no se pisa.
    key = { ...existing, name: values.name ?? existing.name, fingerprint: fingerprint(existing.publicKey), keyId: null, url: null };
  } else {
    if (existing) {
      const raw = await ctx.fs.read(file);
      if (raw != null) await ctx.fs.write(`${file}.bak`, raw, 0o600);
    }
    const pair = generateDeviceKey();
    key = {
      version: 1,
      name: values.name ?? ctx.hostname,
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      fingerprint: fingerprint(pair.publicKey),
      keyId: null,
      url: null,
      createdAt: new Date().toISOString(),
    };
  }
  if (!key.name.trim()) throw new UsageError('el nombre del equipo no puede ir vacío');

  // Primero al disco: si el registro falla, la llave no se pierde y `key init` la retoma.
  await saveDeviceKey(ctx.fs, ctx.home, key);

  const mine = (await ctx.api.listKeys()).keys.find((k) => k.publicKey === key.publicKey);
  let registered: VaultKey;
  if (mine) {
    if (mine.revokedAt) throw new CliError('la llave de este equipo fue revocada en zeus: genera otra con `zeus key init --force`');
    registered = mine;
  } else {
    registered = (await ctx.api.registerKey({ name: key.name, publicKey: key.publicKey })).key;
  }
  if (registered.publicKey !== key.publicKey || (registered.fingerprint && registered.fingerprint !== key.fingerprint)) {
    throw new CliError('zeus registró una llave distinta a la de este equipo; no la uses y avísale a un admin');
  }
  key = { ...key, keyId: registered.id, url: ctx.url };
  await saveDeviceKey(ctx.fs, ctx.home, key);
  await rememberKeys(ctx.fs, ctx.home, [{ keyId: registered.id, fingerprint: key.fingerprint }]);

  ctx.out(`llave de "${key.name}" registrada en zeus`);
  ctx.out(`  id:     ${registered.id}`);
  ctx.out(`  huella: ${key.fingerprint}`);
  ctx.out(`  archivo: ${file} (la privada nunca sale de este equipo; si lo borras pierdes el acceso)`);
  if (ctx.platform === 'win32') {
    ctx.out('  nota: en Windows los permisos 0600 no aplican; el archivo queda protegido por tu perfil de usuario.');
  }
  ctx.out('');
  ctx.out('Antes de que te den acceso, léele la huella EN VOZ ALTA a un admin (en persona o por llamada, no por chat).');
  ctx.out(`El admin corre: zeus env grant <proyecto> <entorno> --to ${registered.id}`);
  return 0;
}

export async function keyShow(ctx: Pick<Ctx, 'fs' | 'home' | 'out' | 'url'>): Promise<number> {
  const key = await loadDeviceKey(ctx.fs, ctx.home);
  if (!key) throw new CliError('este equipo no tiene llave de la bóveda: corre `zeus key init`');
  ctx.out(`equipo:  ${key.name}`);
  ctx.out(`pública: ${key.publicKey}`);
  ctx.out(`huella:  ${fingerprint(key.publicKey)}`);
  ctx.out(`id:      ${key.keyId && key.url === ctx.url ? key.keyId : '(sin registrar en este zeus: corre `zeus key init`)'}`);
  return 0;
}
