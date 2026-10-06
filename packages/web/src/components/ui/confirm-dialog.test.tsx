import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './confirm-dialog';

function setup(over: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Delete 3 documents?"
      description="Their chunks are removed from search."
      confirmLabel="Delete documents"
      destructive
      onConfirm={onConfirm}
      {...over}
    />,
  );
  return { onConfirm, onOpenChange };
}

describe('ConfirmDialog', () => {
  it('names the action and explains the consequence', () => {
    setup();
    expect(screen.getByRole('alertdialog', { name: 'Delete 3 documents?' })).toBeInTheDocument();
    expect(screen.getByText('Their chunks are removed from search.')).toBeInTheDocument();
  });

  it('runs onConfirm only when the confirm button is pressed', async () => {
    const { onConfirm } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Delete documents' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels without confirming, via button or Escape', async () => {
    const { onConfirm, onOpenChange } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await userEvent.keyboard('{Escape}');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('disables both buttons while the action is pending', () => {
    setup({ pending: true });
    expect(screen.getByRole('button', { name: /Delete documents/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('renders nothing when closed', () => {
    setup({ open: false });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
