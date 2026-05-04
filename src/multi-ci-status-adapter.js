export class MultiCiStatusAdapter {
  constructor({ adapters = [] } = {}) {
    this.adapters = adapters.filter(Boolean);
  }

  async getTaskCiStatus(taskId) {
    for (const adapter of this.adapters) {
      if (typeof adapter.getTaskCiStatus !== "function") {
        continue;
      }

      const body = await adapter.getTaskCiStatus(taskId);
      if (body) {
        return body;
      }
    }

    return null;
  }

  async receiveWebhook(payload) {
    for (const adapter of this.adapters) {
      if (typeof adapter.receiveWebhook !== "function") {
        continue;
      }

      const body = await adapter.receiveWebhook(payload);
      if (body?.data?.accepted) {
        return body;
      }
    }

    return {
      data: {
        accepted: true,
        deduplicated: false,
        matchedTasks: []
      },
      availableActions: []
    };
  }
}
