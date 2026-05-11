import type { WaitlistEntry } from "./waitlist-store.ts";

const DEFAULT_LOOPS_API_BASE_URL = "https://app.loops.so/api";

type FetchLike = typeof fetch;

export interface LoopsWaitlistSinkOptions {
  apiKey: string;
  mailingListId?: string | null;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}

export interface LoopsTrackResult {
  provider: "loops";
  contactId: string | null;
}

export class LoopsWaitlistTrackingError extends Error {
  code = "waitlist_tracking_failed";
  statusCode = 502;
  provider = "loops";
  responseStatus: number | null;
  responseBody: string | null;

  constructor(message: string, { responseStatus = null, responseBody = null }: { responseStatus?: number | null; responseBody?: string | null } = {}) {
    super(message);
    this.name = "LoopsWaitlistTrackingError";
    this.responseStatus = responseStatus;
    this.responseBody = responseBody;
  }
}

export class LoopsWaitlistSink {
  private apiKey: string;
  private mailingListId: string | null;
  private apiBaseUrl: string;
  private fetchImpl: FetchLike;

  constructor({ apiKey, mailingListId = null, apiBaseUrl = DEFAULT_LOOPS_API_BASE_URL, fetchImpl = fetch }: LoopsWaitlistSinkOptions) {
    const trimmedApiKey = apiKey.trim();
    if (!trimmedApiKey) {
      throw new LoopsWaitlistTrackingError("Loops API key is empty.");
    }
    this.apiKey = trimmedApiKey;
    this.mailingListId = mailingListId?.trim() || null;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/u, "");
    this.fetchImpl = fetchImpl;
  }

  async trackSignup(entry: WaitlistEntry): Promise<LoopsTrackResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL("v1/contacts/update", `${this.apiBaseUrl}/`), {
        method: "PUT",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(this.buildPayload(entry)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LoopsWaitlistTrackingError(`Failed to reach Loops: ${message}`);
    }

    const responseBody = await response.text().catch(() => "");
    if (!response.ok) {
      throw new LoopsWaitlistTrackingError("Loops rejected the waitlist signup.", {
        responseStatus: response.status,
        responseBody,
      });
    }

    const parsed = parseJsonObject(responseBody);
    return {
      provider: "loops",
      contactId: typeof parsed?.id === "string" ? parsed.id : null,
    };
  }

  private buildPayload(entry: WaitlistEntry): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      email: entry.email,
      source: "AgentRail waitlist",
      agentrailWaitlist: true,
    };
    const { firstName, lastName } = splitName(entry.name);
    if (firstName) payload.firstName = firstName;
    if (lastName) payload.lastName = lastName;
    if (entry.teamName) payload.teamName = entry.teamName;
    if (typeof entry.teamSize === "number") payload.teamSize = entry.teamSize;
    if (entry.agentFramework) payload.agentFramework = entry.agentFramework;
    if (entry.message) payload.message = entry.message;
    if (this.mailingListId) {
      payload.mailingLists = { [this.mailingListId]: true };
    }
    return payload;
  }
}

function splitName(name: string | null): { firstName: string | null; lastName: string | null } {
  const parts = name?.trim().split(/\s+/u).filter(Boolean) ?? [];
  if (parts.length === 0) {
    return { firstName: null, lastName: null };
  }
  return {
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  if (!value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
