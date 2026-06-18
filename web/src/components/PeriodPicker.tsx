import { useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { CalendarDays, Check, ChevronDown, GitCompare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  type PeriodState, type PresetId, type CompareId,
  PRESETS, COMPARES, presetRange, customRange, rangeLabel, compareLabel,
} from '@/lib/period';

export function PeriodPicker({ value, onChange }: { value: PeriodState; onChange: (s: PeriodState) => void }) {
  const [open, setOpen] = useState(false);
  const [draftRange, setDraftRange] = useState<DateRange | undefined>(
    value.preset === 'custom' ? { from: new Date(value.range.from), to: new Date(new Date(value.range.to).getTime() - 86400000) } : undefined,
  );

  const pickPreset = (id: PresetId) => {
    if (id === 'custom') return;
    onChange({ ...value, preset: id, range: presetRange(id) });
  };

  const applyCustom = () => {
    if (draftRange?.from && draftRange?.to) {
      onChange({ ...value, preset: 'custom', range: customRange(draftRange.from, draftRange.to) });
      setOpen(false);
    }
  };

  const setCompare = (c: CompareId) => onChange({ ...value, compare: c });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-9 gap-2">
          <CalendarDays className="text-muted-foreground" />
          <span className="font-medium">{rangeLabel(value)}</span>
          {value.compare !== 'none' && (
            <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
              <GitCompare className="size-3" /> {compareLabel(value.compare).replace('vs. ', '')}
            </span>
          )}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        <div className="flex flex-col sm:flex-row">
          {/* Presets + comparación */}
          <div className="flex w-full flex-col gap-0.5 p-2 sm:w-48">
            <div className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Período</div>
            {PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => pickPreset(p.id)}
                className={cn(
                  'flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent',
                  value.preset === p.id && 'bg-accent font-medium',
                )}
              >
                {p.label}
                {value.preset === p.id && <Check className="size-4 text-primary" />}
              </button>
            ))}
            <Separator className="my-1.5" />
            <div className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Comparar</div>
            {COMPARES.map((c) => (
              <button
                key={c.id}
                onClick={() => setCompare(c.id)}
                className={cn(
                  'flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent',
                  value.compare === c.id && 'bg-accent font-medium',
                )}
              >
                {c.label}
                {value.compare === c.id && <Check className="size-4 text-primary" />}
              </button>
            ))}
          </div>
          <Separator orientation="vertical" className="hidden sm:block" />
          {/* Calendario para rango personalizado */}
          <div className="border-t p-2 sm:border-t-0">
            <Calendar mode="range" numberOfMonths={1} selected={draftRange} onSelect={setDraftRange} defaultMonth={draftRange?.from} />
            <div className="flex items-center justify-between gap-2 px-2 pb-1">
              <span className="text-xs text-muted-foreground">
                {draftRange?.from && draftRange?.to ? 'Aplica el rango elegido' : 'Elige un rango personalizado'}
              </span>
              <Button size="sm" disabled={!draftRange?.from || !draftRange?.to} onClick={applyCustom}>
                Aplicar
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
