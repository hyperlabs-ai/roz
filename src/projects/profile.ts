// Perfil del proyecto (tipo + descripción, migración 0033): el contexto que Jev necesita para no
// leer "arreglar un botón" igual en una landing que en una app con backend complejo.
//
// roz lo propone leyendo GitHub (README, descripción, lenguajes, dependencias y estructura de cada
// repo vinculado):
//   · el TIPO lo juzga Jev (Choice sobre la lista CERRADA + Noul compañero) — Jev juzga, el código
//     decide; si Jev no está, lo propone Claude;
//   · la DESCRIPCIÓN la redacta Claude; si Claude no está disponible (sin llave o sin crédito), se arma
//     con datos de GitHub: la descripción del repo o el primer párrafo del README y el stack detectado.
// Una persona lo revisa: lo propuesto queda marcado como 'ia' hasta que alguien lo edita.
import { config } from '../config.js';
import { complete } from '../adapters/anthropic.js';
import { getRepoProfile, type RepoProfile } from '../adapters/github.js';
import { systemOne, typesafeEnabled, type ChoiceAnswer, type JevQuestion, type NoulAnswer, type SystemOneRequest } from '../adapters/typesafe.js';
import { NOUL_NO, NOUL_YES } from '../assign/jev-questions.js';
import { db } from '../db/supabase.js';
import { AppError } from '../utils/errors.js';

/** Tipos de proyecto (espejo del check de la migración 0033). El hint es lo que lee la IA y Jev. */
export const PROJECT_TYPES = [
  { value: 'landing', label: 'Landing / sitio de marketing', hint: 'páginas informativas o de campaña, sin cuentas de usuario ni lógica de negocio propia' },
  { value: 'ecommerce', label: 'E-commerce / tienda', hint: 'catálogo, carrito y pagos' },
  { value: 'app_web', label: 'App web con backend', hint: 'plataforma o SaaS con usuarios, base de datos y lógica de negocio propia' },
  { value: 'app_movil', label: 'App móvil', hint: 'app iOS/Android (nativa, React Native, Flutter), normalmente con su backend' },
  { value: 'api_backend', label: 'API / backend / integraciones', hint: 'servicio sin interfaz propia: APIs, workers, integraciones, automatizaciones' },
  { value: 'ia', label: 'Producto con IA', hint: 'el núcleo del producto es IA: agentes, LLMs, clasificación o generación' },
  { value: 'otro', label: 'Otro', hint: 'no encaja en los anteriores' },
] as const;

export type ProjectType = (typeof PROJECT_TYPES)[number]['value'];
export const PROJECT_TYPE_VALUES = PROJECT_TYPES.map((t) => t.value) as [ProjectType, ...ProjectType[]];

export function projectTypeLabel(t: string | null | undefined): string | null {
  return PROJECT_TYPES.find((x) => x.value === t)?.label ?? null;
}

/** El tipo como lo lee Jev: etiqueta + qué significa ("App web con backend — plataforma o SaaS…"). */
export function projectTypeForJev(t: string | null | undefined): string | null {
  const x = PROJECT_TYPES.find((y) => y.value === t);
  return x ? `${x.label} — ${x.hint}` : null;
}

/** Máximo de repos que se leen por proyecto (los más recientes) y de caracteres de la descripción. */
export const MAX_REPOS = 5;
export const MAX_DESCRIPTION = 700;

export interface ProfileSuggestion {
  projectType: ProjectType | null;
  description: string | null;
  /** Repos que se leyeron (para mostrar de dónde salió). */
  repos: string[];
  /** Quién propuso cada cosa: el tipo (jev / claude) y la descripción (claude / github). */
  typeBy: 'jev' | 'claude' | null;
  descriptionBy: 'claude' | 'github' | null;
}

// ---------------------------------------------------------------- tipo con Jev

