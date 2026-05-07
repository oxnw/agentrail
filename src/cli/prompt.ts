import * as clack from "@clack/prompts";
import { render } from "oh-my-logo";
import type { Readable, Writable } from "node:stream";

export interface PromptChoice {
  label: string;
  value: string;
  hint?: string;
  disabled?: boolean;
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
  multiselect<T>(opts: {
    message: string;
    options: Array<{
      value: T;
      label?: string;
      hint?: string;
      disabled?: boolean;
    }>;
    initialValues?: T[];
    required?: boolean;
    input?: Readable;
    output?: Writable;
  }): Promise<T[] | symbol>;
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

const AGENTRAIL_INTRO = buildAgentRailIntro();

export interface PromptSession {
  select(options: {
    message: string;
    choices: PromptChoice[];
    defaultValue?: string;
  }): Promise<string>;
  multiselect(options: {
    message: string;
    choices: PromptChoice[];
    defaultValues?: string[];
    required?: boolean;
  }): Promise<string[]>;
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
  let introPromise: Promise<void> | null = null;

  async function ensureIntro() {
    if (hasStarted) return;
    if (introPromise) {
      await introPromise;
      return;
    }
    introPromise = (async () => {
      hasStarted = true;
      output.write(await AGENTRAIL_INTRO);
    })();
    await introPromise;
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
      await ensureIntro();
      return unwrapValue(await clackPrompts.select({
        message,
        initialValue: defaultValue,
        options: choices.map((choice) => ({
          value: choice.value,
          label: choice.label,
          hint: choice.hint,
          disabled: choice.disabled,
        })),
        input,
        output,
      }));
    },

    async multiselect({ message, choices, defaultValues = [], required = true }) {
      await ensureIntro();
      return unwrapValue(await clackPrompts.multiselect({
        message,
        initialValues: defaultValues,
        required,
        options: choices.map((choice) => ({
          value: choice.value,
          label: choice.label,
          hint: choice.hint,
          disabled: choice.disabled,
        })),
        input,
        output,
      }));
    },

    async note({ title, body }) {
      await ensureIntro();
      if (typeof clackPrompts.note === "function") {
        clackPrompts.note(body, title, { input, output });
        return;
      }

      output.write(`${title ? `${title}\n` : ""}${body}\n`);
    },

    async message(body) {
      await ensureIntro();
      if (clackPrompts.log?.message) {
        clackPrompts.log.message(body, { symbol: "\u001b[32m|\u001b[0m" });
        return;
      }

      output.write(`${body}\n`);
    },

    async confirm({ message = "Continue?", defaultValue = true } = {}) {
      await ensureIntro();
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
      await ensureIntro();
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

async function buildAgentRailIntro(): Promise<string> {
  try {
    const logo = await render("AGENTRAIL", {
      palette: ["#9be564", "#37d67a", "#00b894"],
      font: "ANSI Shadow",
      direction: "diagonal",
    });
    return [
      logo.trimEnd(),
      "",
      "\u001b[1;38;5;120mLocal Setup\u001b[0m",
      "\u001b[38;5;151mSet up local files, access, and your first agent.\u001b[0m",
      "",
    ].join("\n");
  } catch {
    return [
      "\u001b[1;32mAGENTRAIL\u001b[0m",
      "\u001b[1;38;5;120mLocal Setup\u001b[0m",
      "\u001b[38;5;151mSet up local files, access, and your first agent.\u001b[0m",
      "",
    ].join("\n");
  }
}
