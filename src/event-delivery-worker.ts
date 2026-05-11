import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  type AgentRailEvent,
  type AgentRailEventSubscription,
  eventMatchesSubscription,
  signatureForPayload
} from "./event-subscription-store.ts";

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
  getEventsAfter(sequence: number, filters?: unknown): AgentRailEvent[];
  subscribe?(listener: (event: AgentRailEvent) => void): () => void;
}

export interface EventSubscriptionStore {
  listActiveSubscriptions(): AgentRailEventSubscription[];
  deactivateSubscription(subscriptionId: string, reason: string): unknown;
}

export interface AgentRailEventDeliveryWorkerOptions {
  eventStore: TaskEventStore;
  eventSubscriptionStore: EventSubscriptionStore;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  storagePath?: string;
}

export class AgentRailEventDeliveryWorker {
  private eventStore: TaskEventStore;
  private eventSubscriptionStore: EventSubscriptionStore;
  private fetchFn: typeof globalThis.fetch;
  private now: () => Date;
  private storagePath: string | undefined;
  private deliveries: Map<string, DeliveryRecord>;

  constructor({
    eventStore,
    eventSubscriptionStore,
    fetch: fetchImpl = globalThis.fetch,
    now = () => new Date(),
    storagePath
  }: AgentRailEventDeliveryWorkerOptions) {
    this.eventStore = eventStore;
    this.eventSubscriptionStore = eventSubscriptionStore;
    this.fetchFn = fetchImpl;
    this.now = now;
    this.storagePath = storagePath;
    this.deliveries = new Map(loadState(storagePath).deliveries ?? []);
  }

  async processDueDeliveries(): Promise<void> {
    const events = this.eventStore.getEventsAfter(0);
    const subscriptions = this.eventSubscriptionStore.listActiveSubscriptions();
    const currentTime = this.now();
    const disabledSubscriptionIds = new Set<string>();

    for (const event of events) {
      for (const subscription of subscriptions) {
        if (disabledSubscriptionIds.has(subscription.id)) continue;
        if (event.sequence <= subscription.createdAfterSequence) continue;
        if (!eventMatchesSubscription(event, subscription)) continue;
        const deliveryKey = toDeliveryKey(event.id, subscription.id);
        const delivery =
          this.deliveries.get(deliveryKey) ??
          createPendingDelivery(event, subscription, currentTime);

        if (isTerminal(delivery.status)) continue;

        if (delivery.nextAttemptAt !== null && new Date(delivery.nextAttemptAt).getTime() > currentTime.getTime()) {
          continue;
        }

        const status = await this.deliverEvent({ deliveryKey, delivery, event, subscription, currentTime });
        if (status === "disabled") {
          disabledSubscriptionIds.add(subscription.id);
        }
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
    event: AgentRailEvent;
    subscription: AgentRailEventSubscription;
    currentTime: Date;
  }): Promise<DeliveryStatus> {
    const attempt = delivery.attempt + 1;
    const rawBody = JSON.stringify(event);
    const deliveryId = createId("dlv");

    try {
      const response = await this.fetchFn(subscription.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentrail-subscription-id": subscription.id,
          "x-agentrail-event-id": event.id,
          "x-agentrail-event-type": event.type,
          "x-agentrail-delivery-id": deliveryId,
          "x-agentrail-delivery-attempt": String(attempt),
          "x-agentrail-signature": signatureForPayload(subscription.secret, rawBody)
        },
        body: rawBody
      });

      if (response.status >= 200 && response.status < 300) {
        this.setDelivery(deliveryKey, {
          ...delivery,
          attempt,
          status: "delivered",
          nextAttemptAt: null,
          lastDeliveryId: deliveryId,
          lastResponseStatus: response.status,
          updatedAt: currentTime.toISOString()
        });
        return "delivered";
      }

      if (response.status === 410) {
        this.eventSubscriptionStore.deactivateSubscription(subscription.id, "remote_gone");
        this.setDelivery(deliveryKey, {
          ...delivery,
          attempt,
          status: "disabled",
          nextAttemptAt: null,
          lastDeliveryId: deliveryId,
          lastResponseStatus: response.status,
          updatedAt: currentTime.toISOString()
        });
        return "disabled";
      }

      if (response.status >= 500) {
        return this.recordRetryableFailure({
          deliveryKey, delivery, attempt, deliveryId, currentTime,
          responseStatus: response.status
        });
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
      return "failed";
    } catch (error) {
      return this.recordRetryableFailure({
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
  }): DeliveryStatus {
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
      return "exhausted";
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
    return "pending";
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

export interface AgentRailEventDeliveryControllerOptions {
  eventStore: TaskEventStore;
  worker: Pick<AgentRailEventDeliveryWorker, "processDueDeliveries">;
  intervalMs?: number;
}

export class AgentRailEventDeliveryController {
  private eventStore: TaskEventStore;
  private worker: Pick<AgentRailEventDeliveryWorker, "processDueDeliveries">;
  private intervalMs: number;
  private unsubscribe: (() => void) | null = null;
  private interval: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private rerunRequested = false;

  constructor({ eventStore, worker, intervalMs = 10_000 }: AgentRailEventDeliveryControllerOptions) {
    this.eventStore = eventStore;
    this.worker = worker;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.interval) return;
    this.unsubscribe = this.eventStore.subscribe?.(() => {
      this.scheduleRun();
    }) ?? null;
    this.interval = setInterval(() => {
      this.scheduleRun();
    }, this.intervalMs);
    this.scheduleRun();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    await this.inFlight;
  }

  private scheduleRun(): void {
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }

    this.inFlight = this.worker.processDueDeliveries()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.emitWarning(`AgentRail event delivery failed: ${message}`);
      })
      .finally(() => {
        this.inFlight = null;
        if (this.rerunRequested) {
          this.rerunRequested = false;
          this.scheduleRun();
        }
      });
  }
}

function createPendingDelivery(
  event: AgentRailEvent,
  subscription: AgentRailEventSubscription,
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
  try {
    return JSON.parse(readFileSync(storagePath, "utf8")) as LoadedState;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.emitWarning(`Failed to load AgentRail event delivery state at ${storagePath}: ${message}`);
    return {};
  }
}
