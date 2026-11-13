// "Quién está en qué": matriz personas × proyectos. Filas = personas, columnas = proyectos donde hay
// al menos una persona; un punto relleno = pertenece. Elegir una columna responde "¿a quién le pido
// acceso a X?" en la franja de abajo. Todo sale de `ZeusOrgMember.projects` (claves de proyecto); el
// nombre legible de cada clave se toma del mapa si ya está cargado.
import { useMemo, useState } from 'react';
import { Crown, Pencil, Search, X } from 'lucide-react';
import { PersonAvatar } from '@/components/avatars';
import { fold } from '@/components/projects/project-ui';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { ZeusOrgMember } from '@/lib/zeus';
import { useZeusProjects } from './hooks';

export const roleLabel = (role: string) => role.replace(/[_-]+/g, ' ').trim() || 'sin rol';

interface Column {
  key: string;
  name: string;
  people: ZeusOrgMember[];
}

export function OrgMatrix({
  members,
  me,
  canEdit,
  onEdit,
  className,
}: {
  members: ZeusOrgMember[];
  me: string | null;
  canEdit: boolean;
  onEdit: (m: ZeusOrgMember) => void;
  className?: string;
}) {
  const projects = useZeusProjects();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [hot, setHot] = useState<string | null>(null);

  const people = useMemo(() => [...members].sort((a, b) => a.name.localeCompare(b.name, 'es')), [members]);
  const allCols = useMemo<Column[]>(() => {
    const names = new Map(projects.filter((p) => p.key).map((p) => [p.key!, p.name]));
    const by = new Map<string, ZeusOrgMember[]>();
    for (const m of people) for (const key of m.projects) by.set(key, [...(by.get(key) ?? []), m]);
    return [...by.entries()]
      .map(([key, list]) => ({ key, name: names.get(key) ?? key, people: list }))
      .sort((a, b) => b.people.length - a.people.length || a.name.localeCompare(b.name, 'es'));
  }, [people, projects]);
  // Proyectos que zeus conoce y donde todavía no hay nadie (solo se sabe con el mapa cargado).
  const empty = useMemo(() => {
    const staffed = new Set(allCols.map((c) => c.key));
    return projects.filter((p) => p.key && !staffed.has(p.key)).length;
  }, [projects, allCols]);

  // El buscador filtra columnas por proyecto y filas por persona; una dimensión sin coincidencias
  // se deja completa (buscar "roz" no debe esconder a la gente, y buscar "Alan" no esconde proyectos).
  const needle = fold(q.trim());
  const colHits = needle ? allCols.filter((c) => fold(`${c.name} ${c.key}`).includes(needle)) : allCols;
  const rowHits = needle ? people.filter((m) => fold(`${m.name} ${roleLabel(m.role)}`).includes(needle)) : people;
  const noMatch = !!needle && colHits.length === 0 && rowHits.length === 0;
  const cols = colHits.length ? colHits : allCols;
  const rows = rowHits.length ? rowHits : people;

  const current = cols.find((c) => c.key === picked) ?? cols[0] ?? null;
  const links = people.reduce((n, m) => n + m.projects.length, 0);

  return (
    <Card className={cn('flex min-h-0 flex-col overflow-hidden', className)}>
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        <div className="grid min-w-0 flex-1 basis-48 gap-0.5">
          <h2 className="truncate text-sm font-semibold tracking-[-0.01em]">Quién está en qué</h2>
          <span className="truncate text-[11.5px] text-muted-foreground">
            {allCols.length} {allCols.length === 1 ? 'proyecto' : 'proyectos'} con gente
            {empty > 0 && <> · {empty} sin nadie</>} · elige una columna
          </span>
        </div>
        <Input
          fieldSize="sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQ('')}
          placeholder="Buscar proyecto o persona…"
          aria-label="Buscar proyecto o persona"
          leading={<Search />}
          trailing={
            q ? (
              <button type="button" onClick={() => setQ('')} aria-label="Limpiar búsqueda" className="grid size-6 place-items-center rounded-sm text-faint hover:text-foreground"><X className="size-3.5" /></button>
            ) : undefined
          }
          wrapperClassName="w-full sm:w-60"
        />
      </header>

      <div className="scroll-thin min-h-0 flex-1 overflow-auto" onPointerLeave={() => setHot(null)}>
        {noMatch ? (
          <p className="grid h-full min-h-40 place-items-center px-4 text-center text-sm text-muted-foreground">Nada coincide con esa búsqueda.</p>
        ) : (
          <div
            role="table"
            aria-label="Personas por proyecto"
            className="grid min-h-full w-full"
            style={{
              minWidth: 164 + cols.length * 32 + 56,
              gridTemplateColumns: `minmax(164px, 232px) repeat(${Math.max(cols.length, 1)}, minmax(32px, 1fr)) 56px`,
              gridTemplateRows: `auto repeat(${rows.length}, minmax(44px, 1fr)) 44px`,
            }}
          >
            {/* Encabezado: una columna por proyecto, con el nombre en vertical. */}
            <div role="row" className="contents">
              <div role="columnheader" className="sticky left-0 z-20 flex items-end border-b bg-card px-4 pb-2.5">
                <span className="label-caps">Personas · {rows.length}</span>
              </div>
              {cols.length === 0 && (
                <div className="flex h-[140px] items-end border-b px-3 pb-2.5 text-[12.5px] text-muted-foreground">Nadie está asignado a un proyecto todavía.</div>
              )}
              {cols.map((c) => {
                const on = current?.key === c.key;
                return (
                  <div key={c.key} role="columnheader" className={cn('border-b transition-colors', on ? 'bg-orange-soft' : hot === c.key && 'bg-panel')}>
                    <button
                      type="button"
                      onClick={() => setPicked(c.key)}
                      onPointerEnter={() => setHot(c.key)}
                      onFocus={() => setHot(c.key)}
                      aria-pressed={on}
                      title={`${c.name} · ${c.people.length} ${c.people.length === 1 ? 'persona' : 'personas'}`}
                      className="flex h-[140px] w-full items-end justify-center pb-2.5 pt-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className={cn('max-h-full rotate-180 truncate text-[12px] [writing-mode:vertical-rl]', on ? 'font-semibold text-orange-ink' : 'font-medium text-muted-foreground')}>{c.name}</span>
                    </button>
                  </div>
                );
              })}
              <div role="columnheader" className="flex items-end justify-end border-b pb-2.5 pr-4"><span className="label-caps">Total</span></div>
            </div>

            {rows.map((m) => {
              const mine = new Set(m.projects);
              const isMe = m.devId === me;
              return (
                <div key={m.devId} role="row" className="group/row contents">
                  <div role="rowheader" className="sticky left-0 z-10 flex min-w-0 items-center gap-2.5 border-b bg-card py-1.5 pl-4 pr-2 transition-colors group-hover/row:bg-sidebar">
                    <PersonAvatar name={m.name} login={m.githubLogin} email={m.email} id={m.devId} presence={m.online ? 'on' : 'off'} className="size-7" />
                    <span className="grid min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className={cn('truncate text-[13px] font-semibold', isMe && 'text-orange-ink')}>{m.name}</span>
                        {m.zeusAdmin && <Crown className="size-3 shrink-0 text-orange" aria-label="Admin de zeus" />}
                      </span>
                      <span className="label-caps truncate text-[9.5px]">{roleLabel(m.role)}{isMe && ' · tú'}</span>
                    </span>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-7 shrink-0 text-faint opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
                        onClick={() => onEdit(m)}
                        aria-label={`Editar a ${m.name}`}
                        title="Cambiar a quién reporta o si administra zeus"
                      >
                        <Pencil className="!size-3.5" />
                      </Button>
                    )}
                  </div>
                  {cols.length === 0 && <div className="border-b" />}
                  {cols.map((c) => {
                    const on = current?.key === c.key;
                    const has = mine.has(c.key);
                    return (
                      <div
                        key={c.key}
                        role="cell"
                        onPointerEnter={() => setHot(c.key)}
                        onClick={() => setPicked(c.key)}
                        aria-label={has ? `${m.name} está en ${c.name}` : undefined}
                        className={cn('grid cursor-pointer place-items-center border-b transition-colors', on ? 'bg-orange-soft/60' : hot === c.key ? 'bg-panel' : 'group-hover/row:bg-sidebar')}
                      >
                        {has ? (
                          <span className={cn('size-3 rounded-full', on ? 'bg-orange' : 'bg-foreground')} />
                        ) : (
                          <span className="size-1 rounded-full bg-toggle-off" />
                        )}
                      </div>
                    );
                  })}
                  <div role="cell" className="flex items-center justify-end border-b pr-4 transition-colors group-hover/row:bg-sidebar">
                    <span className={cn('text-[15px] font-semibold tabular-nums tracking-[-0.02em]', m.projects.length === 0 && 'text-faint')}>{m.projects.length}</span>
                  </div>
                </div>
              );
            })}

            {/* Totales por proyecto. */}
            <div role="row" className="contents">
              <div role="rowheader" className="sticky bottom-0 left-0 z-20 flex items-center bg-sidebar px-4"><span className="label-caps">Personas por proyecto</span></div>
              {cols.length === 0 && <div className="sticky bottom-0 bg-sidebar" />}
              {cols.map((c) => {
                const on = current?.key === c.key;
                return (
                  <div key={c.key} role="cell" className={cn('sticky bottom-0 z-10 grid place-items-center text-[13px] font-semibold tabular-nums', on ? 'bg-orange-soft text-orange-ink' : 'bg-sidebar')}>
                    {c.people.length}
                  </div>
                );
              })}
              <div role="cell" className="sticky bottom-0 z-10 flex items-center justify-end bg-sidebar pr-4 text-[13px] font-semibold tabular-nums text-faint" title="Asignaciones en total">{links}</div>
            </div>
          </div>
        )}
      </div>

      {/* La respuesta: quién está en el proyecto elegido. */}
      <footer className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2.5 border-t px-4 py-3">
        <div className="grid min-w-0 basis-44 gap-0.5">
          <span className="label-caps text-[10px]">Para pedir acceso a</span>
          <span className="truncate text-[15px] font-semibold tracking-[-0.01em]">{current?.name ?? 'un proyecto'}</span>
        </div>
        {current ? (
          <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {current.people.map((m) => (
              <li key={m.devId} className="flex items-center gap-1.5 rounded-full bg-panel py-1 pl-1 pr-2.5">
                <PersonAvatar name={m.name} login={m.githubLogin} email={m.email} id={m.devId} className="size-5" />
                <span className="text-[12.5px] font-medium">{m.name}</span>
                <span className="label-caps text-[9.5px]">{roleLabel(m.role)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">Cuando alguien esté asignado a un proyecto, aquí verás quién lo conoce.</p>
        )}
      </footer>
    </Card>
  );
}
