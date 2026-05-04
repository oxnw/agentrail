import { createHmac, timingSafeEqual } from "node:crypto";
import type { TaskLifecycleEvent, WebhookHeaders } from "./types.js";

export function verifyWebhookSignature(
  rawBody: string | Buffer,
  secret: string,
  signature: string,
): boolean {
  const expected = "sha256=" +
    createHmac("sha256", secret)
      .update(typeof rawBody === "string" ? rawBody : rawBody)
      .digest("hex");

  if (expected.length !== signature.length) return false;

  return timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(signature, "utf8"),
  );
}

export function parseWebhookEvent(
  rawBody: string | Buffer,
  secret: string,
  headers: WebhookHeaders,
): TaskLifecycleEvent {
  if (!verifyWebhookSignature(rawBody, secret, headers["x-agentrail-signature"])) {
    throw new Error("Invalid webhook signature");
  }
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  return JSON.parse(body) as TaskLifecycleEvent;
}
