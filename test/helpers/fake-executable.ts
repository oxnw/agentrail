import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";

export async function installFakeExecutableOnPath(
  t: TestContext,
  root: string,
  name: string,
): Promise<string> {
  const binDir = path.join(root, "fake-bin");
  await mkdir(binDir, { recursive: true });
  const executableName = process.platform === "win32" ? `${name}.cmd` : name;
  const executablePath = path.join(binDir, executableName);
  await writeFile(
    executablePath,
    process.platform === "win32" ? "@echo off\r\nexit /B 0\r\n" : "#!/bin/sh\nexit 0\n",
    "utf8",
  );
  await chmod(executablePath, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  return executablePath;
}
