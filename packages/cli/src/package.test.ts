import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (...p: string[]) => JSON.parse(readFileSync(join(__dirname, '..', '..', ...p), 'utf8'));
const cli = read('cli', 'package.json');
const server = read('server', 'package.json');

describe('the published package', () => {
  it('lists every dependency the bundled server needs, so an install from npm can run it', () => {
    const needed = Object.keys(server.dependencies).filter((d) => !d.startsWith('@ragforge/'));
    const missing = needed.filter((d) => !(d in cli.dependencies));
    expect(missing).toEqual([]);
  });

  it('asks for the same versions as the server', () => {
    for (const [name, range] of Object.entries<string>(server.dependencies)) {
      if (name.startsWith('@ragforge/')) continue;
      expect(cli.dependencies[name], name).toBe(range);
    }
  });

  it('does not depend on the other workspace packages, which are not published', () => {
    expect(Object.keys(cli.dependencies).filter((d) => d.startsWith('@ragforge/'))).toEqual([]);
  });

  it('installs a `ragforge` command and ships only what it needs', () => {
    expect(cli.bin).toEqual({ ragforge: './bin/ragforge.mjs' });
    expect(cli.files).toEqual(['bin', 'dist', 'README.md']);
    expect(cli.name).toBe('@masterdeepak15/ragforge');
    expect(cli.engines.node).toBe('>=20');
    expect(cli.private).toBeUndefined(); // it is meant to be published
  });

  it('uses the same version as the server, which reports it', () => {
    expect(cli.version).toBe(server.version);
  });
});
