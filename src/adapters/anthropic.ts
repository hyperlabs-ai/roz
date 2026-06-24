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

// Directiva de idioma común a TODA llamada a Claude: el texto en prosa sale en español, pero las
// claves JSON y los valores enumerados (kind/priority/category…) se conservan en inglés porque el
// código los valida contra listas en inglés (traducirlos rompería la reconciliación). Va como
// primer bloque de system para que la herede cualquier prompt, presente y futuro.
const LANGUAGE_DIRECTIVE =
  'IDIOMA: escribe TODO el texto en lenguaje natural (títulos, resúmenes, descripciones, ' +
  'especificaciones, veredictos) en ESPAÑOL. Conserva en su idioma original los nombres de ' +
  'herramientas, frameworks, librerías y servicios, los identificadores de código y los términos ' +
  'técnicos sin traducción natural (p.ej. merge, commit, deploy, endpoint, pull request). MUY ' +
  'IMPORTANTE: las claves del JSON y los valores de campos enumerados/categóricos (kind, priority, ' +
  'category y sus valores: feature, bug, chore, refactor, urgent, high, medium, low, trivial, ' +
  'substantive, NONE, etc.) van EXACTAMENTE como se especifican, en inglés y minúsculas — NO los traduzcas.';

export async function complete(input: CompleteInput): Promise<string> {
  const system: SystemBlock[] = [
    { type: 'text', text: LANGUAGE_DIRECTIVE },
    { type: 'text', text: input.system },
  ];
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
