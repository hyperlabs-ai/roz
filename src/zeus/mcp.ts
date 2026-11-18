// Herramientas MCP de zeus: la cara por la que Claude jala contexto, lo actualiza, manda mensajes y
// pide accesos. Contrato: docs/zeus-contracts.md §6.
//
// Todas actúan como UN dev concreto (el dueño del token `zeus_…` o del runner). Por eso reciben el
// actor: lo que el agente escribe queda atribuido a una persona.
import { z } from 'zod';
import { ZEUS_EDGE_KINDS, ZEUS_NODE_KINDS, ZEUS_NODE_STATUSES } from '../types/zeus.js';
import { claimPlan, listPlans, releasePlan } from '../plans/service.js';
import { assertPlansEnabled } from '../plans/store.js';
import { db } from '../db/supabase.js';
import { AppError } from '../utils/errors.js';
import { actorActivity, logActivity, mustParseRef, resolveProject, type ZeusActor } from './core.js';
import { getOrg } from './graph.js';
import {
  MAX_PLAN_CHARS,
  cancelRequest,
  createRequest,
  findDev,
  getInbox,
  getMessage,
  listRequests,
  markRead,
  resolveRequest,
  routeFor,
  sendMessage,
  setMessageStatus,
  sharePlan,
} from './inbox.js';
import type { ZeusMessage } from '../types/zeus.js';
import { contextIndex, createEdge, createNode, deleteEdge, edgesOf, getNodeDetail, searchNodes, updateNode } from './nodes.js';
import { reimportNode } from './ingest.js';
import { envStatus } from './vault.js';

export interface ZeusMcpTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  /** Solo lectura: las ve también un runner (que corre sin una persona mirando). */
  readOnly: boolean;
  handler: (args: any, actor: ZeusActor) => Promise<unknown>;
}

/** Tope por defecto del cuerpo que devuelve zeus_get: un documento largo no debe comerse el contexto. */
const DEFAULT_GET_CHARS = 24_000;

const kindEnum = z.enum(ZEUS_NODE_KINDS);
const projectKey = z.string().describe('Clave del proyecto (de list_projects). Omítela para lo que aplica a toda la organización.');

/** Acepta "node:<uuid>" o el uuid pelón: los agentes mandan cualquiera de los dos. */
function nodeId(refOrId: string): string {
  const s = refOrId.trim();
  return s.startsWith('node:') ? s.slice(5) : s;
}

