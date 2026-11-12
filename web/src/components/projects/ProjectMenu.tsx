import type { ReactNode } from 'react';
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Acciones de un proyecto (lista y detalle). Eliminar solo aparece en archivados: archivar es el
 * camino normal y reversible; borrar es el último paso, con su propia confirmación.
 */
export function ProjectMenu({
  archived,
  onEdit,
  onArchive,
  onDelete,
  trigger,
  align = 'end',
}: {
  archived: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
  trigger?: ReactNode;
  align?: 'start' | 'end';
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        {trigger ?? (
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Acciones del proyecto">
            <MoreHorizontal className="size-4" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={onEdit}><Pencil className="size-4" /> Editar</DropdownMenuItem>
        <DropdownMenuItem onClick={onArchive}>
          {archived ? <><ArchiveRestore className="size-4" /> Restaurar</> : <><Archive className="size-4" /> Archivar</>}
        </DropdownMenuItem>
        {archived && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}>
              <Trash2 className="size-4" /> Eliminar…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
