/**
 * Añade la columna «Apoyo» del plan de HyperHub como CO-CONTRIBUIDOR de cada tarea.
 *
 *   npx tsx scripts/import-hyperhub-support.ts <ruta-del-csv>            # dry-run
 *   npx tsx scripts/import-hyperhub-support.ts <ruta-del-csv> --apply    # escribe
 *
 * Complementa a scripts/import-hyperhub-plan.ts, que cargó las 130 tareas con UN solo responsable.
 * Aquí sólo se agregan filas a `roz.work_item_assignee`:
 *
 * · `assignee_dev_id` NO se toca. Es el responsable principal y el orden importa: getTickets
 *   devuelve la lista con el primario al frente y updateTask vuelve a tomar `[0]` como primario,
 *   así que degradar al responsable por un insert sería un error silencioso.
 * · Insert directo, sin `updateTask`: ése emite `work_item.assigned` por dev y el outbox lo drena
 *   en correo + web push. Son ~53 tareas con apoyo — nadie quiere ese buzón.
 *
 * Idempotente: la junction tiene PK (work_item_id, dev_id), y además se consulta antes de escribir.
 * Empata las tareas por el ID del plan (`0.1`, `AN.2`, …), que es el prefijo del nombre.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { db } from '../src/db/supabase.js';

const PROJECT_KEY = 'HYPERHUB';

/** Igual que en import-hyperhub-plan.ts: el plan dice "Cristian", en roz el dev es "Crix". */
const DEV_ALIAS: Record<string, string> = { Cristian: 'Crix' };

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
    else if (c === '\r') { /* CRLF */ }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const csvPath = args.find((a) => !a.startsWith('--'));
  if (!csvPath) throw new Error('falta la ruta del CSV');

  const rows = parseCsv(readFileSync(csvPath, 'utf8').replace(/^﻿/, ''));
  const head = rows[0].map((h) => h.trim());
  const iId = head.indexOf('ID');
  const iApoyo = head.indexOf('Apoyo');
  const iResp = head.indexOf('Responsable');
  if (iId < 0 || iApoyo < 0 || iResp < 0) throw new Error('el CSV no trae ID / Apoyo / Responsable');

  // ID del plan → nombres de apoyo. Una celda puede traer varios ("Sebas, Manuel").
  const apoyoByPlanId = new Map<string, string[]>();
  for (const r of rows.slice(1)) {
    const id = (r[iId] ?? '').trim();
    const apoyo = (r[iApoyo] ?? '').trim();
    if (!id || !apoyo) continue;
    apoyoByPlanId.set(id, apoyo.split(',').map((s) => s.trim()).filter(Boolean));
  }
  console.log(`CSV: ${apoyoByPlanId.size} tareas con apoyo declarado`);

  const supabase = db();

  const { data: devRows, error: devErr } = await supabase.from('dev').select('id, name');
  if (devErr) throw devErr;
  const devIdByName = new Map((devRows as { id: string; name: string }[]).map((d) => [d.name, d.id]));
  const resolveDev = (nombre: string): string | null => devIdByName.get(DEV_ALIAS[nombre] ?? nombre) ?? null;

  const faltantes = [...new Set([...apoyoByPlanId.values()].flat())].filter((n) => !resolveDev(n));
  if (faltantes.length) throw new Error(`apoyos sin dev en roz: ${faltantes.join(', ')}`);

  const { data: proj, error: perr } = await supabase.from('project').select('id').eq('key', PROJECT_KEY).maybeSingle();
  if (perr) throw perr;
  if (!proj) throw new Error(`no existe el proyecto ${PROJECT_KEY} — corre primero import-hyperhub-plan.ts`);
  const projectId = (proj as { id: string }).id;

  const { data: items, error: ierr } = await supabase
    .from('work_item')
    .select('id, identifier, name, assignee_dev_id')
    .eq('project_id', projectId);
  if (ierr) throw ierr;
  const tareas = items as { id: string; identifier: string; name: string; assignee_dev_id: string | null }[];

  // El nombre es "<ID del plan> · <título>": el ID es todo lo que va antes del primer separador.
  const byPlanId = new Map<string, typeof tareas[number]>();
  for (const t of tareas) byPlanId.set(t.name.split(' · ')[0], t);

  const existing = new Set<string>();
  const { data: asg, error: aerr } = await supabase
    .from('work_item_assignee')
    .select('work_item_id, dev_id')
    .in('work_item_id', tareas.map((t) => t.id));
  if (aerr) throw aerr;
  for (const a of asg as { work_item_id: string; dev_id: string }[]) existing.add(`${a.work_item_id}:${a.dev_id}`);

  // Plan de inserción
  const inserts: { work_item_id: string; dev_id: string }[] = [];
  const sinTarea: string[] = [];
  let yaEstaban = 0;
  let eraElResponsable = 0;

  for (const [planId, apoyos] of apoyoByPlanId) {
    const t = byPlanId.get(planId);
    if (!t) { sinTarea.push(planId); continue; }
    for (const nombre of apoyos) {
      const devId = resolveDev(nombre)!;
      // Un apoyo que ya es el responsable principal no se duplica ni se degrada.
      if (devId === t.assignee_dev_id) { eraElResponsable++; continue; }
      if (existing.has(`${t.id}:${devId}`)) { yaEstaban++; continue; }
      inserts.push({ work_item_id: t.id, dev_id: devId });
      existing.add(`${t.id}:${devId}`);
    }
  }

  if (sinTarea.length) throw new Error(`estos IDs del plan no empataron con ninguna tarea: ${sinTarea.join(', ')}`);

  console.log(`\nApoyos por agregar:      ${inserts.length}`);
  if (yaEstaban) console.log(`Ya estaban en la tarea:  ${yaEstaban}`);
  if (eraElResponsable) console.log(`Ya eran el responsable:  ${eraElResponsable} (se omiten)`);

  const porDev = new Map<string, number>();
  const nameById = new Map((devRows as { id: string; name: string }[]).map((d) => [d.id, d.name]));
  for (const i of inserts) porDev.set(nameById.get(i.dev_id)!, (porDev.get(nameById.get(i.dev_id)!) ?? 0) + 1);
  console.log('\nApoyo por dev:');
  for (const [n, c] of [...porDev].sort((a, b) => b[1] - a[1])) console.log(`  ${n.padEnd(9)} ${String(c).padStart(3)}`);

  if (!inserts.length) { console.log('\nNada por hacer.'); return; }
  if (!apply) { console.log('\n--- DRY RUN: corre con --apply para escribir ---'); return; }

  const { error } = await supabase.from('work_item_assignee').insert(inserts);
  if (error) throw error;
  console.log(`\nListo: ${inserts.length} co-contribuidores agregados.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
