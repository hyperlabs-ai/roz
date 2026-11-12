// Redacción de los avisos (src/notify/copy.ts): puro, así que se prueba sin base ni red.
// Lo que se garantiza para TODOS los eventos: sin guion largo/medio, límites de longitud del push,
// el nombre del destinatario presente y redacción determinística por semilla.
import { describe, expect, it } from 'vitest';
import {
  PUSH_BODY_MAX,
  PUSH_TITLE_MAX,
  assignedNotice,
  botIcon,
  chatNotice,
  clean,
  clip,
  devDigestNotice,
  discordAssignedLine,
  documentedNotice,
  dueLabel,
  dueNotice,
  firstName,
  meetingReadyNotice,
  planClaimableNotice,
  prMergedNotice,
  prReviewedNotice,
  rangeLabel,
  renderEmail,
  repoDetectedNotice,
  teamDigestNotice,
  testNotice,
  toPush,
  workDoneNotice,
  type Notice,
} from '../src/notify/copy.js';
import { senderFrom } from '../src/adapters/email.js';

const NOW = new Date('2026-11-11T15:00:00Z');
const LONG = 'Desarrollar e implementar el generador de tickets inteligentes — parte del objetivo de noviembre – fase dos del plan completo';
const DASH = /[—–―]/;

function all(seed: string, recipient: string | null = 'Germán Morelli (Intern)'): Record<string, Notice> {
  const pr = { repo: 'hyperlabs-ai/app-hyperhub', number: 21, title: `Feat/crm redesign — ${LONG}`, branch: 'feat/HYPERHUB-96', identifier: 'HYPERHUB-96', additions: 1240, deletions: 310 };
  return {
    assigned: assignedNotice({ seed, recipient, actor: 'Manuel Cortez', task: { identifier: 'HYPERHUB-96', name: LONG, project: 'HyperHub', priority: 'high', dueDate: '2026-11-14' }, openBefore: 3, url: 'https://x/t', now: NOW }),
    assignedUrgent: assignedNotice({ seed, recipient, actor: 'Fer', task: { identifier: 'ROZ-329', name: LONG, project: 'ROZ', priority: 'urgent', dueDate: '2026-11-11' }, now: NOW }),
    reassigned: assignedNotice({ seed, recipient, actor: 'Fer', previous: 'Alan', task: { identifier: 'OPS-993', name: 'Subir imágenes de productos Irrigamex', project: 'irrigamex' }, now: NOW }),
    assignedAuto: assignedNotice({ seed, recipient, auto: true, task: { identifier: 'ROZ-12', name: 'Arreglar el cupón', estimate: 3 }, openBefore: 0, now: NOW }),
    assignedBare: assignedNotice({ seed, recipient, task: { identifier: 'ROZ-13' }, now: NOW }),
    done: workDoneNotice({ seed, recipient, identifier: 'ROZ-40', name: LONG, closedBy: 'Alan' }),
    documented1: documentedNotice({ seed, recipient, items: [{ identifier: 'ROZ-50', name: LONG, repo: 'roz' }] }),
    documentedN: documentedNotice({ seed, recipient, items: [1, 2, 3, 4, 5].map((n) => ({ identifier: `ROZ-5${n}`, name: `Cambio ${n}`, repo: 'roz' })), listUrl: 'https://x/tasks' }),
    due1: dueNotice({ seed, recipient, now: NOW, items: [{ identifier: 'ROZ-60', name: LONG, dueDate: '2026-11-11', project: 'ROZ' }] }),
    dueLate: dueNotice({ seed, recipient, now: NOW, items: [{ identifier: 'ROZ-61', name: 'Vencida', dueDate: '2026-11-08' }] }),
    dueMix: dueNotice({ seed, recipient, now: NOW, items: [{ identifier: 'ROZ-61', name: 'Vencida', dueDate: '2026-11-08' }, { identifier: 'ROZ-62', name: 'Hoy', dueDate: '2026-11-11' }, { identifier: 'ROZ-63', name: 'Hoy 2', dueDate: '2026-11-11' }] }),
    prMerged: prMergedNotice({ seed, recipient, merger: 'Manuel Cortez', pr, reviewers: ['Sebas'] }),
    prApproved: prReviewedNotice({ seed, recipient, reviewer: 'Sebastián Escalante', state: 'approved', pr }),
    prChanges: prReviewedNotice({ seed, recipient, reviewer: 'Manuel', state: 'changes_requested', pr }),
    prCommented: prReviewedNotice({ seed, recipient, reviewer: 'Alan', state: 'commented', pr }),
    repoLinked: repoDetectedNotice({ seed, recipient, repo: 'hyperlabs-ai/ecommerce-template', projectName: 'Ecommerce', linked: true }),
    repoOrphan: repoDetectedNotice({ seed, recipient, repo: 'hyperlabs-ai/un-repo-con-un-nombre-bastante-largo-para-probar', linked: false }),
    meeting: meetingReadyNotice({ seed, recipient, title: `Seguimiento con el cliente — ${LONG}`, candidates: 5, decisions: 2, duplicates: 1, project: 'Ecommerce' }),
    meetingEmpty: meetingReadyNotice({ seed, recipient, title: 'Daily', candidates: 0 }),
  };
}

