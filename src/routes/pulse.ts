// Rutas del Pulso del equipo (roz v2). Se montan DENTRO del router del dashboard, así que el auth
// (requireDashboardAuth) ya corrió:
//
//   dashboardRoutes.route('/pulse', pulseRoutes);          → GET /api/dashboard/pulse, /pulse/feed
//   dashboardRoutes.route('/roz-v2', rozV2StatusRoutes);   → GET /api/dashboard/roz-v2/status
//
// Lectura pura: funcionan con ROZ_LINEAR_SOT apagado (contrato (b), excepciones al 409 LINEAR_SOT_OFF).
import { Hono } from 'hono';
import type { RozContext } from '../types/hono.js';
import { fail } from './http.js';
import { getPulse, getPulseFeed, getRozV2Status } from '../dashboard/pulse.js';
import type { PulseGroupBy } from '../types/roz-v2.js';

const GROUP_BY: readonly PulseGroupBy[] = ['persona', 'proyecto', 'cliente'];

export const pulseRoutes = new Hono<RozContext>();

// GET /pulse?groupBy=persona|proyecto|cliente&weekStart=YYYY-MM-DD → PulseResponse
pulseRoutes.get('/', async (c) => {
  try {
    const raw = c.req.query('groupBy');
    const groupBy = GROUP_BY.includes(raw as PulseGroupBy) ? (raw as PulseGroupBy) : 'persona';
    return c.json(await getPulse({ groupBy, weekStart: c.req.query('weekStart') ?? null }));
  } catch (err) {
    return fail(c, err);
  }
});

// GET /pulse/feed?after=<ISO>&limit=<1..100> → PulseFeedResponse (poll cada 20 s)
pulseRoutes.get('/feed', async (c) => {
  try {
    const limit = Number(c.req.query('limit') ?? '');
    return c.json(
      await getPulseFeed({
        after: c.req.query('after') ?? null,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      }),
    );
  } catch (err) {
    return fail(c, err);
  }
});

export const rozV2StatusRoutes = new Hono<RozContext>();

// GET /roz-v2/status → RozV2Status. El front decide con esto qué pantallas mostrar (Pulso como
// principal, Juntas/Planes, Tareas en solo lectura).
rozV2StatusRoutes.get('/status', (c) => c.json(getRozV2Status()));
