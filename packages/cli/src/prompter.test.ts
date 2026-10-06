import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { autoPrompter, readlinePrompter } from './prompter.js';

function terminal(lines: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (d) => (shown += d));
  // Answer one line each time a question has been printed.
  let next = 0;
  output.on('data', () => {
    if (next < lines.length && /[?:>]\s*$/.test(shown)) {
      const line = lines[next++];
      shown += '\n';
      setImmediate(() => input.write(line + '\n'));
    }
  });
  return { prompter: readlinePrompter(input, output), shown: () => shown };
}

const choices = [
  { value: 'docker', label: 'Run Ollama in Docker', hint: 'recommended' },
  { value: 'external', label: 'I already run Ollama' },
  { value: 'none', label: 'Skip for now' },
] as const;

describe('select', () => {
  it('picks the numbered choice', async () => {
    const { prompter } = terminal(['2']);
    expect(await prompter.select('Where does AI run?', [...choices], 'docker')).toBe('external');
  });

  it('uses the default when the answer is empty, and shows which one it is', async () => {
    const { prompter, shown } = terminal(['']);
    expect(await prompter.select('Where does AI run?', [...choices], 'docker')).toBe('docker');
    expect(shown()).toMatch(/1\) Run Ollama in Docker.*recommended/);
    expect(shown()).toMatch(/default: 1/i);
  });

  it('asks again after an answer that is not a choice', async () => {
    const { prompter, shown } = terminal(['9', 'banana', '3']);
    expect(await prompter.select('Where does AI run?', [...choices], 'docker')).toBe('none');
    expect(shown()).toMatch(/Please enter a number from 1 to 3/);
  });
});

describe('confirm', () => {
  it.each([
    ['y', true],
    ['Yes', true],
    ['n', false],
    ['NO', false],
  ])('reads %s', async (typed, expected) => {
    const { prompter } = terminal([typed]);
    expect(await prompter.confirm('Continue?', !expected)).toBe(expected);
  });

  it('uses the default on an empty answer and asks again on nonsense', async () => {
    expect(await terminal(['']).prompter.confirm('Continue?', true)).toBe(true);
    const { prompter, shown } = terminal(['maybe', 'n']);
    expect(await prompter.confirm('Continue?', true)).toBe(false);
    expect(shown()).toMatch(/y or n/i);
  });
});

describe('text', () => {
  it('returns what was typed, or the default when nothing was', async () => {
    expect(await terminal(['9000']).prompter.text('Port', '8080')).toBe('9000');
    expect(await terminal(['']).prompter.text('Port', '8080')).toBe('8080');
  });

  it('keeps asking until the answer is valid, saying what was wrong', async () => {
    const validate = (v: string) => (/^\d+$/.test(v) ? null : 'Use digits only.');
    const { prompter, shown } = terminal(['abc', '12x', '9000']);
    expect(await prompter.text('Port', '8080', validate)).toBe('9000');
    expect(shown().match(/Use digits only\./g)).toHaveLength(2);
  });
});

describe('autoPrompter (--yes)', () => {
  it('accepts every default without asking', async () => {
    const p = autoPrompter();
    expect(await p.select('q', [...choices], 'external')).toBe('external');
    expect(await p.confirm('q', true)).toBe(true);
    expect(await p.text('q', 'dflt')).toBe('dflt');
  });
});
