import express from "express";
import { GitHubAdapter } from "./github-adapter";
import { createRoutes } from "./routes";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const PORT = parseInt(process.env.PORT ?? "3200", 10);

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error("Required env vars: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO");
  process.exit(1);
}

const adapter = new GitHubAdapter({
  token: GITHUB_TOKEN,
  owner: GITHUB_OWNER,
  repo: GITHUB_REPO,
});

const app = express();
app.use(express.json());
app.use("/", createRoutes(adapter));

app.listen(PORT, () => {
  console.log(`AgentRail GitHub adapter listening on :${PORT}`);
  console.log(`  GET  /tasks/mine?assignee=<github_username>`);
  console.log(`  GET  /tasks/<owner>/<repo>#<number>`);
  console.log(`  POST /tasks/<id>/submit  { head, base?, title?, body?, reviewers?, draft? }`);
  console.log(`  POST /tasks/<id>/ship    { prNumber, mergeMethod? }`);
});

export { adapter };
