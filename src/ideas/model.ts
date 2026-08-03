// Modelo de las ideas — fuente ÚNICA del vocabulario, reutilizada por la capa de datos, las rutas
// y el front (vía GET /ideas/filters, para que el SPA no hardcodee strings que luego se
// desincronizan del check de la tabla).
//
// Ciclo natural de una idea:
//   semilla (se me ocurrió algo) → explorando (la estoy aterrizando) → definida (lista para empezar)
//                                                    ↘ en_pausa / descartada

export type IdeaStatus = 'semilla' | 'explorando' | 'definida' | 'en_pausa' | 'descartada';

export const IDEA_STATUS_LABEL: Record<IdeaStatus, string> = {
  semilla: 'Semilla',
  explorando: 'Explorando',
  definida: 'Definida',
  en_pausa: 'En pausa',
  descartada: 'Descartada',
};

export const IDEA_STATUS_ORDER: IdeaStatus[] = ['semilla', 'explorando', 'definida', 'en_pausa', 'descartada'];

export const IDEA_STATUS_OPTIONS = IDEA_STATUS_ORDER.map((value) => ({ value, label: IDEA_STATUS_LABEL[value] }));

/** MoSCoW en español. 'descartada' no es basura: dejar por escrito lo que queda fuera aterriza. */
export type FeaturePriority = 'imprescindible' | 'deseable' | 'opcional' | 'descartada';

export const FEATURE_PRIORITY_LABEL: Record<FeaturePriority, string> = {
  imprescindible: 'Imprescindible',
  deseable: 'Deseable',
  opcional: 'Opcional',
  descartada: 'Fuera',
};

export const FEATURE_PRIORITY_ORDER: FeaturePriority[] = ['imprescindible', 'deseable', 'opcional', 'descartada'];

export const FEATURE_PRIORITY_OPTIONS = FEATURE_PRIORITY_ORDER.map((value) => ({
  value,
  label: FEATURE_PRIORITY_LABEL[value],
}));

/** Tipos de bloque libre. `chat` es una conversación pegada de un LLM. */
export type BlockKind = 'nota' | 'chat' | 'link' | 'referencia' | 'pregunta';

export const BLOCK_KIND_LABEL: Record<BlockKind, string> = {
  nota: 'Nota',
  chat: 'Conversación',
  link: 'Link',
  referencia: 'Referencia',
  pregunta: 'Pregunta abierta',
};

export const BLOCK_KIND_ORDER: BlockKind[] = ['nota', 'chat', 'link', 'referencia', 'pregunta'];

export const BLOCK_KIND_OPTIONS = BLOCK_KIND_ORDER.map((value) => ({ value, label: BLOCK_KIND_LABEL[value] }));
