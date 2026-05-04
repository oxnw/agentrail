// @ts-nocheck
import http from "node:http";

export function createMockGitHubServer({ port = 9999, responses = {} } = {}) {
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsedBody = body ? JSON.parse(body) : null;
      const urlPath = req.url.split("?")[0];
      requests.push({ method: req.method, url: req.url, path: urlPath, body: parsedBody });

      const routeKey = `${req.method} ${urlPath}`;
      const handler = responses[routeKey] ?? defaultResponses[routeKey];

      if (handler) {
        const result = handler(parsedBody, requests);
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.body));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Not found" }));
      }
    });
  });

  return {
    start: () => new Promise((resolve) => server.listen(port, () => resolve())),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
    getRequests: () => requests,
    clearRequests: () => (requests.length = 0),
  };
}

const defaultResponses = {
  "GET /repos/acme/webapp/pulls": () => ({
    status: 200,
    body: [],
  }),
  "POST /repos/acme/webapp/pulls": (body) => ({
    status: 201,
    body: {
      number: 42,
      html_url: "https://github.com/acme/webapp/pull/42",
      title: body?.title ?? "Test PR",
      body: body?.body ?? "",
      state: "open",
      draft: body?.draft ?? false,
      created_at: new Date().toISOString(),
      head: { ref: body?.head ?? "feat/branch" },
      base: { ref: body?.base ?? "main" },
    },
  }),
  "POST /repos/acme/webapp/pulls/42/requested_reviewers": () => ({
    status: 201,
    body: { requested_reviewers: [{ login: "reviewer1" }] },
  }),
  "POST /repos/acme/webapp/issues/42/comments": () => ({
    status: 201,
    body: { id: 100 },
  }),
};
