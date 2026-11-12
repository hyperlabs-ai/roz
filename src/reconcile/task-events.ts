// Automatización código→tarea (señales EN VIVO del ciclo del código, más allá del push a default).
// A diferencia de reconcile/commits.ts y pull-request.ts (que cuentan trabajo YA integrado), aquí
// se reacciona al INICIO del trabajo: una rama o una PR que referencia una tarea (ROZ-123) la mueve
// por su ciclo — rama creada → "En curso"; PR abierta → "En revisión". El cierre (merge → "Done")
// lo maneja reconcilePullRequest. Todo por convención en el nombre de la rama / título / cuerpo.
import { db } from '../db/supabase.js';
import {
  getPullRequest,
  listPullRequestCommits,
  listPullRequestReviews,
  referencesLinearIssue,
  type PrAuthor,
  type PrReview,
} from '../adapters/github.js';
import { persistActors } from './pull-request.js';
import { notifyPrReviewed } from '../notify/notifications.js';
import { resolveReference } from '../linear/legacy.js';
import { linearSourceOfTruth } from '../linear/enabled.js';

// Estados desde los que una señal de código puede AVANZAR la tarea (no retrocede desde review/done).
const CAN_START = ['planificada', 'pendiente'];
const CLOSED = ['completada', 'cancelada'];

/**
 * Rama creada. Si su nombre referencia una tarea (feat/ROZ-123-...), la tarea entra a "En curso"
 * (solo si estaba en backlog/por-hacer — no revierte una PR ya abierta ni una tarea cerrada) y se
 * guarda la rama. Idempotente: reprocesar deja el mismo estado.
 */
export async function handleBranchCreated(input: { repo: string; ref: string; githubId?: number | null }): Promise<{ action: string; identifier?: string }> {
  const identifier = await resolveReference(referencesLinearIssue(input.ref));
  if (!identifier) return { action: 'no-ref' };
  const supabase = db();
  const { data: wi } = await supabase.from('work_item').select('id, status, started_at').eq('identifier', identifier).maybeSingle();
  const item = wi as { id: string; status: string; started_at: string | null } | null;
  if (!item?.id) return { action: 'no-task', identifier };

  const now = new Date().toISOString();
  const upd: Record<string, unknown> = { head_ref: input.ref, updated_at: now };
  // Con Linear como fuente de verdad el estado lo mueve la integración de GitHub de Linear y llega por
  // el espejo: aquí solo se liga la rama.
  const moves = CAN_START.includes(item.status) && !linearSourceOfTruth();
  if (moves) {
    upd.status = 'en_progreso'; // el valor, no STATE_LABEL: `status` tiene check constraint
    if (!item.started_at) upd.started_at = now;
  }
  await supabase.from('work_item').update(upd).eq('id', item.id);
  return { action: moves ? 'en_progreso' : 'branch-linked', identifier };
}

/**
 * PR abierta/reabierta/lista-para-review. Si referencia una tarea, ésta pasa a "En revisión"
 * (salvo que ya esté cerrada), se registra el PR (nº, rama, estado 'open') y se graba la atribución
 * en vivo (autores + revisores; el merger aún no existe). Idempotente vía upsert de actores.
 */
export async function handlePrOpened(input: { repo: string; number: number; githubId?: number | null }): Promise<{ action: string; identifier?: string }> {
  const pr = await getPullRequest(input.repo, input.number);
  const identifier = await resolveReference(referencesLinearIssue(`${pr.title}\n${pr.body ?? ''}\n${pr.headRef ?? ''}`));
  if (!identifier) return { action: 'no-ref' };
  const supabase = db();
  const { data: wi } = await supabase.from('work_item').select('id, status, started_at').eq('identifier', identifier).maybeSingle();
  const item = wi as { id: string; status: string; started_at: string | null } | null;
  if (!item?.id) return { action: 'no-task', identifier };

  const now = new Date().toISOString();
  const upd: Record<string, unknown> = {
    repo: input.repo,
    pr_number: pr.number,
    pr_state: 'open',
    head_ref: pr.headRef ?? null,
    updated_at: now,
  };
  // Igual que con la rama: con el flag encendido el estado viene de Linear; aquí solo PR y atribución.
  const moves = !CLOSED.includes(item.status) && !linearSourceOfTruth();
  if (moves) {
    upd.status = 'revision'; // idem: valor, no etiqueta
    if (!item.started_at) upd.started_at = now;
  }
  await supabase.from('work_item').update(upd).eq('id', item.id);

  // Atribución en vivo (autores reales + revisores). El merger se registra al mergear.
  const [authors, reviews] = await Promise.all([
    listPullRequestCommits(input.repo, input.number).catch(() => [] as PrAuthor[]),
    listPullRequestReviews(input.repo, input.number).catch(() => [] as PrReview[]),
  ]);
  await persistActors(supabase, item.id, { authors, reviews, mergerLogin: null });

  return { action: moves ? 'revision' : 'pr-linked', identifier };
}

/**
 * Revisión enviada en una PR (aprobó / pidió cambios / comentó). Refresca los revisores de la tarea
 * ligada EN VIVO, sin esperar al merge y SIN cambiar su estado (la tarea puede estar en cualquier
 * punto). Resuelve la tarea por la referencia (ROZ-123) en título/cuerpo/rama del PR; si no hay
 * referencia o tarea, no-op. persistActors es idempotente por (tarea, login, rol) → reprocesar es seguro.
 */
export async function handlePrReviewed(input: { repo: string; number: number; githubId?: number | null }): Promise<{ action: string; identifier?: string }> {
  const pr = await getPullRequest(input.repo, input.number);
  const identifier = await resolveReference(referencesLinearIssue(`${pr.title}\n${pr.body ?? ''}\n${pr.headRef ?? ''}`));
  if (!identifier) return { action: 'no-ref' };
  const supabase = db();
  const { data: wi } = await supabase.from('work_item').select('id').eq('identifier', identifier).maybeSingle();
  const item = wi as { id: string } | null;
  if (!item?.id) return { action: 'no-task', identifier };

  const [authors, reviews] = await Promise.all([
    listPullRequestCommits(input.repo, input.number).catch(() => [] as PrAuthor[]),
    listPullRequestReviews(input.repo, input.number).catch(() => [] as PrReview[]),
  ]);
  await persistActors(supabase, item.id, { authors, reviews, mergerLogin: null });
  // Aviso al autor de la PR: quién la revisó y con qué veredicto (best-effort, una vez por veredicto).
  await notifyPrReviewed({
    pr: { repo: input.repo, number: pr.number, title: pr.title, branch: pr.headRef ?? null, identifier },
    authorLogins: [pr.authorLogin, ...authors.map((a) => a.login)],
    reviews,
  });
  return { action: 'reviewed', identifier };
}
