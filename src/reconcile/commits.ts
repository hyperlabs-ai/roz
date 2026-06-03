// Reconciliación de commits [fase 5]: el reto principal. Por cada commit de GitHub:
//  1. ¿apunta a un issue de Linear? (branch/magic words) → la integración nativa lo enlaza.
//     roz NO reimplementa eso; solo marca documentado.
//  2. Si no → trabajo huérfano. Claude clasifica: trivial vs sustantivo.
//  3. Sustantivo → búsqueda semántica contra issues/átomos; crea ticket/doc solo si NO
//     hay match sobre umbral.
//  4. Idempotencia por sha (claimOnce).
import { getCommit, referencesLinearIssue } from '../adapters/github.js';
import { claimOnce } from '../events/outbox.js';

export interface ReconcileInput {
  repo: string; // "owner/name"
  sha: string;
}

export async function reconcileCommit(input: ReconcileInput): Promise<{ action: string }> {
  // Exactamente-una-vez por commit.
  const first = await claimOnce(`commit:${input.repo}:${input.sha}`, 'commit');
  if (!first) return { action: 'skipped:already-processed' };

  const commit = await getCommit(input.repo, input.sha);

  const linked = referencesLinearIssue(commit.message);
  if (linked) {
    // La integración nativa Linear<->GitHub ya lo enlaza. roz no duplica.
    return { action: `linked:${linked}` };
  }

  // TODO fase 5: clasificar (Claude) trivial vs sustantivo; si sustantivo, búsqueda
  // semántica contra work_item + knowledge_atom; crear doc/ticket solo sin match.
  return { action: 'orphan:pending-classification' };
}
