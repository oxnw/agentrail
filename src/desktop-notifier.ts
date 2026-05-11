import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AwaitingUserNotification {
  runId: string;
  taskId: string;
  taskIdentifier: string;
  reason: string;
  actionRequired: string;
  resumeInstructions: string;
}

export type AwaitingUserNotifier = (notification: AwaitingUserNotification) => Promise<void>;

interface NodeNotifierLike {
  notify(
    options: DesktopNotificationOptions,
    callback?: (error?: Error | null) => void,
  ): void;
}

export interface DesktopNotificationOptions {
  title: string;
  subtitle?: string;
  message: string;
  sound?: boolean | string;
  wait?: boolean;
  timeout?: number;
  icon?: string;
}

const require = createRequire(import.meta.url);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_NOTIFICATIONS_TRUTHY = new Set(["1", "true", "yes", "on"]);
const DESKTOP_NOTIFICATIONS_FALSY = new Set(["0", "false", "no", "off"]);

export function parseDesktopNotificationsEnabled(value: string | null | undefined): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (DESKTOP_NOTIFICATIONS_TRUTHY.has(normalized)) {
    return true;
  }
  if (DESKTOP_NOTIFICATIONS_FALSY.has(normalized)) {
    return false;
  }
  return false;
}

export function createDesktopAwaitingUserNotifier({
  enabled,
}: {
  enabled: boolean;
}): AwaitingUserNotifier | null {
  if (!enabled) {
    return null;
  }

  let notifier: NodeNotifierLike;
  try {
    notifier = require("node-notifier") as NodeNotifierLike;
  } catch (error) {
    process.emitWarning(
      `Desktop notifications are enabled, but node-notifier could not be loaded: ${errorMessage(error)}`,
    );
    return null;
  }

  return (notification) => new Promise<void>((resolve, reject) => {
    try {
      notifier.notify(buildAwaitingUserNotificationOptions(notification), (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

export function buildAwaitingUserNotificationOptions(notification: AwaitingUserNotification): DesktopNotificationOptions {
  return {
    title: "AgentRail blocked: user action needed",
    subtitle: `${notification.taskIdentifier} is awaiting you`,
    message: `Blocked: ${notification.actionRequired}`,
    sound: true,
    wait: false,
    timeout: 10,
    icon: resolveNotificationIconPath(),
  };
}

// Runtime packaging should keep notification artwork under ../assets/ relative
// to this module. PNG/ICO are preferred for broad platform compatibility; SVG is
// retained as the current source-friendly fallback.
function resolveNotificationIconPath(): string | undefined {
  const assetDirs = [
    path.resolve(moduleDir, "../assets"),
    path.resolve(moduleDir, "assets"),
  ];
  const candidateNames = process.platform === "win32"
    ? ["agentrail-notification.ico", "agentrail-notification.png", "agentrail-notification.svg"]
    : ["agentrail-notification.png", "agentrail-notification.svg"];

  for (const assetsDir of assetDirs) {
    for (const candidateName of candidateNames) {
      const iconPath = path.join(assetsDir, candidateName);
      if (existsSync(iconPath)) {
        return iconPath;
      }
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