/** El state para Jev: el proyecto y lo que dicen sus repos (sin personas). */
export function buildTypeRequest(project: { name: string; kind: string | null }, repos: RepoProfile[], model: string): SystemOneRequest {
  const options = Object.fromEntries(PROJECT_TYPES.filter((t) => t.value !== 'otro').map((t) => [t.label, t.hint]));
  const typeQuestion: JevQuestion = {
    type: 'choice',
    instructions: 'Which kind of software product in `project_types` best describes the project whose repositories are in `repos`?',
    criteria: options,
  };
  const fit: JevQuestion = {
    type: 'noul',
    instructions: 'The repositories in `repos` clearly show a product that matches one of the kinds listed in `project_types`.',
    criteria: {
      true: 'The README, dependencies or folder structure make it clear what kind of product it is, for example a checkout with a payments library for an online store.',
      false: 'The repositories are empty, are only templates or tooling, or do not show what the product is.',
    },
  };
  return {
    model,
    state: {
      project: { name: project.name, kind: project.kind === 'client' ? 'client project' : 'internal project' },
      project_types: options,
      repos: repos.map((r) => ({
        name: r.fullName,
        description: r.description,
        topics: r.topics,
        languages: r.languages.map((l) => `${l.name} ${l.pct}%`),
        top_level: r.topLevel,
        dependencies: r.dependencies,
        readme: r.readme ? r.readme.slice(0, 1500) : null,
      })),
    },
    questions: { project_type: typeQuestion, project_type_fit: fit },
  };
}

/** Respuesta de Jev → tipo. Compañero ≥ 0.7: el elegido; ≤ 0.3: "otro"; en medio: sin tipo (decide una persona). */
export function readType(answers: Record<string, unknown>): ProjectType | null {
  const fit = (answers.project_type_fit as NoulAnswer | undefined)?.noul ?? null;
  const picked = (answers.project_type as ChoiceAnswer | undefined)?.choice ?? null;
  const type = PROJECT_TYPES.find((t) => t.label === picked)?.value ?? null;
  if (fit !== null && fit >= NOUL_YES && type) return type;
  if (fit !== null && fit <= NOUL_NO) return 'otro';
  return null;
}

// ---------------------------------------------------------------- descripción con datos de GitHub

