// Redacción de TODOS los avisos de roz. Módulo puro: sin base, sin red, sin reloj implícito.
//
// Quien avisa es Roz-bot, en primera persona y con el nombre de quien lo recibe. Cada evento tiene
// varias redacciones y la elección es determinística (hash de una semilla del evento): el mismo
// evento siempre dice lo mismo, dos eventos seguidos no suenan calcados. Nada de IA.
//
// Reglas que se hacen cumplir aquí, no en los llamadores:
//   · sin guion largo ni guion medio en ningún texto (título, cuerpo, asunto, correo);
//   · título de push <= 50 caracteres, cuerpo <= 120;
//   · el nombre del destinatario aparece en el título o en el cuerpo cuando se conoce.
import type { PushPayload } from '../adapters/web-push.js';

export const PUSH_TITLE_MAX = 50;
export const PUSH_BODY_MAX = 120;

/** Expresión de Roz-bot. Cada una tiene su PNG en web/public/brand. */
export type BotMood = 'default' | 'happy' | 'alert' | 'thinking';

const BOT_FILE: Record<BotMood, string> = {
  default: 'roz-bot.png',
  happy: 'roz-bot-happy.png',
  alert: 'roz-bot-alert.png',
  thinking: 'roz-bot-thinking.png',
};

/** Ruta del avatar de Roz-bot. Con `base` (URL del dashboard) sale absoluta, que es lo que exige un correo. */
export function botIcon(mood: BotMood, base = ''): string {
  return `${base.replace(/\/$/, '')}/brand/${BOT_FILE[mood]}`;
}

export interface Notice {
  /** Título del push. */
  title: string;
  /** Cuerpo del push. */
  body: string;
  /** Asunto del correo (sin prefijo de marca: el remitente ya es Roz). */
  subject: string;
  mood: BotMood;
  /** Correo: etiqueta corta sobre el titular ("Tarea nueva", "PR integrada"). */
  kicker: string;
  /** Correo: titular. */
  headline: string;
  /** Correo: una o dos frases de Roz, en primera persona. Texto plano. */
  lead: string;
  /** Correo: el detalle estructurado, pares etiqueta/valor. */
  facts: [string, string][];
  /** Correo: lista de elementos (cambios documentados, tareas por vencer). */
  items?: { code: string; text: string; url?: string | null }[];
  cta?: { label: string; url: string } | null;
}

// ------------------------------------------------------------------ utilidades

/** Quita guiones largos/medios (también los que vengan en el título de una tarea) y colapsa espacios. */
export function clean(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/\s*[—–―]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim();
}

/** Recorta a `max` caracteres sin partir a media palabra cuando se puede. */
export function clip(s: string, max: number): string {
  const t = clean(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.:;·]+$/, '')}…`;
}

/** "Manuel Cortez (AI Developer)" → "Manuel". */
export function firstName(name?: string | null): string {
  return clean((name ?? '').replace(/\s*\(.*\)\s*$/, '')).split(' ')[0] ?? '';
}

/** Hash estable (FNV-1a) de la semilla del evento. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Elige una variante de forma determinística. */
export function pick<T>(seed: string, variants: readonly T[]): T {
  return variants[hashSeed(seed) % variants.length]!;
}

/** La primera variante que cabe en `max`; si ninguna cabe, la más corta recortada. */
function fit(seed: string, max: number, variants: readonly string[]): string {
  const start = hashSeed(seed) % variants.length;
  for (let i = 0; i < variants.length; i++) {
    const v = clean(variants[(start + i) % variants.length]!);
    if (v.length <= max) return v;
  }
  return clip([...variants].sort((a, b) => a.length - b.length)[0]!, max);
}

const title = (seed: string, variants: readonly string[]) => fit(seed, PUSH_TITLE_MAX, variants);
/** Cuerpo del push: el primer tramo es texto libre (título de la tarea, de la PR) y se recorta ÉL
 *  para que los datos concretos que van después (proyecto, prioridad, fecha) no se pierdan. */
function body(...parts: (string | null | undefined | false)[]): string {
  const [head, ...rest] = parts.filter(Boolean).map((p) => clean(p as string)).filter(Boolean);
  if (!head) return '';
  const tail = rest.join(' · ');
  if (!tail) return clip(head, PUSH_BODY_MAX);
  const room = Math.max(30, PUSH_BODY_MAX - tail.length - 3);
  return clip(`${clip(head, room)} · ${tail}`, PUSH_BODY_MAX);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const PRIORITY_LABEL: Record<string, string> = { urgent: 'Urgente', high: 'Alta', medium: 'Media', low: 'Baja' };
export function priorityLabel(p?: string | null): string | null {
  return p ? PRIORITY_LABEL[p] ?? null : null;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Días de calendario entre hoy y la fecha límite (negativo = vencida). Fechas `YYYY-MM-DD` o ISO. */
export function daysUntil(due: string | null | undefined, now: Date): number | null {
  if (!due) return null;
  const d = new Date(due.length <= 10 ? `${due}T00:00:00Z` : due);
  if (Number.isNaN(d.getTime())) return null;
  const a = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const b = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((a - b) / 86_400_000);
}

/** "vence hoy", "vence mañana", "venció hace 3 días", "vence el 14 nov". */
export function dueLabel(due: string | null | undefined, now: Date): string | null {
  const n = daysUntil(due, now);
  if (n === null) return null;
  if (n === 0) return 'vence hoy';
  if (n === 1) return 'vence mañana';
  if (n === -1) return 'venció ayer';
  if (n < 0) return `venció hace ${-n} días`;
  if (n <= 6) return `vence en ${n} días`;
  const d = new Date(due!.length <= 10 ? `${due}T00:00:00Z` : due!);
  return `vence el ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "9 al 15 nov" / "28 oct al 3 nov". Sin guion. */
