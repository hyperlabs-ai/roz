// Postgres REAL en memoria (PGlite) detrás de un doble del cliente de Supabase, para las pruebas de
// integración de zeus. A diferencia de un doble en memoria, aquí corre la migración 0040 de verdad:
// los índices únicos, los checks, la búsqueda de texto y la rotación atómica son los del producto.
//
// El doble traduce a SQL el subconjunto del query builder que usa src/zeus/* (select con embebidos,
// insert/update/delete/upsert, filtros, or(), order/limit, single/maybeSingle, count y rpc).
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code?: string; message: string } | null; count?: number | null };

// Lo mínimo del esquema anterior que zeus lee o referencia (las columnas que de verdad usa).
const PRIOR_SCHEMA = `
  create role service_role; create role anon; create role authenticated;
  create schema roz; create schema extensions;
  create table roz.project (
    id uuid primary key default gen_random_uuid(), name text not null, key text not null unique,
    color text, active boolean not null default true
  );
  create table roz.dev (
    id uuid primary key default gen_random_uuid(), name text not null, email text, role text not null default 'dev',
    github_login text, ops_user_id uuid, active boolean not null default true,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table roz.project_repo (
    id uuid primary key default gen_random_uuid(), project_id uuid not null references roz.project(id) on delete cascade,
    repo text not null unique, created_at timestamptz not null default now()
  );
  create table roz.dev_assignment (
    id uuid primary key default gen_random_uuid(), dev_id uuid not null references roz.dev(id) on delete cascade,
    kind text not null default 'principal', project_id uuid references roz.project(id) on delete set null, sort_order int not null default 0
  );
  create table roz.skill (id uuid primary key default gen_random_uuid(), tag text not null unique);
  create table roz.dev_skill (
    id uuid primary key default gen_random_uuid(), dev_id uuid not null references roz.dev(id) on delete cascade,
    skill_id uuid not null references roz.skill(id) on delete cascade
  );
  create table roz.runner (
    id uuid primary key default gen_random_uuid(), dev_id uuid not null references roz.dev(id) on delete cascade,
    name text not null, platform text, last_seen_at timestamptz, revoked_at timestamptz
  );
  create table roz.agent_plan (id uuid primary key default gen_random_uuid());
`;

const MIGRATION = readFileSync(fileURLToPath(new URL('../migrations/0040_zeus.sql', import.meta.url)), 'utf8');

/** Deja las filas como las entrega PostgREST: fechas en ISO y bigint como número. */
function normalize(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
  return v;
}

interface Embed {
  alias: string;
  fk: string;
  cols: string;
}

/** Separa "a, b, alias:fk(c, d)" en columnas planas y embebidos. */
function parseSelect(cols: string): { plain: string[]; embeds: Embed[]; star: boolean } {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of cols) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  const plain: string[] = [];
  const embeds: Embed[] = [];
  let star = false;
  for (const p of parts) {
    const m = /^(\w+):(\w+)\((.+)\)$/.exec(p);
    if (m) embeds.push({ alias: m[1]!, fk: m[2]!, cols: m[3]! });
    else if (p === '*') star = true;
    else plain.push(p);
  }
  return { plain, embeds, star };
}

const ident = (s: string) => `"${s.replace(/"/g, '')}"`;

