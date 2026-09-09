import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp, CircleAlert, Loader2, X } from 'lucide-react';
import { apiGet, apiSend, type SyncItem } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { usePoll } from '@/lib/usePoll';
import { ProgressBar, ThinkingText } from '@/components/bits';
import { isRunning, isSyncDone } from './status';

interface SyncState {
  syncs: SyncItem[];
  /** Fuerza el re-sync de un repo (POST /resync) y arranca el seguimiento en el widget. */
  trigger: (projectId: string, repo: string) => Promise<void>;
  /**
   * Empieza a seguir un backfill que el BACKEND YA encoló — el caso de vincular un repo, donde
   * `POST /projects/:id/repos` encola por su cuenta (`src/routes/dashboard.ts`). No manda nada:
   * solo pinta la fila optimista y enciende el sondeo. Llamar a `trigger` aquí encolaría un SEGUNDO
   * backfill del mismo repo.
   */
  track: (projectId: string, repo: string) => void;
  /** ¿Ese repo está en cola/sincronizando ahora? (para deshabilitar su botón). */
  isActive: (repo: string) => boolean;
}

const Ctx = createContext<SyncState>({ syncs: [], trigger: async () => {}, track: () => {}, isActive: () => false });

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
  // Vía `usePoll` para que PAUSE con la pestaña oculta: con `setInterval` crudo, una pestaña
  // dormida con un backfill en curso seguía pidiendo /sync-status 20 veces por minuto,
  // indefinidamente. `onFocus: 'always'` porque al volver quieres ver la barra al día de inmediato.
  const tick = useCallback(async () => {
    const s = await poll();
    if (s.some(isRunning)) idle.current = 0;
    else if (++idle.current >= 2) setEnabled(false);
  }, [poll]);

  usePoll(tick, enabled ? 3000 : null, { onFocus: 'always' });

  // Al parar, limpia los terminados unos segundos después (deja ver el ✓/error un momento).
  useEffect(() => {
    if (enabled || !syncs.length) return;
    const t = setTimeout(() => setSyncs((prev) => prev.filter(isRunning)), 6000);
    return () => clearTimeout(t);
  }, [enabled, syncs.length]);

  const track = useCallback((projectId: string, repo: string) => {
    // Optimista: muestra "en cola" de inmediato, sin esperar al primer sondeo.
    setSyncs((prev) => [
      ...prev.filter((x) => x.repo !== repo),
      { repo, projectId, status: 'queued', pages: 0, commits: 0, totalPages: null, error: null, updatedAt: null },
    ]);
    idle.current = 0;
    setEnabled(true);
    setMinimized(false);
  }, []);

  const trigger = useCallback(async (projectId: string, repo: string) => {
    // El optimista va ANTES del envío: si fuera después, entre el clic y la respuesta `isActive`
    // seguiría en false y el botón admitiría un segundo clic (dos backfills del mismo repo).
    track(projectId, repo);
    try {
      await apiSend('POST', `/projects/${projectId}/resync`, { repo });
    } catch (e) {
      setSyncs((prev) => prev.filter((x) => x.repo !== repo)); // no se encoló: fuera la fila
      throw e;
    }
  }, [track]);

  const isActive = useCallback((repo: string) => syncs.some((s) => s.repo === repo && isRunning(s)), [syncs]);

  // Memoizado: era un objeto literal, así que durante un backfill (sondeo cada 3 s) le daba a sus
  // consumidores una identidad nueva cada tres segundos.
  const value = useMemo<SyncState>(() => ({ syncs, trigger, track, isActive }), [syncs, trigger, track, isActive]);

  return (
    <Ctx.Provider value={value}>
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

/**
 * Texto de estado del repo.
 *
 * Mientras el backfill corre, el texto lleva shimmer (receta `28-thinking-states`): un backfill de
 * un repo grande tarda minutos y el porcentaje se mueve a saltos de página, así que entre salto y
 * salto la fila se quedaba completamente quieta y parecía colgada. El shimmer es la señal de "sigo
 * trabajando" que no depende de que el número cambie. Al terminar se apaga.
 */
function StatusText({ s }: { s: SyncItem }) {
  if (isSyncDone(s)) return <span className="shrink-0 text-[11px] font-medium text-success">✓ {s.commits} commits</span>;
  if (s.status === 'queued') {
    return <ThinkingText live className="shrink-0 text-[11px] text-muted-foreground">en cola…</ThinkingText>;
  }
  const p = pctOf(s);
  return (
    <ThinkingText live className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
      {s.commits} commits{p != null ? ` · ${p}%` : ` · pág. ${s.pages}`}
    </ThinkingText>
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
                <ProgressBar pct={isSyncDone(s) ? 100 : pctOf(s)} tone={isSyncDone(s) ? 'success' : 'primary'} className="h-1.5" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