export function rangeLabel(fromISO: string, toISO: string): string {
  const f = new Date(fromISO);
  const t = new Date(toISO);
  const same = f.getMonth() === t.getMonth();
  return `${f.getDate()}${same ? '' : ` ${MONTHS[f.getMonth()]}`} al ${t.getDate()} ${MONTHS[t.getMonth()]}`;
}

function fmtNum(n: number): string {
  return Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n);
}

/** "+1.2k / -300" → tamaño legible de un cambio. */
function sizeLabel(additions?: number | null, deletions?: number | null): string | null {
  if (additions == null && deletions == null) return null;
  return `+${fmtNum(additions ?? 0)} / -${fmtNum(deletions ?? 0)} líneas`;
}

const hi = (name: string) => (name ? `${name}, ` : '');
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function finish(n: Notice): Notice {
  return {
    ...n,
    title: clip(n.title, PUSH_TITLE_MAX),
    body: clip(n.body, PUSH_BODY_MAX),
    subject: clip(n.subject, 110),
    kicker: clean(n.kicker),
    headline: clean(n.headline),
    lead: clean(n.lead),
    facts: n.facts.map(([k, v]) => [clean(k), clean(v)] as [string, string]).filter(([, v]) => v),
    items: n.items?.map((i) => ({ ...i, code: clean(i.code), text: clean(i.text) })),
  };
}

// ------------------------------------------------------------------ tareas

export interface TaskRef {
  identifier: string;
  name?: string | null;
  project?: string | null;
  priority?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
}

export interface AssignedInput {
  seed: string;
  recipient?: string | null;
  /** Quien asignó. null = roz (asignación automática) o desconocido. */
  actor?: string | null;
  /** La asignó roz por reglas (skill, disponibilidad, carga). */
  auto?: boolean;
  /** A quién se la quitaron para dártela. */
  previous?: string | null;
  task: TaskRef;
  /** Tareas abiertas que el dev ya tenía ANTES de esta. 0 = es la única. */
  openBefore?: number | null;
  url?: string | null;
  now?: Date;
}

export function assignedNotice(i: AssignedInput): Notice {
  const now = i.now ?? new Date();
  const me = firstName(i.recipient);
  const actor = firstName(i.actor);
  const prev = firstName(i.previous);
  const t = i.task;
  const id = t.identifier;
  const name = clean(t.name);
  const prio = priorityLabel(t.priority);
  const urgent = t.priority === 'urgent';
  const due = dueLabel(t.dueDate, now);
  const days = daysUntil(t.dueDate, now);
  const tight = days !== null && days <= 1;

  let ttl: string;
  let lead: string;
  if (urgent) {
    ttl = title(i.seed, [`${hi(me)}urgente: ${id}`, `Urgente para ti${me ? `, ${me}` : ''}: ${id}`, `${id} es urgente${me ? `, ${me}` : ''}`]);
    lead = `${actor ? `${actor} te asignó` : 'Te asigné'} ${id} con prioridad urgente${due ? ` y ${due}` : ''}. Conviene que sea lo siguiente que abras.`;
  } else if (prev && prev !== me) {
    ttl = title(i.seed, actor
      ? [`${actor} te pasó ${id}${me ? `, ${me}` : ''}`, `${hi(me)}${actor} te pasó ${id}`, `${id} ahora es tuya${me ? `, ${me}` : ''}`]
      : [`${id} ahora es tuya${me ? `, ${me}` : ''}`, `${hi(me)}heredas ${id}`, `${hi(me)}te pasé ${id}`]);
    lead = `${id} la llevaba ${prev} y ${actor ? `${actor} te la pasó` : 'ahora queda contigo'}. Revisa lo que ya hay avanzado antes de empezar.`;
  } else if (actor) {
    ttl = title(i.seed, [`${actor} te asignó ${id}${me ? `, ${me}` : ''}`, `${hi(me)}${actor} te asignó ${id}`, `${hi(me)}${id} viene de ${actor}`]);
    lead = `${actor} te asignó ${id}${due ? `, ${due}` : ''}.`;
  } else if (i.auto) {
    ttl = title(i.seed, [`${hi(me)}te asigné ${id}`, `${id} va contigo${me ? `, ${me}` : ''}`, `${hi(me)}${id} es para ti`]);
    lead = `Te asigné ${id} porque encaja con tus skills y tu carga actual${due ? `, ${due}` : ''}. Si no te toca, reasígnala y dime por qué.`;
  } else {
    ttl = title(i.seed, [`${hi(me)}tienes tarea nueva: ${id}`, `${id} es tuya${me ? `, ${me}` : ''}`, `${hi(me)}te tocó ${id}`]);
    lead = `Te asignaron ${id}${due ? `, ${due}` : ''}.`;
  }
  if (i.openBefore === 0) lead += ' Es lo único que tienes abierto ahora mismo.';
  else if (i.openBefore != null && i.openBefore >= 6) lead += ` Con esta ya llevas ${i.openBefore + 1} abiertas.`;

  return finish({
    title: ttl,
    body: body(name || 'Tarea nueva', t.project, !urgent && prio ? `prioridad ${prio.toLowerCase()}` : null, due),
    subject: `${urgent ? 'Urgente: ' : ''}${id}${name ? `, ${name}` : ''}`,
    mood: urgent || tight ? 'alert' : 'default',
    kicker: urgent ? 'Tarea urgente' : prev ? 'Tarea reasignada' : 'Tarea nueva',
    headline: name || id,
    lead: `${me ? `Hola ${me}. ` : ''}${lead}`,
    facts: [
      ['Tarea', id],
      ['Proyecto', t.project ?? ''],
      ['Prioridad', prio ?? ''],
      ['Fecha límite', due ? cap(due) : ''],
      ['Estimación', t.estimate ? plural(t.estimate, 'punto', 'puntos') : ''],
      ['Asignó', actor || (i.auto ? 'Roz, por reglas' : '')],
      ['Antes la llevaba', prev],
    ],
    cta: i.url ? { label: 'Abrir tarea', url: i.url } : null,
  });
}

