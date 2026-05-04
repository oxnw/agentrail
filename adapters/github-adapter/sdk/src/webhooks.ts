import { createHmac } from "crypto";
import { WebhookPayload, WebhookEvent } from "./types";

export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string,
  secret: string
): boolean {
  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  const prefixed = `sha256=${expected}`;

  if (signature.length !== prefixed.length) return false;

  let mismatch = 0;
  for (let i = 0; i < prefixed.length; i++) {
    mismatch |= prefixed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

export function parseWebhookPayload(body: string): WebhookPayload {
  return JSON.parse(body) as WebhookPayload;
}

export type WebhookHandler = (payload: WebhookPayload) => void | Promise<void>;

export class WebhookRouter {
  private handlers = new Map<WebhookEvent | "*", WebhookHandler[]>();

  on(event: WebhookEvent | "*", handler: WebhookHandler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  async handle(payload: WebhookPayload): Promise<void> {
    const specific = this.handlers.get(payload.event) ?? [];
    const wildcard = this.handlers.get("*") ?? [];
    for (const handler of [...specific, ...wildcard]) {
      await handler(payload);
    }
  }
}
