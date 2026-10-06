import { Toaster as Sonner, toast } from 'sonner';
import { useTheme } from '../../lib/theme';

export { toast };

/** Themed toast host. Mount once near the app root. */
export function Toaster() {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: '!border !border-border !bg-card !text-foreground !shadow-lg',
          description: '!text-muted-foreground',
        },
      }}
    />
  );
}
