import { toast } from '../../components/ui/toaster';

/** Copies text, falling back to a hidden textarea where the async clipboard API is unavailable. */
export async function copyText(text: string, what = 'Copied'): Promise<boolean> {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      ok = document.execCommand('copy');
      area.remove();
    } catch {
      ok = false;
    }
  }
  if (ok) toast.success(what);
  else toast.error('Could not copy. Select the text and copy it manually.');
  return ok;
}
