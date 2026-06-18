import { Toaster as Sonner } from 'sonner';
import { useTheme } from '@/components/theme';

export function Toaster() {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: 'group rounded-lg border bg-popover text-popover-foreground shadow-md',
          description: 'text-muted-foreground',
        },
      }}
    />
  );
}
