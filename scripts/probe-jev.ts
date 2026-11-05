/**
 * Sonda de las preguntas de Jev (src/assign/jev-questions.ts) contra la API REAL de TypeSafe.
 *
 *   npx tsx scripts/probe-jev.ts                                   # dry-run: imprime los payloads, NO envía
 *   npx tsx scripts/probe-jev.ts --confirm --max-input-tokens 2000000 [--split dev|holdout|all] [--variants] [--out archivo.jsonl]
 *   [--only id1,id2] limita los casos; [--no-profile] manda el proyecto sin tipo ni descripción (comparar).
 *   npx tsx scripts/probe-jev.ts --replay archivo.jsonl            # re-evalúa respuestas guardadas con el código actual (0 tokens)
 *
 * Reglas (guía de TypeSafe + lo acordado con el equipo):
 *   · Solo casos SINTÉTICOS (scripts/jev-probe-cases.json). Mandar tareas reales de roz necesita un
 *     permiso aparte: sus descripciones pueden traer nombres de clientes.
 *   · Antes de enviar hay que tener permiso y presupuesto. El script exige --confirm y un tope de
 *     tokens de entrada (máximo 2M, lo autorizado) y se detiene antes de pasarlo.
 *   · Cada caso guarda su request y response EXACTOS en JSONL, para poder repetir cualquier resultado.
 *   · Ajustar redacción con `split: dev`; verificar con `split: holdout`, que nunca se usa para ajustar.
 *   · Leer las respuestas una por una, no solo el total. Si una respuesta se ve mal: revisar el
 *     payload, luego el state, las opciones, el alcance de la pregunta y AL FINAL la redacción.
 *
 * Usa TYPESAFE_API_KEY de .env (la llave viaja solo en el header; nunca se escribe en la salida).
 */
import 'dotenv/config';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { systemOne, typesafeEnabled, type JevQuestion, type SystemOneRequest, type SystemOneResponse } from '../src/adapters/typesafe.js';
import {
  buildJevRequest,
  readClassification,
  solutionTypeCriteria,
  type CatalogSkill,
  type ProjectOption,
  type SolutionTypeDef,
  type TaskInput,
} from '../src/assign/classify.js';
import { projectTypeForJev } from '../src/projects/profile.js';

const HARD_CAP = 2_000_000;

interface ProbeCase {
  id: string;
  split: 'dev' | 'holdout';
  kind: string;
  project: string | null;
  title: string;
  description: string;
  expect: {
    /** Nombre del tipo, lista de nombres aceptables, o 'none' (no es de ningún tipo). */
    type?: string | string[];
    /** Tipos que NO debe elegir (p.ej. "Landing page" para un botón de una app con backend). */
    typeNot?: string[];
    /** Skill exigida al final (o lista de aceptables): la primaria del tipo, o el módulo. */
    skill?: string | string[];
    urgent?: boolean;
    /** Sobre los puntos CRUDOS de Jev (antes de acotarlos al rango del tipo). */
    sizeMin?: number;
    sizeMax?: number;
    project?: string;
  };
}

interface ProbeType {
  id: string;
  slug: string;
  name: string;
  description: string;
  primary: string | null;
  minLevel: number;
  secondary: string | null;
  sizeMin: number;
  sizeMax: number;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

type ProbeProject = ProjectOption & { type?: string; description?: string };
const file = JSON.parse(readFileSync(new URL('./jev-probe-cases.json', import.meta.url), 'utf8')) as {
  catalog: CatalogSkill[];
  types: ProbeType[];
  projects: ProbeProject[];
  cases: ProbeCase[];
};
/** El perfil como lo arma src/assign/context.ts (tipo con su significado). */
const asOption = (p: ProbeProject): ProjectOption => ({ ...p, type: projectTypeForJev(p.type), description: p.description ?? null, typeKey: p.type ?? null });
const projectOptions = file.projects.map(asOption);

const skillRef = (tag: string | null) => {
  if (!tag) return null;
  const s = file.catalog.find((x) => x.tag === tag);
  if (!s) throw new Error(`el tipo apunta a una skill que no está en el catálogo de la sonda: ${tag}`);
  return { id: s.id, tag: s.tag };
};
const types: SolutionTypeDef[] = file.types.map((t) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  description: t.description,
  primarySkill: skillRef(t.primary),
  minLevel: t.minLevel,
  secondarySkill: skillRef(t.secondary),
  sizeMin: t.sizeMin,
  sizeMax: t.sizeMax,
  active: true,
}));

