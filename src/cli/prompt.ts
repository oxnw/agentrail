import readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface PromptChoice {
  label: string;
  value: string;
}

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
}: {
  input?: Readable;
  output?: Writable;
} = {}): PromptSession {
  const rl = readline.createInterface({ input, output });

  return {
    async select({ message, choices, defaultValue }) {
      output.write(`${message}\n`);
      choices.forEach((choice, index) => {
        output.write(`  ${index + 1}. ${choice.label}\n`);
      });

      const fallbackValue = defaultValue ?? choices[0]?.value;

      while (true) {
        const answer = (await rl.question(
          fallbackValue ? `> [${fallbackValue}] ` : "> ",
        )).trim();

        if (!answer && fallbackValue) {
          return fallbackValue;
        }

        const numeric = Number.parseInt(answer, 10);
        if (Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length) {
          return choices[numeric - 1].value;
        }

        const exact = choices.find((choice) => choice.value === answer);
        if (exact) {
          return exact.value;
        }

        output.write("Enter a valid choice number or value.\n");
      }
    },

    async confirm({ message = "Continue?", defaultValue = true } = {}) {
      const suffix = defaultValue ? "[Y/n]" : "[y/N]";

      while (true) {
        const answer = (await rl.question(`${message} ${suffix} `)).trim().toLowerCase();
        if (!answer) {
          return defaultValue;
        }
        if (["y", "yes"].includes(answer)) {
          return true;
        }
        if (["n", "no"].includes(answer)) {
          return false;
        }

        output.write("Enter y or n.\n");
      }
    },

    async input({ message = "Value", defaultValue = "" } = {}) {
      const answer = (await rl.question(
        defaultValue ? `${message} [${defaultValue}] ` : `${message} `,
      )).trim();

      return answer || defaultValue;
    },

    async close() {
      rl.close();
    },
  };
}
