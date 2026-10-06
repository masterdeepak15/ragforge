import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UploadDropzone } from './UploadDropzone';
import { collectDroppedFiles, isSupportedFile } from './dropzone-utils';

const file = (name: string) => new File(['x'], name, { type: 'application/octet-stream' });

/** Minimal FileSystemEntry fakes (the browser API used for folder drops). */
function fileEntry(f: File) {
  return { isFile: true, isDirectory: false, name: f.name, file: (ok: (f: File) => void) => ok(f) };
}
function dirEntry(name: string, children: unknown[], batch = 2) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let i = 0;
      return {
        readEntries(ok: (e: unknown[]) => void) {
          const slice = children.slice(i, i + batch);
          i += batch;
          ok(slice);
        },
      };
    },
  };
}
const asItem = (entry: unknown) => ({ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => null });

describe('isSupportedFile', () => {
  it.each(['a.pdf', 'A.PDF', 'notes.md', 'doc.markdown', 'plain.txt', 'report.docx'])('accepts %s', (n) => expect(isSupportedFile(file(n))).toBe(true));
  it.each(['photo.png', 'archive.zip', 'sheet.xlsx', 'noextension', 'old.doc'])('rejects %s', (n) => expect(isSupportedFile(file(n))).toBe(false));
});

describe('collectDroppedFiles', () => {
  it('reads plain dropped files', async () => {
    const dt = { files: [file('a.txt'), file('b.pdf')], items: undefined } as unknown as DataTransfer;
    const { files, skipped } = await collectDroppedFiles(dt);
    expect(files.map((f) => f.name)).toEqual(['a.txt', 'b.pdf']);
    expect(skipped).toEqual([]);
  });

  it('walks folders recursively, including entries delivered in several batches', async () => {
    const tree = dirEntry('docs', [
      fileEntry(file('one.md')),
      fileEntry(file('two.pdf')),
      dirEntry('sub', [fileEntry(file('three.txt')), dirEntry('deep', [fileEntry(file('four.docx'))])]),
      fileEntry(file('five.md')),
    ]);
    const dt = { items: [asItem(tree)], files: [] } as unknown as DataTransfer;
    const { files } = await collectDroppedFiles(dt);
    expect(files.map((f) => f.name).sort()).toEqual(['five.md', 'four.docx', 'one.md', 'three.txt', 'two.pdf']);
  });

  it('skips unsupported files and ignores hidden ones silently', async () => {
    const dt = { files: [file('a.txt'), file('pic.png'), file('.DS_Store'), file('data.zip')], items: undefined } as unknown as DataTransfer;
    const { files, skipped } = await collectDroppedFiles(dt);
    expect(files.map((f) => f.name)).toEqual(['a.txt']);
    expect(skipped).toEqual(['pic.png', 'data.zip']);
  });

  it('handles an empty drop', async () => {
    expect(await collectDroppedFiles({ files: [], items: [] } as unknown as DataTransfer)).toEqual({ files: [], skipped: [] });
  });
});

describe('UploadDropzone', () => {
  it('explains what can be dropped and that there is no limit', () => {
    render(<UploadDropzone onFiles={() => {}} />);
    expect(screen.getByText(/drop files or whole folders here/i)).toBeInTheDocument();
    expect(screen.getByText(/no size or count limit/i)).toBeInTheDocument();
  });

  it('passes dropped files to onFiles', async () => {
    const onFiles = vi.fn();
    render(<UploadDropzone onFiles={onFiles} />);
    const zone = screen.getByTestId('dropzone');
    fireEvent.drop(zone, { dataTransfer: { files: [file('a.txt'), file('b.md')], items: undefined } });
    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
    expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(['a.txt', 'b.md']);
  });

  it('accepts a dropped folder', async () => {
    const onFiles = vi.fn();
    render(<UploadDropzone onFiles={onFiles} />);
    const tree = dirEntry('handbook', [fileEntry(file('x.md')), dirEntry('inner', [fileEntry(file('y.pdf'))])]);
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { items: [asItem(tree)], files: [] } });
    await waitFor(() => expect(onFiles).toHaveBeenCalled());
    expect(onFiles.mock.calls[0][0].map((f: File) => f.name).sort()).toEqual(['x.md', 'y.pdf']);
  });

  it('tells the user which files were skipped and why', async () => {
    const onFiles = vi.fn();
    render(<UploadDropzone onFiles={onFiles} />);
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [file('a.txt'), file('x.png'), file('y.zip')], items: undefined } });
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('Skipped 2 unsupported files');
    expect(notice).toHaveTextContent('PDF, Word, Markdown and text');
    expect(onFiles.mock.calls[0][0]).toHaveLength(1);
  });

  it('does not call onFiles when nothing supported was dropped', async () => {
    const onFiles = vi.fn();
    render(<UploadDropzone onFiles={onFiles} />);
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [file('x.png')], items: undefined } });
    await screen.findByRole('status');
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('picks files and folders with the buttons', async () => {
    const onFiles = vi.fn();
    render(<UploadDropzone onFiles={onFiles} />);
    expect(screen.getByLabelText('Choose folder')).toHaveAttribute('webkitdirectory');
    await userEvent.upload(screen.getByLabelText('Choose files'), [file('a.pdf'), file('b.txt')]);
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(['a.pdf', 'b.txt']);
  });

  it('shows a drag-over state', () => {
    render(<UploadDropzone onFiles={() => {}} />);
    const zone = screen.getByTestId('dropzone');
    fireEvent.dragEnter(zone, { dataTransfer: { types: ['Files'] } });
    expect(zone).toHaveAttribute('data-dragging', 'true');
    fireEvent.dragLeave(zone);
    expect(zone).toHaveAttribute('data-dragging', 'false');
  });
});
