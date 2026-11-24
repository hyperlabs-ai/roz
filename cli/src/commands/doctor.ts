// zeus doctor: cómo está este equipo y esta carpeta, en pocas líneas. Lo usa la persona y lo usa el
// hook de inicio de sesión de Claude Code (vía `zeus guard`) para que Claude arranque sabiendo qué
// hay pendiente: encargos y planes en la bandeja, variables que faltan o están desactualizadas.
import path from 'node:path';
import type { Ctx } from '../context.js';
import { findZeusFiles } from '../envfile.js';
import { loadDeviceKey } from '../store.js';
import { updateNotice } from '../update.js';
import { folderStatus } from './env.js';
import { parse, type RegisteredKey } from './vault.js';

const KIND: Record<string, string> = { task: 'encargo', plan: 'plan', message: 'mensaje', env_change: 'aviso' };
/** El hook de inicio de sesión no puede tardar: si zeus no responde, se sigue sin él. */
const HOOK_BUDGET_MS = 6000;

function timeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref?.())]);
}

/** Las líneas del reporte. `brief`: sin lo que ya está bien (para el contexto de Claude). */
export async function doctorReport(ctx: Ctx, opts: { brief?: boolean } = {}): Promise<string[]> {
  const lines: string[] = [];
  const brief = opts.brief ?? false;

  // En paralelo con zeus: a lo más una consulta a npm al día, con espera corta.
  const update = updateNotice(ctx).catch(() => null);
  const me = await timeout(ctx.api.whoami().catch(() => null), HOOK_BUDGET_MS);
  const notice = await update;
  if (notice) lines.push(`! ${notice}${brief ? ' (sugiéreselo a la persona; no lo actualices sin su permiso)' : ''}`);
  if (!me) {
    if (!brief) lines.push('✗ sin conexión con zeus: corre `zeus setup` (o `npx -y @hyperlabs-ai/zeus@latest setup`)');
    return lines;
  }
  if (!brief) lines.push(`✓ conectado como ${me.dev.name}${me.zeusAdmin ? ' (admin)' : ''} a ${ctx.url}`);

  const key = await loadDeviceKey(ctx.fs, ctx.home).catch(() => null);
  const registered = key?.keyId && key.url === ctx.url ? (key as RegisteredKey) : null;
  if (!registered) lines.push('! este equipo no tiene llave de la bóveda: `zeus setup` (o `zeus key init`)');

  // Bandeja.
  const inbox = await timeout(ctx.api.inbox().catch(() => null), HOOK_BUDGET_MS);
  if (inbox) {
    if (inbox.open.length) {
      lines.push(`• ${inbox.open.length} pendiente(s) en tu bandeja (encargos y planes que te mandaron):`);
      for (const m of inbox.open.slice(0, 6)) {
        lines.push(`    - [${KIND[m.kind] ?? m.kind}${m.status && m.status !== 'pending' ? ` · ${m.status}` : ''}] ${m.subject ?? '(sin título)'} — de ${m.from} · id ${m.id}`);
      }
      if (brief) lines.push('    (zeus_inbox / zeus_get_message para verlos; pregunta a la persona antes de aceptarlos o cambiarles el estado)');
    } else if (!brief) lines.push('✓ sin pendientes en tu bandeja');
    if (inbox.envChanges.length) {
      lines.push(`• ${inbox.envChanges.length} aviso(s) de variables que cambiaron:`);
      for (const m of inbox.envChanges.slice(0, 4)) lines.push(`    - ${m.subject ?? ''}`);
    }
    if (inbox.toResolve) lines.push(`• ${inbox.toResolve} solicitud(es) de acceso esperan tu decisión (roz → Zeus → Bandeja)`);
    if (!brief && inbox.waiting.length) lines.push(`· ${inbox.waiting.length} encargo(s)/plan(es) tuyos siguen abiertos con otras personas`);
  }

  // Accesos aprobados en la web que este equipo puede cifrar. Solo se AVISA: cifrar pide que la
  // persona confirme cada huella (`zeus env grant --pending`), nunca se hace solo.
  if (registered) {
    const pending = await timeout(ctx.api.grantIntents().catch(() => null), HOOK_BUDGET_MS);
    const n = pending ? pending.intents.filter((i) => i.keys.length > 0).length : 0;
    if (n) {
      lines.push(`• tienes ${n} acceso(s) aprobado(s) por cifrar: \`zeus env grant --pending\``);
      if (brief) lines.push('    (díselo a la persona; que lo corra ella en su terminal para confirmar las huellas. No uses --yes sin que te lo pida)');
    }
  }

  // Variables de esta carpeta.
  if (registered) {
    const files = await timeout(
      folderStatus(ctx, registered).catch(() => null),
      HOOK_BUDGET_MS,
    );
    if (files && files.length) {
      for (const s of files) {
        const name = path.relative(ctx.cwd, s.file) || s.file;
        const parts = [
          s.missing.length && `${s.missing.length} faltan`,
          s.outdated.length && `${s.outdated.length} desactualizadas`,
          s.localEdits.length && `${s.localEdits.length} cambiadas aquí sin subir`,
          s.localOnly.length && `${s.localOnly.length} solo locales`,
          s.removedRemote.length && `${s.removedRemote.length} ya no están en la bóveda`,
          s.requiredMissing.length && `${s.requiredMissing.length} pedidas por .env.example y no están en la bóveda`,
        ].filter(Boolean);
        if (s.error) lines.push(`! ${name} (${s.projectKey}/${s.env}): ${s.error}`);
        else if (parts.length) lines.push(`• ${name} (${s.projectKey}/${s.env}): ${parts.join(', ')} → \`zeus env status\``);
        else if (!brief) lines.push(`✓ ${name} (${s.projectKey}/${s.env}) al día`);
        if (s.needsRotation) lines.push(`! ${s.projectKey}/${s.env} está POR ROTAR (alguien perdió el acceso)`);
      }
    } else if (files && !files.length) {
      const hasExample = (await ctx.fs.list(ctx.cwd)).some((n) => /^\.env\.(example|sample|template)$/.test(n));
      if (hasExample) lines.push('• este repo tiene .env.example pero ningún .env bajado de zeus: `zeus env pull <proyecto> [entorno]`');
    }
  }
  return lines;
}

export async function doctor(ctx: Ctx, args: string[]): Promise<number> {
  parse(args, {});
  const lines = await doctorReport(ctx);
  if (!(await findZeusFiles(ctx.fs, ctx.cwd)).length) lines.push('· esta carpeta no tiene .env bajados de zeus');
  for (const l of lines) ctx.out(l);
  return 0;
}
