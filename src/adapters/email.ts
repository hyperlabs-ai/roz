// Email vía Resend (API HTTP, compatible con serverless — sin proceso persistente).
// roz lo usa para notificar a los devs por correo. RESEND_FROM debe ser un remitente de un
// dominio verificado en Resend; para pruebas, `onboarding@resend.dev` solo entrega al email
// de la cuenta dueña.
import { config } from '../config.js';

export interface SendEmailInput {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

export interface EmailResult {
  id: string;
}

export async function sendEmail(input: SendEmailInput): Promise<EmailResult> {
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
