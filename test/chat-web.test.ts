import { describe, it, expect } from 'vitest';
import {
  CHANNEL_TOKEN, chatBadge, continuesGroup, dayLabel, decodeMentions, encodeMentions, mentionQueryAt,
  mentionsMe, mentionsToMarkdown, messageAlerts, taskQueryAt, taskRefsToMarkdown, attachmentKind, galleryLayout,
  tooLargeMessage, downloadUrl,
} from '../web/src/lib/chat-text.js';
import type { ChatConversation, ChatMessage } from '../web/src/lib/chat.js';

// Lado cliente del chat (web/src/lib/chat-text.ts): lo que el compositor convierte antes de enviar
// y lo que decide el badge del nav. Un error aquí no truena: manda el mensaje con la mención rota
// o deja un badge prendido para siempre, que es peor porque nadie lo reporta.

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const devs = [
  { id: A, name: 'Ana' },
  { id: B, name: 'Ana María López' },
];
const nameOf = (id: string) => devs.find((d) => d.id === id)?.name;

describe('encodeMentions / decodeMentions', () => {
  it('el nombre más largo gana: "@Ana María López" no se parte en "@Ana"', () => {
    expect(encodeMentions('hola @Ana María López y @Ana', devs)).toBe(`hola <@${B}> y <@${A}>`);
  });

  it('respeta los límites de palabra y no toca correos', () => {
    expect(encodeMentions('@Anabel no, ana@roz.mx tampoco', devs)).toBe('@Anabel no, ana@roz.mx tampoco');
  });

  it('@canal se vuelve token sin importar mayúsculas', () => {
    expect(encodeMentions('@Canal reunión', devs)).toBe(`${CHANNEL_TOKEN} reunión`);
  });

  it('ida y vuelta: lo que se codifica se puede volver a editar igual', () => {
    const text = 'revisa esto @Ana María López, @canal';
    expect(decodeMentions(encodeMentions(text, devs), nameOf)).toBe(text);
  });

  it('el render convierte tokens en enlaces de mención', () => {
    expect(mentionsToMarkdown(`hola <@${A}> ${CHANNEL_TOKEN}`, nameOf)).toBe(
      `hola [@Ana](#mention-${A}) [@canal](#mention-canal)`,
    );
  });
});

describe('mentionQueryAt', () => {
  it('detecta la mención abierta bajo el cursor', () => {
    expect(mentionQueryAt('hola @An', 8)).toEqual({ start: 5, query: 'An' });
    expect(mentionQueryAt('@Ana M', 6)).toEqual({ start: 0, query: 'Ana M' });
  });

  it('no abre con correos ni después de cerrar la mención', () => {
    expect(mentionQueryAt('ana@roz', 7)).toBeNull();
    expect(mentionQueryAt('@Ana María López ya', 19)).toBeNull();
  });
});

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'm', conversationId: 'c', parentId: null, kind: 'user', authorDevId: A, body: 'x', mentions: [],
  mentionChannel: false, meta: null, clientNonce: null, replyCount: 0, lastReplyAt: null, replyDevIds: [],
  editedAt: null, deletedAt: null, createdAt: '2026-11-03T15:00:00Z', attachments: [], tasks: [], citedTasks: [], ...over,
});

describe('continuesGroup', () => {
  it('mismo autor dentro de 5 minutos se agrupa; más tarde u otro autor, no', () => {
    const first = msg({});
    expect(continuesGroup(first, msg({ createdAt: '2026-11-03T15:04:00Z' }))).toBe(true);
    expect(continuesGroup(first, msg({ createdAt: '2026-11-03T15:06:00Z' }))).toBe(false);
    expect(continuesGroup(first, msg({ authorDevId: B, createdAt: '2026-11-03T15:01:00Z' }))).toBe(false);
  });

  it('un mensaje con hilo cierra el grupo (su resumen de respuestas va debajo)', () => {
    expect(continuesGroup(msg({ replyCount: 2 }), msg({ createdAt: '2026-11-03T15:01:00Z' }))).toBe(false);
  });
});

describe('mentionsMe', () => {
  it('directo o con @canal', () => {
    expect(mentionsMe({ mentions: [A], mentionChannel: false }, A)).toBe(true);
    expect(mentionsMe({ mentions: [], mentionChannel: true }, A)).toBe(true);
    expect(mentionsMe({ mentions: [B], mentionChannel: false }, A)).toBe(false);
  });
});

