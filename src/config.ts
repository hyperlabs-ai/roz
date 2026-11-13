// Settings tipados desde env. Falla rápido en producción si falta algo crítico;
// en dev deja vacíos para poder levantar el server sin todas las integraciones.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const flag = (def: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(def)
    .transform((v) => v === 'true');
/** Flag cuyo valor por defecto depende del entorno (se resuelve abajo, ya con ROZ_ENV leído). */
const optionalFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

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
    // Secreto de los jobs internos (/v1/internal/*). El planificador en proceso lo manda en cada
    // corrida y sirve también para dispararlos a mano. Sin él, ningún job corre (fail-closed).
    CRON_SECRET: z.string().default(''),
    // Planificador en proceso (sustituye a los crons de Vercel). Por defecto: encendido en
    // producción, apagado en desarrollo (para que una PC local no compita con producción por los
    // mismos jobs sobre la misma base).
    ROZ_SCHEDULER: optionalFlag,
    // Orígenes extra a los que el API les responde con CORS (coma-separados). Con el front en Vercel
    // reescribiendo /api hacia zeus NO hace falta: todo es mismo origen. Solo para un front que le
    // hable directo al dominio de zeus.
    ROZ_CORS_ORIGINS: z.string().default(''),
    // Origen público de zeus (https://…), para armar la URL del MCP y del CLI que se le muestra a
    // cada dev. Vacío: se usa el dominio que da Railway (RAILWAY_PUBLIC_DOMAIN) o, en su defecto, el
    // del propio request.
    ZEUS_PUBLIC_URL: z.string().default(''),
    RAILWAY_PUBLIC_DOMAIN: z.string().default(''),

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

    // Google Calendar (presencia en vivo: "ocupado hasta las 11:30"). Cada dev conecta SU cuenta
    // desde Configuración; roz solo lee eventos. Opcional: sin client id/secret la feature se apaga
    // en silencio, como el resto de adapters.
    GOOGLE_CLIENT_ID: z.string().default(''),
    GOOGLE_CLIENT_SECRET: z.string().default(''),
    // Explícita, NO derivada de DASHBOARD_URL: Google exige que calce carácter por carácter con la
    // URI registrada en la consola, y una derivación silenciosa produce un redirect_uri_mismatch
    // imposible de diagnosticar desde el código.
    GOOGLE_REDIRECT_URI: z.string().default(''),

    // TypeSafe (Jev): clasifica las tareas para la asignación automática (src/assign). Opcional: sin
    // llave la asignación automática se apaga y /v1/intake sigue con el router de embeddings. El
    // modelo va FIJADO a una versión (no `jev-latest`): los umbrales se calibran contra un modelo
    // concreto y un alias que avanza solo cambiaría las respuestas sin aviso.
    TYPESAFE_API_KEY: z.string().default(''),
    TYPESAFE_MODEL: z.string().default('jev-1.14.0'),
    TYPESAFE_BASE_URL: z.string().default('https://api.typesafe.ai'),
    // Interruptor de emergencia de la asignación automática, aunque haya llave.
    ROZ_AUTO_ASSIGN: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    // Linear (roz v2). Con ROZ_LINEAR_SOT=true Linear vuelve a ser la fuente de verdad de las tareas:
    // roz deja de crear/editar tareas y `work_item` es un espejo de solo lectura (webhook +
    // reconciliación). Apagado por defecto: sin el flag roz se comporta exactamente como antes,
    // aunque las llaves estén puestas.
    LINEAR_API_KEY: z.string().default(''),
    LINEAR_WEBHOOK_SECRET: z.string().default(''),
    // Equipo de Linear por defecto para issues de proyectos sin equipo propio (roz.project.linear_team_id).
    LINEAR_TEAM_ID: z.string().default(''),
    LINEAR_API_URL: z.string().default('https://api.linear.app/graphql'),
    ROZ_LINEAR_SOT: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    // Granola (juntas por API). Opcional: sin llave el poll se apaga y las juntas entran a mano.
    GRANOLA_API_KEY: z.string().default(''),
    GRANOLA_BASE_URL: z.string().default('https://public-api.granola.ai'),

    // Discord como chat de roz (docs/discord-chat-contracts.md). Con ROZ_DISCORD_CHAT=true el chat de
    // roz deja de ser la base interna (0030) y muestra los canales REALES del servidor de la empresa,
    // espejados por el puente (src/bridge/, dentro de zeus). Apagado por defecto: sin el flag el chat
    // interno queda idéntico aunque las llaves estén puestas.
    DISCORD_BOT_TOKEN: z.string().default(''),
    DISCORD_GUILD_ID: z.string().default(''),
    // App de OAuth2 (scope identify) con la que cada dev liga su cuenta desde Configuración.
    DISCORD_CLIENT_ID: z.string().default(''),
    DISCORD_CLIENT_SECRET: z.string().default(''),
    // Explícita por la misma razón que GOOGLE_REDIRECT_URI: Discord exige que calce exacto.
    DISCORD_OAUTH_REDIRECT_URI: z.string().default(''),
    // Base de la API REST. Solo se cambia en pruebas; la versión va fija para que un cambio de
    // Discord no nos cambie la forma de las respuestas sin aviso.
    DISCORD_API_URL: z.string().default('https://discord.com/api/v10'),
    // Tope por adjunto al publicar desde roz. Discord acepta 10 MiB en servidores sin boost; si el
    // servidor tiene boost se puede subir (nivel 2: 50 MiB, nivel 3: 100 MiB).
    DISCORD_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
    // Secreto puente → API (POST /v1/internal/discord/*, Bearer). Con el puente dentro del proceso
    // ya no hay que configurarlo: si viene vacío se genera uno por arranque. Solo se fija a mano si
    // el puente corre como proceso aparte.
    ROZ_BRIDGE_SECRET: z.string().default(''),
    // Sostener el gateway de Discord en este proceso. Por defecto: sí en producción, no en desarrollo
    // (dos procesos con el mismo bot contestarían dos veces cada interacción).
    ROZ_EMBED_BRIDGE: optionalFlag,
    // Mensajes por canal en el backfill inicial y tope de páginas de 100 al ponerse al día.
    DISCORD_BACKFILL_MESSAGES: z.coerce.number().int().min(0).max(100_000).default(200),
    DISCORD_CATCHUP_MAX_PAGES: z.coerce.number().int().min(1).max(10_000).default(50),
    // Registrar /roz en el servidor al conectar, si cambió la definición.
    DISCORD_REGISTER_COMMANDS: flag('true'),
    ROZ_DISCORD_CHAT: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    // Llave de cifrado (32 bytes en base64) para los tokens de terceros guardados por-dev. Generar
    // una vez con: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    ROZ_ENCRYPTION_KEY: z.string().default(''),
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
  // La integración de calendario es opcional en bloque, pero NO a medias: si está encendida hay que
  // poder cifrar los refresh tokens. Arrancar sin llave los guardaría en claro, que es peor que no
  // tener la feature. Se valida en todos los entornos, no solo en producción, porque el token que se
  // guardaría en local es igual de real.
  .superRefine((v, ctx) => {
    if (!v.GOOGLE_CLIENT_ID && !v.GOOGLE_CLIENT_SECRET) return;
    const missing = [
      !v.GOOGLE_CLIENT_ID && 'GOOGLE_CLIENT_ID',
      !v.GOOGLE_CLIENT_SECRET && 'GOOGLE_CLIENT_SECRET',
      !v.GOOGLE_REDIRECT_URI && 'GOOGLE_REDIRECT_URI',
      !v.ROZ_ENCRYPTION_KEY && 'ROZ_ENCRYPTION_KEY',
    ].filter(Boolean);
    for (const k of missing) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${k} es obligatorio cuando la integración de Google Calendar está configurada`,
      });
    }
  })
  // Linear como fuente de verdad, pero NO a medias: con el flag encendido roz ya no puede crear
  // tareas propias, así que sin llave nadie podría crear trabajo, y sin secreto el webhook rechazaría
  // todo y el espejo envejecería en silencio. Se valida en todos los entornos.
  .superRefine((v, ctx) => {
    if (!v.ROZ_LINEAR_SOT) return;
    const missing = [
      !v.LINEAR_API_KEY && 'LINEAR_API_KEY',
      !v.LINEAR_WEBHOOK_SECRET && 'LINEAR_WEBHOOK_SECRET',
    ].filter(Boolean);
    for (const k of missing) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${k} es obligatorio cuando ROZ_LINEAR_SOT=true` });
    }
  })
  // Chat de Discord, pero NO a medias: con el flag encendido el chat interno desaparece, así que sin
  // bot no se puede escribir, sin OAuth nadie puede ligar su cuenta (y sin cuenta no se ve ningún
  // canal), y sin llave de cifrado los tokens de webhook quedarían en claro. Se valida en todos los
  // entornos. (El secreto del puente ya no se exige: se genera solo, ver ROZ_BRIDGE_SECRET.)
  .superRefine((v, ctx) => {
    if (!v.ROZ_DISCORD_CHAT) return;
    const missing = [
      !v.DISCORD_BOT_TOKEN && 'DISCORD_BOT_TOKEN',
      !v.DISCORD_GUILD_ID && 'DISCORD_GUILD_ID',
      !v.DISCORD_CLIENT_ID && 'DISCORD_CLIENT_ID',
      !v.DISCORD_CLIENT_SECRET && 'DISCORD_CLIENT_SECRET',
      !v.DISCORD_OAUTH_REDIRECT_URI && 'DISCORD_OAUTH_REDIRECT_URI',
      !v.ROZ_ENCRYPTION_KEY && 'ROZ_ENCRYPTION_KEY',
    ].filter(Boolean);
    for (const k of missing) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${k} es obligatorio cuando ROZ_DISCORD_CHAT=true` });
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
  google: {
    clientId: raw.GOOGLE_CLIENT_ID,
    clientSecret: raw.GOOGLE_CLIENT_SECRET,
    redirectUri: raw.GOOGLE_REDIRECT_URI,
  },
  typesafe: {
    apiKey: raw.TYPESAFE_API_KEY,
    model: raw.TYPESAFE_MODEL,
    baseUrl: raw.TYPESAFE_BASE_URL.replace(/\/$/, ''),
  },
  autoAssign: { enabled: raw.ROZ_AUTO_ASSIGN },
  linear: {
    apiKey: raw.LINEAR_API_KEY,
    webhookSecret: raw.LINEAR_WEBHOOK_SECRET,
    teamId: raw.LINEAR_TEAM_ID,
    apiUrl: raw.LINEAR_API_URL,
    sourceOfTruth: raw.ROZ_LINEAR_SOT,
  },
  granola: {
    apiKey: raw.GRANOLA_API_KEY,
    baseUrl: raw.GRANOLA_BASE_URL.replace(/\/$/, ''),
  },
  discord: {
    botToken: raw.DISCORD_BOT_TOKEN,
    guildId: raw.DISCORD_GUILD_ID,
    clientId: raw.DISCORD_CLIENT_ID,
    clientSecret: raw.DISCORD_CLIENT_SECRET,
    oauthRedirectUri: raw.DISCORD_OAUTH_REDIRECT_URI,
    apiUrl: raw.DISCORD_API_URL.replace(/\/$/, ''),
    maxUploadBytes: raw.DISCORD_MAX_UPLOAD_BYTES,
    bridgeSecret: raw.ROZ_BRIDGE_SECRET || randomBytes(32).toString('hex'),
    chatEnabled: raw.ROZ_DISCORD_CHAT,
    embedBridge: raw.ROZ_EMBED_BRIDGE ?? raw.ROZ_ENV === 'production',
    backfillMessages: raw.DISCORD_BACKFILL_MESSAGES,
    catchupMaxPages: raw.DISCORD_CATCHUP_MAX_PAGES,
    registerCommands: raw.DISCORD_REGISTER_COMMANDS,
  },
  encryptionKey: raw.ROZ_ENCRYPTION_KEY,
  mcp: { token: raw.ROZ_MCP_TOKEN },
  ingest: { token: raw.ROZ_INGEST_TOKEN },
  cron: { secret: raw.CRON_SECRET },
  scheduler: { enabled: raw.ROZ_SCHEDULER ?? raw.ROZ_ENV === 'production' },
  zeus: {
    publicUrl: (raw.ZEUS_PUBLIC_URL || (raw.RAILWAY_PUBLIC_DOMAIN ? `https://${raw.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/$/, ''),
  },
  cors: { origins: raw.ROZ_CORS_ORIGINS.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean) },
} as const;

export type Config = typeof config;
