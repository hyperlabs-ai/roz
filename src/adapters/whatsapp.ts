// WhatsApp vía Twilio. Mensajes proactivos fuera de la ventana de 24h requieren
// plantillas pre-aprobadas por Meta (ContentSid). Llamamos la REST API directa.
import { config } from '../config.js';

const BASE = 'https://api.twilio.com/2010-04-01';

export interface SendWhatsappInput {
  to: string; // E.164, sin el prefijo whatsapp:
  /** Texto libre (solo válido dentro de la ventana de 24h). */
  body?: string;
  /** ContentSid de plantilla aprobada (para mensajes proactivos). */
  contentSid?: string;
  /** Variables de la plantilla, p.ej. {"1":"ROZ-123","2":"Fer"}. */
  contentVariables?: Record<string, string>;
}

export interface WhatsappResult {
  sid: string;
  status: string;
}

export async function sendWhatsapp(input: SendWhatsappInput): Promise<WhatsappResult> {
  const { accountSid, authToken, whatsappFrom } = config.twilio;
  const params = new URLSearchParams();
  params.set('To', `whatsapp:${input.to}`);
  params.set('From', whatsappFrom);
  if (input.contentSid) {
    params.set('ContentSid', input.contentSid);
    if (input.contentVariables) {
      params.set('ContentVariables', JSON.stringify(input.contentVariables));
    }
  } else if (input.body) {
    params.set('Body', input.body);
  }

  const res = await fetch(`${BASE}/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const json = (await res.json()) as { sid?: string; status?: string; message?: string };
  if (!res.ok) throw new Error(`Twilio error: ${json.message ?? res.statusText}`);
  return { sid: json.sid!, status: json.status ?? 'queued' };
}