describe('dayLabel', () => {
  const now = new Date(2026, 10, 3, 18, 0);
  it('Hoy, Ayer y fecha larga', () => {
    expect(dayLabel(new Date(2026, 10, 3, 9).toISOString(), now)).toBe('Hoy');
    expect(dayLabel(new Date(2026, 10, 2, 23).toISOString(), now)).toBe('Ayer');
    expect(dayLabel(new Date(2026, 9, 26, 10).toISOString(), now)).toBe('lunes 26 de octubre');
    expect(dayLabel(new Date(2025, 9, 26, 10).toISOString(), now)).toBe('domingo 26 de octubre de 2025');
  });
});

describe('chatBadge', () => {
  const conv = (over: Partial<ChatConversation>): ChatConversation => ({
    id: 'c', kind: 'channel', name: 'general', topic: null, description: null, isPrivate: false, isDefault: false,
    createdBy: null, lastMessageAt: null, createdAt: '', memberIds: [], ownerIds: [],
    membership: { role: 'member', notifyLevel: 'mentions', lastReadAt: '', hidden: false }, unread: 0, mentions: 0, ...over,
  });

  it('cuenta MDs sin leer y menciones; los canales sin mención solo prenden el punto', () => {
    expect(chatBadge([conv({ kind: 'dm', unread: 2 }), conv({ unread: 5, mentions: 1 })])).toEqual({ count: 3, dot: false });
    expect(chatBadge([conv({ unread: 5 })])).toEqual({ count: 0, dot: true });
  });

  it('un canal silenciado no prende nada; uno que solo veo (sin membresía) tampoco', () => {
    const muted = { role: 'member' as const, notifyLevel: 'none' as const, lastReadAt: '', hidden: false };
    expect(chatBadge([conv({ unread: 5, mentions: 1, membership: muted })])).toEqual({ count: 0, dot: false });
    expect(chatBadge([conv({ kind: 'dm', unread: 3, membership: muted })])).toEqual({ count: 0, dot: false });
    expect(chatBadge([conv({ unread: 5, mentions: 2, membership: null })])).toEqual({ count: 0, dot: false });
  });
});

describe('citas de tareas', () => {
  it('@tarea abre la búsqueda, con o sin consulta, y no se confunde con @tareas ni un correo', () => {
    expect(taskQueryAt('mira @tarea', 11)).toEqual({ start: 5, query: '' });
    expect(taskQueryAt('mira @tarea crix crono', 22)).toEqual({ start: 5, query: 'crix crono' });
    expect(taskQueryAt('@Tarea ROZ', 10)).toEqual({ start: 0, query: 'ROZ' });
    expect(taskQueryAt('@tareas', 7)).toBeNull();
    expect(taskQueryAt('ana@tarea', 9)).toBeNull();
    expect(taskQueryAt('@tarea\nsiguiente', 16)).toBeNull();
  });

  it('nombrar a la persona con @ NO cierra la búsqueda (era el bug: solo se citaban tareas propias)', () => {
    expect(taskQueryAt('@tarea @', 8)).toEqual({ start: 0, query: '@' });
    expect(taskQueryAt('@tarea @Crix sitemap', 20)).toEqual({ start: 0, query: '@Crix sitemap' });
    expect(taskQueryAt('ver @tarea @Ana María login', 27)).toEqual({ start: 4, query: '@Ana María login' });
  });

  it('una consulta demasiado larga ya es el mensaje, no una cita', () => {
    const long = `@tarea ${'x'.repeat(81)}`;
    expect(taskQueryAt(long, long.length)).toBeNull();
  });

  it('solo las citas que existen se vuelven ficha; el resto queda como texto', () => {
    const known = new Map([['ROZ-12', 'uuid-12']]);
    expect(taskRefsToMarkdown('ver #roz-12 y #ROZ-99', known)).toBe('ver [#ROZ-12](#task-uuid-12) y #ROZ-99');
    expect(taskRefsToMarkdown('# ROZ-12 título', known)).toBe('# ROZ-12 título');
  });
});

