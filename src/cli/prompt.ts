import * as clack from "@clack/prompts";
import type { Readable, Writable } from "node:stream";

export interface PromptChoice {
  label: string;
  value: string;
}

export interface ClackPromptsLike {
  intro(title?: string, opts?: { input?: Readable; output?: Writable }): void;
  select<T>(opts: {
    message: string;
    options: Array<{
      value: T;
      label?: string;
      hint?: string;
      disabled?: boolean;
    }>;
    initialValue?: T;
    input?: Readable;
    output?: Writable;
  }): Promise<T | symbol>;
  confirm(opts: {
    message: string;
    initialValue?: boolean;
    active?: string;
    inactive?: string;
    input?: Readable;
    output?: Writable;
  }): Promise<boolean | symbol>;
  text(opts: {
    message: string;
    defaultValue?: string;
    initialValue?: string;
    placeholder?: string;
    input?: Readable;
    output?: Writable;
  }): Promise<string | symbol>;
  log?: {
    message(message: string, options?: { symbol?: string }): void;
  };
  note?(message?: string, title?: string, opts?: { input?: Readable; output?: Writable }): void;
  cancel(message?: string, opts?: { input?: Readable; output?: Writable }): void;
  isCancel(value: unknown): boolean;
}

export class PromptCancelledError extends Error {
  constructor(message = "Setup cancelled.") {
    super(message);
    this.name = "PromptCancelledError";
  }
}

const AGENTRAIL_INTRO = [
  "\u001b[1;32m    ___   _____________  ____________  ___    ______\u001b[0m",
  "\u001b[1;32m   /   | / ____/ ____/ |/ /_  __/ __ \\/   |  /  _/ /\u001b[0m",
  "\u001b[1;32m  / /| |/ / __/ __/  |   / / / / /_/ / /| |  / // / \u001b[0m",
  "\u001b[1;32m / ___ / /_/ / /___ /   | / / / _, _/ ___ |_/ // /___\u001b[0m",
  "\u001b[1;32m/_/  |_\\____/_____//_/|_|/_/ /_/ |_/_/  |_/___/_____/\u001b[0m",
  "\u001b[32mLocal setup wizard\u001b[0m",
].join("\n");

export interface PromptSession {
  select(options: {
    message: string;
    choices: PromptChoice[];
    defaultValue?: string;
  }): Promise<string>;
  note(options: {
    title?: string;
    body: string;
  }): Promise<void>;
  message(body: string): Promise<void>;
  confirm(options?: {
    message?: string;
    defaultValue?: boolean;
  }): Promise<boolean>;
  input(options?: {
    message?: string;
    defaultValue?: string;
  }): Promise<string>;
  close(): Promise<void>;
}

export function createPromptSession({
  input = process.stdin,
  output = process.stdout,
  clack: clackPrompts = clack,
}: {
  input?: Readable;
  output?: Writable;
  clack?: ClackPromptsLike;
} = {}): PromptSession {
  let hasStarted = false;

  function ensureIntro() {
    if (hasStarted) return;
    hasStarted = true;
    clackPrompts.intro(AGENTRAIL_INTRO, { input, output });
  }

  function unwrapValue<T>(value: T | symbol): T {
    if (clackPrompts.isCancel(value)) {
      clackPrompts.cancel("Setup cancelled.", { input, output });
      throw new PromptCancelledError();
    }

    return value as T;
  }

  return {
    async select({ message, choices, defaultValue }) {
      ensureIntro();
      return unwrapValue(await clackPrompts.select({
        message,
        initialValue: defaultValue,
        options: choices.map((choice) => ({
          value: choice.value,
          label: choice.label,
        })),
        input,
        output,
      }));
    },

    async note({ title, body }) {
      ensureIntro();
      if (typeof clackPrompts.note === "function") {
        clackPrompts.note(body, title, { input, output });
        return;
      }

      output.write(`${title ? `${title}\n` : ""}${body}\n`);
    },

    async message(body) {
      ensureIntro();
      if (clackPrompts.log?.message) {
        clackPrompts.log.message(body, { symbol: "\u001b[32m|\u001b[0m" });
        return;
      }

      output.write(`${body}\n`);
    },

    async confirm({ message = "Continue?", defaultValue = true } = {}) {
      ensureIntro();
      return unwrapValue(await clackPrompts.confirm({
        message,
        initialValue: defaultValue,
        active: "Yes",
        inactive: "No",
        input,
        output,
      }));
    },

    async input({ message = "Value", defaultValue = "" } = {}) {
      ensureIntro();
      return unwrapValue(await clackPrompts.text({
        message,
        defaultValue: defaultValue || undefined,
        placeholder: defaultValue || undefined,
        input,
        output,
      }));
    },

    async close() {
      return;
    },
  };
}
