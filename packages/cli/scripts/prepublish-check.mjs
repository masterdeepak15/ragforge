// Runs before `npm publish` (see "prepublishOnly"). Stops a publish that would ship a package with nothing in it.
// Usage: node scripts/prepublish-check.mjs [package folder]   (default: this package)
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const required = [join('dist', 'ragforge.mjs'), join('dist', 'web', 'index.html')];
const missing = required.filter((f) => !existsSync(join(dir, f)));

if (missing.length > 0) {
  console.error(`Not publishing: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing, so the package would not work.`);
  console.error('Build it first, from the repository root:  npm run package');
  process.exit(1);
}
