// Runs before `npm publish` (see "prepublishOnly"). Stops a publish that would ship a package with nothing in it,
// or one whose built program is older than package.json (a forgotten rebuild after a version bump or a fix).
// Usage: node scripts/prepublish-check.mjs [package folder]   (default: this package)
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join('dist', 'ragforge.mjs');
const required = [bundle, join('dist', 'web', 'index.html')];
const missing = required.filter((f) => !existsSync(join(dir, f)));

if (missing.length > 0) {
  console.error(`Not publishing: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing, so the package would not work.`);
  console.error('Build it first, from the repository root:  npm run package');
  process.exit(1);
}

// The server inside the bundle carries the version it was built with.
const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const built = readFileSync(join(dir, bundle), 'utf8');
if (!built.includes(`"${version}"`) && !built.includes(`'${version}'`)) {
  console.error(`Not publishing: ${bundle} was built before version ${version}, so it would ship old code.`);
  console.error('Rebuild it from the repository root:  npm run package');
  process.exit(1);
}
