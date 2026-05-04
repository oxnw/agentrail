# AgentRail End-to-End Demo

This demo shows an agent completing a task through the AgentRail task lifecycle API:

1. `GET /tasks/mine`
2. `POST /tasks/{id}/submit`
3. `GET /tasks/{id}/ci-status`
4. `GET /tasks/{id}/review-feedback`
5. `POST /tasks/{id}/submit`
6. `GET /tasks/{id}/ci-status`
7. `GET /tasks/{id}/review-feedback`
8. `POST /tasks/{id}/ship`

Run it:

```bash
node scripts/agentrail-e2e-demo.mjs
```

Recorded video:

```text
docs/demo/agentrail-e2e-demo.mp4
```

Machine-readable output:

```bash
node scripts/agentrail-e2e-demo.mjs --json
```

Current reference run:

```json
{
  "taskId": "tsk_DEMOISSUETOSHIP01",
  "firstCiStatus": "failed",
  "firstReviewOutcome": "changes_requested",
  "finalCiStatus": "passed",
  "finalReviewOutcome": "approved",
  "shipStatus": "queued",
  "agentRailEstimatedTokens": 1244,
  "rawGitHubEquivalentEstimatedTokens": 2394,
  "estimatedTokenSavingsPercent": 48
}
```

## Technical Decision

Chosen: implement the demo against the real AgentRail HTTP server routes with a deterministic in-memory task lifecycle store.

Rejected: a shell-only mock that prints the desired flow. That would be quicker, but it would not prove the API contract, idempotency behavior, or SDK compatibility.

Rejected: live GitHub calls for the first demo. Live calls would make the recording harder to reproduce, require secrets, and add external rate-limit failure modes. The raw GitHub comparison is instead measured from a serialized fixture shaped like the equivalent GitHub issue, PR, checks, review, and deployment payloads.

Tradeoff: the demo is deterministic rather than live. That is the right first demo because it isolates AgentRail's value proposition: one compact agent-native API flow for issue to ship, with bounded responses and retry-safe mutations.

## Metrics

- Time to completion is measured from the first AgentRail client call through ship acceptance.
- AgentRail token use is estimated from serialized request and response bytes divided by four.
- Raw GitHub-equivalent token use uses the same estimator over the equivalent issue, PR, checks, review, and deployment fixture.
- Success rate is `1.0` when the scripted issue reaches ship acceptance.

## Known Limitations

- The demo uses a deterministic local task store, not live GitHub.
- The raw GitHub comparison is a controlled fixture, not a benchmark against a production GitHub repository.
