// Un entorno de la bóveda como lo ve la persona: el repo y su etapa como chip (api-hyperhub · PROD),
// igual que en Variables. El nombre completo (`api-hyperhub-production`) queda en el tooltip: es el
// que se usa en los comandos del CLI.
import { cn } from '@/lib/utils';
import { StageChip } from './VaultMatrix';
import { envParts } from './vault-groups';

export function EnvName({ name, project, className }: { name: string; project?: string | null; className?: string }) {
  const { repo, stage } = envParts(name);
  if (!stage) return <span className={cn('font-mono font-medium', className)}>{name}</span>;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 align-middle', className)} data-tip={project ? `${project}/${name}` : name}>
      <span className="truncate font-mono font-medium">{repo ?? project ?? name}</span>
      <StageChip stage={stage} />
    </span>
  );
}

/** ¿Es un nombre de entorno con etapa (`<repo>-<etapa>`)? */
export const isEnvName = (s: string): boolean => envParts(s).stage !== null;
