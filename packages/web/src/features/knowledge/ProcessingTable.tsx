import { X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Progress } from '../../components/ui/progress';
import { Status } from '../../components/ui/status';
import { Table, TBody, TD, TH, THead, TR } from '../../components/ui/table';
import { formatBytes, formatCount } from '../../lib/format';
import type { UploadItem } from '../../lib/upload';
import type { IngestionJob } from './types';

const STAGE_LABEL: Record<string, string> = {
  loading: 'Reading',
  chunking: 'Splitting',
  embedding: 'Embedding',
  storing: 'Saving',
};

export interface ProcessingTableProps {
  uploads: UploadItem[];
  jobs: IngestionJob[];
  onRetry: (jobId: string) => void;
  onCancelJob: (jobId: string) => void;
  onCancelUploads: () => void;
  onClearUploads: () => void;
}

function FileCell({ name, children }: { name: string; children?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="truncate font-medium">{name}</p>
      {children}
    </div>
  );
}

/** Everything still in flight: files being uploaded and documents being processed or failed. */
export function ProcessingTable({ uploads, jobs, onRetry, onCancelJob, onCancelUploads, onClearUploads }: ProcessingTableProps) {
  const visibleUploads = uploads.filter((u) => u.status !== 'done');
  const visibleJobs = jobs.filter((j) => j.status === 'queued' || j.status === 'running' || j.status === 'failed');
  if (visibleUploads.length === 0 && visibleJobs.length === 0) return null;

  const active = visibleUploads.filter((u) => u.status === 'uploading').length + visibleJobs.filter((j) => j.status === 'running').length;
  const queued = visibleUploads.filter((u) => u.status === 'queued').length + visibleJobs.filter((j) => j.status === 'queued').length;
  const uploading = visibleUploads.some((u) => u.status === 'uploading' || u.status === 'queued');
  const finishedUploads = visibleUploads.some((u) => u.status === 'error' || u.status === 'cancelled' || u.status === 'duplicate');

  return (
    <section aria-labelledby="processing-heading" className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="processing-heading" className="text-sm font-semibold">Processing</h2>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>{active} active · {queued} queued</span>
          {uploading && <Button variant="ghost" size="sm" onClick={onCancelUploads}>Cancel uploads</Button>}
          {finishedUploads && <Button variant="ghost" size="sm" onClick={onClearUploads} aria-label="Clear finished uploads">Clear</Button>}
        </div>
      </div>

      <Table>
        <THead>
          <TR>
            <TH>File</TH>
            <TH>Stage</TH>
            <TH className="hidden sm:table-cell">Chunks</TH>
            <TH className="w-24" />
          </TR>
        </THead>
        <TBody>
          {visibleUploads.map((u) => {
            const pct = u.size > 0 ? Math.round((u.loaded / u.size) * 100) : 0;
            return (
              <TR key={u.id}>
                <TD>
                  <FileCell name={u.name}>
                    {u.status === 'uploading' && <Progress value={pct} label={`Uploading ${u.name}`} className="mt-1.5 max-w-xs" />}
                    {u.status === 'error' && <p className="mt-0.5 text-[13px] text-destructive">{u.error}</p>}
                    {u.status === 'duplicate' && <p className="mt-0.5 text-[13px] text-muted-foreground">Already in this knowledge base</p>}
                  </FileCell>
                </TD>
                <TD>
                  {u.status === 'uploading' && <Status kind="processing" label={`Uploading ${pct}%`} />}
                  {u.status === 'queued' && <Status kind="queued" label="Waiting to upload" />}
                  {u.status === 'error' && <Status kind="failed" label="Upload failed" />}
                  {u.status === 'cancelled' && <Status kind="cancelled" />}
                  {u.status === 'duplicate' && <Status kind="ready" label="Duplicate" />}
                </TD>
                <TD className="hidden text-muted-foreground sm:table-cell">{u.status === 'uploading' ? `${formatBytes(u.loaded)} of ${formatBytes(u.size)}` : formatBytes(u.size)}</TD>
                <TD />
              </TR>
            );
          })}

          {visibleJobs.map((j) => {
            const known = j.chunksTotal !== null && j.chunksTotal > 0;
            const pct = known ? Math.min(100, Math.round(((j.chunksDone ?? 0) / j.chunksTotal!) * 100)) : undefined;
            return (
              <TR key={j.id}>
                <TD>
                  <FileCell name={j.title}>
                    {j.status === 'running' && <Progress value={pct} label={`Processing ${j.title}`} className="mt-1.5 max-w-xs" />}
                    {j.status === 'failed' && j.error && <p className="mt-0.5 text-[13px] text-destructive">{j.error}</p>}
                  </FileCell>
                </TD>
                <TD>
                  {j.status === 'running' && <Status kind="processing" label={STAGE_LABEL[j.stage ?? ''] ?? 'Starting'} />}
                  {j.status === 'queued' && <Status kind="queued" />}
                  {j.status === 'failed' && <Status kind="failed" />}
                </TD>
                <TD className="hidden text-muted-foreground sm:table-cell">
                  {j.status === 'running' ? (known ? `${formatCount(j.chunksDone ?? 0)} / ${formatCount(j.chunksTotal!)}` : 'estimating…') : '—'}
                </TD>
                <TD className="text-right">
                  {j.status === 'failed' ? (
                    <Button variant="link" size="sm" aria-label={`Retry ${j.title}`} onClick={() => onRetry(j.id)}>Retry</Button>
                  ) : (
                    <Button variant="ghost" size="icon" aria-label={`Cancel ${j.title}`} onClick={() => onCancelJob(j.id)}>
                      <X />
                    </Button>
                  )}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </section>
  );
}