/** Aviso a quien reportó (un correo suelto, puede no ser dev): su solicitud cerró. */
export function workDoneNotice(i: { seed: string; recipient?: string | null; identifier: string; name?: string | null; closedBy?: string | null; url?: string | null }): Notice {
  const me = firstName(i.recipient);
  const who = firstName(i.closedBy);
  const name = clean(i.name);
  return finish({
    title: title(i.seed, [`${hi(me)}${i.identifier} quedó lista`, `${i.identifier} cerrada${me ? `, ${me}` : ''}`, `Listo${me ? `, ${me}` : ''}: ${i.identifier}`]),
    body: body(name || 'Tu solicitud', who ? `la cerró ${who}` : 'cerrada', 'ya la documenté'),
    subject: `${i.identifier} quedó lista${name ? `: ${name}` : ''}`,
    mood: 'happy',
    kicker: 'Completado',
    headline: name || i.identifier,
    lead: `${me ? `Hola ${me}. ` : ''}Lo que pediste en ${i.identifier} ya quedó cerrado${who ? ` por ${who}` : ''} y lo dejé documentado.`,
    facts: [['Solicitud', i.identifier], ['Cerró', who]],
    cta: i.url ? { label: 'Ver tarea', url: i.url } : null,
  });
}

export interface DocumentedItem { identifier: string; name: string; url?: string | null; repo?: string | null }

export function documentedNotice(i: { seed: string; recipient?: string | null; items: DocumentedItem[]; listUrl?: string | null }): Notice {
  const me = firstName(i.recipient);
  const n = i.items.length;
  const one = i.items[0]!;
  const repos = [...new Set(i.items.map((x) => x.repo).filter(Boolean))] as string[];
  const single = n === 1;
  return finish({
    title: single
      ? title(i.seed, [`${hi(me)}documenté ${one.identifier}`, `${one.identifier} documentada${me ? `, ${me}` : ''}`, `${hi(me)}registré tu cambio`])
      : title(i.seed, [`${hi(me)}documenté ${n} cambios tuyos`, `${n} cambios tuyos documentados${me ? `, ${me}` : ''}`, `${hi(me)}registré ${n} cambios`]),
    body: single
      ? body(one.name, one.repo, 'no tienes que hacer nada')
      : body(i.items.slice(0, 3).map((x) => x.identifier).join(', ') + (n > 3 ? ` y ${n - 3} más` : ''), repos.length === 1 ? repos[0] : null, 'ya quedaron cerrados'),
    subject: single ? `Documenté tu cambio: ${one.identifier}` : `Documenté ${n} cambios tuyos`,
    mood: 'happy',
    kicker: single ? 'Cambio documentado' : 'Cambios documentados',
    headline: single ? one.name || one.identifier : `${n} cambios tuyos quedaron registrados`,
    lead: `${me ? `Hola ${me}. ` : ''}Vi tu trabajo en código y lo registré como ${single ? 'tarea completada' : 'tareas completadas'}. No necesitas hacer nada.`,
    facts: [],
    items: i.items.map((x) => ({ code: x.identifier, text: x.name, url: x.url })),
    cta: single && one.url ? { label: 'Ver tarea', url: one.url } : i.listUrl ? { label: 'Ver mis tareas', url: i.listUrl } : null,
  });
}

