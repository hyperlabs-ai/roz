// Notificaciones [fase 3]. Efectos disparados por el drain del outbox. Canal: EMAIL (Resend).
// Cada envío deja un registro en `notification` (sent/failed con provider_id o error). La
// idempotencia la da el outbox: el evento solo se marca `done` si el efecto no lanzó; si el
// envío falla, se lanza para que el drain reintente (backoff).
import { db } from '../db/supabase.js';
import { sendEmail } from '../adapters/email.js';
import { claimOnce } from '../events/outbox.js';

interface AssignedPayload {
  workItemId?: string;
  devId?: string;
  identifier?: string;
}

/** "Manuel (AI Developer)" -> "Manuel". Quita el rol entre paréntesis del nombre. */
function firstName(name?: string | null): string {
  if (!name) return '';
  return name.replace(/\s*\(.*\)\s*$/, '').trim();
}

/** Plantilla de correo: branding ROZ, bien formateada, con botón directo a Linear. */
function renderEmail(opts: {
  greeting: string;
  identifier: string;
  title: string;
  priority?: string | null;
  url?: string | null;
}): { html: string; text: string } {
  const { greeting, identifier, title, priority, url } = opts;
  const button = url
    ? `<a href="${url}" style="display:inline-block;background:#5e6ad2;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px">Abrir en Linear →</a>`
    : '';
  const prioBadge = priority
    ? `<span style="display:inline-block;background:#eef0ff;color:#5e6ad2;border-radius:6px;padding:3px 10px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.4px">${priority}</span>`
    : '';

  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e8eb">
      <tr><td style="background:#0d0d12;padding:20px 28px">
        <span style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:3px">ROZ</span>
      </td></tr>
      <tr><td style="padding:28px">
        <p style="margin:0 0 4px;color:#6b7280;font-size:13px">${greeting}</p>
        <p style="margin:0 0 18px;color:#111827;font-size:17px;font-weight:600">Te asignaron una tarea</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #eef0f2;border-radius:10px;margin-bottom:22px">
          <tr><td style="padding:16px 18px">
            <div style="color:#5e6ad2;font-size:13px;font-weight:700;margin-bottom:4px">${identifier} &nbsp;${prioBadge}</div>
            <div style="color:#111827;font-size:15px;line-height:1.4">${title}</div>
          </td></tr>
        </table>
        ${button}
      </td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #eef0f2">
        <span style="color:#9ca3af;font-size:12px">Enviado por ROZ · enrutamiento y contexto de desarrollo</span>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  const text =
    `${greeting}\nTe asignaron ${identifier}${title ? ` — ${title}` : ''}` +
    (priority ? ` (prioridad: ${priority})` : '') +
    (url ? `\n\nAbrir en Linear: ${url}` : '') +
    `\n\n— ROZ`;

  return { html, text };
}