export const zeusTools: ZeusMcpTool[] = [
  // ---------- contexto: leer ----------
  {
    name: 'zeus_context_index',
    description:
      'PRIMER paso antes de planear o tocar código de un proyecto. Devuelve el índice corto de su contexto: una línea por ' +
      'cada regla, decisión (ADR), spec, diseño y documento vigente, con lo fijado primero. Es barato a propósito: NO trae ' +
      'el texto. Después trae solo lo que aplique con zeus_get.',
    schema: z.object({ projectKey: projectKey.optional() }),
    readOnly: true,
    handler: async (args, actor) => {
      const project = args.projectKey ? await resolveProject(args.projectKey) : null;
      const index = await contextIndex(project);
      logActivity(actorActivity(actor), 'index', project ? `project:${project.id}` : null, { entries: index.entries.length });
      return index;
    },
  },
  {
    name: 'zeus_search',
    description:
      'Busca en el registro central de contexto del equipo (ADR, specs, cambios, docs, design system, reglas, recursos) por texto. Devuelve ' +
      'ref, título, una línea y un recorte de cada resultado; trae el completo con zeus_get. Con projectKey busca en ese ' +
      'proyecto y en lo de la organización. Usa 2-5 palabras clave, no una frase entera.',
    schema: z.object({
      query: z.string().min(2).describe('Palabras clave. Admite "frase exacta", OR y -excluir.'),
      projectKey: projectKey.optional(),
      kinds: z.array(kindEnum).optional().describe('Limitar a estos tipos.'),
      limit: z.number().int().min(1).max(30).optional().describe('Máximo de resultados (def 8).'),
    }),
    readOnly: true,
    handler: async (args, actor) => {
      const project = args.projectKey ? await resolveProject(args.projectKey) : null;
      const hits = await searchNodes({ query: args.query, projectId: project?.id ?? null, kinds: args.kinds, limit: args.limit ?? 8 });
      logActivity(actorActivity(actor), 'search', project ? `project:${project.id}` : null, { query: args.query, hits: hits.length });
      return {
        hits: hits.map((h) => ({ ref: h.ref, kind: h.kind, title: h.title, summary: h.summary, status: h.status, snippet: h.snippet, updatedAt: h.updatedAt })),
        ...(hits.length ? {} : { hint: 'Sin resultados. Prueba menos palabras o sinónimos, o mira zeus_context_index.' }),
      };
    },
  },
  {
    name: 'zeus_get',
    description:
      'Trae un documento completo del contexto por su ref (node:<id>), con sus conexiones (a qué reemplaza, de qué depende, ' +
      'quién es dueño). Si es largo viene recortado: pide más con offset.',
    schema: z.object({
      ref: z.string().describe('ref del documento, p. ej. "node:…" (de zeus_search o zeus_context_index).'),
      maxChars: z.number().int().min(500).max(100_000).optional().describe(`Máximo de caracteres del cuerpo (def ${DEFAULT_GET_CHARS}).`),
      offset: z.number().int().min(0).optional().describe('Desde qué carácter seguir leyendo un documento recortado.'),
    }),
    readOnly: true,
    handler: async (args, actor) => {
      const d = await getNodeDetail(nodeId(args.ref));
      const max = args.maxChars ?? DEFAULT_GET_CHARS;
      const offset = Math.min(args.offset ?? 0, d.body.length);
      const body = d.body.slice(offset, offset + max);
      const rest = d.body.length - offset - body.length;
      logActivity(actorActivity(actor), 'get', d.ref, { title: d.title });
      return {
        ref: d.ref,
        kind: d.kind,
        title: d.title,
        summary: d.summary,
        status: d.status,
        project: d.projectKey,
        // La procedencia informa, no manda: la versión vigente es la de zeus.
        source:
          d.source === 'git'
            ? { importedFrom: { repo: d.sourceRepo, path: d.sourcePath, url: d.sourceUrl }, note: 'Importado de ese archivo. La versión vigente es ESTA: se edita en zeus (zeus_write), no en el repo.' }
            : 'manual (se edita en zeus)',
        updatedAt: d.updatedAt,
        ...(d.status !== 'active' ? { warning: `Este documento está "${d.status}": no lo tomes como vigente sin revisar qué lo reemplazó.` } : {}),
        ...(d.reviewAfter && d.reviewAfter < new Date().toISOString().slice(0, 10) ? { stale: `Debió revisarse el ${d.reviewAfter}: puede estar desactualizado.` } : {}),
        connections: d.edges.map((e) => ({ relation: e.direction === 'out' ? e.kind : `${e.kind} (entrante)`, ref: e.otherRef, title: e.otherTitle, kind: e.otherKind })),
        body,
        ...(rest > 0 ? { truncated: `Faltan ${rest} caracteres. Sigue con offset ${offset + body.length}.` } : {}),
      };
    },
  },
  {
    name: 'zeus_related',
    description: 'Lo que está conectado a una referencia del grafo (documento, proyecto, persona, repo): qué reemplaza, de qué depende, quién es dueño.',
    schema: z.object({ ref: z.string().describe('node:<id>, project:<id>, dev:<id>, repo:<owner/name> o runner:<id>') }),
    readOnly: true,
    handler: async (args) => {
      mustParseRef(args.ref);
      const edges = await edgesOf(args.ref);
      return { ref: args.ref, connections: edges.map((e) => ({ relation: e.kind, direction: e.direction, ref: e.otherRef, title: e.otherTitle, kind: e.otherKind, note: e.note })) };
    },
  },

  // ---------- contexto: escribir ----------
  {
    name: 'zeus_write',
    description:
      'Crea o actualiza un documento de contexto (ADR, spec, cambio, regla, recurso, doc, diseño) en el registro central de ' +
      'zeus, que es la fuente de verdad del equipo. Para actualizar pasa ref; sirve para CUALQUIER documento, también los ' +
      'importados de un repo: se editan AQUÍ, no en su archivo del repo (ese archivo solo fue el origen de la importación y ' +
      'cambiarlo allá no actualiza zeus). Cada cambio de contenido sube la versión y deja revisión a nombre de la persona. ' +
      'Para retirar un documento pasa status "archived". Escribe el resumen como UNA línea que diga la decisión, no el tema ' +
      '("Usamos Postgres, no Mongo", no "Sobre la base de datos"): es lo que otros agentes verán en el índice. Hazlo solo si ' +
      'la persona te lo pidió o lo confirmó.',
    schema: z.object({
      ref: z.string().optional().describe('ref del documento a actualizar; omítelo para crear.'),
      kind: kindEnum.optional().describe('Tipo (obligatorio al crear).'),
      title: z.string().max(200).optional().describe('Título (obligatorio al crear).'),
      summary: z.string().max(240).optional().describe('UNA línea con la decisión o el hecho.'),
      body: z.string().optional().describe('Markdown completo.'),
      projectKey: projectKey.optional(),
      status: z.enum(ZEUS_NODE_STATUSES).optional(),
      tags: z.array(z.string()).optional(),
      pinned: z.boolean().optional().describe('true = entra siempre al índice. Úsalo con moderación.'),
      owner: z.string().optional().describe('Dueño (nombre, correo o id). A él se le enrutan las solicitudes sobre este recurso.'),
      reviewAfter: z.string().optional().describe('AAAA-MM-DD: cuándo revisar si sigue vigente.'),
    }),
    readOnly: false,
    handler: async (args, actor) => {
      const patch: Record<string, unknown> = {};
      for (const k of ['kind', 'title', 'summary', 'body', 'status', 'tags', 'pinned', 'reviewAfter'] as const) if (args[k] !== undefined) patch[k] = args[k];
      if (args.projectKey !== undefined) patch.projectId = (await resolveProject(args.projectKey)).id;
      if (args.owner !== undefined) patch.ownerDevId = (await findDev(args.owner)).id;
      const d = args.ref ? await updateNode(nodeId(args.ref), patch, actor) : await createNode(patch as any, actor);
      return { ok: true, ref: d.ref, title: d.title, version: d.version, status: d.status, project: d.projectKey };
    },
  },
  {
    name: 'zeus_reimport',
    description:
      'Trae la versión que hay HOY en el repo de un documento importado y la aplica como una edición más (título, resumen y ' +
      'cuerpo; sube versión y deja revisión). PISA el texto que tiene zeus con el del archivo, así que úsalo solo cuando la ' +
      'persona te pida explícitamente "traer la versión del repo". No es la forma normal de editar: eso es zeus_write. ' +
      'Falla si el documento se creó en zeus o si su archivo ya no existe en el repo.',
    schema: z.object({ ref: z.string().describe('ref del documento importado (node:…).') }),
    readOnly: false,
    handler: async (args, actor) => {
      const { node: d, changed } = await reimportNode(nodeId(args.ref), actor);
      return {
        ok: true,
        ref: d.ref,
        title: d.title,
        version: d.version,
        changed,
        from: { repo: d.sourceRepo, path: d.sourcePath },
        ...(changed ? {} : { note: 'El archivo del repo es igual a lo que ya tenía zeus: no cambió nada.' }),
      };
    },
  },
  {
    name: 'zeus_link',
    description:
      `Conecta dos referencias del grafo. Tipos: ${ZEUS_EDGE_KINDS.join(', ')}. La dirección importa: "from supersedes to" ` +
      'significa que from reemplaza a to (y to deja de estar vigente).',
    schema: z.object({
      from: z.string().describe('ref de origen'),
      to: z.string().describe('ref de destino'),
      kind: z.enum(ZEUS_EDGE_KINDS),
      note: z.string().max(300).optional(),
    }),
    readOnly: false,
    handler: (args, actor) => createEdge({ src: args.from, dst: args.to, kind: args.kind, note: args.note }, actor),
  },
  {
    name: 'zeus_unlink',
    description:
      'Quita una conexión entre dos referencias del grafo. Sirve para cualquiera, también las que se crearon al importar un ' +
      'documento de un repo: una vez quitada no regresa.',
    schema: z.object({ from: z.string(), to: z.string(), kind: z.enum(ZEUS_EDGE_KINDS) }),
    readOnly: false,
    handler: async (args, actor) => {
      await deleteEdge({ src: args.from, dst: args.to, kind: args.kind }, actor);
      return { ok: true };
    },
  },

  // ---------- organización ----------
  {
    name: 'zeus_org',
    description:
      'Organigrama del equipo: rol de cada persona, a quién reporta, en qué proyectos está, sus skills, quién administra ' +
      'zeus y quién tiene su PC en línea ahora. Úsalo para saber a quién preguntar o escalar.',
    schema: z.object({ query: z.string().optional().describe('Filtra por nombre, rol, proyecto o skill.') }),
    readOnly: true,
    handler: async (args) => {
      const org = await getOrg();
      const byId = new Map(org.members.map((m) => [m.devId, m.name]));
      const q = args.query?.toLowerCase().trim();
      const members = org.members
        .filter((m) => !q || [m.name, m.role, ...m.projects, ...m.skills].some((v) => v.toLowerCase().includes(q)))
        .map((m) => ({
          ref: `dev:${m.devId}`,
          name: m.name,
          role: m.role,
          reportsTo: m.reportsTo ? (byId.get(m.reportsTo) ?? null) : null,
          projects: m.projects,
          skills: m.skills,
          zeusAdmin: m.zeusAdmin,
          online: m.online,
        }));
      return { members, ...(org.needsAdmin ? { warning: 'Nadie administra zeus todavía: las solicitudes sin dueño no tienen a quién llegar.' } : {}) };
    },
  },
  {
    name: 'zeus_who_owns',
    description:
      'A quién hay que pedirle un acceso o un permiso sobre algo (un recurso, un proyecto, un repo, un documento) y por qué ' +
      'esa persona. No abre nada: para pedirlo usa zeus_request.',
    schema: z.object({
      ref: z.string().optional().describe('ref del recurso (node:…, project:…, repo:…).'),
      projectKey: z.string().optional().describe('Si no tienes ref: la clave del proyecto.'),
      query: z.string().optional().describe('Si no tienes ref: texto para encontrar el recurso (p. ej. "vercel", "stripe").'),
    }),
    readOnly: true,
    handler: async (args, actor) => {
      let ref: string | null = args.ref ?? null;
      let matched: string | null = null;
      if (!ref && args.query) {
        const project = args.projectKey ? await resolveProject(args.projectKey) : null;
        const hit = (await searchNodes({ query: args.query, projectId: project?.id ?? null, kinds: ['resource', 'team'], limit: 1 }))[0];
        if (hit) {
          ref = hit.ref;
          matched = hit.title;
        } else if (project) ref = `project:${project.id}`;
      } else if (!ref && args.projectKey) ref = `project:${(await resolveProject(args.projectKey)).id}`;
      if (ref) mustParseRef(ref);
      const route = await routeFor(actor.devId, ref);
      return {
        resource: ref,
        ...(matched ? { matched } : {}),
        askTo: route.approver ? { ref: `dev:${route.approver.id}`, name: route.approver.name, role: route.approver.role } : null,
        because: route.because,
      };
    },
  },

  // ---------- solicitudes y mensajes ----------
  {
    name: 'zeus_request',
    description:
      'Abre una solicitud (acceso a un sistema, permiso, revisión, cambio) y zeus la enruta sola a quien le toca: el dueño ' +
      'del recurso, quien lleva el proyecto, tu jefe directo o un admin. La respuesta dice a quién llegó y por qué. Aprobar ' +
      'NO cambia permisos por sí solo: quien aprueba da el acceso en el sistema real. Ábrela solo si la persona te lo pidió.',
    schema: z.object({
      title: z.string().max(200).describe('Qué se pide, en una línea ("Acceso de lectura al proyecto de Vercel de orwel").'),
      detail: z.string().optional().describe('Para qué se necesita y por cuánto tiempo.'),
      kind: z.enum(['access', 'permission', 'review', 'change', 'other']).optional(),
      resourceRef: z.string().optional().describe('ref del recurso o proyecto, si se conoce (mejora el enrutado).'),
    }),
    readOnly: false,
    handler: async (args, actor) => {
      const r = await createRequest(args, actor);
      return { ok: true, id: r.id, status: r.status, sentTo: r.approverName ?? 'cualquier administrador de zeus', because: r.routedBecause };
    },
  },
  {
    name: 'zeus_requests',
    description: 'Solicitudes: las que abriste (scope "mine") o las que te toca resolver (scope "to_me").',
    schema: z.object({ scope: z.enum(['mine', 'to_me']).optional() }),
    readOnly: true,
    handler: async (args, actor) => ({ requests: await listRequests(args.scope ?? 'to_me', actor) }),
  },
  {
    name: 'zeus_resolve_request',
    description:
      'Aprueba, rechaza o cancela una solicitud. Aprobar/rechazar solo lo puede hacer a quien se le enrutó (o un admin), y ' +
      'es una decisión de una PERSONA: no la tomes tú; hazlo solo cuando el usuario te lo indique explícitamente.',
    schema: z.object({
      id: z.string().describe('id de la solicitud'),
      decision: z.enum(['approved', 'denied', 'cancelled']),
      note: z.string().max(2000).optional(),
    }),
    readOnly: false,
    handler: (args, actor) => (args.decision === 'cancelled' ? cancelRequest(args.id, actor) : resolveRequest(args.id, args.decision, args.note ?? null, actor)),
  },
  {
    name: 'zeus_send_message',
    description:
      'Manda algo a la bandeja de alguien del equipo (le llega también como notificación). kind "message" (default) es un aviso ' +
      'o pregunta. kind "task" es un ENCARGO ("avísale a Alan que implemente X de tal manera", "necesito que hagas Y"): queda ' +
      'como pendiente en su bandeja de roz hasta que lo marque hecho o lo rechace, y tú ves su estado. Para un encargo pon un ' +
      'subject corto (es lo que se ve en la lista) y en body el detalle con criterios claros. Redacta en segunda persona, como ' +
      'lo diría el usuario. Nunca pongas secretos ni valores de variables de entorno.',
    schema: z.object({
      to: z.string().describe('Nombre, correo, login de GitHub o id de la persona.'),
      body: z.string().max(8000),
      subject: z.string().max(160).optional().describe('Obligatorio si kind = "task".'),
      kind: z.enum(['message', 'task']).optional(),
      projectKey: z.string().optional().describe('Proyecto al que se refiere, si aplica.'),
      ref: z.string().optional().describe('ref de lo que trata el mensaje (documento, proyecto).'),
    }),
    readOnly: false,
    handler: async (args, actor) => {
      const m = await sendMessage(args, actor);
      return { ok: true, id: m.id, to: m.toName, kind: m.kind, status: m.status };
    },
  },
  {
    name: 'zeus_share_plan',
    description:
      'Comparte un PLAN de implementación con alguien del equipo (el plan completo en markdown: objetivo, pasos, archivos, ' +
      'riesgos, cómo se prueba). Le llega a su bandeja como pendiente; su Claude lo jala y le pregunta si lo implementa, lo ajusta ' +
      'o lo rechaza. Para mandar una versión AJUSTADA de un plan (porque te pidieron cambios), pasa revises con el id del plan ' +
      'anterior: queda como la versión nueva y la anterior se marca reemplazada. Úsalo cuando el usuario diga "compártele este ' +
      'plan a X", "mándale el plan a X".',
    schema: z.object({
      to: z.string().describe('Nombre, correo, login de GitHub o id de la persona.'),
      title: z.string().max(160).describe('Título corto del plan.'),
      plan: z.string().max(MAX_PLAN_CHARS).describe('El plan completo en markdown, autocontenido: quien lo recibe no vio tu conversación.'),
      projectKey: z.string().optional(),
      revises: z.string().optional().describe('id del plan que esta versión reemplaza.'),
      ref: z.string().optional(),
    }),
    readOnly: false,
    handler: async (args, actor) => {
      const m = await sharePlan(args, actor);
      return { ok: true, id: m.id, to: m.toName, status: m.status, revises: m.parentId };
    },
  },
  {
    name: 'zeus_get_message',
    description:
      'Trae un mensaje, encargo o plan COMPLETO por id (zeus_inbox recorta los planes largos), con las versiones anteriores si ' +
      'es un plan ajustado.',
    schema: z.object({ id: z.string() }),
    readOnly: true,
    handler: (args, actor) => getMessage(args.id, actor),
  },
  {
    name: 'zeus_respond',
    description:
      'Cambia el estado de un encargo o plan que te mandaron: "accepted" (lo vas a implementar), "changes_requested" (pides ' +
      'ajustes; note obligatorio con QUÉ cambiar), "declined" (no se hará; di por qué en note) o "done" (ya quedó). Quien lo ' +
      'mandó puede "cancelled". A quien lo mandó le llega aviso. Es decisión de la PERSONA: confírmala con el usuario antes.',
    schema: z.object({
      id: z.string(),
      status: z.enum(['accepted', 'changes_requested', 'declined', 'done', 'cancelled']),
      note: z.string().max(8000).optional(),
    }),
    readOnly: false,
    handler: async (args, actor) => {
      const m = await setMessageStatus(args.id, args.status, args.note ?? null, actor);
      return { ok: true, id: m.id, status: m.status };
    },
  },
  {
    name: 'zeus_inbox',
    description:
      'Tu bandeja: "open" son tus PENDIENTES (encargos y planes que te mandaron y siguen abiertos), "waiting" lo que tú mandaste y ' +
      'otros no han cerrado, "messages" los mensajes y avisos recientes (incluye cambios de variables de entorno), "toResolve" ' +
      'solicitudes que te toca resolver y "mine" las que abriste.',
    schema: z.object({ unreadOnly: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() }),
    readOnly: true,
    handler: async (args, actor) => {
      const inbox = await getInbox(actor, { unreadOnly: args.unreadOnly ?? false, limit: args.limit ?? 20 });
      return {
        unread: inbox.unread,
        open: inbox.open.map((m) => agentMessage(m, 2500)),
        waiting: inbox.waiting.map((m) => ({ id: m.id, kind: m.kind, to: m.toName, subject: m.subject, status: m.status, statusNote: m.statusNote, at: m.createdAt })),
        messages: inbox.messages.filter((m) => m.kind === 'message' || m.kind === 'env_change').map((m) => agentMessage(m, 1500)),
        toResolve: inbox.toResolve.map((r) => ({ id: r.id, from: r.requesterName, title: r.title, detail: r.detail, kind: r.kind, because: r.routedBecause, at: r.createdAt })),
        mine: inbox.mine.map((r) => ({ id: r.id, title: r.title, status: r.status, sentTo: r.approverName, note: r.resolutionNote })),
      };
    },
  },
  {
    name: 'zeus_mark_read',
    description: 'Marca mensajes de tu bandeja como leídos (ids o "all").',
    schema: z.object({ ids: z.array(z.string()).optional(), all: z.boolean().optional() }),
    readOnly: false,
    handler: async (args, actor) => ({ ok: true, marked: await markRead(args.all ? 'all' : (args.ids ?? []), actor) }),
  },

  // ---------- planes ----------
  {
    name: 'zeus_plans',
    description:
      'Tu bandeja de planes: los que te tocan (scope "mine"), los que cualquiera puede reclamar porque su dueño no está o ' +
      'llevan mucho en cola ("claimable"), o los del equipo ("team"). Cada plan trae su paquete de contexto (refs de zeus).',
    schema: z.object({ scope: z.enum(['mine', 'claimable', 'team']).optional() }),
    readOnly: true,
    handler: async (args, actor) => {
      assertPlansEnabled();
      const { plans } = await listPlans({ viewerDevId: actor.devId, scope: args.scope ?? 'mine' });
      const ids = plans.map((p) => p.id);
      const packs = new Map<string, unknown>();
      if (ids.length) {
        const { data, error } = await db().from('agent_plan').select('id, context_pack').in('id', ids);
        if (error) throw error;
        for (const r of (data ?? []) as Array<{ id: string; context_pack: unknown }>) packs.set(r.id, r.context_pack);
      }
      return { plans: plans.map((p) => ({ ...p, contextPack: packs.get(p.id) ?? null })) };
    },
  },
  {
    name: 'zeus_plan_claim',
    description:
      'Toma un plan que está marcado como reclamable (su dueño no está en línea o lleva mucho en cola) para implementarlo ' +
      'tú. Queda registrado quién lo tomó y se reasigna la tarea.',
    schema: z.object({ planId: z.string(), note: z.string().max(500).optional().describe('Por qué lo tomas.') }),
    readOnly: false,
    handler: async (args, actor) => {
      assertPlansEnabled();
      return claimPlan(args.planId, await planActor(actor), args.note ?? null);
    },
  },
  {
    name: 'zeus_plan_release',
    description: 'Suelta un plan que es tuyo para que otra persona lo pueda reclamar (no puedes atenderlo ahora).',
    schema: z.object({ planId: z.string() }),
    readOnly: false,
    handler: async (args, actor) => {
      assertPlansEnabled();
      return releasePlan(args.planId, await planActor(actor));
    },
  },

  // ---------- llaves ----------
  {
    name: 'zeus_env_status',
    description:
      'Qué variables de entorno tiene un proyecto en la bóveda (solo NOMBRES, por entorno), si tú tienes acceso y el comando ' +
      'para bajarlas a tu .env. zeus no puede leer los valores; nunca pidas ni pegues valores de secretos.',
    schema: z.object({ projectKey: z.string() }),
    readOnly: true,
    handler: (args, actor) => envStatus(args.projectKey, actor),
  },
];

