import fs from "node:fs";

/**
 * Parses `.env` file content into key/value pairs.
 *
 * Supports comment lines, inline comments outside quoted regions,
 * optional `export ` prefixes, and quoted values that preserve spaces
 * and `#` characters. Escape sequences are preserved literally.
 */
export function parseSimpleEnv(content: string): Record<string, string> {
  const parsed = Object.create(null) as Record<string, string>;
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const rawKey = line.slice(0, separatorIndex).trim();
    const key = rawKey.replace(/^export\s+/u, "").trim();
    const value = stripInlineComment(line.slice(separatorIndex + 1)).trim();
    if (key) {
      parsed[key] = stripQuotes(value);
    }
  }
  return parsed;
}

/**
 * Loads environment variables from a `.env` file without overwriting
 * existing `process.env` values. Missing files are ignored.
 */
export function loadEnvFile(filePath: string): void {
  const content = readFileIfExists(filePath);
  if (!content) return;

  const values = parseSimpleEnv(content);
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") {
      return null;
    }
    throw error;
  }
}

function stripQuotes(value: string): string {
  const trailingBackslashes = (input: string): number => {
    let count = 0;
    for (let index = input.length - 2; index >= 0 && input[index] === "\\"; index -= 1) {
      count += 1;
    }
    return count;
  };
  if (
    value.length >= 2
    && (
      (value.startsWith("\"") && value.endsWith("\"") && trailingBackslashes(value) % 2 === 0)
      || (value.startsWith("'") && value.endsWith("'") && trailingBackslashes(value) % 2 === 0)
    )
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function stripInlineComment(value: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === "\"" && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (char === "#" && !inSingleQuote && !inDoubleQuote) {
      return value.slice(0, index);
    }
  }
  return value;
}
