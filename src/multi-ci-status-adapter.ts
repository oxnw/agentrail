export interface CiStatusBody {
  data: {
    taskId?: string;
    overallStatus?: string;
    accepted?: boolean;
    deduplicated?: boolean;
    matchedTasks?: string[];
    [key: string]: unknown;
  };
  availableActions: string[];
  meta?: Record<string, unknown>;
}

export interface CiAdapter {
  getTaskCiStatus?(taskId: string): Promise<CiStatusBody | null>;
  receiveWebhook?(payload: unknown): Promise<CiStatusBody>;
}

export class MultiCiStatusAdapter {
  adapters: CiAdapter[];

  constructor({ adapters = [] }: { adapters?: CiAdapter[] } = {}) {
    this.adapters = adapters.filter(Boolean);
  }

  async getTaskCiStatus(taskId: string): Promise<CiStatusBody | null> {
    for (const adapter of this.adapters) {
      if (typeof adapter.getTaskCiStatus !== "function") continue;
      const body = await adapter.getTaskCiStatus(taskId);
      if (body) return body;
    }
    return null;
  }

  async receiveWebhook(payload: unknown): Promise<CiStatusBody> {
    for (const adapter of this.adapters) {
      if (typeof adapter.receiveWebhook !== "function") continue;
      const body = await adapter.receiveWebhook(payload);
      if (body?.data?.accepted) return body;
    }
    return { data: { accepted: true, deduplicated: false, matchedTasks: [] }, availableActions: [] };
  }
}