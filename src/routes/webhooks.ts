// Webhooks entrantes (afuera -> roz). Se verifica la firma sobre el cuerpo CRUDO antes
// de parsear. Cada webhook traduce a un OutboxEvent y responde 200 rápido: el trabajo
// pesado ocurre async: lo drena el cron del outbox (/v1/internal/drain).
import { Hono } from 'hono';
import type { RozContext } from '../types/hono.js';
import { config } from '../config.js';
import { verifyGithub, verifyLinear } from '../utils/webhooks.js';
import { emit } from '../events/outbox.js';

export const webhookRoutes = new Hono<RozContext>();

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
  const payload = JSON.parse(raw) as { repository?: { full_name?: string }; commits?: any[] };

  if (event === 'push' && payload.repository?.full_name) {
    const repo = payload.repository.full_name;
    for (const commit of payload.commits ?? []) {
      await emit(
        'commit.received',
        { repo, sha: commit.id },
        { idempotencyKey: `commit:${repo}:${commit.id}` },
      );
    }
    // Detección de repos: una sola vez por repo (dedup por idempotency_key). El drain decide si
    // es realmente nuevo (sin proyecto resoluble): si lo es, lo vincula y notifica a los devs.
    await emit('repo.detected', { repo }, { idempotencyKey: `repo-detected:${repo}` });
  }
  return c.json({ ok: true });
});