export interface DueItem { identifier: string; name: string; dueDate: string; project?: string | null; url?: string | null }

/** Recordatorio diario: lo que vence hoy y lo ya vencido de UNA persona, en un solo aviso. */
export function dueNotice(i: { seed: string; recipient?: string | null; items: DueItem[]; now: Date; listUrl?: string | null }): Notice {
  const me = firstName(i.recipient);
  const today = i.items.filter((x) => daysUntil(x.dueDate, i.now) === 0);
  const late = i.items.filter((x) => (daysUntil(x.dueDate, i.now) ?? 0) < 0);
  const first = late[0] ?? today[0] ?? i.items[0]!;
  const single = i.items.length === 1;
  let ttl: string;
  if (single && late.length) ttl = title(i.seed, [`${hi(me)}${first.identifier} ya venció`, `${first.identifier} va tarde${me ? `, ${me}` : ''}`]);
  else if (single) ttl = title(i.seed, [`${hi(me)}${first.identifier} vence hoy`, `Hoy vence ${first.identifier}${me ? `, ${me}` : ''}`]);
  else if (late.length && today.length) ttl = title(i.seed, [`${hi(me)}${today.length} para hoy, ${late.length} tarde`, `${hi(me)}hoy: ${today.length} vencen, ${late.length} tarde`]);
  else if (late.length) ttl = title(i.seed, [`${hi(me)}traes ${late.length} tareas vencidas`, `${late.length} tareas vencidas${me ? `, ${me}` : ''}`]);
  else ttl = title(i.seed, [`${hi(me)}hoy vencen ${today.length} tareas`, `${today.length} tareas vencen hoy${me ? `, ${me}` : ''}`]);

  const leadParts: string[] = [];
  if (today.length) leadParts.push(`${plural(today.length, 'tarea vence', 'tareas vencen')} hoy`);
  if (late.length) leadParts.push(`${plural(late.length, 'ya venció', 'ya vencieron')}`);
  return finish({
    title: ttl,
    body: single
      ? body(first.name, first.project, dueLabel(first.dueDate, i.now))
      : body(i.items.slice(0, 3).map((x) => x.identifier).join(', ') + (i.items.length > 3 ? ` y ${i.items.length - 3} más` : ''), `empieza por ${first.identifier}`),
    subject: single ? `${first.identifier} ${late.length ? 'ya venció' : 'vence hoy'}` : `Tus fechas de hoy: ${leadParts.join(', ')}`,
    mood: late.length ? 'alert' : 'thinking',
    kicker: late.length ? 'Fechas vencidas' : 'Vence hoy',
    headline: single ? first.name || first.identifier : cap(leadParts.join(' y ')),
    lead: `${me ? `Hola ${me}. ` : ''}Revisé tus fechas: ${leadParts.join(' y ')}. Si alguna ya no aplica, muévele la fecha y dejo de recordártela.`,
    facts: [],
    items: [...late, ...today].map((x) => ({ code: x.identifier, text: `${x.name} (${dueLabel(x.dueDate, i.now)})`, url: x.url })),
    cta: single && first.url ? { label: 'Abrir tarea', url: first.url } : i.listUrl ? { label: 'Ver mis tareas', url: i.listUrl } : null,
  });
}

// ------------------------------------------------------------------ código

export interface PrRef {
  repo: string;
  number: number;
  title?: string | null;
  branch?: string | null;
  identifier?: string | null;
  additions?: number | null;
  deletions?: number | null;
  url?: string | null;
}

const shortRepo = (repo: string) => repo.split('/').pop() ?? repo;

export function prMergedNotice(i: { seed: string; recipient?: string | null; merger?: string | null; pr: PrRef; reviewers?: string[] }): Notice {
  const me = firstName(i.recipient);
  const who = firstName(i.merger);
  const pr = i.pr;
  const ref = `#${pr.number}`;
  const repo = shortRepo(pr.repo);
  const size = sizeLabel(pr.additions, pr.deletions);
  return finish({
    title: who
      ? title(i.seed, [`${who} integró tu PR ${ref}${me ? `, ${me}` : ''}`, `${hi(me)}${who} integró tu PR ${ref}`, `${hi(me)}tu PR ${ref} ya entró`])
      : title(i.seed, [`${hi(me)}tu PR ${ref} ya entró`, `PR ${ref} integrada${me ? `, ${me}` : ''}`]),
    body: body(pr.title || `PR ${ref}`, repo, pr.identifier ? `cerré ${pr.identifier}` : null, size),
    subject: `Tu PR ${ref} en ${repo} ya está integrada`,
    mood: 'happy',
    kicker: 'PR integrada',
    headline: clean(pr.title) || `PR ${ref}`,
    lead: `${me ? `Hola ${me}. ` : ''}${who ? `${who} integró` : 'Se integró'} tu PR ${ref} en ${repo}${pr.identifier ? ` y con eso cerré ${pr.identifier}` : ''}.`,
    facts: [
      ['Repo', pr.repo],
      ['Rama', pr.branch ?? ''],
      ['Tarea', pr.identifier ?? ''],
      ['Tamaño', size ?? ''],
      ['Integró', who],
      ['Revisó', (i.reviewers ?? []).map(firstName).filter(Boolean).join(', ')],
    ],
    cta: pr.url ? { label: 'Ver PR', url: pr.url } : null,
  });
}

