import { useEffect, useState } from 'react';
import { Code2, Download, FileCode2, FileText, Loader2, Maximize2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Markdown } from '@/components/Markdown';
import { downloadUrl, formatBytes, type ChatAttachment } from '@/lib/chat';
import { cn } from '@/lib/utils';

// Adjuntos .md y .html: se ven renderizados en el chat, no como un archivo genérico.
//
// Seguridad:
//   · Markdown → componente <Markdown> (sin HTML crudo: inmune a XSS).
//   · HTML → <iframe srcdoc sandbox> SIN `allow-same-origin`: el documento corre en un origen
//     opaco, así que sus scripts NO pueden leer la sesión, las cookies ni el storage de roz, ni
//     tocar esta página. Nunca se abre como blob: en una pestaña (eso sí sería del mismo origen).
//     En el visor corre con JavaScript (gráficas, prototipos); la miniatura del chat, sin scripts.

/** Más que esto no se previsualiza (solo descarga): renderizar 20 MB de HTML congela la pestaña. */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

const SANDBOX_VIEWER = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';

// Una sola descarga del texto por URL (la miniatura y el visor comparten).
const textCache = new Map<string, Promise<string>>();

function loadText(url: string): Promise<string> {
  let p = textCache.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });
    p.catch(() => textCache.delete(url));
    textCache.set(url, p);
  }
  return p;
}

function useText(url: string | null, enabled: boolean) {
  const [state, setState] = useState<{ text: string | null; error: boolean }>({ text: null, error: false });
  useEffect(() => {
    if (!url || !enabled) return;
    let alive = true;
    loadText(url).then(
      (text) => alive && setState({ text, error: false }),
      () => alive && setState({ text: null, error: true }),
    );
    return () => {
      alive = false;
    };
  }, [url, enabled]);
  return state;
}

/** Los links del documento abren en pestaña nueva en vez de navegar dentro del marco. */
function withBaseTarget(html: string): string {
  if (/<base\s/i.test(html)) return html;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}<base target="_blank">`) : `<base target="_blank">${html}`;
}

function htmlTitle(html: string | null): string | null {
  const t = html ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() : null;
  return t || null;
}

function DocumentViewer({
  a,
  kind,
  text,
  open,
  onOpenChange,
}: {
  a: ChatAttachment;
  kind: 'markdown' | 'html';
  text: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-w-[min(92vw,1100px)] flex-col gap-0 overflow-hidden p-0">
        <Tabs defaultValue="view" className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b px-4 py-3 pr-12">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-sm">{a.name}</DialogTitle>
              <DialogDescription className="text-xs">
                {kind === 'html' ? 'HTML' : 'Markdown'}
                {a.size ? ` · ${formatBytes(a.size)}` : ''}
              </DialogDescription>
            </div>
            <TabsList className="h-8">
              <TabsTrigger value="view" className="h-6 text-xs">Vista</TabsTrigger>
              <TabsTrigger value="code" className="h-6 text-xs"><Code2 className="mr-1 size-3.5" />Código</TabsTrigger>
            </TabsList>
            {a.url && (
              <a
                href={downloadUrl(a.url, a.name)}
                className="grid size-8 place-items-center rounded-md border hover:bg-accent"
                aria-label="Descargar"
                title="Descargar"
              >
                <Download className="size-4" />
              </a>
            )}
          </div>
          {text === null ? (
            <div className="grid flex-1 place-items-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : (
            <>
              <TabsContent value="view" className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden">
                {kind === 'html' ? (
                  <iframe
                    title={a.name}
                    srcDoc={withBaseTarget(text)}
                    sandbox={SANDBOX_VIEWER}
                    referrerPolicy="no-referrer"
                    className="size-full border-0 bg-white"
                  />
                ) : (
                  <div className="h-full overflow-auto px-6 py-5">
                    <Markdown>{text}</Markdown>
                  </div>
                )}
              </TabsContent>
              <TabsContent value="code" className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden">
                <pre className="h-full overflow-auto bg-muted/40 p-4 font-mono text-xs leading-relaxed">{text}</pre>
              </TabsContent>
            </>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** Tarjeta de un .md / .html con su vista previa renderizada; un clic abre el visor completo. */
export function DocumentAttachment({ a, kind }: { a: ChatAttachment; kind: 'markdown' | 'html' }) {
  const [open, setOpen] = useState(false);
  const previewable = !!a.url && (a.size ?? 0) <= MAX_PREVIEW_BYTES;
  const { text, error } = useText(a.url, previewable);
  const Icon = kind === 'html' ? FileCode2 : FileText;
  const title = kind === 'html' ? htmlTitle(text) : null;

  return (
    <div className="w-full max-w-md overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <Icon className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title ?? a.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {[title ? a.name : null, kind === 'html' ? 'HTML' : 'Markdown', formatBytes(a.size) || null].filter(Boolean).join(' · ')}
          </span>
        </span>
        {previewable ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent"
          >
            <Maximize2 className="size-3.5" /> Ver
          </button>
        ) : (
          a.url && (
            <a href={downloadUrl(a.url, a.name)} className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent">
              <Download className="size-3.5" /> Descargar
            </a>
          )
        )}
      </div>

      {previewable && (
        // div y no <button>: un iframe o párrafos dentro de un botón son HTML inválido.
        <div
          role="button"
          tabIndex={0}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen(true);
            }
          }}
          className="relative block h-40 w-full cursor-pointer overflow-hidden border-t text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label={`Abrir ${a.name}`}
        >
          {error ? (
            <span className="grid size-full place-items-center text-xs text-muted-foreground">No se pudo cargar la vista previa</span>
          ) : text === null ? (
            <span className="grid size-full place-items-center text-muted-foreground"><Loader2 className="size-4 animate-spin" /></span>
          ) : kind === 'html' ? (
            // Miniatura SIN scripts (sandbox vacío) y sin eventos: solo para ver de qué se trata.
            <iframe
              title={`Miniatura de ${a.name}`}
              srcDoc={text}
              sandbox=""
              tabIndex={-1}
              aria-hidden
              className="pointer-events-none h-[300%] w-[300%] origin-top-left scale-[0.3333] border-0 bg-white"
            />
          ) : (
            <div className="px-4 py-3 text-sm">
              <Markdown className="pointer-events-none">{text.slice(0, 1500)}</Markdown>
            </div>
          )}
          {/* Se desvanece hacia abajo: es un extracto. */}
          <span className={cn('pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t to-transparent', kind === 'html' ? 'from-white/90' : 'from-card')} />
        </div>
      )}

      <DocumentViewer a={a} kind={kind} text={text} open={open} onOpenChange={setOpen} />
    </div>
  );
}
