// Settings tipados desde env. Falla rápido en producción si falta algo crítico;
// en dev deja vacíos para poder levantar el server sin todas las integraciones.
import { z } from 'zod';

const raw = z
  .object({
    ROZ_ENV: z.enum(['development', 'production']).default('development'),
    ROZ_LOG_LEVEL: z.string().default('info'),
    PORT: z.coerce.number().default(3000),

    SUPABASE_URL: z.string().default(''),
    SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
    // anon key: solo para validar el JWT de usuario del dashboard (auth.getUser). Nunca da acceso
    // a datos por sí sola (RLS), a diferencia del service_role.
    SUPABASE_ANON_KEY: z.string().default(''),
    // Dominios permitidos para el dashboard (coma-separados). Vacío por defecto: cada deploy
    // configura los suyos. Si queda vacío en producción, nadie pasa el filtro de dominio.
    DASHBOARD_ALLOWED_DOMAINS: z.string().default(''),

    ANTHROPIC_API_KEY: z.string().default(''),
    ROZ_CLAUDE_MODEL: z.string().default('claude-haiku-4-5'),

    OPENAI_API_KEY: z.string().default(''),
    // Alineado con el RAG de hyperflow-llm para no reindexar: text-embedding-3-large / 3072.
    ROZ_EMBEDDING_MODEL: z.string().default('text-embedding-3-large'),
    ROZ_EMBEDDING_DIM: z.coerce.number().default(3072),

    GITHUB_TOKEN: z.string().default(''),
    GITHUB_WEBHOOK_SECRET: z.string().default(''),

    RESEND_API_KEY: z.string().default(''),
    RESEND_FROM: z.string().default('roz <onboarding@resend.dev>'),

    // Fallback opcional de HyperOps: leer el schema `public` (github_repositories, projects) para
    // resolver repo→proyecto cuando no hay mapeo directo. Off por defecto: el self-host usa el
    // mapeo directo en roz.project_repo + proyectos manuales, sin depender de un schema ajeno.
    HYPEROPS_FALLBACK: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    // Observabilidad de infraestructura (fase "solo datos"). Todos opcionales: sin token, el
    // adapter correspondiente degrada (reporta ok:false) sin romper el resto del sondeo.
    VERCEL_API_TOKEN: z.string().default(''),
    VERCEL_TEAM_ID: z.string().default(''),       // team/scope por defecto (override por servicio en config)
    RAILWAY_API_TOKEN: z.string().default(''),
    SUPABASE_ACCESS_TOKEN: z.string().default(''), // Personal Access Token de la Management API

    ROZ_MCP_TOKEN: z.string().default(''),
    ROZ_INGEST_TOKEN: z.string().default(''),
    // Secreto compartido para autenticar los crons de Vercel. Vercel inyecta
    // `Authorization: Bearer <CRON_SECRET>` en cada invocación cuando este env var está seteado.
    CRON_SECRET: z.string().default(''),

    // URL pública del dashboard (para el botón del digest semanal). Vacío por defecto; en local
    // apunta a http://localhost:3000.
    DASHBOARD_URL: z.string().default(''),
    // Destinatarios del digest semanal (coma-separados). Vacío por defecto: sin destinatarios,
    // el digest de equipo no se envía.
    DIGEST_RECIPIENTS: z.string().default(''),

    // Web Push (notificaciones a la PWA). Opcional: sin llaves VAPID, el push degrada en silencio
    // (igual que Resend). El public key también se expone al front (VITE_VAPID_PUBLIC_KEY) pero el
    // SPA lo obtiene por API (/api/dashboard/push/public-key) para no acoplarlo al build.
    VAPID_PUBLIC_KEY: z.string().default(''),
    VAPID_PRIVATE_KEY: z.string().default(''),
    // Contacto del emisor (mailto: o https URL) que exige el estándar Web Push.
    VAPID_SUBJECT: z.string().default('mailto:roz@hyperdigital.mx'),
  })
  // Fail-fast en producción: los secretos críticos de seguridad NO pueden quedar vacíos, o el
  // server arrancaría con auth/firmas rotas (webhooks rechazando todo, crons abiertos, etc.).
  .superRefine((v, ctx) => {
    if (v.ROZ_ENV !== 'production') return;
    const required: Record<string, string> = {
      SUPABASE_URL: v.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: v.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_ANON_KEY: v.SUPABASE_ANON_KEY,
      GITHUB_WEBHOOK_SECRET: v.GITHUB_WEBHOOK_SECRET,
      ROZ_MCP_TOKEN: v.ROZ_MCP_TOKEN,
      ROZ_INGEST_TOKEN: v.ROZ_INGEST_TOKEN,
      CRON_SECRET: v.CRON_SECRET,
      ANTHROPIC_API_KEY: v.ANTHROPIC_API_KEY,
    };
    for (const [k, val] of Object.entries(required)) {
      if (!val) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${k} es obligatorio en producción` });
    }
  })
  .parse(process.env);

export const config = {
  env: raw.ROZ_ENV,
  logLevel: raw.ROZ_LOG_LEVEL,
  port: raw.PORT,

  supabase: {
    url: raw.SUPABASE_URL,
    serviceRoleKey: raw.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: raw.SUPABASE_ANON_KEY,
  },
  dashboard: {
    allowedDomains: raw.DASHBOARD_ALLOWED_DOMAINS.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    url: raw.DASHBOARD_URL.replace(/\/$/, ''),
  },
  digest: {
    recipients: raw.DIGEST_RECIPIENTS.split(',').map((e) => e.trim()).filter(Boolean),
  },
  webPush: {
    publicKey: raw.VAPID_PUBLIC_KEY,
    privateKey: raw.VAPID_PRIVATE_KEY,
    subject: raw.VAPID_SUBJECT,
  },
  anthropic: { apiKey: raw.ANTHROPIC_API_KEY, model: raw.ROZ_CLAUDE_MODEL },
  openai: {
    apiKey: raw.OPENAI_API_KEY,
    embeddingModel: raw.ROZ_EMBEDDING_MODEL,
    embeddingDim: raw.ROZ_EMBEDDING_DIM,
  },
  github: { token: raw.GITHUB_TOKEN, webhookSecret: raw.GITHUB_WEBHOOK_SECRET },
  hyperops: { fallback: raw.HYPEROPS_FALLBACK },
  resend: { apiKey: raw.RESEND_API_KEY, from: raw.RESEND_FROM },
  vercel: { token: raw.VERCEL_API_TOKEN, teamId: raw.VERCEL_TEAM_ID },
  railway: { token: raw.RAILWAY_API_TOKEN },
  supabaseAdmin: { token: raw.SUPABASE_ACCESS_TOKEN },
  mcp: { token: raw.ROZ_MCP_TOKEN },
  ingest: { token: raw.ROZ_INGEST_TOKEN },
  cron: { secret: raw.CRON_SECRET },
} as const;

export type Config = typeof config;