export type ReviewState = 'approved' | 'changes_requested' | 'commented';

export function prReviewedNotice(i: { seed: string; recipient?: string | null; reviewer?: string | null; state: ReviewState; pr: PrRef }): Notice {
  const me = firstName(i.recipient);
  const who = firstName(i.reviewer) || 'Alguien';
  const pr = i.pr;
  const ref = `#${pr.number}`;
  const repo = shortRepo(pr.repo);
  const variants: Record<ReviewState, string[]> = {
    approved: [`${who} aprobó tu PR ${ref}${me ? `, ${me}` : ''}`, `${hi(me)}${who} aprobó tu PR ${ref}`, `${hi(me)}PR ${ref} aprobada`],
    changes_requested: [`${who} pidió cambios en ${ref}${me ? `, ${me}` : ''}`, `${hi(me)}${who} pidió cambios en ${ref}`, `${hi(me)}cambios en tu PR ${ref}`],
    commented: [`${who} comentó tu PR ${ref}${me ? `, ${me}` : ''}`, `${hi(me)}${who} comentó tu PR ${ref}`, `${hi(me)}comentarios en ${ref}`],
  };
  const next: Record<ReviewState, string> = {
    approved: 'ya puedes integrarla',
    changes_requested: 'toca ajustar antes de integrar',
    commented: 'dejó comentarios para ti',
  };
  const lead: Record<ReviewState, string> = {
    approved: `${who} aprobó tu PR ${ref} en ${repo}. Por mi parte ya se puede integrar.`,
    changes_requested: `${who} revisó tu PR ${ref} en ${repo} y pidió cambios antes de integrarla.`,
    commented: `${who} dejó comentarios en tu PR ${ref} de ${repo}.`,
  };
  return finish({
    title: title(i.seed, variants[i.state]),
    body: body(pr.title || `PR ${ref}`, repo, pr.identifier, next[i.state]),
    subject: `${variants[i.state][2]!.replace(/^.*?, /, '')} en ${repo}`,
    mood: i.state === 'approved' ? 'happy' : i.state === 'changes_requested' ? 'alert' : 'default',
    kicker: i.state === 'approved' ? 'PR aprobada' : i.state === 'changes_requested' ? 'Cambios solicitados' : 'Comentarios en tu PR',
    headline: clean(pr.title) || `PR ${ref}`,
    lead: `${me ? `Hola ${me}. ` : ''}${lead[i.state]}`,
    facts: [['Repo', pr.repo], ['Rama', pr.branch ?? ''], ['Tarea', pr.identifier ?? ''], ['Revisó', who]],
    cta: pr.url ? { label: 'Ver PR', url: pr.url } : null,
  });
}

export function repoDetectedNotice(i: { seed: string; recipient?: string | null; repo: string; projectName?: string | null; linked: boolean; repoUrl?: string | null }): Notice {
  const me = firstName(i.recipient);
  const repo = shortRepo(i.repo);
  const proj = clean(i.projectName);
  const ttl = i.linked
    ? title(i.seed, [`${hi(me)}vinculé ${repo}`, `Repo nuevo en ${proj || 'roz'}: ${repo}`, `${hi(me)}ya sigo ${repo}`])
    : title(i.seed, [`${hi(me)}¿de quién es ${repo}?`, `${repo} no tiene proyecto${me ? `, ${me}` : ''}`, `${hi(me)}falta vincular ${repo}`]);
  // El nombre va una sola vez: si el título no lo trae (no cupo), lo lleva el cuerpo.
  const named = !me || ttl.includes(me);
  return finish(i.linked
    ? {
        title: ttl,
        body: body(`Lo vinculé a ${proj || 'su proyecto'}`, 'sus commits ya cuentan', !named && `para que lo tengas en el radar, ${me}`),
        subject: `Vinculé el repo ${repo}${proj ? ` a ${proj}` : ''}`,
        mood: 'happy',
        kicker: 'Repo vinculado',
        headline: i.repo,
        lead: `${me ? `Hola ${me}. ` : ''}Detecté el repo ${i.repo} y lo vinculé al proyecto ${proj}. Desde ahora sus commits y PRs cuentan ahí.`,
        facts: [['Repo', i.repo], ['Proyecto', proj]],
        cta: i.repoUrl ? { label: 'Ver en GitHub', url: i.repoUrl } : null,
      }
    : {
        title: ttl,
        body: body('Vi un repo nuevo y no supe a qué proyecto va', 'vincúlalo para que cuente', !named && `¿lo ubicas, ${me}?`),
        subject: `El repo ${repo} no tiene proyecto`,
        mood: 'thinking',
        kicker: 'Repo sin proyecto',
        headline: i.repo,
        lead: `${me ? `Hola ${me}. ` : ''}Detecté el repo ${i.repo} y no encontré a qué proyecto pertenece. Mientras nadie lo vincule, su trabajo no suma a ningún proyecto.`,
        facts: [['Repo', i.repo], ['Proyecto', 'Sin asignar']],
        cta: i.repoUrl ? { label: 'Ver en GitHub', url: i.repoUrl } : null,
      });
}