const split = (arg('--split') ?? 'dev') as 'dev' | 'holdout' | 'all';
const only = arg('--only')?.split(',').map((x) => x.trim()).filter(Boolean) ?? null;
const cases = file.cases.filter((c) => (split === 'all' || c.split === split) && (!only || only.includes(c.id)));
/** --no-profile: manda el proyecto SIN tipo ni descripción (para comparar contra q2). */
const noProfile = flag('--no-profile');
const confirm = flag('--confirm');
const variants = flag('--variants');
const today = new Date().toISOString().slice(0, 10);

/** Variantes de redacción: van como preguntas EXTRA en la misma request (mismo state, costo casi nulo). */
function withVariants(req: SystemOneRequest): SystemOneRequest {
  if (!variants) return req;
  const extra: Record<string, JevQuestion> = {};
  if (req.questions.solution_type) {
    const reversed = Object.fromEntries(Object.entries(solutionTypeCriteria(types)).reverse());
    // Mismo Choice con la tabla al revés: mide el sesgo hacia la primera opción.
    extra.v_type_reversed = { ...(req.questions.solution_type as Extract<JevQuestion, { type: 'choice' }>), criteria: reversed };
  }
  if (req.questions.skill) {
    // ¿Dónde está probablemente la causa, dado CÓMO está hecho el proyecto? (no "qué se ve")
    extra.v_area_cause = {
      ...(req.questions.skill as Extract<JevQuestion, { type: 'choice' }>),
      instructions:
        'Given how the project in `task` is built (read its description), which skill area from `skill_catalog` most likely covers the part of the system that has to be changed to solve `task`?',
    };
  }
  extra.v_needs_backend = {
    type: 'noul',
    instructions: 'Solving `task` probably requires changing the server side of the project (backend, database, APIs or integrations), not only the user interface.',
    criteria: {
      true: 'Something fails to save, send, load or process, or the project description shows the feature depends on a backend, database, queues or external services.',
      false: 'The task is only about how something looks or is laid out, or the project has no backend of its own, such as a static landing page.',
    },
  };
  return { ...req, questions: { ...req.questions, ...extra } };
}

function toTaskInput(c: ProbeCase): TaskInput {
  const p = projectOptions.find((x) => x.id === c.project) ?? null;
  return {
    id: c.id,
    name: c.title,
    description: c.description || null,
    projectId: p?.id ?? null,
    projectName: p?.name ?? null,
    projectKind: p?.kind ?? null,
    projectType: noProfile ? null : p?.type ?? null,
    projectDescription: noProfile ? null : p?.description ?? null,
    projectTypeKey: noProfile ? null : p?.typeKey ?? null,
    priority: null,
    prioritySource: 'humano',
    dueDate: null,
    estimate: null,
    solutionTypeId: null,
  };
}

const estimateTokens = (req: SystemOneRequest) => Math.ceil(JSON.stringify(req).length / 4);

