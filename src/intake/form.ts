// Guion de intake MÍNIMO: 3 elecciones rápidas + 1 descripción libre. roz se encarga de
// DOCUMENTAR (genera el título y estructura el detalle según el tipo con Claude). Filosofía:
// el usuario decide lo que importa (proyecto, tipo, prioridad) y cuenta el problema en sus
// palabras; roz redacta el resto y marca lo asumido como «(a confirmar)». Cero interrogatorio.

export const PRIORITY_OPTIONS = [
  { value: 'urgent', label: '🔴 Urgente — bloquea o algo está caído' },
  { value: 'high', label: '🟠 Alta — importante, esta semana' },
  { value: 'medium', label: '🟡 Media — siguiente sprint' },
  { value: 'low', label: '⚪ Baja — nice to have' },
];

export const KIND_OPTIONS = [
  { value: 'feature', label: '✨ Feature — funcionalidad nueva' },
  { value: 'bug', label: '🐞 Bug/Fix — algo no funciona' },
  { value: 'refactor', label: '🛠 Refactor — mejorar código existente' },
  { value: 'chore', label: '🧹 Chore — mantenimiento/infra' },
  { value: 'ticket', label: '📋 Ticket — tarea suelta' },
];

interface Question {
  id: string;
  question: string;
  type: 'select' | 'text';
  options?: { value: string; label: string }[];
  source?: string;
  required: boolean;
}

// Solo 4 cosas. El título NO se pregunta (roz lo genera). El detalle estructurado tampoco
// se interroga: sale de la descripción libre.
const QUESTIONS: Question[] = [
  { id: 'projectKey', question: '¿En qué proyecto?', type: 'select', source: 'list_projects', required: true },
  { id: 'kind', question: '¿Qué tipo de cambio es?', type: 'select', options: KIND_OPTIONS, required: true },
  { id: 'priority', question: '¿Qué prioridad tiene?', type: 'select', options: PRIORITY_OPTIONS, required: true },
  {
    id: 'description',
    question:
      'Cuéntamelo en tus palabras: ¿qué quieres o qué está fallando? (con una o dos frases ' +
      'basta; roz lo documenta).',
    type: 'text',
    required: true,
  },
];

export function intakeForm(_kind?: string): unknown {
  return {
    instructions:
      'Intake de CERO fricción. Reglas: (1) Solo necesitas 4 cosas: proyecto, tipo, prioridad y ' +
      'una descripción libre del problema/cambio. (2) Presenta proyecto/tipo/prioridad como una ' +
      'lista corta numerada para elegir rápido; acepta también lenguaje natural ("bug urgente"). ' +
      '(3) NO pidas el título: roz lo genera. (4) NO interrogues campo por campo (pasos, ' +
      'objetivos, criterio...): con la descripción libre basta; roz la estructura y documenta. ' +
      '(5) Llama propose_change apenas tengas las 4 cosas. roz devolverá un borrador documentado ' +
      'y, si algo crítico falta, una lista corta `missing` que puedes preguntar DESPUÉS — no antes.',
    questions: QUESTIONS,
    priorityOptions: PRIORITY_OPTIONS,
    kindOptions: KIND_OPTIONS,
  };
}