/** Los planes registran al usuario de auth que actuó; por MCP no hay sesión, se usa el vínculo del dev. */
async function planActor(actor: ZeusActor): Promise<{ userId: string; devId: string }> {
  const { data, error } = await db().from('dev').select('ops_user_id').eq('id', actor.devId).maybeSingle();
  if (error) throw error;
  const userId = (data as { ops_user_id: string | null } | null)?.ops_user_id;
  if (!userId) throw new AppError('FORBIDDEN', 'tu dev no está ligado a un usuario del dashboard: haz esta acción desde roz', 403);
  return { userId, devId: actor.devId };
}

export const zeusToolsByName = new Map(zeusTools.map((t) => [t.name, t]));

/** Un mensaje como lo ve el agente: recortado (los planes se piden completos con zeus_get_message). */
function agentMessage(m: ZeusMessage, maxBody: number) {
  const cut = m.body.length > maxBody;
  return {
    id: m.id,
    kind: m.kind,
    from: m.fromName,
    subject: m.subject,
    body: cut ? `${m.body.slice(0, maxBody)}… [recortado: zeus_get_message id="${m.id}" para el texto completo]` : m.body,
    status: m.status,
    statusNote: m.statusNote,
    project: m.projectKey,
    revises: m.parentId,
    read: !!m.readAt,
    at: m.createdAt,
  };
}