/** Qué se reconoce en las dependencias / carpetas. Orden = cómo se lee la frase. */
const STACK: { group: string; label: string; deps?: RegExp; files?: RegExp }[] = [
  { group: 'frontend', label: 'Next.js', deps: /^next$/ },
  { group: 'frontend', label: 'React', deps: /^react$/ },
  { group: 'frontend', label: 'Vue', deps: /^(vue|nuxt)$/ },
  { group: 'frontend', label: 'Svelte', deps: /^(svelte|@sveltejs\/kit)$/ },
  { group: 'frontend', label: 'Astro', deps: /^astro$/ },
  { group: 'frontend', label: 'Angular', deps: /^@angular\/core$/ },
  { group: 'móvil', label: 'React Native', deps: /^(react-native|expo)$/ },
  { group: 'móvil', label: 'Flutter', files: /^pubspec\.yaml$/ },
  { group: 'móvil', label: 'iOS/Android nativo', files: /^(ios|android)\/$/ },
  { group: 'backend', label: 'Supabase', deps: /^@supabase\//, files: /^supabase\/$/ },
  { group: 'backend', label: 'Node (Express)', deps: /^express$/ },
  { group: 'backend', label: 'Node (Hono)', deps: /^hono$/ },
  { group: 'backend', label: 'Node (Fastify)', deps: /^fastify$/ },
  { group: 'backend', label: 'NestJS', deps: /^@nestjs\/core$/ },
  { group: 'backend', label: 'Prisma', deps: /^(prisma|@prisma\/client)$/, files: /^prisma\/$/ },
  { group: 'backend', label: 'Drizzle', deps: /^drizzle-orm$/ },
  { group: 'backend', label: 'Python', files: /^(requirements\.txt|pyproject\.toml)$/ },
  { group: 'backend', label: 'Firebase', deps: /^firebase(-admin)?$/ },
  { group: 'integraciones', label: 'Stripe', deps: /stripe/ },
  { group: 'integraciones', label: 'WhatsApp/Twilio', deps: /(twilio|whatsapp)/ },
  { group: 'integraciones', label: 'correo (Resend/SendGrid)', deps: /^(resend|@sendgrid\/mail|nodemailer)$/ },
  { group: 'integraciones', label: 'Google APIs', deps: /^googleapis$/ },
  { group: 'IA', label: 'OpenAI', deps: /^openai$/ },
  { group: 'IA', label: 'Claude', deps: /^@anthropic-ai\// },
  { group: 'IA', label: 'LangChain', deps: /langchain/ },
  { group: 'IA', label: 'AI SDK', deps: /^ai$|^@ai-sdk\// },
];

export function detectStack(repos: RepoProfile[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of STACK) {
    const hit = repos.some((r) => (s.deps && r.dependencies.some((d) => s.deps!.test(d))) || (s.files && r.topLevel.some((f) => s.files!.test(f))));
    if (hit) (out[s.group] ??= []).includes(s.label) || out[s.group]!.push(s.label);
  }
  return out;
}

/** Primer párrafo de prosa de un README (salta títulos, listas y bloques de código). */
export function firstParagraph(readme: string | null, max = 260): string | null {
  if (!readme) return null;
  let inCode = false;
  let para: string[] = [];
  // Un párrafo de markdown puede venir partido en varias líneas: se juntan hasta la línea vacía.
  const done = () => {
    const text = para.join(' ').replace(/\s+/g, ' ').trim();
    para = [];
    return text.length >= 30 ? text : null; // "Getting started", "Install"…
  };
  for (const raw of [...readme.split('\n'), '']) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inCode = !inCode;
      para = [];
      continue;
    }
    if (inCode) continue;
    if (!line || /^(#|[-*+]\s|\d+\.\s|>|\||<)/.test(line)) {
      const text = done();
      if (text) return text.length > max ? `${text.slice(0, max - 1)}…` : text;
      continue;
    }
    para.push(line);
  }
  return null;
}

/** Descripción factual (sin LLM): qué dice GitHub que es y con qué está hecho. */
/** Texto de plantilla que no dice nada del producto (README/descripción sin tocar). */
const BOILERPLATE = [
  /this template provides a minimal setup/i,
  /everything you need to build a svelte project/i,
  /bootstrapped with (create-react-app|create-next-app|`?create-)/i,
  /getting started with create react app/i,
  /^(plantilla|template)\b/i,
  /^npx\s/i,
];

export function isBoilerplate(text: string): boolean {
  return BOILERPLATE.some((re) => re.test(text.trim()));
}

/** Quita marcas de markdown (negritas, código, enlaces) de una frase. */
export function plainText(text: string): string {
  return text
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Repos de marketing (landing, sitio): su frase describe el sitio, no el producto. Van al final. */
const MARKETING_REPO = /(landing|^site-|-site$|-web$|^www)/i;

/** La frase que mejor dice qué es el producto: primero del repo principal, sin plantillas. */
const slug = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Rango de un repo para tomar la frase principal: 0 = el principal (se llama como el proyecto, o es
 * su "app"), 1 = las demás partes, 2 = marketing (landing, sitio).
 */
function repoRank(r: RepoProfile, projectName: string | null): number {
  const name = r.fullName.split('/').pop() ?? '';
  if (MARKETING_REPO.test(name)) return 2;
  const n = slug(name);
  const p = projectName ? slug(projectName) : '';
  if ((p && n === p) || /(^|-)app(-|$)/i.test(name) || (p && n === `${p}app`)) return 0;
  return 1;
}

export function leadSentence(repos: RepoProfile[], max = 280, projectName: string | null = null): string | null {
  const ordered = [...repos].sort((a, b) => repoRank(a, projectName) - repoRank(b, projectName));
  // Las descripciones de GitHub (cortas, escritas a propósito) antes que los READMEs; el repo
  // principal primero y los de marketing al final.
  const nonMarketing = ordered.filter((r) => repoRank(r, projectName) < 2);
  const marketing = ordered.filter((r) => repoRank(r, projectName) === 2);
  const candidates = [
    ...nonMarketing.map((r) => r.description?.trim() ?? ''),
    ...nonMarketing.map((r) => firstParagraph(r.readme, 1000) ?? ''),
    ...marketing.flatMap((r) => [r.description?.trim() ?? '', firstParagraph(r.readme, 1000) ?? '']),
  ]
    .map(plainText)
    .filter((t) => t.length > 15 && !isBoilerplate(t));
  const lead = candidates[0];
  if (!lead) return null;
  if (lead.length <= max) return lead.replace(/[.\s]*$/, '.');
  // Corta en la última frase completa que quepa; si no hay, en una palabra.
  const cut = lead.slice(0, max);
  const lastStop = cut.lastIndexOf('. ');
  return lastStop > 60 ? cut.slice(0, lastStop + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

export function factualDescription(repos: RepoProfile[], projectName: string | null = null): string | null {
  const lead = leadSentence(repos, 280, projectName);
  const stack = detectStack(repos);
  const parts: string[] = [];
  if (lead) parts.push(lead);
  const g = (k: string) => stack[k]?.join(', ');
  const tech = [
    g('frontend') && `Frontend: ${g('frontend')}`,
    g('móvil') && `App móvil: ${g('móvil')}`,
    g('backend') && `Backend: ${g('backend')}`,
    g('integraciones') && `Integraciones: ${g('integraciones')}`,
    g('IA') && `IA: ${g('IA')}`,
  ].filter(Boolean);
  if (tech.length) parts.push(`${tech.join('. ')}.`);
  // Los repos dicen la estructura (app, storefront, sdk, mobile…).
  if (repos.length > 1) parts.push(`Repos: ${repos.map((r) => r.fullName.split('/').pop()).join(', ')}.`);
  if (!parts.length) {
    const langs = [...new Set(repos.flatMap((r) => r.languages.map((l) => l.name)))].slice(0, 4);
    if (langs.length) parts.push(`Código en ${langs.join(', ')}.`);
  }
  const text = parts.join(' ').trim();
  if (!text) return null;
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
}

// ---------------------------------------------------------------- puro

export function buildProfilePrompt(
  project: { name: string; kind: string | null },
  repos: RepoProfile[],
): { system: string; user: string } {
  const types = PROJECT_TYPES.map((t) => `- ${t.value}: ${t.label} — ${t.hint}`).join('\n');
  const system = [
    'Describes proyectos de software de una agencia a partir de lo que hay en sus repositorios de GitHub.',
    'La descripción la va a leer otro modelo para entender de qué trata cada ticket del proyecto: por eso importa',
    'decir QUÉ es el producto, para quién, y CÓMO está hecho (frontend, backend, base de datos, app móvil,',
    'integraciones, pagos, IA, tiempo real…) y qué partes son complejas. Usa solo lo que se ve en los repos;',
    'si algo no se puede saber, no lo inventes.',
    '',
    'Responde SOLO un objeto JSON, sin texto alrededor:',
    '{"type": "<uno de los valores de abajo>", "description": "<2 a 4 frases en español, máximo 600 caracteres>"}',
    '',
    'Valores de type (elige el tipo PRINCIPAL; los matices van en la descripción):',
    types,
  ].join('\n');

  const blocks = repos.map((r) =>
    [
      `### ${r.fullName}`,
      r.description ? `Descripción en GitHub: ${r.description}` : null,
      r.homepage ? `Sitio: ${r.homepage}` : null,
      r.topics.length ? `Topics: ${r.topics.join(', ')}` : null,
      r.languages.length ? `Lenguajes: ${r.languages.map((l) => `${l.name} ${l.pct}%`).join(', ')}` : null,
      r.topLevel.length ? `Primer nivel: ${r.topLevel.join(' ')}` : null,
      r.dependencies.length ? `Dependencias: ${r.dependencies.join(', ')}` : null,
      r.readme ? `README:\n${r.readme}` : 'README: (no tiene)',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  const user = [
    `Proyecto: ${project.name} (${project.kind === 'client' ? 'proyecto de cliente' : 'proyecto interno'})`,
    `Repositorios vinculados (${repos.length}):`,
    '',
    blocks.join('\n\n'),
  ].join('\n');
  return { system, user };
}

/** Lee la respuesta de la IA. Tolerante a texto alrededor; un tipo fuera de la lista queda null. */
export function parseProfile(raw: string): { projectType: ProjectType | null; description: string | null } {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { projectType: null, description: null };
  try {
    const j = JSON.parse(m[0]) as { type?: unknown; description?: unknown };
    const type = typeof j.type === 'string' && (PROJECT_TYPE_VALUES as readonly string[]).includes(j.type) ? (j.type as ProjectType) : null;
    let description = typeof j.description === 'string' ? j.description.replace(/\s+/g, ' ').trim() : '';
    if (description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION - 1)}…`;
    return { projectType: type, description: description || null };
  } catch {
    return { projectType: null, description: null };
  }
}

/** Solo campos vacíos: el llenado con IA nunca pisa lo que escribió una persona. */
export function fillPatch(
  current: { project_type: string | null; description: string | null },
  s: { projectType: string | null; description: string | null },
): { project_type?: string; description?: string } {
  return {
    ...(!current.project_type && s.projectType ? { project_type: s.projectType } : {}),
    ...(!current.description?.trim() && s.description ? { description: s.description } : {}),
  };
}

// ---------------------------------------------------------------- I/O

async function projectRepos(projectId: string): Promise<string[]> {
  const { data, error } = await db().from('project_repo').select('repo').eq('project_id', projectId);
  if (error) throw error;
  return ((data ?? []) as { repo: string }[]).map((r) => r.repo);
}

/** Propone tipo y descripción leyendo GitHub. No escribe nada. */
export async function suggestProfile(projectId: string): Promise<ProfileSuggestion> {
  const { data: p, error } = await db().from('project').select('id, name, kind').eq('id', projectId).maybeSingle();
  if (error) throw error;
  if (!p) throw new AppError('NOT_FOUND', 'el proyecto no existe', 404);
  const repos = await projectRepos(projectId);
  if (!repos.length) throw new AppError('NO_REPOS', 'El proyecto no tiene repos vinculados: no hay de dónde leer', 409);

  const profiles = (await Promise.all(repos.map((r) => getRepoProfile(r).catch(() => null)))).filter((x): x is RepoProfile => !!x);
  if (!profiles.length) throw new AppError('GITHUB_UNAVAILABLE', 'No se pudo leer ningún repo del proyecto en GitHub', 502);
  // Los más recientes primero: suelen ser los que describen el producto actual.
  const picked = profiles.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? '')).slice(0, MAX_REPOS);

  const project = p as { name: string; kind: string | null };

  // Tipo: Jev (si hay TypeSafe).
  let projectType: ProjectType | null = null;
  let typeBy: ProfileSuggestion['typeBy'] = null;
  if (typesafeEnabled()) {
    try {
      const res = await systemOne(buildTypeRequest(project, picked, config.typesafe.model));
      projectType = readType(res.answers);
      typeBy = 'jev';
    } catch {
      /* sin Jev: lo intenta Claude abajo */
    }
  }

  // Descripción: Claude; si no se puede (sin llave o sin crédito), la de GitHub.
  let description: string | null = null;
  let descriptionBy: ProfileSuggestion['descriptionBy'] = null;
  if (config.anthropic.apiKey) {
    try {
      const { system, user } = buildProfilePrompt(project, picked);
      const parsed = parseProfile(await complete({ system, user, maxTokens: 600 }));
      description = parsed.description;
      descriptionBy = description ? 'claude' : null;
      if (!typeBy && parsed.projectType) {
        projectType = parsed.projectType;
        typeBy = 'claude';
      }
    } catch {
      /* sin crédito / caído: queda la de GitHub */
    }
  }
  if (!description) {
    description = factualDescription(picked, project.name);
    descriptionBy = description ? 'github' : null;
  }
  return { projectType, description, repos: picked.map((r) => r.fullName), typeBy, descriptionBy };
}

export interface FillResult {
  projectId: string;
  name: string;
  status: 'llenado' | 'ya_tenia' | 'sin_repos' | 'error';
  wrote: { project_type?: string; description?: string };
  suggestion?: ProfileSuggestion;
  error?: string;
}

/**
 * Llena con IA los proyectos activos a los que les falta tipo o descripción. Solo escribe campos
 * vacíos y marca el perfil como 'ia' (pendiente de revisión). `dryRun` no escribe nada.
 */
/**
 * Rehace la descripción de los proyectos cuyo perfil sigue siendo de la IA (`profile_source='ia'`,
 * nadie lo revisó) con el armado actual desde GitHub. No toca el tipo ni lo que escribió una persona.
 */
export async function refreshAiDescriptions(opts: { dryRun?: boolean; log?: (r: { name: string; before: string | null; after: string | null }) => void } = {}): Promise<number> {
  const { data, error } = await db().from('project').select('id, name, active, description, profile_source').eq('profile_source', 'ia').order('name');
  if (error) throw error;
  let n = 0;
  for (const p of (data ?? []) as { id: string; name: string; active: boolean | null; description: string | null }[]) {
    if (p.active === false) continue;
    const repos = await projectRepos(p.id);
    const profiles = (await Promise.all(repos.map((r) => getRepoProfile(r).catch(() => null)))).filter((x): x is RepoProfile => !!x);
    const picked = profiles.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? '')).slice(0, MAX_REPOS);
    const after = factualDescription(picked, p.name);
    opts.log?.({ name: p.name, before: p.description, after });
    if (!opts.dryRun && after && after !== p.description) {
      const { error: uerr } = await db()
        .from('project')
        .update({ description: after, profile_updated_at: new Date().toISOString() })
        .eq('id', p.id)
        .eq('profile_source', 'ia');
      if (uerr) throw uerr;
      n++;
    }
  }
  return n;
}

export async function fillMissingProfiles(opts: { dryRun?: boolean; onlyIds?: string[]; log?: (r: FillResult) => void } = {}): Promise<FillResult[]> {
  let q = db().from('project').select('id, name, active, project_type, description, profile_source').order('name');
  if (opts.onlyIds?.length) q = q.in('id', opts.onlyIds);
  const { data, error } = await q;
  if (error) throw error;
  const rows = ((data ?? []) as { id: string; name: string; active: boolean | null; project_type: string | null; description: string | null; profile_source: string | null }[]).filter(
    (p) => p.active !== false,
  );
  const out: FillResult[] = [];
  for (const p of rows) {
    let r: FillResult;
    if (p.project_type && p.description?.trim()) {
      r = { projectId: p.id, name: p.name, status: 'ya_tenia', wrote: {} };
    } else {
      try {
        const s = await suggestProfile(p.id);
        const patch = fillPatch(p, s);
        if (!opts.dryRun && Object.keys(patch).length) {
          const { error: uerr } = await db()
            .from('project')
            .update({
              ...patch,
              // Si una persona ya había escrito una parte, el perfil sigue siendo suyo.
              profile_source: p.profile_source === 'humano' ? 'humano' : 'ia',
              profile_updated_at: new Date().toISOString(),
            })
            .eq('id', p.id);
          if (uerr) throw uerr;
        }
        r = { projectId: p.id, name: p.name, status: 'llenado', wrote: patch, suggestion: s };
      } catch (err) {
        const code = (err as { code?: string }).code;
        r = { projectId: p.id, name: p.name, status: code === 'NO_REPOS' ? 'sin_repos' : 'error', wrote: {}, error: err instanceof Error ? err.message : String(err) };
      }
    }
    opts.log?.(r);
    out.push(r);
  }
  return out;
}
