// Builds the publishable package: one JavaScript file (CLI + server) plus the web app.
// Run `npm run build` at the repository root first, so the server and the web app are built.
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');
const serverDir = join(pkgDir, '..', 'server');
const webDist = join(pkgDir, '..', 'web', 'dist');
const out = join(pkgDir, 'dist');

if (!existsSync(join(serverDir, 'dist', 'index.js'))) throw new Error('The server is not built. Run `npm run build` at the repository root first.');
if (!existsSync(join(webDist, 'index.html'))) throw new Error('The web app is not built. Run `npm run build` at the repository root first.');

const serverPkg = JSON.parse(await readFile(join(serverDir, 'package.json'), 'utf8'));
// Everything the server needs from npm stays a normal dependency; only our own code is bundled in.
const external = Object.keys(serverPkg.dependencies).filter((d) => !d.startsWith('@ragforge/'));

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [join(pkgDir, 'src', 'main.ts')],
  outfile: join(out, 'ragforge.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external,
  // Some bundled code uses require(); give it one.
  banner: { js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});

await cp(webDist, join(out, 'web'), { recursive: true });
console.log('Built dist/ragforge.mjs and dist/web');
