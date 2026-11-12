// Snowflakes de Discord: 64 bits, los 42 altos son milisegundos desde el epoch de Discord (2015).
// Se manejan como string; para comparar se pasan a BigInt (comparar texto falla con largos distintos).

const DISCORD_EPOCH = 1420070400000n;

export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

export function snowflakeIso(id: string): string {
  return new Date(snowflakeTime(id)).toISOString();
}

/** Snowflake mínimo de un instante (sirve como cota en rangos). */
export function snowflakeFromTime(ms: number): string {
  return ((BigInt(ms) - DISCORD_EPOCH) << 22n).toString();
}

export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function maxSnowflake(ids: Iterable<string>): string | null {
  let best: string | null = null;
  for (const id of ids) if (best === null || compareSnowflakes(id, best) > 0) best = id;
  return best;
}

export function minSnowflake(ids: Iterable<string>): string | null {
  let best: string | null = null;
  for (const id of ids) if (best === null || compareSnowflakes(id, best) < 0) best = id;
  return best;
}

export function isSnowflake(v: unknown): v is string {
  return typeof v === 'string' && /^\d{1,25}$/.test(v);
}
