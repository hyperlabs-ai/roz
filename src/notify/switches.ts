// Interruptores de notificaciones (killswitch). Estado en roz.notification_switch, no en env:
// apagar los avisos es inmediato y sin redeploy.
//
// Dos alcances que se multiplican — para enviar, AMBOS deben estar encendidos:
//   · global  → todo el entorno (apaga Resend y/o el push de roz por completo).
//   · dev     → los avisos de UNA persona.
//
// Por qué existe: cuando Resend falla de forma permanente (dominio sin verificar, cuota agotada),
// cada intento de envío lanza, el drain reintenta y los eventos terminan en el dead-letter. Con el
// interruptor apagado el envío se OMITE en silencio (no lanza), así que el evento se marca `done`
// y la cola no se llena de "Aviso sin enviar".
//
// El estado se cachea en memoria del proceso por unos segundos: cada envío lo consulta (y el drain
// envía en bucle), pero un killswitch tiene que sentirse inmediato. Con TTL corto, apagar tarda a
// lo sumo ese TTL en propagarse a las instancias serverless ya calientes.
import { db } from '../db/supabase.js';

export interface SwitchState {
  emailEnabled: boolean;
  pushEnabled: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface DevSwitch extends SwitchState {
  devId: string;
}

interface Row {
  scope: 'global' | 'dev';
  dev_id: string | null;
  email_enabled: boolean;
  push_enabled: boolean;
  updated_by: string | null;
  updated_at: string | null;
}

interface Snapshot {
  global: SwitchState;
  byDev: Map<string, SwitchState>;
}

const CACHE_TTL_MS = 10_000;
const SELECT = 'scope, dev_id, email_enabled, push_enabled, updated_by, updated_at';

// Por defecto roz notifica: si la tabla no existe todavía (deploy adelantado a la migración) o la
// consulta falla, NO se apagan las notificaciones — un error de lectura no debe silenciar a roz.
const DEFAULT_ON: SwitchState = { emailEnabled: true, pushEnabled: true, updatedBy: null, updatedAt: null };

let cache: { at: number; snap: Snapshot } | null = null;

function toState(row: Row): SwitchState {
  return {
    emailEnabled: row.email_enabled,
    pushEnabled: row.push_enabled,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

async function snapshot(): Promise<Snapshot> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.snap;

  const snap: Snapshot = { global: { ...DEFAULT_ON }, byDev: new Map() };
  const { data, error } = await db().from('notification_switch').select(SELECT);
  if (!error) {
    for (const row of (data ?? []) as Row[]) {
      if (row.scope === 'global') snap.global = toState(row);
      else if (row.dev_id) snap.byDev.set(row.dev_id, toState(row));
    }
  }
  cache = { at: Date.now(), snap };
  return snap;
}

/** Invalida la caché tras un cambio, para que el apagado se sienta inmediato en esta instancia. */
function invalidate(): void {
  cache = null;
}

/** ¿El correo de roz está encendido para todo el entorno? (killswitch global) */
export async function emailEnabled(): Promise<boolean> {
  return (await snapshot()).global.emailEnabled;
}

/** ¿El push de roz está encendido para todo el entorno? (killswitch global) */
export async function pushEnabledGlobally(): Promise<boolean> {
  return (await snapshot()).global.pushEnabled;
}

/** ¿Se le puede mandar correo a este dev? Global Y su propio interruptor. */
export async function emailAllowed(devId?: string | null): Promise<boolean> {
  const snap = await snapshot();
  if (!snap.global.emailEnabled) return false;
  if (!devId) return true; // destinatario sin dev (p.ej. quien reportó, o el digest de equipo)
  return snap.byDev.get(devId)?.emailEnabled ?? true;
}

/** ¿Se le puede mandar push a este dev? Global Y su propio interruptor (además del toggle por
 *  dispositivo, que vive en roz.push_subscription). */
export async function pushAllowed(devId?: string | null): Promise<boolean> {
  const snap = await snapshot();
  if (!snap.global.pushEnabled) return false;
  if (!devId) return true;
  return snap.byDev.get(devId)?.pushEnabled ?? true;
}

/** Estado global + el de cada dev que tenga fila. Lectura fresca (la usa el dashboard). */
export async function listSwitches(): Promise<{ global: SwitchState; devs: DevSwitch[] }> {
  invalidate();
  const snap = await snapshot();
  return {
    global: snap.global,
    devs: [...snap.byDev.entries()].map(([devId, state]) => ({ devId, ...state })),
  };
}

export interface SwitchPatch {
  emailEnabled?: boolean;
  pushEnabled?: boolean;
}

function patchRow(patch: SwitchPatch, by: string | null): Record<string, unknown> {
  const row: Record<string, unknown> = { updated_by: by, updated_at: new Date().toISOString() };
  if (patch.emailEnabled !== undefined) row.email_enabled = patch.emailEnabled;
  if (patch.pushEnabled !== undefined) row.push_enabled = patch.pushEnabled;
  return row;
}

/** Mueve el interruptor global (killswitch del equipo). */
export async function setGlobalSwitch(patch: SwitchPatch, by: string | null): Promise<SwitchState> {
  const supabase = db();
  // Update-then-insert en vez de upsert: la unicidad de la fila global la da un índice PARCIAL, y
  // PostgREST no puede inferir un ON CONFLICT sobre un índice con predicado.
  const { data, error } = await supabase
    .from('notification_switch')
    .update(patchRow(patch, by))
    .eq('scope', 'global')
    .select(SELECT);
  if (error) throw error;

  let row = (data as Row[] | null)?.[0];
  if (!row) {
    const seeded = await supabase
      .from('notification_switch')
      .insert({ scope: 'global', dev_id: null, ...patchRow(patch, by) })
      .select(SELECT)
      .single();
    if (seeded.error) throw seeded.error;
    row = seeded.data as Row;
  }

  invalidate();
  return toState(row);
}

/** Mueve el interruptor de UNA persona (sus propios avisos). */
export async function setDevSwitch(devId: string, patch: SwitchPatch, by: string | null): Promise<SwitchState> {
  const { data, error } = await db()
    .from('notification_switch')
    .upsert({ scope: 'dev', dev_id: devId, ...patchRow(patch, by) }, { onConflict: 'dev_id' })
    .select(SELECT)
    .single();
  if (error) throw error;
  invalidate();
  return toState(data as Row);
}
