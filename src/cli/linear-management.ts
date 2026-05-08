import { readFile } from "node:fs/promises";

import { parseSimpleEnv } from "../env-file.ts";
import {
  operatorEnvPathForHome,
  readSetupConfigFromHome,
  resolveAgentRailHome,
} from "./agentrail-home.ts";
import { withTemporaryLocalServer } from "./local-bootstrap.ts";
import type { SetupConfig } from "./setup-config.ts";

interface Writer {
  write(chunk: string | Uint8Array): boolean;
}

function normalizeBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/`;
}

export async function runLinearCommand(argv: string[], {
  cwd,
  stdout,
  stderr,
}: {
  cwd: string;
  stdout: Writer;
  stderr: Writer;
}): Promise<number> {
  const [subcommand, selector] = argv;
  if (subcommand !== "import") {
    stderr.write("Usage: agentrail linear import <issue-id|issue-url|issue-uuid>\n");
    return 1;
  }
  if (!selector) {
    stderr.write("agentrail linear import requires an issue selector such as ENG-123 or a Linear issue URL.\n");
    return 1;
  }
  const normalizedSelector = normalizeImportSelector(selector);
  if (!normalizedSelector) {
    stderr.write("Linear issue selector must be a valid issue id, issue UUID, or Linear issue URL.\n");
    return 1;
  }

  const homePath = resolveAgentRailHome({ cwd, explicitHome: null });
  const config = await readSetupConfigFromHome(homePath);
  if (!config) {
    stderr.write(`No AgentRail config found in ${homePath}. Run \`agentrail init\` first.\n`);
    return 1;
  }
  if (config.providers?.linear?.mode !== "real") {
    stderr.write("Linear is not connected yet. Run `agentrail provider connect linear`.\n");
    return 1;
  }

  const operatorEnv = await readSimpleEnvFile(operatorEnvPathForHome(homePath));
  const operatorKey = process.env.AGENTRAIL_OPERATOR_KEY ?? operatorEnv.AGENTRAIL_OPERATOR_KEY ?? null;
  if (!operatorKey) {
    stderr.write("Local operator key is missing. Re-run `agentrail init` to restore ~/.agentrail/operator.env.\n");
    return 1;
  }

  try {
    const result = await withTemporaryLocalServer({
      homePath,
      config: config as SetupConfig,
      validateExistingBaseUrl: (baseUrl) => validateExistingImportServer(baseUrl, operatorKey),
      async handler({ baseUrl }) {
        const response = await fetch(new URL("providers/linear/import", normalizeBaseUrl(baseUrl)), {
          method: "POST",
          headers: {
            authorization: `Bearer ${operatorKey}`,
            "content-type": "application/json",
            "idempotency-key": buildImportIdempotencyKey(normalizedSelector),
          },
          body: JSON.stringify({ selector: normalizedSelector }),
          signal: AbortSignal.timeout(120_000),
        });

        const bodyText = await response.text();
        const payload = parseJsonObject(bodyText);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? linearImportErrorMessage(response.status, bodyText));
        }
        return payload;
      },
    });

    const data = isRecord(result.data) ? result.data : null;
    if (
      !data
      || typeof data.identifier !== "string"
      || data.identifier.trim().length === 0
      || typeof data.taskId !== "string"
      || data.taskId.trim().length === 0
    ) {
      throw new Error("Linear import succeeded but the response was missing expected fields.");
    }

    const issueIdentifier = displayLinearIdentifier(data.identifier, normalizedSelector);
    stdout.write(`✓ Imported ${issueIdentifier} from Linear.\n`);
    stdout.write(`Created AgentRail task ${data.taskId}.\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function readSimpleEnvFile(filePath: string): Promise<Record<string, string>> {
  try {
    return parseSimpleEnv(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function buildImportIdempotencyKey(selector: string): string {
  return `linear-import:${selector.trim().toLowerCase()}`;
}

function normalizeImportSelector(selector: string): string | null {
  const trimmed = selector.trim();
  if (!trimmed || /[\r\n]/u.test(trimmed)) {
    return null;
  }
  if (/^[A-Z][A-Z0-9]+-\d+$/iu.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  try {
    const url = new URL(trimmed);
    if ((url.protocol === "https:" || url.protocol === "http:")
      && /(^|\.)linear\.app$/iu.test(url.hostname)) {
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function displayLinearIdentifier(identifier: unknown, fallback: string): string {
  if (typeof identifier === "string") {
    const match = identifier.match(/\/([^/]+)$/u);
    if (match?.[1]) {
      return match[1];
    }
  }
  return fallback.trim();
}

function parseJsonObject(text: string): Record<string, any> {
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function linearImportErrorMessage(status: number, bodyText: string): string {
  const snippet = bodyText.replace(/\s+/gu, " ").trim().slice(0, 240);
  return snippet
    ? `Linear import failed with ${status}: ${snippet}`
    : `Linear import failed with ${status}.`;
}

async function validateExistingImportServer(baseUrl: string, operatorKey: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("tasks?limit=1", normalizeBaseUrl(baseUrl)), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${operatorKey}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}
