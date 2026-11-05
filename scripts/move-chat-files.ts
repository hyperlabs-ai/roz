/**
 * Mueve los adjuntos del chat del bucket viejo ('chat-attachments', PÚBLICO y de otra app del mismo
 * proyecto de Supabase) al bucket propio de roz ('roz-chat', privado). Ver migración 0035.
 *
 *   npx tsx scripts/move-chat-files.ts            # dry-run: lista lo que movería, no toca nada
 *   npx tsx scripts/move-chat-files.ts --apply    # mueve los archivos y actualiza cada fila
 *
 * Correrlo DESPUÉS del deploy del código que lee `chat_attachment.bucket`: así cada fila apunta
 * siempre a donde está su archivo (el código viejo solo sabe leer del bucket viejo).
 *
 * Idempotente: solo toca filas con bucket = 'chat-attachments'. Por fila: mueve el objeto y luego
 * actualiza la fila; si el objeto no existe (subida que nunca terminó y quedó sin mensaje), lo
 * reporta y, con --apply, borra esa fila huérfana. Solo toca rutas de conversaciones de roz:
 * los archivos de la otra app ('uploads/…') nunca se listan ni se mueven.
 */
import 'dotenv/config';
import { db } from '../src/db/supabase.js';
import { CHAT_BUCKET, LEGACY_CHAT_BUCKET } from '../src/chat/attachments.js';

const apply = process.argv.includes('--apply');

interface Row {
  id: string;
  message_id: string | null;
  storage_path: string;
  name: string;
}

async function main() {
  const supabase = db();
  const { data, error } = await supabase
    .from('chat_attachment')
    .select('id, message_id, storage_path, name')
    .eq('bucket', LEGACY_CHAT_BUCKET)
    .order('created_at');
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  console.log(`${rows.length} adjuntos en '${LEGACY_CHAT_BUCKET}'. ${apply ? 'Moviendo…' : 'DRY-RUN: no se toca nada (usa --apply).'}\n`);

  let moved = 0;
  let orphans = 0;
  let failed = 0;
  for (const r of rows) {
    const { data: exists } = await supabase.storage.from(LEGACY_CHAT_BUCKET).exists(r.storage_path);
    if (!exists) {
      orphans++;
      console.log(`  · huérfana (sin archivo${r.message_id ? '' : ', sin mensaje'}): ${r.name}`);
      // Solo se borran las que además no tienen mensaje: una subida que nunca terminó.
      if (apply && !r.message_id) await supabase.from('chat_attachment').delete().eq('id', r.id);
      continue;
    }
    if (!apply) {
      console.log(`  → movería: ${r.name}`);
      continue;
    }
    const { error: mvErr } = await supabase.storage
      .from(LEGACY_CHAT_BUCKET)
      .move(r.storage_path, r.storage_path, { destinationBucket: CHAT_BUCKET });
    if (mvErr) {
      failed++;
      console.log(`  ✗ ${r.name}: ${mvErr.message}`);
      continue;
    }
    const { error: upErr } = await supabase.from('chat_attachment').update({ bucket: CHAT_BUCKET }).eq('id', r.id);
    if (upErr) {
      failed++;
      console.log(`  ✗ ${r.name}: se movió pero no se actualizó la fila (${upErr.message}). Re-correr no lo arregla: actualiza la fila a mano.`);
      continue;
    }
    moved++;
    console.log(`  ✓ ${r.name}`);
  }
  console.log(`\nMovidos: ${moved} · huérfanas: ${orphans} · fallidos: ${failed}`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
