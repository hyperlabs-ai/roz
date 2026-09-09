// Email vía Resend (API HTTP, compatible con serverless — sin proceso persistente).
// roz lo usa para notificar a los devs por correo. RESEND_FROM debe ser un remitente de un
// dominio verificado en Resend; para pruebas, `onboarding@resend.dev` solo entrega al email
// de la cuenta dueña.
import { config } from '../config.js';
import { emailEnabled } from '../notify/switches.js';

export interface SendEmailInput {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

export interface EmailResult {
  /** id del proveedor; null si el envío se omitió por el killswitch. */
  id: string | null;
  /** true = no se envió porque las notificaciones por correo están apagadas. */
  suppressed?: boolean;
}

export async function sendEmail(input: SendEmailInput): Promise<EmailResult> {
  // Killswitch global (roz.notification_switch). Omite en silencio en vez de lanzar: si lanzara,
  // el drain reintentaría y los eventos acabarían en el dead-letter, que es justo lo que se quiere
  // evitar al apagar los avisos. Es la barrera de última instancia — los llamadores también
  // consultan el interruptor (y el de cada dev) antes de armar el correo.
  if (!(await emailEnabled())) return { id: null, suppressed: true };
  if (!config.resend.apiKey) throw new Error('RESEND_API_KEY no configurado');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.resend.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: config.resend.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  });

  const json = (await res.json()) as { id?: string; message?: string };
  if (!res.ok) throw new Error(`Resend error: ${json.message ?? res.statusText}`);
  return { id: json.id! };
}
