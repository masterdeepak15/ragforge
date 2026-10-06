import * as React from 'react';
import * as Primitive from '@radix-ui/react-dropdown-menu';
import { cn } from '../../lib/cn';

/** Non-modal: a row menu should not lock scroll or hide the rest of the page from assistive tech. */
export function DropdownMenu(props: React.ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root modal={false} {...props} />;
}
export const DropdownMenuTrigger = Primitive.Trigger;

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <Primitive.Portal>
    <Primitive.Content
      ref={ref}
      sideOffset={sideOffset}
      align="end"
      className={cn('z-50 min-w-48 rounded-lg border border-border bg-card p-1 text-sm text-foreground shadow-lg', className)}
      {...props}
    />
  </Primitive.Portal>
));
DropdownMenuContent.displayName = 'DropdownMenuContent';

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof Primitive.Item>,
  React.ComponentPropsWithoutRef<typeof Primitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <Primitive.Item
    ref={ref}
    className={cn(
      'flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-2 outline-none data-[highlighted]:bg-muted [&_svg]:size-4 [&_svg]:shrink-0',
      destructive ? 'text-destructive' : 'text-foreground',
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = 'DropdownMenuItem';

export const DropdownMenuSeparator = () => <Primitive.Separator className="my-1 h-px bg-border" />;