// ------------------------------------------------------------------ agentes y juntas

export type ClaimableReason = 'dueño_fuera_de_linea' | 'mucho_en_cola';

/** Aviso al EQUIPO (sin destinatario individual): un plan de agente se puede reclamar. */
export function planClaimableNotice(i: { seed: string; identifier: string; name?: string | null; owner?: string | null; reason: ClaimableReason; project?: string | null; url?: string | null }): Notice {
  const owner = firstName(i.owner);
  const why = i.reason === 'dueño_fuera_de_linea'
    ? `${owner || 'su dueño'} lleva más de 2 h fuera de línea`
    : 'lleva más de un día hábil en cola';
  return finish({
    title: title(i.seed, [`${i.identifier} busca quien lo tome`, `¿Alguien toma ${i.identifier}?`, `${i.identifier} se puede reclamar`]),
    body: body(i.name || i.identifier, i.project, why),
    subject: `${i.identifier} se puede reclamar`,
    mood: 'thinking',
    kicker: 'Plan reclamable',
    headline: clean(i.name) || i.identifier,
    lead: `El plan de ${i.identifier} ${why}. Si tienes tu runner encendido, puedes reclamarlo.`,
    facts: [['Tarea', i.identifier], ['Proyecto', i.project ?? ''], ['Dueño', owner]],
    cta: i.url ? { label: 'Ver plan', url: i.url } : null,
  });
}

export function meetingReadyNotice(i: { seed: string; recipient?: string | null; title: string; candidates: number; decisions?: number; duplicates?: number; project?: string | null; url?: string | null }): Notice {
  const me = firstName(i.recipient);
  const n = i.candidates;
  const mt = clean(i.title) || 'tu junta';
  return finish(n > 0
    ? {
        title: title(i.seed, [`${hi(me)}leí tu junta: ${plural(n, 'candidata', 'candidatas')}`, `${plural(n, 'candidata', 'candidatas')} por decidir${me ? `, ${me}` : ''}`, `${hi(me)}tu junta dejó ${n} ${n === 1 ? 'tarea' : 'tareas'}`]),
        body: body(mt, i.project, i.duplicates ? `${plural(i.duplicates, 'posible duplicado', 'posibles duplicados')}` : null, i.decisions ? `${plural(i.decisions, 'decisión guardada', 'decisiones guardadas')}` : null, 'te esperan en la bandeja'),
        subject: `Leí "${mt}": ${plural(n, 'candidata', 'candidatas')} por decidir`,
        mood: 'default',
        kicker: 'Junta procesada',
        headline: mt,
        lead: `${me ? `Hola ${me}. ` : ''}Terminé de leer la junta y saqué ${plural(n, 'tarea candidata', 'tareas candidatas')}. Ninguna se crea sola: te esperan en la bandeja para que decidas.`,
        facts: [['Proyecto', i.project ?? ''], ['Candidatas', String(n)], ['Posibles duplicados', i.duplicates ? String(i.duplicates) : ''], ['Decisiones', i.decisions ? String(i.decisions) : '']],
        cta: i.url ? { label: 'Abrir la bandeja', url: i.url } : null,
      }
    : {
        title: title(i.seed, [`${hi(me)}leí tu junta, sin tareas`, `Junta leída${me ? `, ${me}` : ''}: sin tareas`]),
        body: body(mt, i.project, i.decisions ? `${plural(i.decisions, 'decisión guardada', 'decisiones guardadas')}` : 'no encontré trabajo accionable'),
        subject: `Leí "${mt}": no salió trabajo nuevo`,
        mood: 'thinking',
        kicker: 'Junta procesada',
        headline: mt,
        lead: `${me ? `Hola ${me}. ` : ''}Leí la junta completa y no encontré tareas accionables.`,
        facts: [['Proyecto', i.project ?? ''], ['Decisiones', i.decisions ? String(i.decisions) : '']],
        cta: i.url ? { label: 'Ver la junta', url: i.url } : null,
      });
}

// ------------------------------------------------------------------ chat

export interface ChatInput {
  author: string;
  preview: string;
  kind: 'dm' | 'channel';
  channelName?: string | null;
  group?: boolean;
  isReply?: boolean;
  /** Mencionaron directamente al destinatario (o a todo el canal). */
  mentioned?: boolean;
  statusCount?: number;
  attachmentCount?: number;
}

