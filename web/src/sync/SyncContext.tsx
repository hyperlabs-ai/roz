import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp, CircleAlert, Loader2, X } from 'lucide-react';
import { apiGet, apiSend, type SyncItem } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { cn } from '@/lib/utils';

interface SyncState {
  syncs: SyncItem[];
  /** Fuerza el re-sync de un repo y arranca el seguimiento en el widget. */
  trigger: (projectId: string, repo: string) => Promise<void>;
  /** ¿Ese repo está en cola/sincronizando ahora? (para deshabilitar su botón). */
  isActive: (repo: string) => boolean;
}

const Ctx = createContext<SyncState>({ syncs: [], trigger: async () => {}, isActive: () => false });

const isRunning = (s: SyncItem) => s.status === 'queued' || s.status === 'syncing';

/**
 * Estado GLOBAL de las sincronizaciones (backfill). Vive en el root del dashboard, así que el
 * progreso sigue corriendo aunque cambies de pantalla, y se muestra en un widget minimizable abajo
 * a la derecha. Sondea un endpoint LIGERO (/sync-status) solo mientras hay algo activo — nunca
 * recarga las páginas pesadas, para no provocar parpadeo.
 */
export function SyncProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const isAdmin = !!user; // control total para cualquier usuario autenticado (sin roles)
  const [syncs, setSyncs] = useState<SyncItem[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const idle = useRef(0);

  const poll = useCallback(async (): Promise<SyncItem[]> => {
    try {
      const r = await apiGet<{ syncs: SyncItem[] }>('/sync-status');
      setSyncs(r.syncs);
      return r.syncs;
    } catch {
      return [];
    }
  }, []);

  // Al montar: descubre sincronizaciones ya en curso (sobrevive recargas o las lanzó otro admin).
  useEffect(() => {
    if (!isAdmin) return;
    poll().then((s) => {
      if (s.some(isRunning)) {
        idle.current = 0;
        setEnabled(true);
      }
    });
  }, [isAdmin, poll]);

  // Sondeo activo: cada 3s mientras haya algo corriendo; se detiene tras 2 ciclos inactivos.
  useEffect(() => {
    if (!enabled) return;
    const iv = setInterval(async () => {
      const s = await poll();
      if (s.some(isRunning)) idle.current = 0;
      else if (++idle.current >= 2) setEnabled(false);
    }, 3000);
    return () => clearInterval(iv);
  }, [enabled, poll]);

  // Al parar, limpia los terminados unos segundos después (deja ver el ✓/error un momento).
  useEffect(() => {
    if (enabled || !syncs.length) return;
    const t = setTimeout(() => setSyncs((prev) => prev.filter(isRunning)), 6000);
    return () => clearTimeout(t);
  }, [enabled, syncs.length]);

  const trigger = useCallback(async (projectId: string, repo: string) => {
    await apiSend('POST', `/projects/${projectId}/resync`, { repo });
    // Optimista: muestra "en cola" de inmediato, sin esperar al primer sondeo.
    setSyncs((prev) => [
      ...prev.filter((x) => x.repo !== repo),
      { repo, projectId, status: 'queued', pages: 0, commits: 0, totalPages: null, error: null, updatedAt: null },
    ]);
    idle.current = 0;
    setEnabled(true);
    setMinimized(false);
  }, []);

  const isActive = useCallback((repo: string) => syncs.some((s) => s.repo === repo && isRunning(s)), [syncs]);

  return (
    <Ctx.Provider value={{ syncs, trigger, isActive }}>
      {children}
      {isAdmin && syncs.length > 0 && (
        <SyncWidget
          syncs={syncs}
          minimized={minimized}
          onToggle={() => setMinimized((m) => !m)}
          onDismiss={(repo) => setSyncs((p) => p.filter((x) => x.repo !== repo))}
        />
      )}
    </Ctx.Provider>
  );
}

export const useSync = () => useContext(Ctx);

// ---- Widget ----

const short = (repo: string) => repo.replace('hyperlabs-ai/', '');
const pctOf = (s: SyncItem): number | null =>
  s.totalPages ? Math.min(100, Math.round((s.pages / s.totalPages) * 100)) : null;

function ProgressBar({ pct, tone }: { pct: number | null; tone: 'primary' | 'success' }) {
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', tone === 'primary' && 'shimmer')}>
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-500 ease-spring',
          tone === 'success' ? 'bg-success' : 'bg-primary',
          pct == null && 'w-1/3 animate-pulse',
        )}
        style={pct != null ? { width: `${pct}%` } : undefined}
      />
    </div>
  );
}

function StatusText({ s }: { s: SyncItem }) {
  if (s.status === 'done') return <span className="shrink-0 text-[11px] font-medium text-success">✓ {s.commits} commits</span>;
  if (s.status === 'queued') return <span className="shrink-0 text-[11px] text-muted-foreground">en cola…</span>;
  const p = pctOf(s);
  return (
    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
      {s.commits} commits{p != null ? ` · ${p}%` : ` · pág. ${s.pages}`}
    </span>
  );
}

function SyncWidget({
  syncs,
  minimized,
  onToggle,
  onDismiss,
}: {
  syncs: SyncItem[];
  minimized: boolean;
  onToggle: () => void;
  onDismiss: (repo: string) => void;
}) {
  const running = syncs.filter(isRunning).length;
  return (
    <div className="animate-slide-in-up fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border bg-card shadow-lg">
      <button onClick={onToggle} className="flex w-full items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm font-medium transition-colors hover:bg-muted/70">
        {running > 0 ? <Loader2 className="size-4 shrink-0 animate-spin text-primary" /> : <Check className="size-4 shrink-0 text-success" />}
        <span className="flex-1 text-left">
          {running > 0 ? `Sincronizando ${running} repo${running > 1 ? 's' : ''}` : 'Sincronización completa'}
        </span>
        {minimized ? <ChevronUp className="size-4 shrink-0" /> : <ChevronDown className="size-4 shrink-0" />}
      </button>
      {!minimized && (
        <div className="max-h-72 divide-y overflow-y-auto">
          {syncs.map((s) => (
            <div key={s.repo} className="px-3 py-2.5">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={s.repo}>{short(s.repo)}</span>
                {s.status === 'error' ? <CircleAlert className="size-3.5 shrink-0 text-destructive" /> : <StatusText s={s} />}
                {!isRunning(s) && (
                  <button onClick={() => onDismiss(s.repo)} className="shrink-0 text-muted-foreground hover:text-foreground" title="Quitar">
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
              {s.status === 'error' ? (
                <p className="text-[11px] leading-snug text-destructive">{s.error ?? 'Error al sincronizar'}</p>
              ) : (
                <ProgressBar pct={s.status === 'done' ? 100 : pctOf(s)} tone={s.status === 'done' ? 'success' : 'primary'} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
