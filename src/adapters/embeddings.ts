// Embeddings vía OpenAI (sustituye al FastEmbed local del roz-legacy). Costo por uso →
// el caller debe cachear el vector por hash de contenido y solo reindexar al cambiar el
// cuerpo del átomo. La dimensión debe coincidir con vector(N) en la migración.
// Import NOMBRADO (no default): funciona con o sin esModuleInterop, así el build no depende
// de la config del compilador (Vercel type-chequea con sus propios defaults).
import { OpenAI } from 'openai';
import { config } from '../config.js';

let client: OpenAI | null = null;

function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: config.openai.apiKey });
  return client;
}

export async function embed(text: string): Promise<number[]> {
  const res = await openai().embeddings.create({
    model: config.openai.embeddingModel,
    input: text,
    dimensions: config.openai.embeddingDim,
  });
  return res.data[0]!.embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await openai().embeddings.create({
    model: config.openai.embeddingModel,
    input: texts,
    dimensions: config.openai.embeddingDim,
  });
  return res.data.map((d) => d.embedding);
}

export const embeddingModel = config.openai.embeddingModel;
