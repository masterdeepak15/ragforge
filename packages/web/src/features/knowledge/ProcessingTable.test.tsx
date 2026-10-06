import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProcessingTable } from './ProcessingTable';
import type { IngestionJob } from './types';
import type { UploadItem } from '../../lib/upload';

const job = (over: Partial<IngestionJob> = {}): IngestionJob => ({
  id: 'j1', documentId: 'd1', knowledgeBaseId: 'kb1', title: 'Q3-architecture-review.pdf', status: 'running', stage: 'embedding',
  chunksTotal: 664, chunksDone: 412, attempts: 1, error: null, createdAt: '', updatedAt: '', ...over,
});
const upload = (over: Partial<UploadItem> = {}): UploadItem => ({ id: 'u1', name: 'handbook.pdf', size: 1000, status: 'uploading', loaded: 430, ...over });

function setup(props: Partial<React.ComponentProps<typeof ProcessingTable>> = {}) {
  const handlers = { onRetry: vi.fn(), onCancelJob: vi.fn(), onCancelUploads: vi.fn(), onClearUploads: vi.fn() };
  render(<ProcessingTable uploads={[]} jobs={[]} {...handlers} {...props} />);
  return handlers;
}

describe('ProcessingTable', () => {
  it('renders nothing when there is nothing in flight', () => {
    setup();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Processing')).not.toBeInTheDocument();
  });

  it('shows stage, chunk progress and a progress line for a running job', () => {
    setup({ jobs: [job()] });
    const row = screen.getByRole('row', { name: /Q3-architecture-review\.pdf/ });
    expect(within(row).getByText('Embedding')).toBeInTheDocument();
    expect(within(row).getByText('412 / 664')).toBeInTheDocument();
    expect(within(row).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '62');
  });

  it('says "estimating" while the total chunk count is unknown', () => {
    setup({ jobs: [job({ stage: 'chunking', chunksTotal: null, chunksDone: null })] });
    expect(screen.getByText('Splitting')).toBeInTheDocument();
    expect(screen.getByText(/estimating/i)).toBeInTheDocument();
  });

  it('shows queued jobs with a cancel action', async () => {
    const h = setup({ jobs: [job({ status: 'queued', stage: null, chunksDone: null, chunksTotal: null })] });
    expect(screen.getByText('Queued')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel Q3-architecture-review.pdf' }));
    expect(h.onCancelJob).toHaveBeenCalledWith('j1');
  });

  it('explains a failure and offers to retry it', async () => {
    const h = setup({ jobs: [job({ status: 'failed', error: 'No extractable text (the file is empty, or it is a scanned document without a text layer)' })] });
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/scanned document without a text layer/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry Q3-architecture-review.pdf' }));
    expect(h.onRetry).toHaveBeenCalledWith('j1');
  });

  it('shows uploads in progress with percent and bytes sent', () => {
    setup({ uploads: [upload()] });
    const row = screen.getByRole('row', { name: /handbook\.pdf/ });
    expect(within(row).getByText('Uploading 43%')).toBeInTheDocument();
    expect(within(row).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43');
  });

  it('shows upload errors in place and hides finished uploads', () => {
    setup({ uploads: [upload({ id: 'a', name: 'bad.pdf', status: 'error', error: 'Could not reach the server.' }), upload({ id: 'b', name: 'ok.pdf', status: 'done', loaded: 1000 })] });
    expect(screen.getByText('Could not reach the server.')).toBeInTheDocument();
    expect(screen.queryByText('ok.pdf')).not.toBeInTheDocument();
  });

  it('summarises active and queued work and cancels all uploads at once', async () => {
    const h = setup({ jobs: [job(), job({ id: 'j2', status: 'queued', title: 'b.pdf' }), job({ id: 'j3', status: 'queued', title: 'c.pdf' })], uploads: [upload()] });
    expect(screen.getByText(/2 active · 2 queued/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel uploads' }));
    expect(h.onCancelUploads).toHaveBeenCalled();
  });

  it('lets the user dismiss finished and failed uploads', async () => {
    const h = setup({ uploads: [upload({ status: 'cancelled' })] });
    await userEvent.click(screen.getByRole('button', { name: 'Clear finished uploads' }));
    expect(h.onClearUploads).toHaveBeenCalled();
  });
});
