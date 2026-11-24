// zeus en memoria para los tests de comandos. Cumple el contrato de docs/zeus-contracts.md §4 a
// nivel HTTP (se usa con el ZeusClient real) y, como el servidor de verdad, SOLO guarda texto
// cifrado: no tiene ninguna llave. Registra el cuerpo crudo de cada petición para poder afirmar
// que nunca recibió un valor en claro.
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { ZeusClient, type FetchLike } from '../src/api.js';
import type { Ctx, FileOps, Prompter } from '../src/context.js';
import type { VaultKey } from '../src/types.js';

const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const WRAPPED_DEK_RE = /^zv1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{64}$/;
const SECRET_RE = /^zs1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const ZEUS_URL = 'https://zeus.test';

interface Dev {
  id: string;
  name: string;
  email: string;
  admin: boolean;
  token: string;
}

interface StoredSecret {
  ciphertext: string;
  dekVersion: number;
  version: number;
  updatedAt: string;
  updatedByName?: string;
}

interface StoredEnv {
  id: string;
  projectKey: string;
  name: string;
  dekVersion: number;
  /** keyId → { versión de la DEK, DEK envuelta }. */
  grants: Map<string, { dekVersion: number; wrappedDek: string }>;
  secrets: Map<string, StoredSecret>;
  /** Versiones anteriores (ciphertext null = borrada en esa versión). */
  revisions: Array<{ name: string; version: number; ciphertext: string | null; dekVersion: number; setAt: string; setBy: string }>;
  needsRotation: boolean;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function serverFingerprint(publicKey: string): string {
  const hex = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex').slice(0, 16);
  return (hex.match(/.{4}/g) ?? []).join('-');
}

export class FakeZeus {
  readonly devs: Dev[] = [];
  readonly keys: VaultKey[] = [];
  readonly projects: Array<{ key: string; name: string }> = [];
  readonly envs: StoredEnv[] = [];
  /** Cuerpo crudo de cada petición con cuerpo, en orden. */
  readonly bodies: string[] = [];
  readonly calls: string[] = [];
  /** Si se pone, la siguiente escritura responde 409 ZEUS_VAULT_STALE. */
  failNextWriteAsStale = false;
  /** Lo que devuelve GET /inbox en `open`. */
  inboxOpen: Array<Record<string, unknown>> = [];

