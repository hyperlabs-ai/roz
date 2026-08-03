// Vocabulario de las ideas (espejo manual de src/ideas/model.ts, igual que labels.ts espeja
// src/tasks/states.ts) MÁS el cálculo del medidor de definición.
//
// El medidor se calcula solo aquí, en el cliente, a propósito: es la única forma de que la barra se
// mueva mientras escribes, antes de guardar. Si lo calculara el backend habría que duplicar la
// lógica para la vista en vivo, y dos implementaciones de la misma regla se desincronizan.

export type IdeaStatus = 'semilla' | 'explorando' | 'definida' | 'en_pausa' | 'descartada';

export const IDEA_STATUS_LABEL: Record<string, string> = {
  semilla: 'Semilla',
  explorando: 'Explorando',
  definida: 'Definida',
  en_pausa: 'En pausa',
  descartada: 'Descartada',
};

export const IDEA_STATUS_ORDER: IdeaStatus[] = ['semilla', 'explorando', 'definida', 'en_pausa', 'descartada'];

export const IDEA_STATUS_OPTIONS = IDEA_STATUS_ORDER.map((value) => ({ value, label: IDEA_STATUS_LABEL[value] }));

/** Estado → variante de Badge. Definida = cerrada con éxito; descartada/pausa = apagadas. */
export function ideaStatusVariant(status: string): 'success' | 'default' | 'secondary' | 'outline' {
  if (status === 'definida') return 'success';
  if (status === 'explorando') return 'default';
  if (status === 'descartada') return 'outline';
  return 'secondary';
}

export const FEATURE_PRIORITY_LABEL: Record<string, string> = {
  imprescindible: 'Imprescindible',
  deseable: 'Deseable',
  opcional: 'Opcional',
  descartada: 'Fuera',
};

export const FEATURE_PRIORITY_ORDER = ['imprescindible', 'deseable', 'opcional', 'descartada'] as const;

export const FEATURE_PRIORITY_OPTIONS = FEATURE_PRIORITY_ORDER.map((value) => ({
  value,
  label: FEATURE_PRIORITY_LABEL[value],
}));

/** Prioridad → clase de dot. 'Fuera' es gris tachado: está ahí para recordar que se descartó. */
export const FEATURE_PRIORITY_DOT: Record<string, string> = {
  imprescindible: 'bg-chart-1',
  deseable: 'bg-chart-3',
  opcional: 'bg-chart-4',
  descartada: 'bg-muted-foreground',
};

export const BLOCK_KIND_LABEL: Record<string, string> = {
  nota: 'Nota',
  chat: 'Conversación',
  link: 'Link',
  referencia: 'Referencia',
  pregunta: 'Pregunta abierta',
};

export const BLOCK_KIND_ORDER = ['nota', 'chat', 'link', 'referencia', 'pregunta'] as const;

export const BLOCK_KIND_OPTIONS = BLOCK_KIND_ORDER.map((value) => ({ value, label: BLOCK_KIND_LABEL[value] }));

// ---- Campos guiados ----

export type GuidedKey = 'problem' | 'audience' | 'value' | 'outOfScope' | 'risks' | 'success' | 'nextStep';

export interface GuidedField {
  key: GuidedKey;
  label: string;
  /** La pregunta es el contenido, no decoración: es lo que convierte la hoja en blanco en algo que
   *  se puede contestar. Se muestra siempre, también cuando el campo está vacío. */
  question: string;
  placeholder: string;
}