function check(c: ProbeCase, cls: ReturnType<typeof readClassification>): string[] {
  const out: string[] = [];
  const e = c.expect;
  const mark = (ok: boolean | null, label: string) => out.push(`${ok === null ? '?' : ok ? '✓' : '✗'} ${label}`);
  if (e.type !== undefined) {
    const want = Array.isArray(e.type) ? e.type : [e.type];
    const got = cls.typeState === 'ninguno' ? 'none' : cls.solutionType?.name ?? null;
    if (cls.typeState === 'incierto') mark(null, `tipo incierto (esperado ${want.join(' | ')}; Jev dijo ${cls.signals.jevType ?? '-'})`);
    else mark(want.includes(got ?? ''), `tipo ${got} (esperado ${want.join(' | ')})`);
  }
  if (e.typeNot !== undefined) {
    const got = cls.solutionType?.name ?? null;
    if (cls.typeState === 'incierto') mark(null, `tipo incierto (no debía ser ${e.typeNot.join(' | ')}; Jev dijo ${cls.signals.jevType ?? '-'})`);
    else mark(!e.typeNot.includes(got ?? ''), `tipo ${got ?? cls.typeState} (no debía ser ${e.typeNot.join(' | ')})`);
  }
  if (e.skill !== undefined) {
    const want = Array.isArray(e.skill) ? e.skill : [e.skill];
    if (cls.skillState === 'incierta') mark(null, `skill (esperada ${want.join(' | ')}, quedó incierta; Jev dijo ${cls.signals.jevSkill ?? '-'})`);
    else if (cls.moduleOpen) mark(want.includes('(abierta)'), `skill abierta → encargado (Jev pensó en ${cls.signals.jevSkill ?? '-'}; esperada ${want.join(' | ')})`);
    else mark(want.includes(cls.skill?.tag ?? ''), `skill ${cls.skill?.tag ?? 'ninguna'} (esperada ${want.join(' | ')})`);
  }
  if (e.urgent !== undefined) {
    if (cls.urgency === 'incierta') mark(null, `urgencia incierta (esperada ${e.urgent ? 'urgente' : 'no urgente'})`);
    else mark((cls.urgency === 'urgente') === e.urgent, `urgencia ${cls.urgency}`);
  }
  const pts = cls.signals.jevPoints;
  if (e.sizeMin !== undefined) mark(pts !== null && pts >= e.sizeMin, `tamaño ${pts} pts (≥ ${e.sizeMin})`);
  if (e.sizeMax !== undefined) mark(pts !== null && pts <= e.sizeMax, `tamaño ${pts} pts (≤ ${e.sizeMax})`);
  if (e.project !== undefined) mark(cls.projectId === e.project, `proyecto ${cls.projectId ?? 'ninguno'} (esperado ${e.project})`);
  return out;
}

function printLine(cls: ReturnType<typeof readClassification>): void {
  console.log(
    `  tipo=${cls.signals.jevType ?? '-'} fits=${cls.signals.fitsSolutionType?.toFixed(2) ?? '-'} (${cls.typeState})` +
      ` → skill=${cls.skill ? `${cls.skill.tag}≥${cls.skill.minLevel}` : cls.skillState}` +
      ` (jev skill=${cls.signals.jevSkill ?? '-'} needs=${cls.signals.needsCatalogSkill?.toFixed(2) ?? '-'} servidor=${cls.signals.serverSide?.toFixed(2) ?? '-'})` +
      ` tamaño=${cls.signals.jevPoints ?? '-'}pts${cls.signals.sizeSplit ? ' (dividida)' : ''}→${cls.points}` +
      `${cls.signals.sizeAboveTypical ? ' (más de lo típico)' : ''}` +
      ` prod=${cls.signals.productionBroken?.toFixed(2)} cliente=${cls.signals.clientBlocked?.toFixed(2)}` +
      (cls.signals.projectFit !== null ? ` proyecto=${cls.projectId ?? '-'} fit=${cls.signals.projectFit.toFixed(2)}` : ''),
  );
}