// ---------------------------------------------------------------- instrucciones del servidor

/**
 * Lo que Claude Code carga SOLO al conectarse (campo `instructions` del initialize de MCP). Hace de
 * "skill" sin instalar nada: quien tiene zeus conectado ya trae estas reglas en cada sesión.
 */
export const ZEUS_MCP_INSTRUCTIONS = [
  'zeus es el contexto compartido del equipo y su bóveda de variables de entorno.',
  '',
  'CONTEXTO. Antes de planear o tocar código de un proyecto llama zeus_context_index y trae con zeus_get solo lo que aplique. ' +
    'Las reglas y decisiones vigentes se respetan. El registro de zeus es la fuente de verdad de ADR, specs, reglas y documentos: ' +
    'para cambiar uno edítalo AQUÍ con zeus_write (también los importados de un repo), no en su archivo del repo.',
  '',
  'BANDEJA. Al empezar una sesión de trabajo revisa zeus_inbox. Si hay planes en "open" con status pending, preséntalos (quién, ' +
    'título, resumen en 3-5 líneas; trae el texto completo con zeus_get_message) y PREGUNTA al usuario: ¿lo implemento tal cual, ' +
    'lo ajusto o lo rechazo? Si lo implementa: zeus_respond status="accepted" y al terminar "done". Si quiere ajustes: anota QUÉ ' +
    'cambiar y zeus_respond status="changes_requested" con esa nota. Encargos (kind "task") igual: confirma antes de cambiarles el ' +
    'estado. "Avísale a X…" / "pídele a X que…" = zeus_send_message (kind "task" si es trabajo que X debe hacer). "Compártele el ' +
    'plan a X" = zeus_share_plan con el plan completo y autocontenido.',
  '',
  'VARIABLES DE ENTORNO (CLI `zeus`, corre en la PC del usuario):',
  '- Nunca leas, imprimas ni pegues valores de secretos: ni `cat .env`, ni `zeus env pull --stdout`, ni pedirle al usuario que te ' +
    'pegue un valor. Tú manejas NOMBRES; los valores van de la bóveda al archivo sin pasar por la conversación.',
  '- Ver qué hay: zeus_env_status (nombres, versión, quién y cuándo cambió cada una). Comparar el .env local con la bóveda: ' +
    '`zeus env status` (solo nombres; detecta el proyecto y entorno por la cabecera de cada .env).',
  '- Nombres de entorno: NO los inventes ni los escribas completos. Corre el CLI dentro del repo y pasa solo la etapa ' +
    '(local/dev/development o prod/production): el CLI arma `<repo>-<etapa>` (estándar del equipo).',
  '- Bajar: `zeus env pull <proyecto> [etapa] --yes`. Cada etapa va a su archivo: development → .env, production → ' +
    '.env.production (local y prod nunca se mezclan). Alias: local/dev = development, prod = production. Si el archivo ' +
    'tiene variables que la bóveda no, `--yes` las conserva sin subirlas: pregúntale al usuario si quiere subirlas y, si sí, ' +
    'repite con `--push-local` (nunca lo decidas tú).',
  '- Subir o reemplazar UNA variable: pide al usuario que copie el valor y corre `zeus env set <proyecto> <entorno> NOMBRE ' +
    '--from-clipboard` (o --from-file <ruta>). Nunca pongas el valor en el comando.',
  '- Subir un archivo completo: `zeus env push <proyecto> <entorno> --yes` (muestra solo nombres). Diferencias entre entornos: ' +
    '`zeus env diff <proyecto> development production`. Historial: `zeus env history <proyecto> <entorno> [NOMBRE]`; volver a una ' +
    'versión: `zeus env restore <proyecto> <entorno> NOMBRE --version N`.',
  '- Para que el usuario VEA valores, que corra él `zeus env ui` (visor local en su navegador). Tú no abras esa URL.',
  '- Si un comando dice que falta acceso, abre una solicitud con zeus_request; no intentes rodearlo.',
  '',
  'Nunca escribas secretos ni valores de variables de entorno en mensajes, planes o documentos.',
].join('\n');