export const GUIDED_FIELDS: GuidedField[] = [
  {
    key: 'problem',
    label: 'El problema',
    question: '¿Qué duele hoy, sin esto?',
    placeholder: 'Hoy X tiene que hacer Y a mano cada vez que…',
  },
  {
    key: 'audience',
    label: 'Para quién',
    question: '¿Quién lo va a usar? ¿Una persona concreta que conozcas?',
    placeholder: 'Devs del equipo · clientes con más de N usuarios · yo mismo…',
  },
  {
    key: 'value',
    label: 'Por qué vale',
    question: '¿Qué cambia si existe? ¿Y por qué ahora y no en seis meses?',
    placeholder: 'Ahorra X horas al mes · desbloquea Y · sin esto no podemos Z…',
  },
  {
    key: 'outOfScope',
    label: 'Fuera de alcance',
    question: '¿Qué NO es? Lo que descartas explícitamente es lo que más aterriza una idea.',
    placeholder: 'No es un CRM. No sincroniza con nada. No tiene permisos por rol…',
  },
  {
    key: 'risks',
    label: 'Riesgos',
    question: '¿Qué puede salir mal, o qué te haría abandonarla?',
    placeholder: 'Depende de una API que puede cambiar · nadie lo usaría si…',
  },
  {
    key: 'success',
    label: 'Criterio de éxito',
    question: '¿Cómo sabrás, en concreto, que funcionó?',
    placeholder: 'Si en un mes hay N ideas capturadas y al menos una llegó a proyecto…',
  },
  {
    key: 'nextStep',
    label: 'Siguiente paso',
    question: '¿Cuál es la siguiente acción, hoy, en una frase?',
    placeholder: 'Hacer un boceto en Figma · preguntarle a X si le sirve…',
  },
];

// ---- Medidor de definición ----

/** Lo mínimo que necesita el medidor: los campos guiados + cuántas features imprescindibles hay. */
export interface DefinitionInput {
  problem?: string | null;
  audience?: string | null;
  value?: string | null;
  outOfScope?: string | null;
  risks?: string | null;
  success?: string | null;
  nextStep?: string | null;
  mustCount?: number;
}

export interface DefinitionCheck {
  key: GuidedKey | 'must';
  label: string;
  /** El campo guiado al que salta el clic desde la checklist ('must' apunta a la lista de features). */
  target: GuidedKey | 'features';
}

/** Los 8 checks, en el orden en que tiene sentido contestarlos. */
export const DEFINITION_CHECKS: DefinitionCheck[] = [
  { key: 'problem', label: 'El problema', target: 'problem' },
  { key: 'audience', label: 'Para quién', target: 'audience' },
  { key: 'value', label: 'Por qué vale', target: 'value' },
  { key: 'must', label: 'Features imprescindibles', target: 'features' },
  { key: 'outOfScope', label: 'Fuera de alcance', target: 'outOfScope' },
  { key: 'risks', label: 'Riesgos', target: 'risks' },
  { key: 'success', label: 'Criterio de éxito', target: 'success' },
  { key: 'nextStep', label: 'Siguiente paso', target: 'nextStep' },
];

function filled(v: string | null | undefined): boolean {
  return !!v && v.trim().length > 0;
}

export interface DefinitionScore {
  pct: number;
  done: DefinitionCheck[];
  missing: DefinitionCheck[];
}

/** Qué tan aterrizada está la idea: 8 checks, todo o nada por check. */
export function definitionScore(idea: DefinitionInput): DefinitionScore {
  const done: DefinitionCheck[] = [];
  const missing: DefinitionCheck[] = [];
  for (const check of DEFINITION_CHECKS) {
    const ok = check.key === 'must' ? (idea.mustCount ?? 0) > 0 : filled(idea[check.key as GuidedKey]);
    (ok ? done : missing).push(check);
  }
  return { pct: Math.round((done.length / DEFINITION_CHECKS.length) * 100), done, missing };
}

/** Color de la barra por tramo. Nunca colores crudos: tokens del tema. */
export function definitionBarClass(pct: number): string {
  if (pct >= 100) return 'bg-success';
  if (pct >= 50) return 'bg-chart-1';
  if (pct > 0) return 'bg-chart-4';
  return 'bg-muted-foreground/40';
}

/** Lectura en una frase del porcentaje, para que el número signifique algo. */
export function definitionHint(pct: number): string {
  if (pct >= 100) return 'Aterrizada: ya se puede empezar';
  if (pct >= 75) return 'Casi lista';
  if (pct >= 50) return 'Va tomando forma';
  if (pct > 0) return 'Apenas empieza';
  return 'Sin definir';
}