/** Plantilla de cierre: avisa a quien propuso que su cambio quedó cerrado y documentado. */
function renderDoneEmail(opts: {
  identifier: string;
  title: string;
  url?: string | null;
}): { html: string; text: string } {
  const { identifier, title, url } = opts;
  const button = url
    ? `<a href="${url}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px">Ver en Linear →</a>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e8eb">
      <tr><td style="background:#0d0d12;padding:20px 28px">
        <span style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:3px">ROZ</span>
      </td></tr>
      <tr><td style="padding:28px">
        <p style="margin:0 0 4px;color:#16a34a;font-size:13px;font-weight:600">✓ Completado</p>
        <p style="margin:0 0 18px;color:#111827;font-size:17px;font-weight:600">Tu solicitud quedó cerrada y documentada</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #eef0f2;border-radius:10px;margin-bottom:22px">
          <tr><td style="padding:16px 18px">
            <div style="color:#5e6ad2;font-size:13px;font-weight:700;margin-bottom:4px">${identifier}</div>
            <div style="color:#111827;font-size:15px;line-height:1.4">${title}</div>
          </td></tr>
        </table>
        ${button}
      </td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #eef0f2">
        <span style="color:#9ca3af;font-size:12px">Enviado por ROZ · enrutamiento y contexto de desarrollo</span>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  const text =
    `✓ Completado\nTu solicitud ${identifier}${title ? ` — ${title}` : ''} quedó cerrada y documentada.` +
    (url ? `\n\nVer en Linear: ${url}` : '') +
    `\n\n— ROZ`;
  return { html, text };
}

/** Avisa a quien propuso (requester) que su cambio cerró. Registra el envío en `notification`. */
export async function notifyProposerDone(opts: {
  to: string;
  identifier: string;
  title: string;
  url?: string | null;
}): Promise<void> {
  const supabase = db();
  const subject = `ROZ · ${opts.identifier} completado${opts.title ? ` — ${opts.title}` : ''}`;
  const { html, text } = renderDoneEmail(opts);
  try {
    const res = await sendEmail({ to: opts.to, subject, html, text });
    await supabase.from('notification').insert({
      channel: 'email',
      to_address: opts.to,
      template: 'work_done',
      body: text,
      status: 'sent',
      provider_id: res.id,
    });
  } catch (err) {
    await supabase.from('notification').insert({
      channel: 'email',
      to_address: opts.to,
      template: 'work_done',
      body: text,
      status: 'failed',
      error: String(err),
    });
    throw err; // que el drain reintente
  }
}

/** Avisa por correo al dev que le asignaron un issue. */
export async function notifyAssignment(payload: AssignedPayload): Promise<void> {
  const { workItemId, devId, identifier } = payload;
  if (!devId || !identifier) return;

  const supabase = db();

  // Guard anti-duplicado: el evento del outbox puede reintentarse (p.ej. si el envío fue OK
  // pero el insert en `notification` falló). Reclamar aquí asegura UN solo correo por
  // (issue, dev); si el efecto falla se libera para que el reintento sí pueda enviar.
  const notifyKey = `notify-assign:${identifier}:${devId}`;
  const firstTime = await claimOnce(notifyKey, 'notify-assign');
  if (!firstTime) return;
  const releaseAndThrow = async (err: unknown): Promise<never> => {
    await supabase.from('idempotency_key').delete().eq('key', notifyKey);
    throw err;
  };
  const { data: dev } = await supabase
    .from('dev')
    .select('id, name, email')
    .eq('id', devId)
    .single();
  const { data: wi } = workItemId
    ? await supabase
        .from('work_item')
        .select('title, url, priority')
        .eq('id', workItemId)
        .single()
    : { data: null };

  const title = wi?.title ?? '';
  const greeting = dev?.name ? `Hola ${firstName(dev.name)},` : 'Hola,';
  const subject = `ROZ · Te asignaron ${identifier}${title ? ` — ${title}` : ''}`;
  const { html, text } = renderEmail({
    greeting,
    identifier,
    title,
    priority: wi?.priority,
    url: wi?.url,
  });

  if (!dev?.email) {
    await supabase.from('notification').insert({
      channel: 'email',
      to_dev_id: devId,
      body: text,
      status: 'failed',
      error: 'dev sin email',
    });
    return; // no hay a quién mandar; no es reintentable
  }

  try {
    const res = await sendEmail({ to: dev.email, subject, html, text });
    await supabase.from('notification').insert({
      channel: 'email',
      to_dev_id: devId,
      to_address: dev.email,
      body: text,
      status: 'sent',
      provider_id: res.id,
    });
  } catch (err) {
    await supabase.from('notification').insert({
      channel: 'email',
      to_dev_id: devId,
      to_address: dev.email,
      body: text,
      status: 'failed',
      error: String(err),
    });
    await releaseAndThrow(err); // libera el guard y relanza para que el drain reintente
  }
}

/** Plantilla: cambios documentados (trabajo ya hecho, auto-creado desde commits). */
function renderDocumentedEmail(opts: { greeting: string; items: { identifier: string; title: string; url: string | null }[] }): { html: string; text: string } {
  const { greeting, items } = opts;
  const n = items.length;
  const heading = n === 1 ? 'Se documentó tu cambio' : `Se documentaron ${n} de tus cambios`;
  const rows = items
    .map(
      (i) =>
        `<tr><td style="padding:10px 16px;border-bottom:1px solid #eef0f2">
           <span style="color:#5e6ad2;font-size:13px;font-weight:700">${i.identifier}</span>
           <div style="color:#111827;font-size:14px;line-height:1.4;margin-top:2px">${i.title}</div>
         </td></tr>`,
    )
    .join('');

  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="500" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e8eb">
      <tr><td style="background:#0d0d12;padding:20px 28px"><span style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:3px">ROZ</span></td></tr>
      <tr><td style="padding:28px 28px 12px">
        <p style="margin:0 0 4px;color:#16a34a;font-size:13px;font-weight:600">✓ Cambio documentado</p>
        <p style="margin:0 0 6px;color:#111827;font-size:17px;font-weight:600">${heading}</p>
        <p style="margin:0 0 16px;color:#6b7280;font-size:13px">${greeting} roz registró tu trabajo en Linear (ya completado). No necesitas hacer nada.</p>
      </td></tr>
      <tr><td style="padding:0 12px 16px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #eef0f2;border-radius:10px">${rows}</table>
      </td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #eef0f2"><span style="color:#9ca3af;font-size:12px">Enviado por ROZ · documentación automática de cambios</span></td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  const text =
    `${heading}\n${greeting} roz registró tu trabajo en Linear (ya completado):\n\n` +
    items.map((i) => `• ${i.identifier} — ${i.title}${i.url ? ` (${i.url})` : ''}`).join('\n') +
    `\n\n— ROZ`;

  return { html, text };
}

/**
 * Notifica al dev, en UN solo correo, los cambios que roz auto-documentó recientemente.
 * Agrupa por ventana de tiempo (el caller dedup-ea por dev+hora vía el outbox), así una PR con
 * muchos commits genera un único correo. Lista los issues completados creados desde `since`.
 */
export async function notifyChangesDocumented(devId: string): Promise<void> {
  if (!devId) return;
  const supabase = db();

  const { data: dev } = await supabase.from('dev').select('id, name, email').eq('id', devId).single();

  // Cambios auto-documentados PENDIENTES de notificar (change_notified=false). Agrupa por estado,
  // no por tiempo: cada PR genera nuevos pendientes (siempre notifica) y el primer evento del
  // push agarra todos; los siguientes ven 0 y no envían.
  const { data: items } = await supabase
    .from('work_item')
    .select('id, identifier, title, url')
    .eq('assignee_dev_id', devId)
    .eq('documented', true)
    .eq('change_notified', false)
    .order('completed_at', { ascending: false })
    .limit(50);

  const list = (items ?? []) as { id: string; identifier: string; title: string; url: string | null }[];
  if (!list.length) return; // nada pendiente (otro evento del mismo push ya notificó)

  const ids = list.map((i) => i.id);

  // Sin email: igual marcamos como notificados para no reintentar para siempre.
  if (!dev?.email) {
    await supabase.from('work_item').update({ change_notified: true }).in('id', ids);
    return;
  }

  const greeting = dev.name ? `Hola ${firstName(dev.name)},` : 'Hola,';
  const subject = list.length === 1 ? `ROZ · Cambio documentado — ${list[0]!.identifier}` : `ROZ · ${list.length} cambios documentados`;
  const { html, text } = renderDocumentedEmail({ greeting, items: list });

  const res = await sendEmail({ to: dev.email, subject, html, text }); // si falla, lanza → reintento (pendientes intactos)
  // Marca como notificados SOLO tras enviar OK, para que un fallo reintente sin perder el aviso.
  await supabase.from('work_item').update({ change_notified: true }).in('id', ids);
  await supabase.from('notification').insert({ channel: 'email', to_dev_id: devId, to_address: dev.email, template: 'change_documented', body: text, status: 'sent', provider_id: res.id });
}
