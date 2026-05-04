import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  type WebhookEvent,
  type WebhookSubscription,
  eventMatchesSubscription,
  signatureForPayload
} from "./task-webhook-store.ts";

export const DELIVERY_SCHEDULE_SECONDS = [0, 10, 30, 90, 300, 900, 1800, 3600] as const;

type DeliveryStatus = "pending" | "delivered" | "disabled" | "failed" | "exhausted";

export interface DeliveryRecord {
  eventId: string;
  subscriptionId: string;
  attempt: number;
  status: DeliveryStatus;
  nextAttemptAt: string | null;
  lastDeliveryId: string | null;
  lastResponseStatus: number | null;
  lastError: string | null;
  updatedAt: string;
}

export interface TaskEventStore {
  getEventsAfter(sequence: number, filters?: unknown): WebhookEvent[];
}

export interface TaskWebhookStore {
  listActiveSubscriptions(): WebhookSubscription[];
  deactivateSubscription(subscriptionId: string, reason: string): unknown;
}

export interface TaskWebhookDeliveryWorkerOptions {
  eventStore: TaskEventStore;
  webhookStore: TaskWebhookStore;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  storagePath?: string;
}

export class TaskWebhookDeliveryWorker {
  private eventStore: TaskEventStore;
  private webhookStore: TaskWebhookStore;
  private fetchFn: typeof globalThis.fetch;
  private now: () => Date;
  private storagePath: string | undefined;
  private deliveries: Map<string, DeliveryRecord>;

  constructor({
    eventStore,
    webhookStore,
    fetch: fetchImpl = globalThis.fetch,
    now = () => new Date(),
    storagePath
  }: TaskWebhookDeliveryWorkerOptions) {
    this.eventStore = eventStore;
    this.webhookStore = webhookStore;
    this.fetchFn = fetchImpl;
    this.now = now;
    this.storagePath = storagePath;
    this.deliveries = new Map(loadState(storagePath).deliveries ?? []);
  }

  async processDueDeliveries(): Promise<void> {
    const events = this.eventStore.getEventsAfter(0);
    const subscriptions = this.webhookStore.listActiveSubscriptions();
    const currentTime = this.now();

    for (const event of events) {
      for (const subscription of subscriptions) {
        if (!eventMatchesSubscription(event, subscription)) continue;
        const deliveryKey = toDeliveryKey(event.id, subscription.id);
        const delivery =
          this.deliveries.get(deliveryKey) ??
          createPendingDelivery(event, subscription, currentTime);

        if (isTerminal(delivery.status)) continue;

        if (delivery.nextAttemptAt !== null && new Date(delivery.nextAttemptAt).getTime() > currentTime.getTime()) {
          this.setDelivery(deliveryKey, delivery);
          continue;
        }

        await this.deliverEvent({ deliveryKey, delivery, event, subscription, currentTime });
      }
    }
  }

  getDelivery(eventId: string, subscriptionId: string): DeliveryRecord | null {
    const delivery = this.deliveries.get(toDeliveryKey(eventId, subscriptionId));
    return delivery ? structuredClone(delivery) : null;
  }

  private setDelivery(deliveryKey: string, delivery: DeliveryRecord): void {
    this.deliveries.set(deliveryKey, delivery);
    this.persist();
  }

  private async deliverEvent({
    deliveryKey,
    delivery,
    event,
    subscription,
    currentTime
  }: {
    deliveryKey: string;
    delivery: DeliveryRecord;
    event: WebhookEvent;
    subscription: WebhookSubscription;
    currentTime: Date;
  }): Promise<void> {
    const attempt = delivery.attempt + 1;
    const rawBody = JSON.stringify(event);
    const deliveryId = createId("dlv");

    try {
      const response = await this.fetchFn(subscription.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentrail-webhook-id": subscription.id,
          "x-agentrail-event-id": event.id,
          "x-agentrail-event-type": event.type,
          "x-agentrail-delivery-id": deliveryId,
          "x-agentrail-delivery-attempt": String(attempt),
          "x-agentrail-signature": signatureForPayload(subscription.secret, rawBody)
        },
        body: rawBody
      });

