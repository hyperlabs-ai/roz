/**
 * Importa el desglose del Plan de desarrollo de HyperHub (130 tareas) como tareas NATIVAS de roz.
 *
 *   npx tsx scripts/import-hyperhub-plan.ts <ruta-del-csv>            # dry-run: no escribe nada
 *   npx tsx scripts/import-hyperhub-plan.ts <ruta-del-csv> --apply    # escribe
 *
 * El CSV es el export del plan, con cabecera:
 *   Fase,Carril,ID,Título,Descripción,Responsable,Apoyo,Tipo,Terminado cuando
 *
 * Decisiones que este script implementa, y por qué:
 *
 * · Un solo proyecto, `HyperHub` (key HYPERHUB). Un proyecto por módulo daría el "Agrupar:
 *   Proyecto" nativo, pero mete 14 proyectos sin repo en la vista de proyectos, commits e
 *   hyperpoints. El carril viaja como prefijo del nombre (`AN.2 · …`) porque el buscador de
 *   /tasks solo mira `name` e `identifier` (web/src/pages/Tasks.tsx:152): así "AN." filtra el
 *   carril de Analytics sin tocar la UI.
 *
 * · INSERT directo, sin pasar por createTask(). createTask() emite `work_item.assigned` por
 *   responsable (src/dashboard/queries.ts:1624) y el outbox lo drena en correo + web push: 130
 *   tareas = 130 correos al equipo. Un import masivo no quiere eso.
 *
 * · `status` va SIEMPRE explícito: el default de la columna sigue siendo 'backlog' y ese valor
 *   viola el CHECK de 0020, así que omitirlo revienta la fila con 23514.
 *
 * · Se puebla `work_item_assignee` además de `assignee_dev_id`: la lista de tareas lee los
 *   responsables de la junction (src/dashboard/queries.ts:1251), el campo directo es compat.
 *
 * · `ops_task_id` queda null, así que los triggers del puente a Ops no hacen nada (sólo disparan
 *   en UPDATE/DELETE y además están guardados por `ops_task_id is not null`).
 *
 * Idempotente por (project_id, name): re-correrlo no duplica, sólo informa qué ya existía.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { db, dbPublic } from '../src/db/supabase.js';
import type { TaskState } from '../src/tasks/states.js';

// ---------- Configuración del import ----------

const PROJECT_NAME = 'HyperHub';
const PROJECT_KEY = 'HYPERHUB';
const PROJECT_COLOR = '#9C7CFF'; // el violeta del plan

/** Nombre en el CSV → nombre en roz.dev. El plan dice "Cristian"; en roz el dev es "Crix". */
const DEV_ALIAS: Record<string, string> = { Cristian: 'Crix' };

/** Fase del plan → estado inicial. F0 es lo único que no espera a nada: nace lista para tomar. */
const STATUS_BY_PHASE: Record<string, TaskState> = { F0: 'pendiente', F1: 'planificada', F2: 'planificada' };

/** Fase del plan → prioridad. F0 bloquea al resto; F2 es "lo que sigue", fuera del corte. */
const PRIORITY_BY_PHASE: Record<string, string> = { F0: 'high', F1: 'medium', F2: 'low' };

/** Quién queda como autor de las tareas en el dashboard (auth.users.id, vía user_profiles). */
const CREATED_BY_EMAIL = 'manuel@hyperlabs.vc';

// ---------- CSV ----------

interface PlanRow {
  fase: string;
  carril: string;
  id: string;
  titulo: string;
  descripcion: string;
  responsable: string;
  apoyo: string;
  tipo: string;
  dod: string;
}

/** Parser de CSV con comillas dobles escapadas (""), que es lo que trae el export del plan. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* CRLF: el \n cierra la fila */ }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const HEADER = ['Fase', 'Carril', 'ID', 'Título', 'Descripción', 'Responsable', 'Apoyo', 'Tipo', 'Terminado cuando'];

