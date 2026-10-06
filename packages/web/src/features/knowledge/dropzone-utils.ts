const SUPPORTED = new Set(['pdf', 'docx', 'txt', 'md', 'markdown']);

export function isSupportedFile(file: File): boolean {
  const dot = file.name.lastIndexOf('.');
  return dot > 0 && SUPPORTED.has(file.name.slice(dot + 1).toLowerCase());
}

export const SUPPORTED_ACCEPT = '.pdf,.docx,.txt,.md,.markdown';

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, fail?: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (entries: FsEntry[]) => void, fail?: (e: unknown) => void) => void };
}

/** Directory readers return entries in batches; keep reading until an empty batch. */
async function readAllEntries(entry: FsEntry): Promise<FsEntry[]> {
  const reader = entry.createReader!();
  const all: FsEntry[] = [];
  for (;;) {
    const batch = await new Promise<FsEntry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

async function walk(entry: FsEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    out.push(await new Promise<File>((ok, fail) => entry.file!(ok, fail)));
  } else if (entry.isDirectory) {
    for (const child of await readAllEntries(entry)) await walk(child, out);
  }
}

export interface Collected {
  files: File[];
  /** Names of files left out because their type is not indexed. Hidden files are never reported. */
  skipped: string[];
}

/** Splits files into supported ones and the names of unsupported ones; dot-files are ignored silently. */
export function partitionFiles(all: File[]): Collected {
  const files: File[] = [];
  const skipped: string[] = [];
  for (const f of all) {
    if (f.name.startsWith('.')) continue;
    if (isSupportedFile(f)) files.push(f);
    else skipped.push(f.name);
  }
  return { files, skipped };
}

/** Reads everything from a drop, descending into dropped folders. */
export async function collectDroppedFiles(dt: DataTransfer): Promise<Collected> {
  const collected: File[] = [];
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = items.map((i) => (i as unknown as { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.() ?? null);

  if (entries.length > 0 && entries.every((e) => e !== null)) {
    for (const entry of entries as FsEntry[]) await walk(entry, collected);
  } else {
    collected.push(...Array.from(dt.files ?? []));
  }
  return partitionFiles(collected);
}