/** Prompts del servidor: en Claude Code aparecen como /mcp__zeus__<nombre>. */
export const ZEUS_MCP_PROMPTS: Array<{
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
  render: (args: Record<string, string>) => string;
}> = [
  {
    name: 'pendientes',
    description: 'Revisa tu bandeja de zeus: encargos, planes compartidos y avisos de variables.',
    arguments: [],
    render: () =>
      'Revisa mi bandeja de zeus (zeus_inbox). Primero mis pendientes ("open"): para cada plan dame quién lo manda, título y un ' +
      'resumen corto, y pregúntame si lo implementamos tal cual, lo ajustamos o lo rechazamos. Para cada encargo dime qué piden y ' +
      'pregúntame qué hacemos. Luego, en una línea cada uno, los avisos de variables de entorno que cambiaron y si me conviene ' +
      'correr `zeus env status`. No cambies ningún estado sin que yo lo confirme.',
  },
  {
    name: 'compartir-plan',
    description: 'Comparte el plan de implementación de esta conversación con alguien del equipo.',
    arguments: [{ name: 'para', description: 'A quién (nombre, correo o login de GitHub).', required: true }],
    render: (a) =>
      `Comparte con ${a.para ?? 'la persona que te diga'} el plan de implementación que acabamos de definir, usando zeus_share_plan. ` +
      'Escríbelo autocontenido (quien lo recibe no vio esta conversación): objetivo, contexto, pasos, archivos a tocar, riesgos y ' +
      'cómo se prueba. Antes de mandarlo muéstrame el título y un resumen y espera mi OK.',
  },
  {
    name: 'variables',
    description: 'Pon al día las variables de entorno de este repo (local y prod) sin ver valores.',
    arguments: [{ name: 'proyecto', description: 'Clave del proyecto en zeus (si no, la deduces del repo).', required: false }],
    render: (a) =>
      `Revisa las variables de entorno${a.proyecto ? ` del proyecto ${a.proyecto}` : ' de este repo'}: corre \`zeus env status\` y ` +
      'dime, por archivo (.env, .env.production…), qué falta, qué está desactualizado y qué cambié yo localmente sin subir. ' +
      'Propón los comandos (pull o push) y córrelos solo cuando te diga. Nunca muestres valores.',
  },
];
