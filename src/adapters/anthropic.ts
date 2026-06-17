// Claude para el razonamiento de roz: veredicto de optimalidad de una propuesta,
// clasificación de commits huérfanos, extracción/reconciliación de átomos. Prompt
// caching sobre el contexto del proyecto (que se repite entre llamadas).
// Import NOMBRADO (no default): funciona con o sin esModuleInterop.
import { Anthropic } from '@anthropic-ai/sdk';
import { config } from '../config.js';

// Tipo estructural para no depender de los namespaces del SDK (que varían entre versiones y
// rompen el type-check de Vercel). Estructuralmente compatible con los params del SDK.
type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

export interface CompleteInput {
  system: string;
  user: string;
  /** Contexto grande y estable (átomos del brain) — se cachea. */
  cachedContext?: string;
  maxTokens?: number;
}

export async function complete(input: CompleteInput): Promise<string> {
  const system: SystemBlock[] = [{ type: 'text', text: input.system }];
  if (input.cachedContext) {
    system.push({
      type: 'text',
      text: input.cachedContext,
      cache_control: { type: 'ephemeral' },
    });
  }

  const res = await anthropic().messages.create({
    model: config.anthropic.model,
    max_tokens: input.maxTokens ?? 1024,
    system,
    messages: [{ role: 'user', content: input.user }],
  });

  // Extraer el texto sin type-predicate (evita depender de los tipos ContentBlock del SDK).
  const parts: string[] = [];
  for (const b of res.content as Array<{ type: string; text?: string }>) {
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}