/** Push de chat. Aquí no hay variantes ni voz de Roz: quien habla es la persona que escribió. */
export function chatNotice(i: ChatInput): { title: string; body: string } {
  const author = firstName(i.author) || 'Alguien';
  let preview = clean(i.preview);
  if (i.statusCount) {
    const label = `Status de ${plural(i.statusCount, 'tarea', 'tareas')}`;
    preview = preview ? `${label}: ${preview}` : label;
  }
  if (!preview && i.attachmentCount) preview = i.attachmentCount === 1 ? 'Envió un archivo' : `Envió ${i.attachmentCount} archivos`;

  let ttl: string;
  let text: string;
  if (i.kind === 'dm') {
    ttl = i.group ? `${author} · grupo` : author;
    if (i.isReply) ttl = `${ttl} · hilo`;
    text = preview;
  } else {
    const ch = `#${clean(i.channelName)}`;
    ttl = i.mentioned ? `${author} te mencionó en ${ch}` : i.isReply ? `${author} respondió en ${ch}` : `${author} en ${ch}`;
    text = preview;
  }
  return { title: clip(ttl, PUSH_TITLE_MAX), body: clip(text, PUSH_BODY_MAX) };
}

// ------------------------------------------------------------------ digest

export interface DigestStats { commits: number; tickets: number; lines: number; contributors?: number; commitsChangePct?: number | null }

function trend(pct?: number | null): string | null {
  if (pct == null || pct === 0) return null;
  return `${pct > 0 ? 'sube' : 'baja'} ${Math.abs(pct)}% vs. la semana pasada`;
}

export function devDigestNotice(i: { seed: string; recipient?: string | null; range: string; stats: DigestStats; topProject?: string | null; url?: string | null }): Pick<Notice, 'title' | 'body' | 'subject' | 'mood'> {
  const me = firstName(i.recipient);
  const s = i.stats;
  const up = (s.commitsChangePct ?? 0) > 0;
  return {
    title: title(i.seed, [`${hi(me)}tu semana en números`, `Tu semana${me ? `, ${me}` : ''}: ${plural(s.commits, 'commit', 'commits')}`, `${hi(me)}así cerraste la semana`]),
    body: body(plural(s.commits, 'commit', 'commits'), plural(s.tickets, 'tarea cerrada', 'tareas cerradas'), `${fmtNum(s.lines)} líneas`, i.topProject ? `sobre todo en ${i.topProject}` : null, trend(s.commitsChangePct)),
    subject: clip(`${me ? `${me}, tu` : 'Tu'} semana del ${i.range}: ${plural(s.commits, 'commit', 'commits')} y ${plural(s.tickets, 'tarea cerrada', 'tareas cerradas')}`, 110),
    mood: up ? 'happy' : 'default',
  };
}

export function teamDigestNotice(i: { seed: string; range: string; stats: DigestStats; topProject?: string | null }): Pick<Notice, 'title' | 'body' | 'subject' | 'mood'> {
  const s = i.stats;
  return {
    title: title(i.seed, [`La semana del equipo, ${i.range}`, `Resumen del equipo: ${i.range}`]),
    body: body(plural(s.commits, 'commit', 'commits'), plural(s.tickets, 'tarea cerrada', 'tareas cerradas'), s.contributors != null ? plural(s.contributors, 'persona activa', 'personas activas') : null, i.topProject ? `más movimiento en ${i.topProject}` : null),
    subject: clip(`La semana del equipo, ${i.range}: ${plural(s.commits, 'commit', 'commits')} y ${plural(s.tickets, 'tarea cerrada', 'tareas cerradas')}`, 110),
    mood: 'default',
  };
}

export function testNotice(recipient?: string | null): { title: string; body: string } {
  const me = firstName(recipient);
  return {
    title: clip(`${hi(me)}aquí Roz`, PUSH_TITLE_MAX),
    body: 'Si lees esto, mis avisos llegan bien a este dispositivo.',
  };
}

/** Línea que Roz-bot publica en Discord al asignar un ticket. La mención va aparte (la pone el llamador). */
export function discordAssignedLine(i: { seed: string; identifier: string; title: string; actor?: string | null; project?: string | null; priority?: string | null }): string {
  const actor = firstName(i.actor);
  const urgent = i.priority === 'urgent';
  const opener = urgent
    ? `urgente para ti: ${i.identifier}`
    : actor
      ? pick(i.seed, [`${actor} te asignó ${i.identifier}`, `${i.identifier} viene de ${actor} y va contigo`])
      : pick(i.seed, [`te asigné ${i.identifier}`, `${i.identifier} va contigo`]);
  const t = clean(i.title);
  return clean([opener, t, i.project && !urgent ? clean(i.project) : null].filter(Boolean).join(' · '));
}

// ------------------------------------------------------------------ salida: push y correo

