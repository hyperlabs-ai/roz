import { useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthContext';
import { apiSend } from '@/lib/api';
import { cn } from '@/lib/utils';

// Color según ocupación: rojo (saturado) → ámbar → verde (libre).
function tone(v: number): string {
  if (v >= 0.66) return 'text-success';
  if (v >= 0.33) return 'text-warning';
  return 'text-destructive';
}
function barTone(v: number): string {
  if (v >= 0.66) return 'accent-success';
  if (v >= 0.33) return 'accent-warning';
  return 'accent-destructive';
}

/**
 * Disponibilidad editable de un dev (0 saturado .. 1 libre). Afecta al router de roz.
 * Solo admin puede editar; el resto ve el % como lectura. Guarda al soltar el slider.
 */
export function AvailabilityControl({ devId, value, onSaved }: { devId: string; value: number; onSaved?: (v: number) => void }) {
  const { user } = useAuth();
  const isAdmin = ['admin', 'superadmin'].includes(user?.role ?? '');
  const [val, setVal] = useState(Math.round(value * 100)); // 0–100 mientras se arrastra
  const [busy, setBusy] = useState(false);

  async function commit(pct: number) {
    setBusy(true);
    try {
      await apiSend('PATCH', `/developers/${devId}/availability`, { availability: pct / 100 });
      toast.success('Disponibilidad actualizada', { description: `${pct}% — afecta la asignación de roz` });
      onSaved?.(pct / 100);
    } catch (e: any) {
      toast.error('No se pudo guardar', { description: String(e.message ?? e) });
      setVal(Math.round(value * 100)); // revertir
    }
    setBusy(false);
  }

  if (!isAdmin) {
    return (
      <div className="text-right">
        <div className="text-xs text-muted-foreground">Disponibilidad</div>
        <div className={cn('text-lg font-semibold', tone(value))}>{Math.round(value * 100)}%</div>
      </div>
    );
  }

  return (
    <div className="w-44">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs text-muted-foreground">Disponibilidad</span>
        <span className={cn('text-sm font-bold tabular-nums', tone(val / 100))}>{val}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={val}
        disabled={busy}
        onChange={(e) => setVal(Number(e.target.value))}
        onPointerUp={() => commit(val)}
        onKeyUp={(e) => (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && commit(val)}
        className={cn('h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted', barTone(val / 100))}
      />
      <div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
        <span>Saturado</span>
        <span>Libre</span>
      </div>
    </div>
  );
}
