import { createInterface } from 'readline/promises';
import type { Readable, Writable } from 'stream';

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** Everything the setup wizard asks. Real terminal in use; scripted answers in tests; defaults with --yes. */
export interface Prompter {
  select<T extends string>(question: string, choices: Choice<T>[], defaultValue: T): Promise<T>;
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  text(question: string, defaultValue: string, validate?: (value: string) => string | null): Promise<string>;
}

/** A prompter that reads lines from `input` and writes questions to `output`. */
export function readlinePrompter(input: Readable = process.stdin, output: Writable = process.stdout): Prompter {
  const rl = createInterface({ input, output, terminal: false });
  const ask = async (question: string) => (await rl.question(question)).trim();
  const say = (text: string) => output.write(text + '\n');

  return {
    async select(question, choices, defaultValue) {
      const defaultIndex = Math.max(0, choices.findIndex((c) => c.value === defaultValue));
      say(`\n${question}`);
      choices.forEach((c, i) => say(`  ${i + 1}) ${c.label}${c.hint ? `  (${c.hint})` : ''}`));
      for (;;) {
        const answer = await ask(`Choose 1-${choices.length} [default: ${defaultIndex + 1}]: `);
        if (answer === '') return choices[defaultIndex].value;
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;
        say(`Please enter a number from 1 to ${choices.length}.`);
      }
    },

    async confirm(question, defaultValue) {
      for (;;) {
        const answer = (await ask(`${question} ${defaultValue ? '[Y/n]' : '[y/N]'}: `)).toLowerCase();
        if (answer === '') return defaultValue;
        if (['y', 'yes'].includes(answer)) return true;
        if (['n', 'no'].includes(answer)) return false;
        say('Please answer y or n.');
      }
    },

    async text(question, defaultValue, validate) {
      for (;;) {
        const answer = (await ask(`${question} [${defaultValue}]: `)) || defaultValue;
        const problem = validate?.(answer) ?? null;
        if (!problem) return answer;
        say(problem);
      }
    },
  };
}

/** For `--yes` and non-interactive use: accepts every default. */
export function autoPrompter(): Prompter {
  return {
    select: async (_q, _choices, defaultValue) => defaultValue,
    confirm: async (_q, defaultValue) => defaultValue,
    text: async (_q, defaultValue) => defaultValue,
  };
}
