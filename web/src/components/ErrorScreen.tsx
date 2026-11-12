import { Component, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Eyebrow } from '@/components/brand';

/** Convierte cualquier excepción de render en un mensaje visible (en vez de página en blanco). */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error('[roz dashboard] render error:', error);
  }
  render() {
    if (this.state.error) return <ErrorScreen title="Algo falló al renderizar" detail={String(this.state.error?.message ?? this.state.error)} />;
    return this.props.children;
  }
}

export function ErrorScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-5">
      <Card className="w-full max-w-md">
        <CardContent className="p-6">
          <Eyebrow color="red">Error</Eyebrow>
          <div className="mt-3 flex items-center gap-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-red-soft text-red">
              <AlertTriangle className="size-4" />
            </span>
            <span className="title-tight text-lg">{title}</span>
          </div>
          <p className="mt-3 whitespace-pre-wrap rounded-md bg-panel p-3 font-mono text-xs text-muted-foreground">{detail}</p>
        </CardContent>
      </Card>
    </div>
  );
}
