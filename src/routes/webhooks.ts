// Webhooks entrantes (afuera -> roz). Se verifica la firma sobre el cuerpo CRUDO antes
// de parsear. Cada webhook traduce a un OutboxEvent y responde 200 rápido: el trabajo
// pesado ocurre async: lo drena el cron del outbox (/v1/internal/drain).
import { Hono } from 'hono';
import type { RozContext } from '../types/hono.js';
import { config } from '../config.js';
import { verifyGithub, verifyLinear } from '../utils/webhooks.js';
import { emit } from '../events/outbox.js';

export const webhookRoutes = new Hono<RozContext>();

// GitHub trunca el array `commits` del payload de push a este tope. Si lo alcanzamos, el push
// pudo traer más commits → se encola un backfill que enumera el rango completo vía la API.
const GITHUB_PUSH_COMMIT_CAP = 20;
const ZERO_SHA = '0'.repeat(40); // `before` en la creación de una rama (sin historial previo)

// --- Linear: cambios de estado de issues (fuente de verdad del trabajo). ---
webhookRoutes.post('/linear', async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header('linear-signature');
  if (!verifyLinear(raw, sig ?? null, config.linear.webhookSecret)) {
    return c.json({ error: 'bad signature' }, 401);
  }
  const evt = JSON.parse(raw) as { type?: string; action?: string; data?: any };

  // Auto-onboarding: proyecto nuevo en Linear → roz empieza a trackearlo.
  if (evt.type === 'Project') {
    if (evt.action !== 'remove') {
      await emit('linear.project_upserted', { data: evt.data });
    }
    return c.json({ ok: true });
  }

  if (evt.type === 'Issue') {
    if (evt.action === 'remove') {
      await emit('linear.issue_removed', { linearId: evt.data?.id });
    } else {
      // create | update: espejar SIEMPRE (sin idempotency_key — cada update es legítimo;
      // el upsert por linear_id es idempotente, así que reprocesar es seguro).
      await emit('linear.issue_upserted', { data: evt.data });

      // Completado -> disparar efectos de cierre (fase 4: documentar + avisar al proposer).
      if (evt.data?.state?.type === 'completed') {
        await emit(
          'work_item.done',
          { linearId: evt.data.id, identifier: evt.data.identifier },
          { idempotencyKey: `done:${evt.data.id}` },
        );
      }
    }
  }
  return c.json({ ok: true });
});

// --- GitHub: push/commits (fuente de verdad del código). ---
webhookRoutes.post('/github', async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header('x-hub-signature-256');
  if (!verifyGithub(raw, sig ?? null, config.github.webhookSecret)) {
    return c.json({ error: 'bad signature' }, 401);
  }
  const event = c.req.header('x-github-event');
  const payload = JSON.parse(raw) as {
    ref?: string; // "refs/heads/<branch>" en push
    before?: string; // tip anterior de la rama (push)
    after?: string; // tip nuevo de la rama (push)
    repository?: { full_name?: string; name?: string; description?: string | null; html_url?: string; default_branch?: string };
    commits?: any[];
    action?: string;
    pull_request?: { number?: number; merged?: boolean };
  };
  const repo = payload.repository?.full_name;

  // Detección de repos: desde el evento `repository` (action: created), no desde el push. El
  // payload ya trae la metadata del repo, así que la pasamos y evitamos una llamada a la API de
  // GitHub. Dedup por idempotency_key (una sola vez por repo). El drain decide si es realmente
  // nuevo (sin proyecto resoluble): si lo es, lo vincula y notifica a los devs.
  if (event === 'repository' && payload.action === 'created' && repo) {
    const r = payload.repository!;
    const meta =
      r.name && r.html_url
        ? { fullName: repo, name: r.name, description: r.description ?? null, url: r.html_url }
        : undefined; // si faltara algo, se omite y handleRepoDetected hace el fetch
    await emit('repo.detected', { repo, meta }, { idempotencyKey: `repo-detected:${repo}` });
  }

  if (event === 'push' && repo) {
    // Solo se cuenta el trabajo que aterriza en la RAMA POR DEFECTO (lo que de verdad se integró).
    // Esto deduplica de raíz: una PR (squash/merge/rebase) termina como commit(s) en la default y
    // se cuenta una sola vez; los pushes a feature branches y el crear/borrar ramas no inflan.
    // Los merge commits se descartan después en la reconciliación (no son trabajo nuevo).
    const def = payload.repository?.default_branch;
    const onDefault = !!def && payload.ref === `refs/heads/${def}`;
    if (onDefault) {
      const commits = payload.commits ?? [];
      for (const commit of commits) {
        await emit(
          'commit.received',
          { repo, sha: commit.id },
          { idempotencyKey: `commit:${repo}:${commit.id}` },
        );
      }
      // Si el push alcanzó el tope (array truncado por GitHub), pudo traer más commits que los
      // 20 del payload —común en un merge de PR grande—. Se encola un backfill que enumera el
      // rango before...after vía la API de compare en el drain. Idempotente por sha → los 20 ya
      // emitidos no se duplican. Se omite si `before` es ZERO (no hay rango previo que comparar).
      if (commits.length >= GITHUB_PUSH_COMMIT_CAP && payload.before && payload.after && payload.before !== ZERO_SHA) {
        await emit(
          'commits.backfill',
          { repo, before: payload.before, after: payload.after },
          { idempotencyKey: `push-backfill:${repo}:${payload.after}` },
        );
      }
    }
  }

  // PR mergeada → documentar por PR (un ticket con atribución). Idempotente por nº de PR, así
  // reintentos / reopen+merge no duplican. El dedup con el flujo de commits lo hace reconcileCommit
  // (un commit que pertenece a una PR no se documenta dos veces).
  if (event === 'pull_request' && repo && payload.action === 'closed' && payload.pull_request?.merged) {
    const number = payload.pull_request.number;
    if (number != null) {
      await emit('pr.merged', { repo, number }, { idempotencyKey: `pr:${repo}:${number}` });
    }
  }
  return c.json({ ok: true });
});
