// Red de seguridad del puente Ops ⇄ roz. El camino normal son los triggers de la migración 0021:
// escribes en un schema y el otro se entera dentro de la misma transacción. Esto NO los sustituye
// ni los duplica — cubre el hueco que un trigger no puede ver, porque no hubo evento que disparar:
//
//   · Activas un dev que estaba inactivo → sus tareas YA asignadas nunca insertaron nada en
//     task_assignees, así que nadie las bajó.
//   · Vinculas un proyecto de Ops a uno de roz (hyperops_project_id) después del hecho.
//   · Un trigger devolvió por su `exception when others` (la escritura local se completó, la
//     propagación no) — es la garantía de que roz nunca bloquea a Ops, y el precio es esta pasada.
//
// La lógica de reparación NO vive aquí: vive en roz.ops_bridge_repair(), que a su vez llama a
// roz.sync_ops_task() — la MISMA función que llaman los triggers. Reimplementarla en TypeScript
// sería garantizar que backfill y tiempo real divergan con el tiempo.
//
// Deduplicación: sync_ops_task() busca por ops_task_id antes de insertar, y encima está el índice
// único parcial idx_roz_work_item_ops_task. Correr esto N veces converge al mismo estado.
import { db } from '../db/supabase.js';

export type BridgeIssue = 'falta_en_roz' | 'huerfano_en_roz' | 'duplicado' | 'datos_distintos';

export type BridgeAuditRow = {
  issue: BridgeIssue;
  task_id: string | null;
  work_item_id: string | null;
  detail: string | null;
};

export type BridgeRepairRow = {
  action: string;
  task_id: string | null;
  detail: string | null;
};

// Solo diagnostica. Útil para responder "¿está sano el puente?" sin efectos.
export async function auditOpsBridge(): Promise<{ total: number; byIssue: Record<string, number>; rows: BridgeAuditRow[] }> {
  const { data, error } = await db().rpc('ops_bridge_audit');
  if (error) throw error;

  const rows = (data ?? []) as BridgeAuditRow[];
  const byIssue: Record<string, number> = {};
  for (const r of rows) byIssue[r.issue] = (byIssue[r.issue] ?? 0) + 1;

  return { total: rows.length, byIssue, rows };
}

// Repara. `dryRun` va en true por defecto a propósito: la escritura se pide explícitamente.
export async function repairOpsBridge(dryRun = true): Promise<{ dryRun: boolean; total: number; byAction: Record<string, number>; rows: BridgeRepairRow[] }> {
  const { data, error } = await db().rpc('ops_bridge_repair', { p_dry_run: dryRun });
  if (error) throw error;

  const rows = (data ?? []) as BridgeRepairRow[];
  const byAction: Record<string, number> = {};
  for (const r of rows) byAction[r.action] = (byAction[r.action] ?? 0) + 1;

  return { dryRun, total: rows.length, byAction, rows };
}

// Lo que corre el cron: audita, repara si hace falta, y vuelve a auditar para confirmar que
// convergió. La segunda auditoría es la verificación de deduplicación — si algo quedara duplicado
// o la reparación no fuera idempotente, `remaining` saldría distinto de cero y queda en el log.
export async function reconcileOpsBridge(): Promise<{
  found: number;
  byIssue: Record<string, number>;
  repaired: number;
  byAction: Record<string, number>;
  remaining: number;
  converged: boolean;
}> {
  const before = await auditOpsBridge();

  if (before.total === 0) {
    return { found: 0, byIssue: {}, repaired: 0, byAction: {}, remaining: 0, converged: true };
  }

  const repair = await repairOpsBridge(false);
  const after = await auditOpsBridge();

  return {
    found: before.total,
    byIssue: before.byIssue,
    repaired: repair.total,
    byAction: repair.byAction,
    remaining: after.total,
    converged: after.total === 0,
  };
}
