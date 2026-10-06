import { forwardRef, useImperativeHandle, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { FolderUp, Upload } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { SUPPORTED_ACCEPT, collectDroppedFiles, partitionFiles } from './dropzone-utils';

export interface UploadDropzoneHandle {
  /** Opens the file picker (used by the page's "Upload files" button). */
  open(): void;
}

export const UploadDropzone = forwardRef<UploadDropzoneHandle, { onFiles: (files: File[]) => void; disabled?: boolean }>(function UploadDropzone({ onFiles, disabled }, ref) {
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const depth = useRef(0); // dragenter/leave fire for every child element
  const filesInput = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ open: () => filesInput.current?.click() }));

  const accept = (files: File[], skipped: string[]) => {
    setNotice(
      skipped.length > 0
        ? `Skipped ${skipped.length} unsupported ${skipped.length === 1 ? 'file' : 'files'}. Only PDF, Word, Markdown and text are indexed.`
        : null,
    );
    if (files.length > 0) onFiles(files);
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (disabled) return;
    const { files, skipped } = await collectDroppedFiles(e.dataTransfer);
    accept(files, skipped);
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const { files, skipped } = partitionFiles(Array.from(e.target.files ?? []));
    e.target.value = ''; // allow picking the same files again
    accept(files, skipped);
  };

  return (
    <div>
      <div
        data-testid="dropzone"
        data-dragging={dragging}
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current++;
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragging(false);
        }}
        onDrop={onDrop}
        className={cn(
          'flex flex-wrap items-center gap-4 rounded-lg border-[1.5px] border-dashed bg-card px-5 py-4 transition-colors',
          dragging ? 'border-primary bg-accent' : 'border-border',
        )}
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground">
          <Upload className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Drop files or whole folders here</p>
          <p className="text-sm text-muted-foreground">PDF, Word, Markdown and text. No size or count limit; large files resume if the connection drops.</p>
        </div>
        <div className="flex gap-2">
          <label className="inline-flex">
            <Button asChild variant="secondary" disabled={disabled}>
              <span>
                <Upload aria-hidden /> Choose files
              </span>
            </Button>
            <input ref={filesInput} aria-label="Choose files" type="file" multiple accept={SUPPORTED_ACCEPT} onChange={onPick} className="sr-only" disabled={disabled} />
          </label>
          <label className="inline-flex">
            <Button asChild variant="secondary" disabled={disabled}>
              <span>
                <FolderUp aria-hidden /> Choose folder
              </span>
            </Button>
            <input
              aria-label="Choose folder"
              type="file"
              // @ts-expect-error non-standard but widely supported attribute
              webkitdirectory=""
              multiple
              onChange={onPick}
              className="sr-only"
              disabled={disabled}
            />
          </label>
        </div>
      </div>
      {notice && (
        <p role="status" className="mt-2 text-sm text-warning">
          {notice}
        </p>
      )}
    </div>
  );
});
