// "Quién se encarga de qué": temas del equipo y quién los atiende, en orden (roz.zeus_duty, 0045).
//
// Sirve para dos cosas:
//   · enrutar una solicitud con tema (zeus_request topic="code_review" → la primera persona de la
//     lista que no sea quien pide);
//   · contestarle a Claude "¿a quién le pido review / un deploy / un token de Meta?" (zeus_who_owns).
//
// El catálogo es fijo en código para que el MCP lo pueda describir; quién atiende cada tema es dato.
import { db } from '../db/supabase.js';
import { ValidationError } from '../utils/errors.js';

export const ZEUS_DUTIES = {
  code_review: { label: 'Revisión de código y merge de PRs', hint: 'revisar o aprobar un PR, hacer merge' },
  deploys: { label: 'Deploys y producción', hint: 'desplegar, revisar producción, variables de Vercel/Railway' },
  architecture: { label: 'Decisiones técnicas y de arquitectura', hint: 'validar una propuesta, un diseño o una arquitectura nueva' },
  client_feedback: { label: 'Retro y pedidos de clientes', hint: 'qué pidió o qué opinó un cliente, cambios que vienen de cliente' },
  clients: { label: 'Contacto con clientes', hint: 'hablar con un cliente, coordinar una junta con cliente' },
  advanced_access: { label: 'Accesos avanzados', hint: 'tokens y cuentas de alto nivel: Google, Meta, Ads, dueños de cuentas' },
} as const;

export type ZeusDuty = keyof typeof ZEUS_DUTIES;
export const ZEUS_DUTY_KEYS = Object.keys(ZEUS_DUTIES) as ZeusDuty[];

export function isDuty(v: unknown): v is ZeusDuty {
  return typeof v === 'string' && (ZEUS_DUTY_KEYS as string[]).includes(v);
}

export function assertDuty(v: unknown): ZeusDuty {
  if (!isDuty(v)) throw new ValidationError(`tema desconocido (usa: ${ZEUS_DUTY_KEYS.join(', ')})`);
  return v;
}

export interface DutyRow {
  duty: string;
  dev_id: string;
  rank: number;
  note: string | null;
}

/** Todas las filas, ordenadas por tema y rango. Tolera que la migración aún no esté aplicada. */
export async function loadDuties(): Promise<DutyRow[]> {
  const { data, error } = await db().from('zeus_duty').select('duty, dev_id, rank, note').order('duty').order('rank');
  if (error) {
    // PGRST205 = la tabla no existe todavía (0045 sin aplicar): el organigrama sigue funcionando.
    if ((error as { code?: string }).code === 'PGRST205' || /zeus_duty/.test(error.message)) return [];
    throw error;
  }
  return ((data ?? []) as DutyRow[]).filter((r) => isDuty(r.duty));
}

/** Quién atiende un tema, en orden, sin contar a `exclude` (quien pide). */
export function holdersOf(rows: DutyRow[], duty: ZeusDuty, exclude?: string | null): DutyRow[] {
  return rows.filter((r) => r.duty === duty && r.dev_id !== exclude).sort((a, b) => a.rank - b.rank);
}

/** Reemplaza quién atiende un tema (lista en orden). */
export async function setDutyHolders(duty: ZeusDuty, devIds: string[], notes: Record<string, string | null> = {}): Promise<void> {
  const unique = [...new Set(devIds)];
  const supabase = db();
  const { error: delErr } = await supabase.from('zeus_duty').delete().eq('duty', duty);
  if (delErr) throw delErr;
  if (!unique.length) return;
  const { error } = await supabase
    .from('zeus_duty')
    .insert(unique.map((dev_id, i) => ({ duty, dev_id, rank: i + 1, note: notes[dev_id] ?? null, updated_at: new Date().toISOString() })));
  if (error) throw error;
}
