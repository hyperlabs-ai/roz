import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

/**
 * Render seguro de Markdown (GFM: autolinks, tablas, listas de tareas). NO habilita HTML crudo
 * (`rehype-raw`), así que es inmune a XSS aunque el `spec` venga de commits/PRs auto-documentados.
 * El estilo vive en `.markdown-body` (styles.css), theme-aware con los tokens del tema. Los links
 * abren en pestaña nueva. Úsalo con el markdown crudo como children: `<Markdown>{spec}</Markdown>`.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('markdown-body', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ node, ...props }) {
            void node;
            return <a {...props} target="_blank" rel="noreferrer noopener" />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