function loadPlan(path: string): PlanRow[] {
  const rows = parseCsv(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  const head = rows[0].map((h) => h.trim());
  const missing = HEADER.filter((h) => !head.includes(h));
  if (missing.length) throw new Error(`el CSV no trae las columnas: ${missing.join(', ')}`);
  const col = (name: string): number => head.indexOf(name);
  return rows.slice(1).map((r) => ({
    fase: (r[col('Fase')] ?? '').trim(),
    carril: (r[col('Carril')] ?? '').trim(),
    id: (r[col('ID')] ?? '').trim(),
    titulo: (r[col('Título')] ?? '').trim(),
    descripcion: (r[col('Descripción')] ?? '').trim(),
    responsable: (r[col('Responsable')] ?? '').trim(),
    apoyo: (r[col('Apoyo')] ?? '').trim(),
    tipo: (r[col('Tipo')] ?? '').trim(),
    dod: (r[col('Terminado cuando')] ?? '').trim(),
  }));
}

// ---------- Derivaciones ----------

/** "F0 · Base" → "F0". Es la llave de estado y prioridad. */
function phaseCode(fase: string): string {
  const m = /^(F\d+)/.exec(fase);
  if (!m) throw new Error(`no puedo leer la fase de "${fase}"`);
  return m[1];
}

/** "Hyper Analytics — la adaptación de Orwel" → "Hyper Analytics"; "Hyper ID · etapa 00" → "Hyper ID". */
function moduleName(carril: string): string {
  return carril.split(/\s+[·—]\s+/)[0].trim();
}

/** El nombre lleva el ID del plan al frente: hace buscable el carril completo con "AN.", "LAB.", … */
function taskName(row: PlanRow): string {
  return `${row.id} · ${row.titulo}`;
}

/** Descripción en Markdown (la UI la renderiza con react-markdown + GFM). */
function taskDescription(row: PlanRow): string {
  const parts = [row.descripcion];
  if (row.dod) parts.push(`**Terminado cuando:** ${row.dod}`);
  const meta = [
    `- **Plan:** HyperHub · ${row.fase}`,
    `- **Carril:** ${row.carril}`,
    `- **Tarea del plan:** ${row.id}`,
    `- **Responsable:** ${row.responsable}`,
  ];
  if (row.apoyo) meta.push(`- **Apoyo:** ${row.apoyo}`);
  if (row.tipo) meta.push(`- **Tipo:** ${row.tipo}`);
  parts.push('---', meta.join('\n'));
  return parts.join('\n\n');
}

// ---------- Main ----------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const csvPath = args.find((a) => !a.startsWith('--'));
  if (!csvPath) throw new Error('falta la ruta del CSV: npx tsx scripts/import-hyperhub-plan.ts <csv> [--apply]');

  const plan = loadPlan(csvPath);
  console.log(`CSV: ${csvPath} → ${plan.length} tareas`);

  const supabase = db();

  // --- Devs: resuelve por nombre (con alias) y falla ruidoso si falta alguno ---
  const { data: devRows, error: devErr } = await supabase.from('dev').select('id, name, email, active');
  if (devErr) throw devErr;
  const devByName = new Map<string, { id: string; name: string; active: boolean }>();
  for (const d of devRows as { id: string; name: string; active: boolean }[]) devByName.set(d.name, d);

  const responsables = [...new Set(plan.map((r) => r.responsable).filter(Boolean))];
  const devIdFor = new Map<string, string>();
  const unresolved: string[] = [];
  for (const nombre of responsables) {
    const dev = devByName.get(DEV_ALIAS[nombre] ?? nombre);
    if (!dev) unresolved.push(nombre);
    else devIdFor.set(nombre, dev.id);
  }
  if (unresolved.length) {
    throw new Error(
      `estos responsables del plan no existen en roz.dev: ${unresolved.join(', ')}. ` +
        `Devs disponibles: ${[...devByName.keys()].join(', ')}. Agrega el alias en DEV_ALIAS o el dev en roz.dev.`,
    );
  }
  console.log('\nResponsables:');
  for (const [nombre, id] of devIdFor) {
    const dev = devByName.get(DEV_ALIAS[nombre] ?? nombre)!;
    const alias = DEV_ALIAS[nombre] ? ` (alias de roz.dev "${dev.name}")` : '';
    const n = plan.filter((r) => r.responsable === nombre).length;
    console.log(`  ${nombre.padEnd(9)}${alias.padEnd(30)} ${String(n).padStart(3)} tareas  ${id}`);
  }

  // --- Autor de las tareas: user_profiles.user_id, que es lo que resuelve loadCreators() ---
  let createdBy: string | null = null;
  try {
    const { data } = await dbPublic().from('user_profiles').select('user_id').eq('email', CREATED_BY_EMAIL).maybeSingle();
    createdBy = (data as { user_id?: string } | null)?.user_id ?? null;
  } catch {
    /* public no expuesto: las tareas quedan sin autor resuelto, que es cosmético */
  }
  console.log(`\ncreated_by: ${createdBy ?? '(sin resolver — las tareas no mostrarán autor)'}`);

  // --- Proyecto ---
  const { data: existing, error: projErr } = await supabase
    .from('project')
    .select('id, key, name')
    .eq('key', PROJECT_KEY)
    .maybeSingle();
  if (projErr) throw projErr;

  let projectId = (existing as { id?: string } | null)?.id ?? null;
  if (projectId) {
    console.log(`Proyecto: ${PROJECT_KEY} ya existe (${projectId})`);
  } else if (!apply) {
    console.log(`Proyecto: ${PROJECT_KEY} NO existe — se crearía (name "${PROJECT_NAME}", kind internal, color ${PROJECT_COLOR})`);
  } else {
    const { data, error } = await supabase
      .from('project')
      .insert({ name: PROJECT_NAME, key: PROJECT_KEY, kind: 'internal', color: PROJECT_COLOR, active: true })
      .select('id')
      .single();
    if (error) throw error;
    projectId = (data as { id: string }).id;
    console.log(`Proyecto: ${PROJECT_KEY} creado (${projectId})`);
  }

  // --- Idempotencia: qué nombres ya están cargados en el proyecto ---
  const already = new Set<string>();
  if (projectId) {
    const { data, error } = await supabase.from('work_item').select('name').eq('project_id', projectId);
    if (error) throw error;
    for (const w of data as { name: string }[]) already.add(w.name);
  }

  const pending = plan.filter((r) => !already.has(taskName(r)));
  const skipped = plan.length - pending.length;

  console.log('\nResumen:');
  const byPhase = new Map<string, number>();
  for (const r of pending) byPhase.set(phaseCode(r.fase), (byPhase.get(phaseCode(r.fase)) ?? 0) + 1);
  for (const [f, n] of [...byPhase].sort()) {
    console.log(`  ${f}: ${n} tareas → status ${STATUS_BY_PHASE[f]}, prioridad ${PRIORITY_BY_PHASE[f]}`);
  }
  console.log(`  módulos (labels): ${[...new Set(pending.map((r) => moduleName(r.carril)))].join(', ')}`);
  if (skipped) console.log(`  ${skipped} ya existían en el proyecto — se omiten`);

  if (!pending.length) { console.log('\nNada por hacer.'); return; }

  if (!apply) {
    console.log('\n--- DRY RUN (sin --apply no se escribe nada) ---');
    for (const r of pending.slice(0, 3)) {
      const f = phaseCode(r.fase);
      console.log(`\n${PROJECT_KEY}-? · ${taskName(r)}`);
      console.log(`  status=${STATUS_BY_PHASE[f]} priority=${PRIORITY_BY_PHASE[f]} assignee=${r.responsable} labels=[${moduleName(r.carril)}, ${f}]`);
      console.log(taskDescription(r).split('\n').map((l) => `  | ${l}`).join('\n'));
    }
    console.log(`\n… y ${pending.length - Math.min(3, pending.length)} más. Corre con --apply para escribir.`);
    return;
  }

  // --- Insert, una por una: el identifier lo da la RPC atómica del contador por proyecto ---
  let ok = 0;
  for (const r of pending) {
    const f = phaseCode(r.fase);
    const status = STATUS_BY_PHASE[f];
    const devId = devIdFor.get(r.responsable) ?? null;

    const { data: num, error: nerr } = await supabase.rpc('next_work_item_number', { p_project_id: projectId });
    if (nerr) throw nerr;
    const number = Number(num);
    const identifier = `${PROJECT_KEY}-${number}`;

    const { data: created, error } = await supabase
      .from('work_item')
      .insert({
        linear_id: null,
        identifier,
        number,
        project_id: projectId,
        name: taskName(r),
        description: taskDescription(r),
        status, // explícito a propósito: el default 'backlog' viola el CHECK de 0020
        priority: PRIORITY_BY_PHASE[f],
        assignee_dev_id: devId,
        labels: [moduleName(r.carril), f],
        created_by: createdBy,
        source: 'native',
        documented: true,
        change_notified: true, // false dispararía el correo de "cambio documentado"
      })
      .select('id, identifier')
      .single();
    if (error) throw new Error(`${identifier} (${r.id}): ${error.message}`);
    const row = created as { id: string; identifier: string };

    // La lista de tareas lee los responsables de la junction; assignee_dev_id es compat.
    if (devId) {
      const { error: aerr } = await supabase
        .from('work_item_assignee')
        .insert({ work_item_id: row.id, dev_id: devId });
      if (aerr) throw new Error(`${identifier}: responsable — ${aerr.message}`);
    }

    ok++;
    console.log(`  ${row.identifier.padEnd(13)} ${taskName(r)}`);
  }

  console.log(`\nListo: ${ok} tareas creadas en ${PROJECT_KEY}.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
