import { useEffect, useRef, useState } from 'react';
import { toast } from '@/lib/toast';
import { useAuth } from '@/auth/AuthContext';
import { apiSend } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Slider } from '@/components/ui/slider';

// Color según ocupación: rojo (saturado) → ámbar → verde (libre).
function tone(v: number): string {
  if (v >= 0.66) return 'text-success';
  if (v >= 0.33) return 'text-warning';
  return 'text-destructive';
}

/**
 * Disponibilidad editable de un dev (0 saturado .. 1 libre). Afecta al router de roz.
 * Cualquier usuario autenticado puede editar. Guarda al soltar el slider.
 */
export function AvailabilityControl({ devId, value, onSaved }: { devId: string; value: number; onSaved?: (v: number) => void }) {
  const { user } = useAuth();
  const isAdmin = !!user; // control total para cualquier usuario autenticado (sin roles)
  const [val, setVal] = useState(Math.round(value * 100)); // 0–100 mientras se arrastra
  const [busy, setBusy] = useState(false);
  /** Último valor confirmado por el servidor: evita PATCHear un valor que no cambió. */
  const saved = useRef(Math.round(value * 100));

  // Resincronización con la prop. Sin esto, el slider guardaba su primer valor PARA SIEMPRE: si la
  // disponibilidad cambiaba por otra vía (el selector del diálogo de credenciales, otra persona, un
  // refetch del perfil), el slider seguía mostrando el valor viejo y se contradecía con el resto de
  // la pantalla.
  useEffect(() => {
    const next = Math.round(value * 100);
    saved.current = next;
    setVal(next);
  }, [value]);

  async function commit(pct: number) {
    // Un clic sin arrastrar disparaba PATCH + toast igual. Ahora solo se guarda lo que cambió.
    if (pct === saved.current) return;
    setBusy(true);
    try {
      await apiSend('PATCH', `/developers/${devId}/availability`, { availability: pct / 100 });
      saved.current = pct;
      toast.success('Disponibilidad actualizada', { description: `${pct}% — afecta la asignación de roz` });
      onSaved?.(pct / 100);
    } catch (e: any) {
      toast.error('No se pudo guardar', { description: String(e.message ?? e) });
      setVal(saved.current); // revertir a lo último confirmado
    }
    setBusy(false);
  }

  if (!isAdmin) {
    return (
      <div className="text-right">
        <div className="label-caps">Disponibilidad</div>
        <div className={cn('text-lg font-semibold', tone(value))}>{Math.round(value * 100)}%</div>
      </div>
    );
  }

  return (
    <div className="w-full sm:w-44">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="label-caps">Disponibilidad</span>
        <span className={cn('text-sm font-semibold tabular-nums', tone(val / 100))}>{val}%</span>
      </div>
      <Slider
        value={val}
        step={5}
        disabled={busy}
        aria-label="Disponibilidad"
        tone={tone(val / 100)}
        onValueChange={setVal}
        onValueCommit={(v) => { void commit(v); }}
      />
      <div className="mt-0.5 flex justify-between label-caps text-faint">
        <span>Saturado</span>
        <span>Libre</span>
      </div>
    </div>
  );
}
