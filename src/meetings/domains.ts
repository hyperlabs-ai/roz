// Proyecto de una junta por el dominio del correo de sus asistentes: una junta con gente de
// @acme.com cae sola en el proyecto cuyo `client_email_domains` incluye "acme.com". PURO.
//
// Reglas:
//   · Se ignoran los dominios del equipo (los de los correos de los devs): que haya alguien de
//     @hyper.com no dice de qué cliente es la junta.
//   · Un subdominio calza con su dominio (mail.acme.com → acme.com), nunca al revés.
//   · Gana el proyecto con MÁS asistentes que calzan. Empate entre proyectos distintos → null: la UI
//     pide elegir en vez de adivinar (un mismo cliente puede tener dos proyectos).

export interface DomainProject {
  id: string;
  name: string;
  domains: string[];
}

export interface DomainMatch {
  projectId: string;
  projectName: string;
  domain: string;
}

export interface DomainResolution {
  projectId: string | null;
  matches: DomainMatch[];
}

/** "Ana <ana@Acme.com>" / "ana@acme.com" → "acme.com". null si no parece correo. */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const m = /<([^>]+)>/.exec(email);
  const addr = (m ? m[1]! : email).trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  if (at <= 0 || at === addr.length - 1) return null;
  const domain = addr.slice(at + 1).replace(/\.$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

/** Normaliza un dominio configurado: sin '@', sin espacios, minúsculas. */
export function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^@+/, '').replace(/\.$/, '');
}

/** ¿El dominio del asistente es el del cliente (o un subdominio suyo)? */
export function domainMatches(attendeeDomain: string, clientDomain: string): boolean {
  const a = normalizeDomain(attendeeDomain);
  const c = normalizeDomain(clientDomain);
  if (!a || !c) return false;
  return a === c || a.endsWith(`.${c}`);
}

export function resolveProjectByDomains(
  emails: (string | null | undefined)[],
  projects: DomainProject[],
  ignoreDomains: string[] = [],
): DomainResolution {
  const ignored = ignoreDomains.map(normalizeDomain).filter(Boolean);
  const attendees = [
    ...new Set(
      emails
        .map((e) => (e ? (/<([^>]+)>/.exec(e)?.[1] ?? e).trim().toLowerCase() : null))
        .filter((e): e is string => !!e && emailDomain(e) !== null),
    ),
  ];

  const matches: DomainMatch[] = [];
  const seenMatch = new Set<string>();
  const perProject = new Map<string, Set<string>>();
  for (const email of attendees) {
    const domain = emailDomain(email)!;
    if (ignored.some((d) => domainMatches(domain, d))) continue;
    for (const p of projects) {
      const hit = p.domains.find((d) => domainMatches(domain, d));
      if (!hit) continue;
      const key = `${p.id}:${normalizeDomain(hit)}`;
      if (!seenMatch.has(key)) {
        seenMatch.add(key);
        matches.push({ projectId: p.id, projectName: p.name, domain: normalizeDomain(hit) });
      }
      const set = perProject.get(p.id) ?? new Set<string>();
      set.add(email);
      perProject.set(p.id, set);
    }
  }

  const ranked = [...perProject.entries()].map(([id, set]) => ({ id, n: set.size })).sort((a, b) => b.n - a.n);
  const top = ranked[0];
  const projectId = top && (ranked.length === 1 || ranked[1]!.n < top.n) ? top.id : null;
  return { projectId, matches };
}
