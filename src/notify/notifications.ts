// Notificaciones [fase 3]. Efectos disparados por el drain del outbox. Cada envío deja
// un registro en `notification` (sent/failed con provider_id o error). La idempotencia la
// da el outbox: el evento solo se marca `done` si el efecto no lanzó; si el envío falla,
// se lanza para que el drain reintente (backoff). Riesgo de doble envío solo si el proceso
// muere entre el send y el marcado `done` — aceptable; se puede endurecer con una llave
// `notify:*` cuando haga falta.
import { db } from '../db/supabase.js';
import { sendWhatsapp } from '../adapters/whatsapp.js';

interface AssignedPayload {
  workItemId?: string;
  devId?: string;
  identifier?: string;
}

/** Avisa al dev que le asignaron un issue. */
export async function notifyAssignment(payload: AssignedPayload): Promise<void> {
  const { workItemId, devId, identifier } = payload;
  if (!devId || !identifier) return;

  const supabase = db();
  const { data: dev } = await supabase
    .from('dev')
    .select('id, name, whatsapp')
    .eq('id', devId)
    .single();
  const { data: wi } = workItemId
    ? await supabase.from('work_item').select('title').eq('id', workItemId).single()
    : { data: null };

  const body = `🟣 roz · Te asignaron ${identifier}${wi?.title ? ` — ${wi.title}` : ''}`;

  if (!dev?.whatsapp) {
    await supabase.from('notification').insert({
      channel: 'whatsapp',
      to_dev_id: devId,
      body,
      status: 'failed',
      error: 'dev sin número de whatsapp',
    });
    return; // no hay a quién mandar; no es un fallo reintentables
  }

  try {
    const res = await sendWhatsapp({ to: dev.whatsapp, body });
    await supabase.from('notification').insert({
      channel: 'whatsapp',
      to_dev_id: devId,
      to_address: dev.whatsapp,
      body,
      status: 'sent',
      provider_id: res.sid,
    });
  } catch (err) {
    await supabase.from('notification').insert({
      channel: 'whatsapp',
      to_dev_id: devId,
      to_address: dev.whatsapp,
      body,
      status: 'failed',
      error: String(err),
    });
    throw err; // que el drain reintente
  }
}