/** Payload de push listo para enviar: texto del aviso + avatar de Roz-bot según el ánimo. */
export function toPush(n: Pick<Notice, 'title' | 'body' | 'mood'>, extra: Omit<PushPayload, 'title' | 'body' | 'icon'> = {}): PushPayload {
  return { title: n.title, body: n.body, icon: botIcon(n.mood), ...extra };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const MOOD_COLOR: Record<BotMood, { ink: string; soft: string }> = {
  default: { ink: '#b23a0e', soft: '#ffe4d8' },
  happy: { ink: '#15803d', soft: '#dcfce7' },
  alert: { ink: '#b91c1c', soft: '#fee2e2' },
  thinking: { ink: '#6d28d9', soft: '#ede9fe' },
};

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Cabecera común de los correos: Roz-bot como remitente, con la expresión del aviso. */
export function emailHeader(mood: BotMood, base: string, tagline = 'te escribe Roz'): string {
  const img = base
    ? `<img src="${botIcon(mood, base)}" width="40" height="40" alt="Roz" style="display:block;border-radius:12px;background:#ff5b23">`
    : `<div style="width:40px;height:40px;border-radius:12px;background:#ff5b23;color:#fff;font:800 15px ${FONT};line-height:40px;text-align:center">rz</div>`;
  return `<tr><td style="background:#171614;padding:18px 28px">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:middle">${img}</td>
          <td style="vertical-align:middle;padding-left:12px">
            <div style="color:#ffffff;font:700 16px ${FONT}">Roz</div>
            <div style="color:#a8a29a;font:400 12px ${FONT}">${esc(tagline)}</div>
          </td>
        </tr></table>
      </td></tr>`;
}

export function emailFooter(note = 'Puedes silenciar mis avisos en Configuración.'): string {
  return `<tr><td style="padding:16px 28px;border-top:1px solid #eeeae4"><span style="color:#a8a29a;font:400 12px ${FONT}">Roz, el bot de tu equipo · ${esc(note)}</span></td></tr>`;
}

/** Correo breve con el detalle estructurado. `base` = URL pública del dashboard (para el avatar). */
export function renderEmail(n: Notice, base = ''): { subject: string; html: string; text: string } {
  const c = MOOD_COLOR[n.mood];
  const facts = n.facts.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f5;border:1px solid #eeeae4;border-radius:10px;margin:0 0 20px">${n.facts
        .map(([k, v], idx) => `<tr>
          <td style="padding:9px 16px;color:#8a847b;font:600 11px ${FONT};text-transform:uppercase;letter-spacing:.5px;white-space:nowrap;width:1%;${idx ? 'border-top:1px solid #eeeae4' : ''}">${esc(k)}</td>
          <td style="padding:9px 16px 9px 0;color:#171614;font:500 14px ${FONT};${idx ? 'border-top:1px solid #eeeae4' : ''}">${esc(v)}</td>
        </tr>`)
        .join('')}</table>`
    : '';
  const items = n.items?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f5;border:1px solid #eeeae4;border-radius:10px;margin:0 0 20px">${n.items
        .map((it, idx) => `<tr><td style="padding:10px 16px;${idx ? 'border-top:1px solid #eeeae4' : ''}">
          <span style="color:#b23a0e;font:700 12px ui-monospace,Menlo,monospace">${esc(it.code)}</span>
          <div style="color:#171614;font:400 14px/1.4 ${FONT};margin-top:2px">${it.url ? `<a href="${it.url}" style="color:#171614;text-decoration:none">${esc(it.text)}</a>` : esc(it.text)}</div>
        </td></tr>`)
        .join('')}</table>`
    : '';
  const button = n.cta
    ? `<a href="${n.cta.url}" style="display:inline-block;background:#ff5b23;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:9px;font:600 14px ${FONT}">${esc(n.cta.label)}</a>`
    : '';

  const html = `<!doctype html><html><body style="margin:0;background:#f3efe9;padding:24px 0;font-family:${FONT}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="500" cellpadding="0" cellspacing="0" style="max-width:500px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e7e2da">
      ${emailHeader(n.mood, base)}
      <tr><td style="padding:26px 28px 24px">
        <span style="display:inline-block;background:${c.soft};color:${c.ink};border-radius:6px;padding:3px 9px;font:700 11px ${FONT};text-transform:uppercase;letter-spacing:.5px">${esc(n.kicker)}</span>
        <p style="margin:12px 0 8px;color:#171614;font:700 19px/1.3 ${FONT}">${esc(n.headline)}</p>
        <p style="margin:0 0 20px;color:#57524b;font:400 14px/1.55 ${FONT}">${esc(n.lead)}</p>
        ${facts}${items}${button}
      </td></tr>
      ${emailFooter()}
    </table>
  </td></tr></table>
</body></html>`;

  const text = [
    n.headline,
    '',
    n.lead,
    '',
    ...n.facts.map(([k, v]) => `${k}: ${v}`),
    ...(n.items ?? []).map((it) => `· ${it.code}: ${it.text}${it.url ? ` (${it.url})` : ''}`),
    ...(n.cta ? ['', `${n.cta.label}: ${n.cta.url}`] : []),
    '',
    'Roz',
  ].join('\n').replace(/\n{3,}/g, '\n\n');

  return { subject: n.subject, html, text };
}
