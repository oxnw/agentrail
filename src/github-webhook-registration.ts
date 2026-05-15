export const GITHUB_WEBHOOK_EVENTS = ["issues", "workflow_run", "pull_request_review"] as const;

export interface GitHubWebhookMetadata {
  repoSlug: string;
  hookId: number;
  url: string;
  events: string[];
  active: boolean;
}

export interface GitHubWebhookRegistrationResult {
  action: "created" | "updated";
  hook: GitHubWebhookMetadata;
}

interface GitHubHookResponse {
  id?: number;
  active?: boolean;
  events?: string[];
  config?: {
    url?: string;
  };
}

export function buildGitHubWebhookUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/providers/github/webhooks`;
}

export async function listGitHubWebhooks({
  token,
  repoSlug,
  fetch,
}: {
  token: string;
  repoSlug: string;
  fetch: typeof globalThis.fetch;
}): Promise<GitHubHookResponse[]> {
  assertGitHubRepoSlug(repoSlug);
  assertFetch(fetch);
  const hooks: GitHubHookResponse[] = [];
  let nextUrl: string | null = `${githubRepoApiUrl(repoSlug)}/hooks?per_page=100`;
  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: githubHeaders(token),
    });
    if (!response.ok) {
      throw await githubWebhookError(response, `GitHub webhook registration failed while listing hooks for ${repoSlug}`);
    }
    const body = await response.json().catch(() => []);
    if (Array.isArray(body)) {
      hooks.push(...body as GitHubHookResponse[]);
    }
    nextUrl = parseNextLink(response.headers.get("link"));
  }
  return hooks;
}

export async function registerGitHubWebhook({
  token,
  repoSlug,
  webhookUrl,
  secret,
  fetch,
  events = [...GITHUB_WEBHOOK_EVENTS],
}: {
  token: string;
  repoSlug: string;
  webhookUrl: string;
  secret: string;
  fetch: typeof globalThis.fetch;
  events?: string[];
}): Promise<GitHubWebhookRegistrationResult> {
  assertGitHubRepoSlug(repoSlug);
  assertFetch(fetch);
  const existingHooks = await listGitHubWebhooks({ token, repoSlug, fetch });
  const matchingHook = existingHooks.find((hook) => hook.config?.url === webhookUrl);
  if (matchingHook?.id) {
    const response = await fetch(`${githubRepoApiUrl(repoSlug)}/hooks/${matchingHook.id}`, {
      method: "PATCH",
      headers: {
        ...githubHeaders(token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        active: true,
        events,
        config: webhookConfig({ webhookUrl, secret }),
      }),
    });
    if (!response.ok) {
      throw await githubWebhookError(response, `GitHub webhook registration failed while updating hook ${matchingHook.id} for ${repoSlug}`);
    }
    const hook = await response.json().catch(() => matchingHook) as GitHubHookResponse;
    return {
      action: "updated",
      hook: toMetadata({ repoSlug, webhookUrl, requestedEvents: events, hook }),
    };
  }

  const response = await fetch(`${githubRepoApiUrl(repoSlug)}/hooks`, {
    method: "POST",
    headers: {
      ...githubHeaders(token),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "web",
      active: true,
      events,
      config: webhookConfig({ webhookUrl, secret }),
    }),
  });
  if (!response.ok) {
    throw await githubWebhookError(response, `GitHub webhook registration failed while creating hook for ${repoSlug}`);
  }
  const hook = await response.json().catch(() => ({})) as GitHubHookResponse;
  return {
    action: "created",
    hook: toMetadata({ repoSlug, webhookUrl, requestedEvents: events, hook }),
  };
}

export async function verifyGitHubWebhookMetadata({
  token,
  fetch,
  metadata,
}: {
  token: string;
  fetch: typeof globalThis.fetch;
  metadata: GitHubWebhookMetadata[];
}): Promise<void> {
  for (const item of metadata) {
    const hooks = await listGitHubWebhooks({ token, repoSlug: item.repoSlug, fetch });
    const match = hooks.find((hook) => hook.id === item.hookId && hook.config?.url === item.url);
    if (!match) {
      throw new Error(`GitHub webhook registration for ${item.repoSlug} is missing or no longer points at ${item.url}. Re-run \`agentrail provider connect github --delivery-mode webhook\`.`);
    }
    if (match.active === false) {
      throw new Error(`GitHub webhook registration for ${item.repoSlug} is disabled. Re-run \`agentrail provider connect github --delivery-mode webhook\`.`);
    }
    const missingEvents = GITHUB_WEBHOOK_EVENTS.filter((event) => !(match.events ?? []).includes(event));
    if (missingEvents.length > 0) {
      throw new Error(`GitHub webhook registration for ${item.repoSlug} is missing events: ${missingEvents.join(", ")}. Re-run \`agentrail provider connect github --delivery-mode webhook\`.`);
    }
  }
}

function githubRepoApiUrl(repoSlug: string): string {
  const [owner, repo] = repoSlug.split("/");
  return `https://api.github.com/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repo ?? "")}`;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="next"$/u);
    if (match) {
      return match[1] ?? null;
    }
  }
  return null;
}

function webhookConfig({ webhookUrl, secret }: { webhookUrl: string; secret: string }) {
  return {
    url: webhookUrl,
    content_type: "json",
    secret,
    insecure_ssl: "0",
  };
}

function toMetadata({
  repoSlug,
  webhookUrl,
  requestedEvents,
  hook,
}: {
  repoSlug: string;
  webhookUrl: string;
  requestedEvents: string[];
  hook: GitHubHookResponse;
}): GitHubWebhookMetadata {
  if (!Number.isInteger(hook.id)) {
    throw new Error(`GitHub webhook registration failed for ${repoSlug}: response did not include a hook id.`);
  }
  return {
    repoSlug,
    hookId: hook.id!,
    url: hook.config?.url ?? webhookUrl,
    events: Array.isArray(hook.events) && hook.events.length > 0 ? hook.events : requestedEvents,
    active: hook.active !== false,
  };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };
}

async function githubWebhookError(response: Response, prefix: string): Promise<Error> {
  const text = await response.text().catch(() => "");
  const suffix = text.trim() ? ` ${text.slice(0, 200)}` : "";
  return new Error(`${prefix}: ${response.status}${suffix}`);
}

function assertFetch(fetch: typeof globalThis.fetch): void {
  if (typeof fetch !== "function") {
    throw new Error("GitHub webhook registration requires a fetch implementation.");
  }
}

function assertGitHubRepoSlug(repoSlug: string): void {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repoSlug)) {
    throw new Error(`GitHub webhook registration requires an owner/repo slug, got "${repoSlug}".`);
  }
}
