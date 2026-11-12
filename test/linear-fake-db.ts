// Doble en memoria del cliente de Supabase para las pruebas del módulo Linear. Implementa SOLO lo que
// usan src/linear/* (select/insert/update/delete/upsert + filtros + order/limit/single), con
// violaciones de unicidad como 23505 — que es justo lo que el espejo tiene que manejar.

export type Row = Record<string, unknown>;

interface Order {
  col: string;
  asc: boolean;
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === 'string' && typeof b === 'string') {
    const da = Date.parse(a);
    const db_ = Date.parse(b);
    if (!Number.isNaN(da) && !Number.isNaN(db_) && /\d{4}-\d{2}-\d{2}/.test(a) && /\d{4}-\d{2}-\d{2}/.test(b)) return da - db_;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return Number(a) - Number(b);
}

export function createFakeDb(unique: Record<string, string[]> = {}) {
  const tables: Record<string, Row[]> = {};
  let seq = 0;
  const table = (name: string): Row[] => (tables[name] ??= []);

  class Query implements PromiseLike<{ data: unknown; error: unknown }> {
    private op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
    private payload: unknown = null;
    private filters: ((r: Row) => boolean)[] = [];
    private orders: Order[] = [];
    private lim: number | null = null;
    private one: 'one' | 'maybe' | null = null;
    private returning = false;
    private conflict: string[] = [];

    constructor(private readonly t: string) {}

    select(_cols?: string, _opts?: unknown) {
      if (this.op !== 'select') this.returning = true;
      return this;
    }
    insert(p: unknown) {
      this.op = 'insert';
      this.payload = p;
      return this;
    }
    update(p: unknown) {
      this.op = 'update';
      this.payload = p;
      return this;
    }
    delete() {
      this.op = 'delete';
      return this;
    }
    upsert(p: unknown, o?: { onConflict?: string }) {
      this.op = 'upsert';
      this.payload = p;
      this.conflict = (o?.onConflict ?? 'id').split(',').map((s) => s.trim());
      return this;
    }
    eq(c: string, v: unknown) {
      this.filters.push((r) => r[c] === v);
      return this;
    }
    neq(c: string, v: unknown) {
      this.filters.push((r) => r[c] !== v);
      return this;
    }
    is(c: string, v: unknown) {
      this.filters.push((r) => (r[c] ?? null) === v);
      return this;
    }
    in(c: string, vs: unknown[]) {
      this.filters.push((r) => vs.includes(r[c]));
      return this;
    }
    not(c: string, op: string, v: unknown) {
      if (op === 'is') this.filters.push((r) => (r[c] ?? null) !== v);
      else if (op === 'in') {
        const vals = String(v).replace(/[()]/g, '').split(',');
        this.filters.push((r) => !vals.includes(String(r[c])));
      }
      return this;
    }
    lt(c: string, v: unknown) {
      this.filters.push((r) => r[c] != null && cmp(r[c], v) < 0);
      return this;
    }
    lte(c: string, v: unknown) {
      this.filters.push((r) => r[c] != null && cmp(r[c], v) <= 0);
      return this;
    }
    gt(c: string, v: unknown) {
      this.filters.push((r) => r[c] != null && cmp(r[c], v) > 0);
      return this;
    }
    gte(c: string, v: unknown) {
      this.filters.push((r) => r[c] != null && cmp(r[c], v) >= 0);
      return this;
    }
    like(c: string, pattern: string) {
      const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`);
      this.filters.push((r) => typeof r[c] === 'string' && re.test(r[c] as string));
      return this;
    }
    order(col: string, o?: { ascending?: boolean }) {
      this.orders.push({ col, asc: o?.ascending !== false });
      return this;
    }
    limit(n: number) {
      this.lim = n;
      return this;
    }
    maybeSingle() {
      this.one = 'maybe';
      return this;
    }
    single() {
      this.one = 'one';
      return this;
    }

    private matched(): Row[] {
      return table(this.t).filter((r) => this.filters.every((f) => f(r)));
    }

    private violates(row: Row, self: Row | null): boolean {
      for (const col of unique[this.t] ?? []) {
        const v = row[col];
        if (v === null || v === undefined) continue;
        if (table(this.t).some((r) => r !== self && r[col] === v)) return true;
      }
      return false;
    }

    private shape(rows: Row[]): { data: unknown; error: unknown } {
      const copies = rows.map((r) => ({ ...r }));
      if (this.one === 'maybe') return { data: copies[0] ?? null, error: null };
      if (this.one === 'one') return copies[0] ? { data: copies[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      return { data: copies, error: null };
    }

    private exec(): { data: unknown; error: unknown } {
      const rows = table(this.t);
      if (this.op === 'select') {
        let out = this.matched();
        for (const o of [...this.orders].reverse()) out = [...out].sort((a, b) => (o.asc ? cmp(a[o.col], b[o.col]) : cmp(b[o.col], a[o.col])));
        if (this.lim !== null) out = out.slice(0, this.lim);
        return this.shape(out);
      }
      if (this.op === 'insert') {
        const list = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        const added: Row[] = [];
        for (const p of list) {
          const row = { id: `${this.t}-${++seq}`, ...p };
          if (this.violates(row, null)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          rows.push(row);
          added.push(row);
        }
        return this.returning ? this.shape(added) : { data: null, error: null };
      }
      if (this.op === 'update') {
        const hit = this.matched();
        for (const r of hit) {
          const next = { ...r, ...(this.payload as Row) };
          if (this.violates(next, r)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          Object.assign(r, this.payload as Row);
        }
        return this.returning ? this.shape(hit) : { data: null, error: null };
      }
      if (this.op === 'delete') {
        const hit = new Set(this.matched());
        tables[this.t] = rows.filter((r) => !hit.has(r));
        return { data: null, error: null };
      }
      // upsert
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      for (const p of list) {
        const found = rows.find((r) => this.conflict.every((c) => r[c] === p[c]));
        if (found) Object.assign(found, p);
        else rows.push({ id: `${this.t}-${++seq}`, ...p });
      }
      return { data: null, error: null };
    }

    then<A = { data: unknown; error: unknown }, B = never>(
      onfulfilled?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null,
      onrejected?: ((e: unknown) => B | PromiseLike<B>) | null,
    ): PromiseLike<A | B> {
      return Promise.resolve(this.exec()).then(onfulfilled, onrejected);
    }
  }

  return {
    tables,
    table,
    from: (t: string) => new Query(t),
    rpc: async () => ({ data: null, error: null }),
  };
}

export type FakeDb = ReturnType<typeof createFakeDb>;
