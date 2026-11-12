import type { ReactNode } from 'react';
import { Eyebrow, type BrandColor } from '@/components/brand';
import { cn } from '@/lib/utils';
import { CHAT_BAR } from './ChannelSidebar';

/**
 * Estado vacío / de error del chat (Discord e interno). Va centrado en la columna, SIN la tarjeta
 * gris flotante de antes: ícono enmarcado, eyebrow, título, una línea de contexto y acciones.
 */
export function ChatState({
  icon,
  eyebrow,
  color = 'orange',
  title,
  lede,
  action,
  className,
}: {
  icon: ReactNode;
  eyebrow: string;
  color?: BrandColor;
  title: string;
  lede?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex h-full min-h-0 flex-1 items-center justify-center bg-background p-6', className)}>
      <div className="grid w-full max-w-sm justify-items-center gap-4 text-center">
        <span className="grid size-12 place-items-center rounded-[12px] border bg-card text-foreground shadow-sm [&_svg]:size-5">{icon}</span>
        <div className="grid justify-items-center gap-2">
          <Eyebrow color={color}>{eyebrow}</Eyebrow>
          <h2 className="text-balance text-[20px] font-semibold leading-tight tracking-[-0.03em]">{title}</h2>
          {lede && <p className="text-pretty text-sm text-muted-foreground">{lede}</p>}
        </div>
        {action && <div className="flex flex-wrap justify-center gap-2">{action}</div>}
      </div>
    </div>
  );
}

function Bar({ w, className }: { w: string; className?: string }) {
  return <div className={cn('shimmer h-3 rounded-sm', className)} style={{ width: w }} />;
}

/**
 * Carga del chat con la forma final (barra de canales + canal), para que nada "salte" ni flote
 * mientras llega el estado de Discord. En móvil solo se ve la lista, como en la pantalla real.
 */
export function ChatSkeleton({ label = 'Cargando el chat' }: { label?: string }) {
  return (
    <div className="flex h-full min-h-0 overflow-hidden" role="status" aria-label={label}>
      <aside className="flex h-full w-full shrink-0 flex-col border-r border-chat-sidebar-border bg-chat-sidebar md:w-56 lg:w-64 xl:w-72">
        <div className={cn(CHAT_BAR, 'flex shrink-0 items-center gap-2.5 border-b border-chat-sidebar-border px-3')}>
          <div className="shimmer size-7 shrink-0 rounded-[8px] bg-chat-sidebar-hover" />
          <Bar w="45%" className="h-3.5 bg-chat-sidebar-hover" />
        </div>
        <div className="grid gap-5 px-4 pt-5">
          {[4, 3, 2].map((rows, s) => (
            <div key={s} className="grid gap-2.5">
              <Bar w="5rem" className="h-2.5 bg-chat-sidebar-hover" />
              {Array.from({ length: rows }).map((_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="shimmer size-4 shrink-0 rounded-[4px] bg-chat-sidebar-hover" />
                  <Bar w={`${55 + ((i * 17 + s * 9) % 35)}%`} className="bg-chat-sidebar-hover" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <ChannelSkeleton className="hidden md:flex" />
    </div>
  );
}

/** Carga de la columna del canal: encabezado, mensajes y compositor en su sitio. */
export function ChannelSkeleton({ label, className }: { label?: string; className?: string }) {
  return (
    <section
      className={cn('flex h-full min-w-0 flex-1 flex-col bg-background', className)}
      {...(label ? { role: 'status', 'aria-label': label } : {})}
    >
      <div className={cn(CHAT_BAR, 'flex shrink-0 items-center gap-2 border-b bg-card px-5')}>
        <div className="shimmer size-4 rounded-[4px] bg-panel" />
        <Bar w="7rem" className="h-3.5 bg-panel" />
      </div>
      <div className="flex flex-1 flex-col justify-end gap-5 px-5 py-6">
        {[0.62, 0.4, 0.78, 0.5].map((w, i) => (
          <div key={i} className="flex gap-3">
            <div className="shimmer size-9 shrink-0 rounded-full bg-panel" />
            <div className="grid flex-1 gap-2 pt-0.5">
              <Bar w="6rem" className="bg-panel" />
              <Bar w={`${w * 100}%`} className="bg-panel" />
            </div>
          </div>
        ))}
      </div>
      <div className="shrink-0 px-4 pb-3">
        <div className="h-11 rounded-lg border bg-card" />
      </div>
    </section>
  );
}
