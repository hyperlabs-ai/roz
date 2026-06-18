import { Component, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

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
          <div className="mb-3 flex items-center gap-2 text-destructive">
            <AlertTriangle className="size-5" />
            <span className="text-base font-semibold">{title}</span>
          </div>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{detail}</p>
        </CardContent>
      </Card>
    </div>
  );
}