      if (response.status === 200 || response.status === 202) {
        this.setDelivery(deliveryKey, {
          ...delivery,
          attempt,
          status: "delivered",
          nextAttemptAt: null,
          lastDeliveryId: deliveryId,
          lastResponseStatus: response.status,
          updatedAt: currentTime.toISOString()
        });
        return;
      }

      if (response.status === 410) {
        this.webhookStore.deactivateSubscription(subscription.id, "remote_gone");
        this.setDelivery(deliveryKey, {
          ...delivery,
          attempt,
          status: "disabled",
          nextAttemptAt: null,
          lastDeliveryId: deliveryId,
          lastResponseStatus: response.status,
          updatedAt: currentTime.toISOString()
        });
        return;
      }

      if (response.status >= 500) {
        this.recordRetryableFailure({
          deliveryKey, delivery, attempt, deliveryId, currentTime,
          responseStatus: response.status
        });
        return;
      }

      this.setDelivery(deliveryKey, {
        ...delivery,
        attempt,
        status: "failed",
        nextAttemptAt: null,
        lastDeliveryId: deliveryId,
        lastResponseStatus: response.status,
        updatedAt: currentTime.toISOString()
      });
    } catch (error) {
      this.recordRetryableFailure({
        deliveryKey, delivery, attempt, deliveryId, currentTime,
        responseStatus: null,
        lastError: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private recordRetryableFailure({
    deliveryKey,
    delivery,
    attempt,
    deliveryId,
    currentTime,
    responseStatus,
    lastError = null
  }: {
    deliveryKey: string;
    delivery: DeliveryRecord;
    attempt: number;
    deliveryId: string;
    currentTime: Date;
    responseStatus: number | null;
    lastError?: string | null;
  }): void {
    if (attempt >= DELIVERY_SCHEDULE_SECONDS.length) {
      this.setDelivery(deliveryKey, {
        ...delivery,
        attempt,
        status: "exhausted",
        nextAttemptAt: null,
        lastDeliveryId: deliveryId,
        lastResponseStatus: responseStatus,
        lastError,
        updatedAt: currentTime.toISOString()
      });
      return;
    }
    this.setDelivery(deliveryKey, {
      ...delivery,
      attempt,
      status: "pending",
      nextAttemptAt: new Date(
        currentTime.getTime() + DELIVERY_SCHEDULE_SECONDS[attempt] * 1000
      ).toISOString(),
      lastDeliveryId: deliveryId,
      lastResponseStatus: responseStatus,
      lastError,
      updatedAt: currentTime.toISOString()
    });
  }

  private persist(): void {
    if (!this.storagePath) return;
    mkdirSync(path.dirname(this.storagePath), { recursive: true });
    writeFileSync(
      this.storagePath,
      JSON.stringify({ deliveries: [...this.deliveries.entries()] }, null, 2),
      "utf8"
    );
  }
}

function createPendingDelivery(
  event: WebhookEvent,
  subscription: WebhookSubscription,
  currentTime: Date
): DeliveryRecord {
  return {
    eventId: event.id,
    subscriptionId: subscription.id,
    attempt: 0,
    status: "pending",
    nextAttemptAt: currentTime.toISOString(),
    lastDeliveryId: null,
    lastResponseStatus: null,
    lastError: null,
    updatedAt: currentTime.toISOString()
  };
}

function toDeliveryKey(eventId: string, subscriptionId: string): string {
  return `${eventId}:${subscriptionId}`;
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function isTerminal(status: DeliveryStatus): boolean {
  return status === "delivered" || status === "disabled" || status === "exhausted" || status === "failed";
}

interface LoadedState {
  deliveries?: Array<[string, DeliveryRecord]>;
}

function loadState(storagePath: string | undefined): LoadedState {
  if (!storagePath || !existsSync(storagePath)) return {};
  return JSON.parse(readFileSync(storagePath, "utf8")) as LoadedState;
}
