// Claude para el razonamiento de roz: veredicto de optimalidad de una propuesta,
// clasificación de commits huérfanos, extracción/reconciliación de átomos. Prompt
// caching sobre el contexto del proyecto (que se repite entre llamadas).
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

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
  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: input.system }];
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

  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
