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

    ANTHROPIC_API_KEY: z.string().default(''),
    ROZ_CLAUDE_MODEL: z.string().default('claude-opus-4-8'),

    OPENAI_API_KEY: z.string().default(''),
    // Alineado con el RAG de hyperflow-llm para no reindexar: text-embedding-3-large / 3072.
    ROZ_EMBEDDING_MODEL: z.string().default('text-embedding-3-large'),
    ROZ_EMBEDDING_DIM: z.coerce.number().default(3072),

    LINEAR_API_KEY: z.string().default(''),
    LINEAR_WEBHOOK_SECRET: z.string().default(''),

    GITHUB_TOKEN: z.string().default(''),
    GITHUB_WEBHOOK_SECRET: z.string().default(''),

    RESEND_API_KEY: z.string().default(''),
    RESEND_FROM: z.string().default('roz <onboarding@resend.dev>'),

    ROZ_MCP_TOKEN: z.string().default(''),
    ROZ_INGEST_TOKEN: z.string().default(''),
  })
  .parse(process.env);

export const config = {
  env: raw.ROZ_ENV,
  logLevel: raw.ROZ_LOG_LEVEL,
  port: raw.PORT,

  supabase: { url: raw.SUPABASE_URL, serviceRoleKey: raw.SUPABASE_SERVICE_ROLE_KEY },
  anthropic: { apiKey: raw.ANTHROPIC_API_KEY, model: raw.ROZ_CLAUDE_MODEL },
  openai: {
    apiKey: raw.OPENAI_API_KEY,
    embeddingModel: raw.ROZ_EMBEDDING_MODEL,
    embeddingDim: raw.ROZ_EMBEDDING_DIM,
  },
  linear: { apiKey: raw.LINEAR_API_KEY, webhookSecret: raw.LINEAR_WEBHOOK_SECRET },
  github: { token: raw.GITHUB_TOKEN, webhookSecret: raw.GITHUB_WEBHOOK_SECRET },
  resend: { apiKey: raw.RESEND_API_KEY, from: raw.RESEND_FROM },
  mcp: { token: raw.ROZ_MCP_TOKEN },
  ingest: { token: raw.ROZ_INGEST_TOKEN },
} as const;

export type Config = typeof config;