describe('redacción de avisos', () => {
  it('ningún texto lleva guion largo ni medio, ni siquiera heredado del título de la tarea', () => {
    for (const seed of ['a', 'b', 'c', 'evento-4']) {
      for (const [name, n] of Object.entries(all(seed))) {
        const mail = renderEmail(n, 'https://roz.example');
        for (const s of [n.title, n.body, n.subject, mail.subject, mail.text, mail.html]) expect(s, name).not.toMatch(DASH);
      }
    }
  });

  it('el push respeta los límites: título <= 50, cuerpo <= 120', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      for (const [name, n] of Object.entries(all(seed))) {
        expect(n.title.length, `${name}: ${n.title}`).toBeLessThanOrEqual(PUSH_TITLE_MAX);
        expect(n.body.length, `${name}: ${n.body}`).toBeLessThanOrEqual(PUSH_BODY_MAX);
        expect(n.title.length, name).toBeGreaterThan(0);
        expect(n.body.length, name).toBeGreaterThan(0);
      }
    }
  });

  it('llama al destinatario por su nombre, en el push y en el correo', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      for (const [name, n] of Object.entries(all(seed))) {
        expect(`${n.title} ${n.body}`, `${name}: ${n.title} / ${n.body}`).toContain('Germán');
        expect(n.lead, name).toContain('Hola Germán');
      }
    }
  });

  it('sin nombre del destinatario no deja saludos rotos', () => {
    for (const [name, n] of Object.entries(all('a', null))) {
      expect(n.title, name).not.toMatch(/^[,\s]|,\s*$|undefined|null/);
      expect(n.lead, name).not.toMatch(/Hola\s*\.|undefined|null/);
    }
  });

  it('es determinística por semilla y varía entre eventos', () => {
    expect(all('x')).toEqual(all('x'));
    const titles = new Set(['1', '2', '3', '4', '5', '6', '7', '8'].map((s) => all(s).assignedBare!.title));
    expect(titles.size).toBeGreaterThan(1);
  });

  it('dice quién hizo qué y el dato concreto del evento', () => {
    const a = all('a');
    expect(a.assigned!.title).toMatch(/Manuel|HYPERHUB-96/);
    expect(a.assigned!.body).toContain('HyperHub');
    expect(a.assigned!.body).toContain('prioridad alta');
    expect(a.assigned!.body).toContain('vence en 3 días');
    expect(a.assignedUrgent!.title.toLowerCase()).toContain('urgente');
    expect(a.assignedUrgent!.mood).toBe('alert');
    expect(a.assignedUrgent!.body).toContain('vence hoy');
    expect(a.reassigned!.lead).toContain('la llevaba Alan');
    expect(a.assignedAuto!.lead).toContain('Es lo único que tienes abierto');
    expect(a.prMerged!.body).toContain('app-hyperhub');
    expect(a.prMerged!.lead).toContain('Manuel integró tu PR #21');
    expect(a.prChanges!.mood).toBe('alert');
    expect(a.prApproved!.title).toContain('aprobó');
    expect(a.dueLate!.mood).toBe('alert');
    expect(a.dueMix!.title).toMatch(/2.*1/);
    expect(a.meeting!.body).toContain('1 posible duplicado');
  });

  it('el correo trae el detalle estructurado, el avatar de Roz-bot y el botón', () => {
    const n = all('a').assigned!;
    const mail = renderEmail(n, 'https://roz.example/');
    expect(mail.html).toContain('https://roz.example/brand/roz-bot.png');
    expect(mail.html).toContain('Abrir tarea');
    expect(mail.text).toContain('Proyecto: HyperHub');
    expect(mail.text).toContain('Asignó: Manuel');
    expect(mail.text.trim().endsWith('Roz')).toBe(true);
    // El título de una tarea es texto de usuario: nunca entra como HTML.
    const evil = renderEmail(assignedNotice({ seed: 's', recipient: 'Ana', task: { identifier: 'X-1', name: '<script>alert(1)</script>' }, now: NOW }));
    expect(evil.html).not.toContain('<script>');
  });

  it('el push sale con el avatar de Roz-bot según el ánimo', () => {
    expect(toPush(all('a').assignedUrgent!, { tag: 't' })).toMatchObject({ icon: '/brand/roz-bot-alert.png', tag: 't' });
    expect(botIcon('happy')).toBe('/brand/roz-bot-happy.png');
  });

  it('aviso al equipo, digest, prueba y Discord', () => {
    const plan = planClaimableNotice({ seed: 'p', identifier: 'ROZ-9', name: LONG, owner: 'Ana López', reason: 'dueño_fuera_de_linea', project: 'ROZ' });
    expect(plan.body).toContain('Ana lleva más de 2 h fuera de línea');
    const dev = devDigestNotice({ seed: 'd', recipient: 'Alan', range: '9 al 15 nov', stats: { commits: 184, tickets: 1, lines: 86000, commitsChangePct: 12 }, topProject: 'Ecommerce' });
    const team = teamDigestNotice({ seed: 'd', range: '9 al 15 nov', stats: { commits: 331, tickets: 4, lines: 400000, contributors: 5 } });
    for (const n of [plan, dev, team, testNotice('Alan Vazquez')]) {
      expect(n.title.length).toBeLessThanOrEqual(PUSH_TITLE_MAX);
      expect(n.body.length).toBeLessThanOrEqual(PUSH_BODY_MAX);
      expect(`${n.title}${n.body}`).not.toMatch(DASH);
    }
    expect(`${dev.title} ${dev.body}`).toContain('Alan');
    expect(dev.body).toContain('1 tarea cerrada');
    expect(testNotice('Alan Vazquez').title).toBe('Alan, aquí Roz');
    expect(discordAssignedLine({ seed: 'ROZ-1', identifier: 'ROZ-1', title: 'Arreglar — cupón', actor: 'Fer' })).not.toMatch(DASH);
    expect(discordAssignedLine({ seed: 'ROZ-1', identifier: 'ROZ-1', title: 'x', priority: 'urgent' })).toContain('urgente');
  });

  it('chat: habla quien escribió, y a quien mencionaron se le dice', () => {
    expect(chatNotice({ author: 'Alan Vazquez', preview: 'ya quedó — revisen', kind: 'channel', channelName: 'general', mentioned: true }))
      .toEqual({ title: 'Alan te mencionó en #general', body: 'ya quedó, revisen' });
    expect(chatNotice({ author: 'Alan', preview: '', kind: 'dm', attachmentCount: 2 })).toEqual({ title: 'Alan', body: 'Envió 2 archivos' });
    expect(chatNotice({ author: 'Alan', preview: 'va', kind: 'dm', group: true, isReply: true }).title).toBe('Alan · grupo · hilo');
    expect(chatNotice({ author: 'Alan', preview: 'avance', kind: 'channel', channelName: 'dev', statusCount: 3 }).body).toBe('Status de 3 tareas: avance');
    expect(chatNotice({ author: 'Alan', preview: 'x'.repeat(400), kind: 'channel', channelName: 'dev', isReply: true }).body.length).toBeLessThanOrEqual(PUSH_BODY_MAX);
  });

  it('utilidades', () => {
    expect(clean('a — b – c')).toBe('a, b, c');
    expect(clip('una frase bastante larga para recortar', 20).length).toBeLessThanOrEqual(20);
    expect(firstName('Manuel Cortez (AI Developer)')).toBe('Manuel');
    expect(dueLabel('2026-11-11', NOW)).toBe('vence hoy');
    expect(dueLabel('2026-11-12', NOW)).toBe('vence mañana');
    expect(dueLabel('2026-11-08', NOW)).toBe('venció hace 3 días');
    expect(dueLabel('2026-12-24', NOW)).toBe('vence el 24 dic');
    expect(rangeLabel('2026-11-09T12:00:00Z', '2026-11-15T12:00:00Z')).toBe('9 al 15 nov');
    expect(rangeLabel('2026-10-28T12:00:00Z', '2026-11-03T12:00:00Z')).toBe('28 oct al 3 nov');
  });
});