  addDev(name: string, opts: { admin?: boolean } = {}): Dev {
    const dev: Dev = {
      id: randomUUID(),
      name,
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@hyper.test`,
      admin: opts.admin ?? false,
      token: `zeus_${Buffer.from(createHash('sha256').update(name).digest()).toString('base64url')}`,
    };
    this.devs.push(dev);
    return dev;
  }

  addProject(key: string, name: string): void {
    this.projects.push({ key, name });
  }

  env(projectKey: string, name: string): StoredEnv | undefined {
    return this.envs.find((e) => e.projectKey === projectKey && e.name === name);
  }

  /** Todo lo que el servidor tiene guardado, como texto (para buscar fugas). */
  dump(): string {
    return JSON.stringify({
      keys: this.keys,
      envs: this.envs.map((e) => ({ ...e, grants: [...e.grants], secrets: [...e.secrets] })),
    });
  }

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    this.calls.push(`${method} ${u.pathname}${u.search}`);
    const raw = typeof init.body === 'string' ? init.body : null;
    if (raw != null) this.bodies.push(raw);
    try {
      // device/*: públicas (login por navegador de `zeus setup`), antes de exigir token.
      if (u.pathname.startsWith('/v1/zeus/device/')) {
        const body = raw != null ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const result = this.deviceRoute(u.pathname.slice('/v1/zeus/device/'.length), body);
        return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const headers = new Headers(init.headers);
      const token = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
      const dev = this.devs.find((d) => d.token === token);
      if (!dev) throw new HttpError(401, 'UNAUTHORIZED', 'token inválido');
      if (!u.pathname.startsWith('/v1/zeus/')) throw new HttpError(404, 'NOT_FOUND', 'ruta desconocida');
      const body = raw != null ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const result = this.route(dev, method, u.pathname.slice('/v1/zeus'.length), u.searchParams, body);
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: { code: err.code, message: err.message } }), { status: err.status });
      }
      throw err;
    }
  };

  /** Solicitudes de `zeus setup`. */
  readonly devices: Array<{ deviceCode: string; userCode: string; clientName: string; status: 'pending' | 'approved' | 'denied' | 'delivered'; polls: number }> = [];
  /** Lo que hace "la persona en el navegador": decide al llegar a N consultas, a nombre de `devName`. */
  browser: { devName: string; afterPolls: number; decision: 'approve' | 'deny' | 'never' } | null = null;

  private deviceRoute(route: string, body: Record<string, unknown>): unknown {
    if (route === 'start') {
      const n = this.devices.length + 1;
      const d = { deviceCode: `zdc_${'d'.repeat(42)}${n}`, userCode: `BCDF-${String(2000 + n)}`, clientName: String(body.clientName ?? ''), status: 'pending' as const, polls: 0 };
      this.devices.push(d);
      const uri = 'https://roz.test/conectar';
      return { deviceCode: d.deviceCode, userCode: d.userCode, verificationUri: uri, verificationUriComplete: `${uri}?code=${d.userCode}`, expiresIn: 600, interval: 5 };
    }
    if (route === 'poll') {
      const d = this.devices.find((x) => x.deviceCode === body.deviceCode);
      if (!d) return { status: 'expired' };
      d.polls++;
      const b = this.browser;
      if (d.status === 'pending' && b && b.decision !== 'never' && d.polls >= b.afterPolls) d.status = b.decision === 'approve' ? 'approved' : 'denied';
      if (d.status === 'pending') return { status: 'pending', interval: 5 };
      if (d.status === 'denied' || d.status === 'delivered') return { status: d.status };
      d.status = 'delivered';
      const dev = this.devs.find((x) => x.name === b?.devName);
      if (!dev) throw new HttpError(500, 'INTERNAL', 'sin dev para el navegador');
      return { status: 'approved', token: dev.token, dev: { id: dev.id, name: dev.name, email: dev.email } };
    }
    throw new HttpError(404, 'NOT_FOUND', 'ruta desconocida');
  }

  private route(dev: Dev, method: string, route: string, query: URLSearchParams, body: Record<string, unknown>): unknown {
    const parts = route.split('/').filter(Boolean).map(decodeURIComponent);
    const admin = (): void => {
      if (!dev.admin) throw new HttpError(403, 'FORBIDDEN', 'solo un administrador de zeus puede hacer esto');
    };

    if (method === 'GET' && route === '/whoami') {
      return { dev: { id: dev.id, name: dev.name, email: dev.email }, zeusAdmin: dev.admin };
    }
    if (method === 'GET' && route === '/vault/keys') {
      // Llaves públicas: cualquiera las lista para poder dar acceso.
      const all = query.get('all') === '1';
      return { keys: this.keys.filter((k) => !k.revokedAt && (all || k.devId === dev.id)) };
    }
    if (method === 'POST' && route === '/vault/keys') {
      const { name, publicKey } = body as { name: string; publicKey: string };
      if (!PUBLIC_KEY_RE.test(publicKey) || !name) throw new HttpError(400, 'VALIDATION', 'llave inválida');
      if (this.keys.some((k) => k.publicKey === publicKey)) throw new HttpError(409, 'ZEUS_VAULT_KEY_EXISTS', 'esa llave pública ya está registrada');
      const key: VaultKey = {
        id: randomUUID(),
        devId: dev.id,
        devName: dev.name,
        name,
        publicKey,
        fingerprint: serverFingerprint(publicKey),
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date().toISOString(),
      };
      this.keys.push(key);
      return { key };
    }
    if (method === 'GET' && route === '/vault/projects') {
      const mine = new Set(this.keys.filter((k) => k.devId === dev.id && !k.revokedAt).map((k) => k.id));
      return {
        projects: this.projects.map((p) => ({
          key: p.key,
          name: p.name,
          envs: this.envs
            .filter((e) => e.projectKey === p.key)
            .map((e) => ({
              name: e.name,
              dekVersion: e.dekVersion,
              hasGrant: [...e.grants].some(([keyId, g]) => mine.has(keyId) && g.dekVersion === e.dekVersion),
              needsRotation: e.needsRotation,
            })),
        })),
      };
    }
    if (method === 'GET' && route === '/inbox') {
      return { unread: 0, open: this.inboxOpen, waiting: [], envChanges: [], toResolve: 0 };
    }
    if (method === 'POST' && route === '/vault/keys/rotate') {
      const { oldKeyId, newKeyId, grants, compromised } = body as {
        oldKeyId: string;
        newKeyId: string;
        grants: Array<{ projectKey: string; env: string; dekVersion: number; wrappedDek: string }>;
        compromised: boolean;
      };
      const oldKey = this.ownKey(dev, oldKeyId);
      this.ownKey(dev, newKeyId);
      for (const g of grants) {
        const env = this.env(this.project(g.projectKey).key, g.env);
        if (!env) throw new HttpError(404, 'NOT_FOUND', 'no existe el entorno');
        this.granted(dev, env, oldKeyId);
        if (!WRAPPED_DEK_RE.test(g.wrappedDek)) throw new HttpError(400, 'VALIDATION', 'wrappedDek inválida');
        env.grants.set(newKeyId, { dekVersion: env.dekVersion, wrappedDek: g.wrappedDek });
      }
      for (const env of this.envs) {
        if (env.grants.delete(oldKeyId) && compromised) env.needsRotation = true;
      }
      oldKey.revokedAt = new Date().toISOString();
      return { ok: true, moved: grants.length };
    }
    if (method === 'POST' && route === '/vault/envs') {
      // Como el servidor real: cualquier dev crea un entorno y queda como el primero con acceso.
      const { projectKey, env, keyId, wrappedDek } = body as { projectKey: string; env: string; keyId: string; wrappedDek: string };
      const project = this.project(projectKey);
      this.ownKey(dev, keyId);
      if (!WRAPPED_DEK_RE.test(wrappedDek)) throw new HttpError(400, 'VALIDATION', 'wrappedDek inválida');
      if (this.env(project.key, env)) throw new HttpError(409, 'ZEUS_VAULT_ENV_EXISTS', 'ese entorno ya existe');
      const created: StoredEnv = {
        id: randomUUID(),
        projectKey: project.key,
        name: env,
        dekVersion: 1,
        grants: new Map([[keyId, { dekVersion: 1, wrappedDek }]]),
        secrets: new Map(),
        revisions: [],
        needsRotation: false,
      };
      this.envs.push(created);
      return { envId: created.id, dekVersion: 1 };
    }

    if (parts[0] === 'vault' && parts[1] === 'envs' && parts[2] && parts[3]) {
      const project = this.project(parts[2]);
      const env = this.env(project.key, parts[3]);
      if (!env) throw new HttpError(404, 'NOT_FOUND', `el proyecto ${project.key} no tiene el entorno "${parts[3]}" en la bóveda`);
      const rest = parts.slice(4);

      if (method === 'GET' && rest.length === 0) {
        const wrappedDek = this.granted(dev, env, query.get('keyId') ?? '');
        return {
          envId: env.id,
          dekVersion: env.dekVersion,
          wrappedDek,
          secrets: [...env.secrets].map(([name, s]) => ({ name, ...s })),
          grants: [...env.grants]
            .filter(([, g]) => g.dekVersion === env.dekVersion)
            .flatMap(([keyId]) => {
              const k = this.keys.find((x) => x.id === keyId);
              return k ? [{ keyId, devName: k.devName, keyName: k.name, fingerprint: k.fingerprint }] : [];
            }),
          needsRotation: env.needsRotation,
        };
      }
      if (method === 'PUT' && rest[0] === 'secrets') {
        const { keyId, dekVersion, set, delete: del } = body as { keyId: string; dekVersion: number; set: Array<{ name: string; ciphertext: string }>; delete: string[] };
        this.granted(dev, env, keyId);
        this.checkVersion(env.dekVersion, dekVersion);
        for (const s of set) {
          if (!SECRET_NAME_RE.test(s.name)) throw new HttpError(400, 'VALIDATION', `nombre inválido: ${s.name}`);
          if (!SECRET_RE.test(s.ciphertext)) throw new HttpError(400, 'VALIDATION', `el valor de ${s.name} no viene cifrado`);
        }
        const now = new Date().toISOString();
        const lastVersion = (name: string): number =>
          Math.max(env.secrets.get(name)?.version ?? 0, ...env.revisions.filter((r) => r.name === name).map((r) => r.version));
        for (const s of set) {
          const prev = env.secrets.get(s.name);
          if (prev) env.revisions.push({ name: s.name, version: prev.version, ciphertext: prev.ciphertext, dekVersion: prev.dekVersion, setAt: prev.updatedAt, setBy: dev.name });
          env.secrets.set(s.name, { ciphertext: s.ciphertext, dekVersion, version: lastVersion(s.name) + 1, updatedAt: now, updatedByName: dev.name });
        }
        let deleted = 0;
        for (const name of del) {
          const prev = env.secrets.get(name);
          if (!prev) continue;
          env.revisions.push({ name, version: prev.version, ciphertext: prev.ciphertext, dekVersion: prev.dekVersion, setAt: prev.updatedAt, setBy: dev.name });
          env.revisions.push({ name, version: prev.version + 1, ciphertext: null, dekVersion: env.dekVersion, setAt: now, setBy: dev.name });
          env.secrets.delete(name);
          deleted++;
        }
        return { ok: true, written: set.length, deleted };
      }
      if (method === 'GET' && rest[0] === 'history') {
        this.granted(dev, env, query.get('keyId') ?? '');
        const name = query.get('name');
        const current = [...env.secrets]
          .filter(([n]) => !name || n === name)
          .map(([n, s]) => ({ name: n, version: s.version, ciphertext: s.ciphertext, dekVersion: s.dekVersion, setAt: s.updatedAt, setByName: s.updatedByName ?? null, replacedAt: null, replacedByName: null, current: true }));
        const old = env.revisions
          .filter((r) => !name || r.name === name)
          .map((r) => ({ name: r.name, version: r.version, ciphertext: r.ciphertext, dekVersion: r.dekVersion, setAt: r.setAt, setByName: r.setBy, replacedAt: r.setAt, replacedByName: r.setBy, current: false }));
        const revisions = [...current, ...old].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : b.version - a.version));
        return { dekVersion: env.dekVersion, revisions };
      }
      if (method === 'POST' && rest[0] === 'grants') {
        const { keyId, grants } = body as { keyId: string; grants: Array<{ keyId: string; wrappedDek: string }> };
        this.granted(dev, env, keyId);
        for (const g of grants) {
          if (!WRAPPED_DEK_RE.test(g.wrappedDek)) throw new HttpError(400, 'VALIDATION', 'wrappedDek inválida');
          if (!this.keys.some((k) => k.id === g.keyId && !k.revokedAt)) throw new HttpError(400, 'VALIDATION', 'llave desconocida o revocada');
        }
        for (const g of grants) env.grants.set(g.keyId, { dekVersion: env.dekVersion, wrappedDek: g.wrappedDek });
        return { ok: true, granted: grants.length };
      }
      if (method === 'DELETE' && rest[0] === 'grants' && rest[1]) {
        const holdsAccess = this.keys.some((k) => k.devId === dev.id && !k.revokedAt && env.grants.get(k.id)?.dekVersion === env.dekVersion);
        if (!holdsAccess) admin();
        if (!env.grants.delete(rest[1])) throw new HttpError(404, 'NOT_FOUND', 'esa llave no tenía acceso');
        env.needsRotation = true;
        return { ok: true };
      }
      if (method === 'POST' && rest[0] === 'rotate') {
        const { keyId, dekVersion, grants, secrets, revisions } = body as {
          keyId: string;
          dekVersion: number;
          grants: Array<{ keyId: string; wrappedDek: string }>;
          secrets: Array<{ name: string; ciphertext: string }>;
          revisions?: Array<{ name: string; version: number; ciphertext: string }>;
        };
        const readable = env.revisions.filter((r) => r.ciphertext != null && r.dekVersion === env.dekVersion);
        if (revisions && (revisions.length !== readable.length || readable.some((r) => !revisions.some((x) => x.name === r.name && x.version === r.version)))) {
          throw new HttpError(409, 'ZEUS_VAULT_INCOMPLETE', 'rotate debe traer todo el historial legible');
        }
        this.granted(dev, env, keyId);
        this.checkVersion(env.dekVersion + 1, dekVersion);
        const names = new Set(secrets.map((s) => s.name));
        if (names.size !== env.secrets.size || [...env.secrets.keys()].some((n) => !names.has(n))) {
          throw new HttpError(400, 'VALIDATION', 'rotate debe traer todos los secretos existentes');
        }
        if (!grants.some((g) => g.keyId === keyId)) throw new HttpError(400, 'VALIDATION', 'rotate debe incluir tu propia llave');
        for (const g of grants) if (!WRAPPED_DEK_RE.test(g.wrappedDek)) throw new HttpError(400, 'VALIDATION', 'wrappedDek inválida');
        for (const s of secrets) if (!SECRET_RE.test(s.ciphertext)) throw new HttpError(400, 'VALIDATION', 'secreto sin cifrar');
        env.dekVersion = dekVersion;
        env.grants = new Map(grants.map((g) => [g.keyId, { dekVersion, wrappedDek: g.wrappedDek }]));
        for (const s of secrets) {
          const prev = env.secrets.get(s.name);
          env.secrets.set(s.name, { ciphertext: s.ciphertext, dekVersion, version: (prev?.version ?? 0) + 1, updatedAt: new Date().toISOString(), updatedByName: dev.name });
        }
        env.revisions = env.revisions.flatMap((r) => {
          if (r.ciphertext == null) return [{ ...r, dekVersion }];
          const re = revisions?.find((x) => x.name === r.name && x.version === r.version);
          return re ? [{ ...r, ciphertext: re.ciphertext, dekVersion }] : [];
        });
        env.needsRotation = false;
        return { ok: true, dekVersion };
      }
    }
    throw new HttpError(404, 'NOT_FOUND', `ruta desconocida: ${method} ${route}`);
  }

  /** Como el servidor real: la clave del proyecto no distingue mayúsculas. */
  private project(key: string): { key: string; name: string } {
    const p = this.projects.find((x) => x.key.toLowerCase() === key.toLowerCase());
    if (!p) throw new HttpError(404, 'NOT_FOUND', `no existe el proyecto ${key}`);
    return p;
  }

  private ownKey(dev: Dev, keyId: string): VaultKey {
    const key = this.keys.find((k) => k.id === keyId);
    if (!key || key.devId !== dev.id || key.revokedAt) throw new HttpError(403, 'ZEUS_VAULT_NO_ACCESS', 'esa llave no es tuya o está revocada');
    return key;
  }

  private granted(dev: Dev, env: StoredEnv, keyId: string): string {
    this.ownKey(dev, keyId);
    const g = env.grants.get(keyId);
    if (!g || g.dekVersion !== env.dekVersion) {
      throw new HttpError(403, 'ZEUS_VAULT_NO_ACCESS', 'este equipo no tiene acceso a ese entorno: pídeselo a un administrador de zeus');
    }
    return g.wrappedDek;
  }

  private checkVersion(expected: number, got: number): void {
    if (this.failNextWriteAsStale || got !== expected) {
      this.failNextWriteAsStale = false;
      throw new HttpError(409, 'ZEUS_VAULT_STALE', 'la llave del entorno cambió');
    }
  }
}

// ---------------------------------------------------------------- disco y terminal falsos

export class MemFs implements FileOps {
  readonly files = new Map<string, string>();
  readonly modes = new Map<string, number>();
  readonly dirs = new Set<string>();

  async read(file: string): Promise<string | null> {
    return this.files.get(file) ?? null;
  }
  async write(file: string, content: string, mode?: number): Promise<void> {
    this.files.set(file, content);
    if (mode != null) this.modes.set(file, mode);
  }
  async mkdirPrivate(dir: string): Promise<void> {
    this.dirs.add(dir);
  }
  async remove(file: string): Promise<boolean> {
    return this.files.delete(file);
  }
  async list(dir: string): Promise<string[]> {
    return [...this.files.keys()].filter((f) => path.dirname(f) === dir).map((f) => path.basename(f));
  }
}

export class FakePrompt implements Prompter {
  interactive = true;
  /** Respuesta a cada confirmación, en orden; al agotarse responde `fallback`. */
  answers: boolean[] = [];
  fallback = true;
  secretValue = '';
  readonly questions: string[] = [];

  async confirm(question: string): Promise<boolean> {
    this.questions.push(question);
    return this.answers.shift() ?? this.fallback;
  }
  async ask(question: string): Promise<string> {
    this.questions.push(question);
    return '';
  }
  async secret(question: string): Promise<string> {
    this.questions.push(question);
    return this.secretValue;
  }
}

/** Un "equipo": su propia carpeta ~/.zeus, su carpeta de trabajo y su sesión de zeus. */
export interface Machine {
  ctx: Ctx;
  fs: MemFs;
  prompt: FakePrompt;
  out: string[];
  log: string[];
  spawned: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; quiet: boolean }>;
  /** Lo que hay en el portapapeles, en stdin y las URLs que se abrieron. */
  io: { clipboard: string; stdin: string; opened: string[] };
  /** Ruta absoluta de un archivo en la carpeta de trabajo. */
  file(name: string): string;
  /** Todo lo que se imprimió (stdout + stderr). */
  printed(): string;
}

export function machine(zeus: FakeZeus, token: string, name: string, platform: NodeJS.Platform = 'linux'): Machine {
  const fs = new MemFs();
  const prompt = new FakePrompt();
  const out: string[] = [];
  const log: string[] = [];
  const spawned: Machine['spawned'] = [];
  const io: Machine['io'] = { clipboard: '', stdin: '', opened: [] };
  const cwd = path.resolve('/work', name);
  const ctx: Ctx = {
    api: new ZeusClient({ url: ZEUS_URL, token, fetch: zeus.fetch }),
    fs,
    prompt,
    out: (line) => out.push(line),
    log: (line) => log.push(line),
    home: path.resolve('/home', name, '.zeus'),
    url: ZEUS_URL,
    cwd,
    platform,
    env: { PATH: '/usr/bin' },
    hostname: name,
    spawn: async (command, args, env, opts) => {
      spawned.push({ command, args, env, quiet: opts?.quiet ?? false });
      return 7;
    },
    clipboard: async () => io.clipboard,
    openUrl: async (url) => {
      io.opened.push(url);
    },
    stdin: async () => io.stdin,
  };
  return { ctx, fs, prompt, out, log, spawned, io, file: (n) => path.resolve(cwd, n), printed: () => [...out, ...log].join('\n') };
}

/** Las formas en que un valor podría aparecer en un cuerpo JSON: tal cual o escapado. */
export function plaintextForms(value: string): string[] {
  const forms = new Set([value, JSON.stringify(value).slice(1, -1), Buffer.from(value, 'utf8').toString('base64'), Buffer.from(value, 'utf8').toString('base64url')]);
  return [...forms].filter((f) => f.length >= 6);
}