describe('messageAlerts (cuándo suena un mensaje)', () => {
  const ME = A;
  const conv = (kind: 'dm' | 'channel', notifyLevel: 'all' | 'mentions' | 'none' = 'mentions') => ({
    kind,
    membership: { role: 'member' as const, notifyLevel, lastReadAt: '', hidden: false },
  });
  const msg = (over: Partial<Pick<ChatMessage, 'kind' | 'authorDevId' | 'mentions' | 'mentionChannel' | 'parentId'>> = {}) => ({
    kind: 'user' as const, authorDevId: B, mentions: [] as string[], mentionChannel: false, parentId: null as string | null, ...over,
  });

  it('MD: siempre, también en hilo; lo mío y los mensajes de sistema nunca', () => {
    expect(messageAlerts(conv('dm'), msg(), ME)).toBe(true);
    expect(messageAlerts(conv('dm'), msg({ parentId: 'root' }), ME)).toBe(true);
    expect(messageAlerts(conv('dm'), msg({ authorDevId: ME.toUpperCase() }), ME)).toBe(false);
    expect(messageAlerts(conv('dm'), msg({ kind: 'system' }), ME)).toBe(false);
  });

  it('canal: mención directa o @canal en raíz; en hilo solo la mención directa', () => {
    expect(messageAlerts(conv('channel'), msg(), ME)).toBe(false);
    expect(messageAlerts(conv('channel'), msg({ mentions: [ME] }), ME)).toBe(true);
    expect(messageAlerts(conv('channel'), msg({ mentionChannel: true }), ME)).toBe(true);
    expect(messageAlerts(conv('channel'), msg({ mentionChannel: true, parentId: 'root' }), ME)).toBe(false);
    expect(messageAlerts(conv('channel'), msg({ mentions: [ME], parentId: 'root' }), ME)).toBe(true);
  });

  it("nivel 'all' suena en raíz pero no en hilos ajenos; 'none' y sin membresía nunca", () => {
    expect(messageAlerts(conv('channel', 'all'), msg(), ME)).toBe(true);
    expect(messageAlerts(conv('channel', 'all'), msg({ parentId: 'root' }), ME)).toBe(false);
    expect(messageAlerts(conv('channel', 'none'), msg({ mentions: [ME] }), ME)).toBe(false);
    expect(messageAlerts(conv('dm', 'none'), msg(), ME)).toBe(false);
    expect(messageAlerts({ kind: 'channel', membership: null }, msg({ mentions: [ME] }), ME)).toBe(false);
  });
});

describe('adjuntos: tipo, galería y límite', () => {
  it('clasifica por MIME y, si falta, por extensión; SVG nunca se pinta como imagen', () => {
    expect(attachmentKind({ name: 'foto.jpg', contentType: 'image/jpeg' })).toBe('image');
    expect(attachmentKind({ name: 'IMG_0001.MOV', contentType: 'video/quicktime' })).toBe('video');
    expect(attachmentKind({ name: 'clip.mp4', contentType: null })).toBe('video');
    expect(attachmentKind({ name: 'README.md', contentType: '' })).toBe('markdown');
    expect(attachmentKind({ name: 'reporte.HTML', contentType: null })).toBe('html');
    expect(attachmentKind({ name: 'logo.svg', contentType: 'image/svg+xml' })).toBe('file');
    expect(attachmentKind({ name: 'datos.csv', contentType: 'text/csv' })).toBe('file');
  });

  it('galería estilo WhatsApp: 1, 2, 3 y 4+ con "+N"', () => {
    expect(galleryLayout(1)).toEqual({ shape: 'single', visible: 1, extra: 0 });
    expect(galleryLayout(2)).toEqual({ shape: 'pair', visible: 2, extra: 0 });
    expect(galleryLayout(3)).toEqual({ shape: 'trio', visible: 3, extra: 0 });
    expect(galleryLayout(4)).toEqual({ shape: 'grid', visible: 4, extra: 0 });
    expect(galleryLayout(5)).toEqual({ shape: 'grid', visible: 4, extra: 1 });
  });

  it('el aviso de límite dice cuánto pesa y cuál es el tope', () => {
    expect(tooLargeMessage('video.mov', 34.2 * 1024 * 1024, 20 * 1024 * 1024)).toBe('video.mov pesa 34.2 MB y el límite es 20 MB');
  });

  it('la descarga respeta la query de la URL firmada', () => {
    expect(downloadUrl('https://x.supabase.co/o/a.png?token=t', 'mi foto.png')).toBe('https://x.supabase.co/o/a.png?token=t&download=mi%20foto.png');
  });
});
