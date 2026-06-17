// Second brain — documentación al cierre [fase 4]. Disparado por `work_item.done` (webhook de
// Linear cuando un issue pasa a completed). roz:
//   1. marca el work_item como documentado;
//   2. crea/actualiza un átomo de conocimiento con el delta del trabajo (título + spec),
//      con embedding y procedencia ligada al identifier de Linear — supersede en vez de
//      duplicar (si ya hay un átomo para ese issue con otro contenido, lo marca superseded);
//   3. avisa por email a quien propuso (si el requester es un correo) que su cambio cerró.
//
// Todo es idempotente: el efecto se reintenta vía el outbox, así que reprocesar el mismo
// `done` no crea átomos ni correos duplicados (dedup por content_hash + claimOnce del aviso).
import { createHash } from 'node:crypto';
import { db } from '../db/supabase.js';
import { embed, embeddingModel } from '../adapters/embeddings.js';
import { claimOnce } from '../events/outbox.js';
import { notifyProposerDone } from '../notify/notifications.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface DoneInput {
  linearId?: string;
  identifier?: string;
}

export interface DocumentResult {
  documented: boolean;
  atom: 'created' | 'updated' | 'unchanged' | 'skipped';
  notified: boolean;
}

function contentHash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function documentCompletedWork(payload: DoneInput): Promise<DocumentResult> {
  const supabase = db();
  const linearId = String(payload.linearId ?? '');
  if (!linearId) return { documented: false, atom: 'skipped', notified: false };

  const { data: wi } = await supabase
    .from('work_item')
    .select('id, identifier, project_id, title, spec, requester, url, documented')
    .eq('linear_id', linearId)
    .maybeSingle();
  if (!wi) return { documented: false, atom: 'skipped', notified: false };

  // 1. Marcar documentado (idempotente).
  if (!wi.documented) {
    await supabase.from('work_item').update({ documented: true }).eq('id', wi.id);
  }

  // 2. Átomo de conocimiento. Sin project_id no hay dónde anclarlo en el brain.
  let atomResult: DocumentResult['atom'] = 'skipped';
  if (wi.project_id) {
    atomResult = await upsertAtom(wi);
  }

  // 3. Avisar al proposer (solo si el requester es un email y no se notificó antes).
  let notified = false;
  const requester = (wi.requester ?? '').trim();
  if (EMAIL_RE.test(requester)) {
    const firstTime = await claimOnce(`done-notify:${linearId}`, 'done-notify');
    if (firstTime) {
      try {
        await notifyProposerDone({
          to: requester,
          identifier: wi.identifier,
          title: wi.title,
          url: wi.url,
        });
        notified = true;
      } catch (err) {
        // Liberar para reintentar el aviso en el próximo drain (no perder la notificación).
        await supabase.from('idempotency_key').delete().eq('key', `done-notify:${linearId}`);
        throw err;
      }
    }
  }

  return { documented: true, atom: atomResult, notified };
}

async function upsertAtom(wi: {
  id: string;
  identifier: string;
  project_id: string;
  title: string;
  spec: string | null;
}): Promise<DocumentResult['atom']> {
  const supabase = db();
  const title = wi.title;
  const body = (wi.spec ?? '').trim() || wi.title;
  const hash = contentHash(`${title}\n${body}`);

  // ¿Ya hay un átomo activo para este issue (procedencia = identifier)?
  const { data: existing } = await supabase
    .from('knowledge_atom')
    .select('id, content_hash')
    .eq('project_id', wi.project_id)
    .eq('status', 'active')
    .contains('provenance', [wi.identifier])
    .maybeSingle();

  if (existing && existing.content_hash === hash) {
    return 'unchanged'; // ya documentado con el mismo contenido
  }

  // Embedding (best-effort: si falla, se inserta sin vector y lo rellena el brain-sweep).
  let embeddingLiteral: string | null = null;
  try {
    const v = await embed(`${title}\n${body}`);
    embeddingLiteral = `[${v.join(',')}]`;
  } catch {
    embeddingLiteral = null;
  }

  // Insertar el átomo nuevo.
  const { data: inserted, error } = await supabase
    .from('knowledge_atom')
    .insert({
      scope: 'project',
      project_id: wi.project_id,
      status: 'active',
      title,
      body,
      provenance: [wi.identifier],
      embedding: embeddingLiteral,
      embedding_model: embeddingLiteral ? embeddingModel : null,
      content_hash: hash,
    })
    .select('id')
    .single();
  if (error) throw error;

  // Supersede el anterior (no se borra: se conserva con procedencia).
  if (existing) {
    await supabase
      .from('knowledge_atom')
      .update({ status: 'superseded', superseded_by: inserted.id })
      .eq('id', existing.id);
    return 'updated';
  }
  return 'created';
}
