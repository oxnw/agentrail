import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  eventMatchesSubscription,
  signatureForPayload
} from "./task-webhook-store.js";

export const DELIVERY_SCHEDULE_SECONDS = [0, 10, 30, 90, 300, 900, 1800, 3600];

export class TaskWebhookDeliveryWorker {
  constructor({
    eventStore,
    webhookStore,
    fetch: fetchImpl = globalThis.fetch,
    now = () => new Date(),
    storagePath
  }) {
    this.eventStore = eventStore;
    this.webhookStore = webhookStore;
    this.fetch = fetchImpl;
    this.now = now;
    this.storagePath = storagePath;
    this.deliveries = new Map(loadState(storagePath).deliveries ?? []);
  }

  async processDueDeliveries() {
    const events = this.eventStore.getEventsAfter(0);
    const subscriptions = this.webhookStore.listActiveSubscriptions();
    const currentTime = this.now();

    for (const event of events) {
      for (const subscription of subscriptions) {
        if (!eventMatchesSubscription(event, subscription)) {
          continue;
        }

        const deliveryKey = toDeliveryKey(event.id, subscription.id);
        const delivery = this.deliveries.get(deliveryKey) ?? createPendingDelivery(event, subscription, currentTime);

        if (isTerminal(delivery.status)) {
          continue;
        }

        if (new Date(delivery.nextAttemptAt).getTime() > currentTime.getTime()) {
          this.setDelivery(deliveryKey, delivery);
          continue;
        }

        await this.deliverEvent({ deliveryKey, delivery, event, subscription, currentTime });
      }
    }
  }

  getDelivery(eventId, subscriptionId) {
    const delivery = this.deliveries.get(toDeliveryKey(eventId, subscriptionId));
    return delivery ? structuredClone(delivery) : null;
  }

  setDelivery(deliveryKey, delivery) {
    this.deliveries.set(deliveryKey, delivery);
    this.persist();
  }

  async deliverEvent({ deliveryKey, delivery, event, subscription, currentTime }) {
    const attempt = delivery.attempt + 1;
    const rawBody = JSON.stringify(event);
    const deliveryId = createId("dlv");

    try {
      const response = await this.fetch(subscription.url, {
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
          deliveryKey,
          delivery,
          attempt,
          deliveryId,
          currentTime,
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
        deliveryKey,
        delivery,
        attempt,
        deliveryId,
        currentTime,
        responseStatus: null,
        lastError: error.message
      });
    }
  }

  recordRetryableFailure({
    deliveryKey,
    delivery,
    attempt,
    deliveryId,
    currentTime,
    responseStatus,
    lastError = null
  }) {
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

  persist() {
    if (!this.storagePath) {
      return;
    }

    mkdirSync(path.dirname(this.storagePath), { recursive: true });
    writeFileSync(
      this.storagePath,
      JSON.stringify(
        {
          deliveries: [...this.deliveries.entries()]
        },
        null,
        2
      ),
      "utf8"
    );
  }
}

function createPendingDelivery(event, subscription, currentTime) {
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

function toDeliveryKey(eventId, subscriptionId) {
  return `${eventId}:${subscriptionId}`;
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function isTerminal(status) {
  return status === "delivered" || status === "disabled" || status === "exhausted" || status === "failed";
}

function loadState(storagePath) {
  if (!storagePath || !existsSync(storagePath)) {
    return {};
  }

  return JSON.parse(readFileSync(storagePath, "utf8"));
}