async function main() {
  const requests = cases.map((c) => ({ c, task: toTaskInput(c) })).map(({ c, task }) => ({
    c,
    task,
    req: withVariants(buildJevRequest(task, file.catalog, types, task.projectId ? null : projectOptions, config.typesafe.model)),
  }));
  const estimated = requests.reduce((s, r) => s + estimateTokens(r.req), 0);

  // Re-evaluar respuestas guardadas: cambia CÓMO se leen (classify.ts), no qué se preguntó.
  const replay = arg('--replay');
  if (replay) {
    const saved = new Map<string, SystemOneResponse>();
    for (const line of readFileSync(replay, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line) as { case: string; response?: SystemOneResponse };
      if (r.response) saved.set(r.case, r.response);
    }
    const tally = { dev: { ok: 0, bad: 0, unsure: 0 }, holdout: { ok: 0, bad: 0, unsure: 0 } };
    for (const { c, task } of requests) {
      const res = saved.get(c.id);
      if (!res) continue;
      const cls = readClassification(res.answers, task, file.catalog, types, task.projectId ? null : projectOptions, today);
      const marks = check(c, cls);
      for (const m of marks) tally[c.split][m.startsWith('✓') ? 'ok' : m.startsWith('✗') ? 'bad' : 'unsure']++;
      console.log(`\n${c.id} [${c.split}/${c.kind}] (replay)`);
      printLine(cls);
      for (const m of marks) console.log(`  ${m}`);
    }
    console.log(`\nREPLAY de ${replay} (0 tokens).`);
    console.log(`dev     ✓${tally.dev.ok} ✗${tally.dev.bad} ?${tally.dev.unsure}`);
    console.log(`holdout ✓${tally.holdout.ok} ✗${tally.holdout.bad} ?${tally.holdout.unsure}`);
    return;
  }

  if (!confirm) {
    for (const { c, req } of requests) {
      console.log(`\n=== ${c.id} (${c.split}/${c.kind}) ~${estimateTokens(req)} tokens ===`);
      console.log(JSON.stringify(req, null, 2));
    }
    console.log(`\nDRY-RUN: ${requests.length} casos, ~${estimated} tokens de entrada estimados (chars/4). No se envió nada.`);
    console.log('Para enviar: --confirm --max-input-tokens <N> (máx. 2000000).');
    return;
  }

  const cap = Number(arg('--max-input-tokens'));
  if (!Number.isFinite(cap) || cap <= 0) throw new Error('--confirm exige --max-input-tokens <N>');
  if (cap > HARD_CAP) throw new Error(`el tope autorizado es ${HARD_CAP} tokens de entrada`);
  if (!typesafeEnabled()) throw new Error('falta TYPESAFE_API_KEY en .env');

  const out = arg('--out') ?? join(tmpdir(), `jev-probe-${Date.now()}.jsonl`);
  writeFileSync(out, '');
  let used = 0;
  const tally = { dev: { ok: 0, bad: 0, unsure: 0 }, holdout: { ok: 0, bad: 0, unsure: 0 } };

  for (const { c, task, req } of requests) {
    if (used + estimateTokens(req) > cap) {
      console.log(`\nTope alcanzado (${used}/${cap} tokens): se detiene antes de ${c.id}.`);
      break;
    }
    try {
      const res = await systemOne(req);
      used += res.usage.input_tokens;
      appendFileSync(out, `${JSON.stringify({ case: c.id, split: c.split, request: req, response: res })}\n`);
      const cls = readClassification(res.answers, task, file.catalog, types, task.projectId ? null : projectOptions, today);
      const marks = check(c, cls);
      for (const m of marks) tally[c.split][m.startsWith('✓') ? 'ok' : m.startsWith('✗') ? 'bad' : 'unsure']++;
      console.log(`\n${c.id} [${c.split}/${c.kind}] modelo=${res.model} tokens=${res.usage.input_tokens}`);
      printLine(cls);
      if (variants) {
        const rev = res.answers.v_type_reversed as { choice?: string } | undefined;
        const area = res.answers.v_area_cause as { choice?: string; probabilities?: Record<string, number> } | undefined;
        const be = res.answers.v_needs_backend as { noul?: number } | undefined;
        const top = Object.entries(area?.probabilities ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
        console.log(`  variantes: tipo_al_revés=${rev?.choice ?? '-'} · área_por_causa=${area?.choice ?? '-'} (${top}) · necesita_backend=${be?.noul?.toFixed(2) ?? '-'}`);
      }
      for (const m of marks) console.log(`  ${m}`);
    } catch (err) {
      appendFileSync(out, `${JSON.stringify({ case: c.id, split: c.split, request: req, error: String(err) })}\n`);
      console.log(`\n${c.id}: ERROR ${String(err)}`);
    }
  }

  console.log(`\nTokens de entrada usados: ${used} (tope ${cap}).`);
  console.log(`dev     ✓${tally.dev.ok} ✗${tally.dev.bad} ?${tally.dev.unsure}`);
  console.log(`holdout ✓${tally.holdout.ok} ✗${tally.holdout.bad} ?${tally.holdout.unsure}`);
  console.log(`Payloads y respuestas exactos: ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
