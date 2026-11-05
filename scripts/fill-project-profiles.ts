/**
 * Llena con IA el tipo y la descripción de los proyectos activos a los que les faltan, leyendo
 * GitHub (src/projects/profile.ts). Solo escribe campos VACÍOS y los marca como 'ia' para revisión.
 *
 *   npx tsx scripts/fill-project-profiles.ts            # dry-run: muestra lo que propondría, no escribe
 *   npx tsx scripts/fill-project-profiles.ts --apply    # escribe los campos vacíos
 *   npx tsx scripts/fill-project-profiles.ts --refresh-ia [--apply]   # rehace las descripciones que siguen
 *                                                       # siendo de la IA (nadie las revisó), solo con GitHub
 *
 * Usa GITHUB_TOKEN y ANTHROPIC_API_KEY de .env. Lo que se envía a Claude es lo que hay en los repos
 * vinculados a cada proyecto (README, descripción, lenguajes, dependencias, carpetas).
 */
import 'dotenv/config';
import { fillMissingProfiles, projectTypeLabel, refreshAiDescriptions } from '../src/projects/profile.js';

const apply = process.argv.includes('--apply');

async function main() {
  if (process.argv.includes('--refresh-ia')) {
    const n = await refreshAiDescriptions({
      dryRun: !apply,
      log: (r) => console.log(`\n· ${r.name}\n  antes:   ${r.before ?? '-'}\n  después: ${r.after ?? '-'}`),
    });
    console.log(`\n${apply ? `${n} descripciones rehechas.` : 'DRY-RUN: no se escribió nada (usa --apply).'}`);
    return;
  }
  console.log(apply ? 'Llenando campos vacíos…' : 'DRY-RUN: no se escribe nada (usa --apply para guardar).');
  const results = await fillMissingProfiles({
    dryRun: !apply,
    log: (r) => {
      if (r.status === 'ya_tenia') return console.log(`· ${r.name}: ya tenía tipo y descripción`);
      if (r.status !== 'llenado') return console.log(`✗ ${r.name}: ${r.status}${r.error ? ` — ${r.error}` : ''}`);
      const s = r.suggestion!;
      console.log(`\n✓ ${r.name} → ${projectTypeLabel(s.projectType) ?? '(sin tipo: decide una persona)'}  [tipo: ${s.typeBy ?? '-'} · descripción: ${s.descriptionBy ?? '-'}]  [${s.repos.join(', ')}]`);
      console.log(`  ${s.description ?? '(sin descripción)'}`);
      if (apply) console.log(`  escrito: ${Object.keys(r.wrote).join(', ') || 'nada (ya estaba lleno)'}`);
    },
  });
  const by = (s: string) => results.filter((r) => r.status === s).length;
  console.log(`\n${results.length} proyectos: ${by('llenado')} ${apply ? 'llenados' : 'con propuesta'}, ${by('ya_tenia')} ya tenían, ${by('sin_repos')} sin repos, ${by('error')} con error.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
