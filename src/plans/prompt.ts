// El prompt que el runner le pasa a `claude -p`. Lo arma el SERVIDOR (no el runner) para poder
// cambiar las instrucciones sin actualizar el CLI en la PC de cada dev. Puro: se prueba aparte.
import type { PlanPhase, PlanRisk, RiskReason } from '../types/roz-v2.js';
import type { ZeusContextPack } from '../types/zeus.js';

export interface PromptInput {
  planId: string;
  leaseId: string;
  phase: PlanPhase;
  risk: PlanRisk;
  riskReasons: RiskReason[];
  identifier: string;
  title: string;
  description: string | null;
  url: string | null;
  projectName: string | null;
  repo: string | null;
  branch: string;
  planMd: string | null;
  feedback: string | null;
  /** Paquete de contexto de zeus (referencias, no texto). Null si el plan no trae. */
  contextPack?: ZeusContextPack | null;
}

/** Turnos máximos de Claude Code por fase. */
export const MAX_TURNS: Record<PlanPhase, number> = { planear: 40, implementar: 120 };

const RISK_TEXT: Record<PlanRisk, string> = {
  0: 'Riesgo 0: después de planear, implementa hasta dejar la rama lista para PR.',
  1: 'Riesgo 1: solo planea. Una persona aprueba el plan antes de implementar.',
  2: 'Riesgo 2: solo planea. Lo implementa una persona, no el agente.',
};

export function buildRunnerPrompt(i: PromptInput): string {
  const out: string[] = [];
  out.push(`Eres el agente de roz trabajando el issue ${i.identifier} de Linear${i.projectName ? ` (proyecto ${i.projectName})` : ''}.`);
  out.push('');
  out.push(`# ${i.identifier} — ${i.title}`);
  if (i.url) out.push(`Issue: ${i.url}`);
  if (i.repo) out.push(`Repositorio: ${i.repo} · rama de trabajo: ${i.branch}`);
  out.push('');
  out.push('## Descripción del issue');
  out.push(i.description?.trim() || '(sin descripción)');
  out.push('');
  out.push('## Riesgo');
  out.push(RISK_TEXT[i.risk]);
  for (const r of i.riskReasons) out.push(`- ${r.detail}`);
  out.push('');

  if (i.contextPack?.items.length) {
    out.push('## Contexto del equipo (zeus)');
    out.push(
      'Decisiones, reglas y specs que aplican a esta tarea. Trae el texto de las que necesites con zeus_get (por ref) ' +
        'ANTES de planear; respétalas, y si tu plan contradice alguna, dilo en Riesgos.',
    );
    for (const it of i.contextPack.items) out.push(`- [${it.kind}] ${it.title} (${it.ref})${it.summary ? `: ${it.summary}` : ''}`);
    out.push('Si falta algo, búscalo con zeus_search.');
    out.push('');
  }

  if (i.phase === 'planear') {
    out.push('## Tu tarea: escribir el plan');
    out.push('1. Lee el código relevante del repositorio (Read, Glob, Grep). NO modifiques ningún archivo salvo PLAN.md.');
    out.push('2. Consulta las decisiones del proyecto con la herramienta get_decisions y el plan con get_plan.');
    out.push('3. Escribe PLAN.md en la raíz del worktree con: Contexto, Objetivo, Pasos numerados, Archivos que se tocan, Riesgos y Cómo se prueba.');
    out.push('4. Sé concreto: rutas reales, funciones reales. Si algo es ambiguo, anótalo en Riesgos en vez de suponer.');
    if (i.planMd) {
      out.push('');
      out.push('## Borrador anterior del plan');
      out.push(i.planMd);
    }
    if (i.feedback) {
      out.push('');
      out.push('## Cambios que pidió una persona (atiéndelos todos)');
      out.push(i.feedback);
    }
  } else {
    out.push('## Tu tarea: implementar el plan aprobado');
    out.push('1. Sigue PLAN.md paso por paso; no amplíes el alcance.');
    out.push('2. Corre las pruebas y el typecheck del repositorio antes de terminar.');
    out.push(`3. Haz commits pequeños en la rama ${i.branch} con mensajes en español que empiecen con "${i.identifier}".`);
    out.push('4. NO hagas push ni abras la PR: el runner lo hace al terminar.');
    if (i.planMd) {
      out.push('');
      out.push('## PLAN.md aprobado');
      out.push(i.planMd);
    }
  }

  out.push('');
  out.push('## Avance');
  out.push(
    `Reporta tu avance con la herramienta report_progress (planId "${i.planId}", leaseId "${i.leaseId}") ` +
      'al terminar cada paso, con un mensaje corto en español.',
  );
  return out.join('\n');
}
