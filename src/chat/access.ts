// Quién puede ver y hacer qué en una conversación. Toda ruta del chat pasa por aquí: el dev sale de
// la sesión (requireDashboardAuth), nunca del body.
//
//   · Ver: miembros; y cualquiera en un canal PÚBLICO (para leerlo antes de unirse).
//   · Escribir, invitar, editar el canal: miembros.
//   · Borrar el canal, cambiar su privacidad, sacar a otros: el dueño.
// Una conversación privada ajena responde 404, no 403: no se confirma ni que exista.
import { db } from '../db/supabase.js';
import { AppError, NotFoundError } from '../utils/errors.js';
import { CONVERSATION_COLUMNS, MEMBER_COLUMNS, type ConversationRow, type MemberRow } from './model.js';

export async function loadConversation(id: string): Promise<ConversationRow> {
  const { data, error } = await db().from('chat_conversation').select(CONVERSATION_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('la conversación no existe');
  return data as unknown as ConversationRow;
}

export async function getMembership(conversationId: string, devId: string): Promise<MemberRow | null> {
  const { data, error } = await db()
    .from('chat_member')
    .select(MEMBER_COLUMNS)
    .eq('conversation_id', conversationId)
    .eq('dev_id', devId)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as MemberRow | null) ?? null;
}

export async function listMembers(conversationId: string): Promise<MemberRow[]> {
  const { data, error } = await db().from('chat_member').select(MEMBER_COLUMNS).eq('conversation_id', conversationId);
  if (error) throw error;
  return (data ?? []) as unknown as MemberRow[];
}

export interface Access {
  conv: ConversationRow;
  member: MemberRow | null;
}

/** Puede leer: es miembro, o es un canal público. */
export async function assertCanView(conversationId: string, devId: string): Promise<Access> {
  const conv = await loadConversation(conversationId);
  const member = await getMembership(conversationId, devId);
  if (member) return { conv, member };
  if (conv.kind === 'channel' && !conv.is_private) return { conv, member: null };
  throw new NotFoundError('la conversación no existe');
}

/** Puede escribir: tiene que ser miembro (en un canal público, primero se une). */
export async function assertMember(conversationId: string, devId: string): Promise<Access & { member: MemberRow }> {
  const access = await assertCanView(conversationId, devId);
  if (!access.member) throw new AppError('NOT_MEMBER', 'únete al canal para participar', 403);
  return access as Access & { member: MemberRow };
}

export function assertChannel(conv: ConversationRow): void {
  if (conv.kind !== 'channel') throw new AppError('NOT_A_CHANNEL', 'esta acción solo aplica a canales', 400);
}

export function assertOwner(member: MemberRow | null): void {
  if (member?.role !== 'owner') throw new AppError('FORBIDDEN', 'solo quien administra el canal puede hacer esto', 403);
}
