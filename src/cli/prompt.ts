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
    initialValue?: string;
    placeholder?: string;
    input?: Readable;
    output?: Writable;
  }): Promise<string | symbol>;
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

const AGENTRAIL_INTRO = "\u001b[32mAgentRail\u001b[0m";

export interface PromptSession {
  select(options: {
    message: string;
    choices: PromptChoice[];
    defaultValue?: string;
  }): Promise<string>;
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
        initialValue: defaultValue,
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
