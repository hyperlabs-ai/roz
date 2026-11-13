// login, whoami y mcp: conectar este equipo con zeus.
import { ZeusApiError, normalizeUrl, type ZeusApi } from '../api.js';
import { CliError, type Ctx } from '../context.js';
import { TOKEN_RE, configPath, loadConfig, loadDeviceKey, maskToken, saveConfig } from '../store.js';
import { parse } from './vault.js';

export type LoginDeps = Pick<Ctx, 'fs' | 'prompt' | 'out' | 'home' | 'env'> & {
  /** Arma un cliente para una URL y token que todavía no están guardados. */
  connect(url: string, token: string): ZeusApi;
};

export async function login(deps: LoginDeps, args: string[]): Promise<number> {
  const { values } = parse(args, { url: { type: 'string' }, token: { type: 'string' } });
  const prev = await loadConfig(deps.fs, deps.home, {}).catch(() => null);

  const rawUrl = values.url ?? deps.env.ZEUS_URL ?? prev?.url ?? (deps.prompt.interactive ? await deps.prompt.ask('URL de zeus (https://…): ') : '');
  if (!rawUrl) throw new CliError('falta la URL de zeus: pásala con --url o en ZEUS_URL');
  const url = normalizeUrl(rawUrl);

  let token = (values.token ?? deps.env.ZEUS_TOKEN ?? '').trim();
  if (!token) {
    if (!deps.prompt.interactive) throw new CliError('falta el token: pásalo con --token o en ZEUS_TOKEN');
    token = (await deps.prompt.secret('Token de zeus (zeus_…, no se muestra): ')).trim();
  }
  if (!TOKEN_RE.test(token)) {
    throw new CliError('ese no parece un token de zeus (zeus_ y 43 caracteres). Créalo en el dashboard: zeus → Acceso → Nuevo token.');
  }

  let me;
  try {
    me = await deps.connect(url, token).whoami();
  } catch (err) {
    if (err instanceof ZeusApiError) throw new CliError(`no se guardó nada: ${err.message}`);
    throw err;
  }
  await saveConfig(deps.fs, deps.home, { url, token });
  deps.out(`conectado a ${url} como ${me.dev.name}${me.zeusAdmin ? ' (admin de zeus)' : ''}`);
  deps.out(`config: ${configPath(deps.home)}`);
  if (!(await loadDeviceKey(deps.fs, deps.home).catch(() => null))) {
    deps.out('siguiente paso: `zeus key init` para crear la llave de la bóveda de este equipo.');
  }
  return 0;
}

export async function whoami(ctx: Ctx): Promise<number> {
  const me = await ctx.api.whoami();
  ctx.out(`zeus:   ${ctx.url}`);
  ctx.out(`dev:    ${me.dev.name}${me.dev.email ? ` <${me.dev.email}>` : ''}${me.zeusAdmin ? ' · admin de zeus' : ''}`);
  const key = await loadDeviceKey(ctx.fs, ctx.home);
  ctx.out(
    key
      ? `equipo: ${key.name} · huella ${key.fingerprint}${key.keyId && key.url === ctx.url ? '' : ' · sin registrar (corre `zeus key init`)'}`
      : 'equipo: sin llave de la bóveda (corre `zeus key init`)',
  );
  return 0;
}

export async function mcp(ctx: Pick<Ctx, 'out' | 'log' | 'url'>, token: string): Promise<number> {
  // Aquí SÍ se imprime el token completo: la persona tiene que pegarlo en su terminal.
  ctx.log(`Conecta Claude Code con zeus (token ${maskToken(token)}). El comando de abajo lleva tu token completo:`);
  ctx.log('no lo pegues en chats ni en capturas de pantalla.');
  ctx.out(`claude mcp add --transport http zeus ${ctx.url}/mcp --header "Authorization: Bearer ${token}"`);
  return 0;
}
