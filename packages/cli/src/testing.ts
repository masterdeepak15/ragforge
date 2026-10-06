/** Helpers for tests only. Nothing in the shipped program imports this file. */
import type { Choice, Prompter } from './prompter.js';
import type { RunResult, Shell } from './docker.js';

/** Answers questions by matching their text; anything unmatched gets its default. Remembers every question asked. */
export function scriptedPrompter(rules: Array<[RegExp, string | boolean]> = []) {
  const asked: string[] = [];
  const answer = (question: string): string | boolean | undefined => rules.find(([re]) => re.test(question))?.[1];
  const prompter: Prompter = {
    async select<T extends string>(question: string, choices: Choice<T>[], defaultValue: T) {
      asked.push(question);
      const a = answer(question);
      if (a === undefined) return defaultValue;
      if (!choices.some((c) => c.value === a)) throw new Error(`Test script answered "${a}" to "${question}", which is not a choice`);
      return a as T;
    },
    async confirm(question, defaultValue) {
      asked.push(question);
      const a = answer(question);
      return typeof a === 'boolean' ? a : defaultValue;
    },
    async text(question, defaultValue) {
      asked.push(question);
      const a = answer(question);
      return typeof a === 'string' ? a : defaultValue;
    },
  };
  return { prompter, asked };
}

export type ShellReply = RunResult | ((args: string[]) => RunResult);
export const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
export const fail = (stderr = 'failed', code = 1): RunResult => ({ code, stdout: '', stderr });

/** A shell that answers from a table keyed by "command arg arg" (longest match wins) and records every call. */
export function fakeShell(replies: Record<string, ShellReply>) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const lookup = (cmd: string, args: string[]): RunResult => {
    const key = [cmd, ...args].join(' ');
    const hits = Object.entries(replies).filter(([k]) => key === k || key.startsWith(k + ' '));
    if (hits.length === 0) return fail(`not found: ${cmd}`, 127);
    const reply = hits.sort((a, b) => b[0].length - a[0].length)[0][1];
    return typeof reply === 'function' ? reply(args) : reply;
  };
  const shell: Shell = {
    async run(cmd, args) {
      calls.push({ cmd, args });
      return lookup(cmd, args);
    },
    async runLive(cmd, args) {
      calls.push({ cmd, args });
      return lookup(cmd, args).code;
    },
  };
  return { shell, calls, has: (...words: string[]) => calls.some((c) => words.every((w) => [c.cmd, ...c.args].join(' ').includes(w))) };
}