export async function createZeusPg() {
  const pg = new PGlite({ parsers: { 1082: (v: string) => v } }); // date como 'AAAA-MM-DD'
  await pg.exec(PRIOR_SCHEMA);
  await pg.exec(MIGRATION);

  // (tabla, columna) → tabla referida, para resolver los selects embebidos.
  const fkRows = (
    await pg.query<{ tbl: string; col: string; ref: string }>(`
      select c.conrelid::regclass::text as tbl, a.attname as col, c.confrelid::regclass::text as ref
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and c.connamespace = 'roz'::regnamespace`)
  ).rows;
  const fks = new Map(fkRows.map((r) => [`${r.tbl.replace(/^roz\./, '')}.${r.col}`, r.ref.replace(/^roz\./, '')]));

  const jsonCols = new Set(
    (await pg.query<{ k: string }>(`select table_name || '.' || column_name as k from information_schema.columns where table_schema = 'roz' and data_type in ('jsonb', 'json')`)).rows.map((r) => r.k),
  );

  async function run(sql: string, params: unknown[]): Promise<Row[]> {
    return (await pg.query<Row>(sql, params)).rows.map((r) => normalize(r) as Row);
  }

  class Query implements PromiseLike<Result> {
    private op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
    private payload: Row | Row[] | null = null;
    private cols: string | null = null;
    private wheres: string[] = [];
    private params: unknown[] = [];
    private orders: string[] = [];
    private lim: number | null = null;
    private one: 'one' | 'maybe' | null = null;
    private countOnly = false;
    private wantCount = false;
    private conflict: string[] = [];
    private ignoreDup = false;

    constructor(private readonly t: string) {}

    private p(v: unknown): string {
      this.params.push(v);
      return `$${this.params.length}`;
    }

    select(cols = '*', opts?: { count?: string; head?: boolean }) {
      this.cols = cols;
      if (opts?.count) this.wantCount = true;
      if (opts?.head) this.countOnly = true;
      return this;
    }
    insert(p: Row | Row[]) {
      this.op = 'insert';
      this.payload = p;
      return this;
    }
    update(p: Row) {
      this.op = 'update';
      this.payload = p;
      return this;
    }
    delete() {
      this.op = 'delete';
      return this;
    }
    upsert(p: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) {
      this.op = 'upsert';
      this.payload = p;
      this.conflict = (o?.onConflict ?? 'id').split(',').map((s) => s.trim());
      this.ignoreDup = !!o?.ignoreDuplicates;
      return this;
    }

    eq(c: string, v: unknown) {
      this.wheres.push(`${ident(c)} = ${this.p(v)}`);
      return this;
    }
    neq(c: string, v: unknown) {
      this.wheres.push(`${ident(c)} <> ${this.p(v)}`);
      return this;
    }
    gt(c: string, v: unknown) {
      this.wheres.push(`${ident(c)} > ${this.p(v)}`);
      return this;
    }
    lt(c: string, v: unknown) {
      this.wheres.push(`${ident(c)} < ${this.p(v)}`);
      return this;
    }
    in(c: string, vs: unknown[]) {
      this.wheres.push(vs.length ? `${ident(c)} in (${vs.map((v) => this.p(v)).join(', ')})` : 'false');
      return this;
    }
    is(c: string, v: null | boolean) {
      this.wheres.push(`${ident(c)} is ${v === null ? 'null' : v ? 'true' : 'false'}`);
      return this;
    }
    ilike(c: string, pattern: string) {
      this.wheres.push(`${ident(c)} ilike ${this.p(pattern)}`);
      return this;
    }
    /** "a.eq.x,b.is.null" → (a = x or b is null). */
    or(expr: string) {
      const terms = expr.split(',').map((term) => {
        const [col, op, ...rest] = term.split('.');
        const value = rest.join('.');
        if (op === 'eq') return `${ident(col!)} = ${this.p(value)}`;
        if (op === 'is' && value === 'null') return `${ident(col!)} is null`;
        throw new Error(`or() no soportado en el doble: ${term}`);
      });
      this.wheres.push(`(${terms.join(' or ')})`);
      return this;
    }
    order(col: string, o?: { ascending?: boolean }) {
      this.orders.push(`${ident(col)} ${o?.ascending === false ? 'desc' : 'asc'}`);
      return this;
    }
    limit(n: number) {
      this.lim = n;
      return this;
    }
    single() {
      this.one = 'one';
      return this;
    }
    maybeSingle() {
      this.one = 'maybe';
      return this;
    }

    private value(col: string, v: unknown): unknown {
      // jsonb: PostgREST recibe JSON; el driver, un texto que Postgres convierte.
      return jsonCols.has(`${this.t}.${col}`) && v !== null && v !== undefined ? JSON.stringify(v) : v;
    }

    private async embed(rows: Row[], embeds: Embed[]): Promise<void> {
      for (const e of embeds) {
        const target = fks.get(`${this.t}.${e.fk}`);
        if (!target) throw new Error(`embebido sin FK conocida: ${this.t}.${e.fk}`);
        const ids = [...new Set(rows.map((r) => r[e.fk]).filter((x) => x != null))];
        const cols = e.cols.split(',').map((c) => ident(c.trim()));
        const found = ids.length ? await run(`select id, ${cols.join(', ')} from roz.${ident(target)} where id = any($1::uuid[])`, [ids]) : [];
        const byId = new Map(found.map((f) => [f.id, f]));
        for (const r of rows) {
          const f = byId.get(r[e.fk]);
          if (f) {
            const { id: _id, ...rest } = f;
            r[e.alias] = e.cols.split(',').map((c) => c.trim()).includes('id') ? f : rest;
          } else r[e.alias] = null;
        }
      }
    }

    private async exec(): Promise<Result> {
      const table = `roz.${ident(this.t)}`;
      const where = this.wheres.length ? ` where ${this.wheres.join(' and ')}` : '';
      const sel = this.cols === null ? null : parseSelect(this.cols);
      // Los embebidos necesitan su columna de FK aunque no se haya pedido.
      const returning = sel ? (sel.star ? '*' : [...new Set([...sel.plain, ...sel.embeds.map((e) => e.fk)])].map(ident).join(', ')) : null;
      let rows: Row[] = [];
      let count: number | null = null;

      if (this.op === 'select') {
        if (this.wantCount) {
          count = Number((await run(`select count(*)::int as n from ${table}${where}`, this.params))[0]!.n);
        }
        if (!this.countOnly) {
          const order = this.orders.length ? ` order by ${this.orders.join(', ')}` : '';
          const limit = this.lim !== null ? ` limit ${this.lim}` : '';
          rows = await run(`select ${returning} from ${table}${where}${order}${limit}`, this.params);
        }
      } else if (this.op === 'insert' || this.op === 'upsert') {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload!];
        const keys = [...new Set(list.flatMap((r) => Object.keys(r)))];
        const tuples = list.map((r) => `(${keys.map((k) => (k in r && r[k] !== undefined ? this.p(this.value(k, r[k])) : 'default')).join(', ')})`);
        let sql = `insert into ${table} (${keys.map(ident).join(', ')}) values ${tuples.join(', ')}`;
        if (this.op === 'upsert') {
          const target = `(${this.conflict.map(ident).join(', ')})`;
          const sets = keys.filter((k) => !this.conflict.includes(k)).map((k) => `${ident(k)} = excluded.${ident(k)}`);
          sql += this.ignoreDup || !sets.length ? ` on conflict ${target} do nothing` : ` on conflict ${target} do update set ${sets.join(', ')}`;
        }
        if (returning) sql += ` returning ${returning}`;
        rows = await run(sql, this.params);
      } else if (this.op === 'update') {
        const p = this.payload as Row;
        // Los SET van después de los filtros ya numerados: se agregan al final de los parámetros.
        const sets = Object.keys(p).filter((k) => p[k] !== undefined).map((k) => `${ident(k)} = ${this.p(this.value(k, p[k]))}`);
        rows = await run(`update ${table} set ${sets.join(', ')}${where}${returning ? ` returning ${returning}` : ''}`, this.params);
      } else {
        rows = await run(`delete from ${table}${where}${returning ? ` returning ${returning}` : ''}`, this.params);
      }

      if (sel?.embeds.length) await this.embed(rows, sel.embeds);
      if (this.cols === null) return { data: null, error: null, count };
      if (this.one === 'one') {
        if (rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'se esperaba exactamente una fila' }, count };
        return { data: rows[0], error: null, count };
      }
      if (this.one === 'maybe') {
        if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'más de una fila' }, count };
        return { data: rows[0] ?? null, error: null, count };
      }
      return { data: this.countOnly ? null : rows, error: null, count };
    }

    then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
      return this.exec()
        .catch((e: { code?: string; message?: string }): Result => ({ data: null, error: { code: e.code, message: e.message ?? String(e) } }))
        .then(ok, ko);
    }
  }

  const client = {
    from: (t: string) => new Query(t),
    async rpc(fn: string, args: Record<string, unknown>): Promise<Result> {
      const keys = Object.keys(args);
      // Los argumentos jsonb viajan como texto JSON; los arreglos de texto, tal cual.
      const params = keys.map((k) => (k === 'p_grants' || k === 'p_secrets' ? JSON.stringify(args[k]) : args[k]));
      try {
        const rows = await run(`select * from roz.${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')})`, params);
        // Función escalar: una fila con una columna llamada como la función.
        if (rows.length === 1 && Object.keys(rows[0]!).length === 1 && fn in rows[0]!) return { data: rows[0]![fn], error: null };
        return { data: rows, error: null };
      } catch (e) {
        const err = e as { code?: string; message?: string };
        return { data: null, error: { code: err.code, message: err.message ?? String(e) } };
      }
    },
  };

  return {
    client,
    /** SQL directo, para sembrar datos y afirmar sobre el estado. */
    sql: <T extends Row = Row>(text: string, params: unknown[] = []) => run(text, params) as Promise<T[]>,
    close: () => pg.close(),
  };
}

export type ZeusPg = Awaited<ReturnType<typeof createZeusPg>>;
