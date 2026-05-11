# Railway Production Deployment

This runbook covers the production API deployment for AgentRail on Railway and
the DNS and monitoring steps needed to publish `https://api.agentrail.app/v1`.

## Technical Decision

Chosen:

- Run the API as a single Railway service using the existing `Dockerfile` and
  `railway.toml`.
- Keep the public API base URL versioned at `https://api.agentrail.app/v1`.
- Accept both root routes (`/tasks/...`) and versioned routes (`/v1/tasks/...`)
  in the service so Railway does not need a path-rewriting proxy in front of the
  container.
- Use Railway's `/health` deployment health check for rollout gating and pair it
  with an external uptime monitor for continuous checks.
- Reserve `agentrail.app` and `www.agentrail.app` for landing-page work in
  `AGEA-74` so API cutovers do not share blast radius with marketing hosting.

Rejected:

- Proxy-only `/v1` prefixing outside the app. That hides a production-only
  routing dependency and breaks local parity.
- Railway health checks as the only monitor. They gate deployment startup, but
  continuous availability still needs an external check.
- Serving the apex marketing site from the API service in this phase. It couples
  deploy risk for the product API and the landing page.

## Railway Settings

Repository config already covers:

- `builder = "dockerfile"`
- `healthcheckPath = "/health"`
- `healthcheckTimeout = 60`
- restart on failure

Set these Railway service variables before the first production cut:

| Variable | Value | Why |
| --- | --- | --- |
| `AGENTRAIL_HOST` | `0.0.0.0` | Bind on Railway's injected network interface |
| `PORT` | Railway-managed | Railway injects this automatically |
| `AGENTRAIL_PUBLIC_BASE_URL` | `https://api.agentrail.app/v1` | Keeps generated links and SDK examples aligned with Cloud |
| `AGENTRAIL_LOG_FORMAT` | `json` | Structured logs for incident response |
| `AGENTRAIL_OBSERVABILITY` | `true` | Emit request-level observability lines |
| `LOOPS_API_KEY` | secret | Durable waitlist contact tracking |
| `LOOPS_WAITLIST_MAILING_LIST_ID` | Loops list ID | Add signups to the Cloud waitlist list |

Optional production variables:

- `GITHUB_TOKEN` if live GitHub-backed task sources are enabled
- `CIRCLECI_TOKEN` and `CIRCLECI_WEBHOOK_SECRET` if CircleCI status is enabled
- `AGENTRAIL_EVENT_STORE_PATH` only if persistent local event storage is added later
- `BREVO_API_KEY`, `SENDGRID_API_KEY`, or `RESEND_API_KEY` only if waitlist
  confirmation emails are deliberately re-enabled. The current launch path
  tracks signups in Loops and shows on-page confirmation only.

## DNS Plan

1. In Railway, add the custom domain `api.agentrail.app` to the API service.
2. Copy the Railway-provided DNS values into the DNS provider.
   For a subdomain this is typically a `CNAME`, plus any verification record Railway requests.
3. Wait for Railway domain verification and automatic SSL issuance.
4. Do not move the apex `agentrail.app` record in this phase.
   Leave landing-page hosting decisions to `AGEA-74`.

If the DNS provider is Cloudflare:

- Keep the API subdomain compatible with Railway's certificate flow.
- For deeper nested proxying rules, follow Railway's current domain guidance
  before enabling proxy behavior.

## Cloudflare Steps

Use these steps when `agentrail.app` is already active in Cloudflare.

1. In Railway, open the API service and add `api.agentrail.app` as a custom domain.
2. Copy the CNAME target Railway shows for that custom domain.
3. In Cloudflare, open the `agentrail.app` zone.
4. Go to `DNS` -> `Records`.
5. Select `Add record`.
6. Set `Type` to `CNAME`.
7. Set `Name` to `api`.
8. Set `Target` to the Railway-provided CNAME value.
9. Set `Proxy status` to `DNS only` while Railway verifies the domain and issues TLS.
10. Save the record, then wait for Railway to show the domain and certificate as active.

Do not create `api.agentrail.app` as a separate Cloudflare site. It is just a
DNS record inside the existing `agentrail.app` zone.

After Railway verifies the domain, leave the record as `DNS only` unless there is
a deliberate decision to put Cloudflare proxying in front of the API. If proxying
is enabled later, re-check SSL mode and health monitoring because Cloudflare will
sit in the request path.

## Monitoring

Railway health checks verify startup during deployment, but they do not provide
continuous uptime monitoring. Configure both layers:

1. Railway deployment health check: `GET /health`
2. External uptime monitor: `GET https://api.agentrail.app/v1/health`

Recommended monitor behavior:

- interval: 60 seconds
- timeout: 10 seconds
- expected status: `200`
- alert after: 2 consecutive failures

Health response example:

```json
{
  "status": "ok",
  "service": "agentrail-service",
  "publicBaseUrl": "https://api.agentrail.app/v1",
  "pathPrefix": "/v1",
  "time": "2026-05-04T14:54:17.000Z",
  "uptimeSeconds": 43
}
```

## Verification

After the Railway deploy is live and DNS has propagated:

```bash
curl -sS https://api.agentrail.app/v1/health
curl -sS https://api.agentrail.app/health
```

Expected:

- both endpoints return `200`
- `publicBaseUrl` is `https://api.agentrail.app/v1`
- `pathPrefix` is `/v1`

If an API key has been provisioned, verify one authenticated route too:

```bash
curl -sS https://api.agentrail.app/v1/tasks/mine?status=in_progress \
  -H "Authorization: Bearer $AGENTRAIL_API_KEY"
```

## Troubleshooting

### `https://api.agentrail.app` shows the landing page

This does not prove the DNS record is pointed at the wrong service. The current
AgentRail server intentionally serves `landing/index-light.html` at `/` and
serves the API below specific paths such as `/health`, `/tasks/...`, and
`/task-events/...`.

Use path-specific checks for production readiness:

```bash
curl -sS https://api.agentrail.app/health
curl -sS https://api.agentrail.app/v1/health
```

If `/health` returns `200`, the request is reaching the AgentRail API service.
If `/v1/health` still returns `not_found`, follow the redeploy guidance below.

### `/health` works but `/v1/health` returns 404

This means DNS and Railway routing are working, but production is running a build
that does not include the version-prefix routing support.

Confirm with:

```bash
curl -sS https://api.agentrail.app/health
curl -sS https://api.agentrail.app/v1/health
```

Expected current production-ready health payload:

```json
{
  "status": "ok",
  "service": "agentrail-service",
  "publicBaseUrl": "https://api.agentrail.app/v1",
  "pathPrefix": "/v1"
}
```

If `/health` returns only `{"status":"ok"}` or `/v1/health` returns
`{"error":{"code":"not_found"}}`, redeploy the revision that includes:

- `src/app.ts` route-prefix support
- `src/server.ts` passing `publicBaseUrl` into `createServer`
- `AGENTRAIL_PUBLIC_BASE_URL=https://api.agentrail.app/v1` in Railway variables

In Railway's Variables UI, click the checkmark after editing
`AGENTRAIL_PUBLIC_BASE_URL`; otherwise the value remains unsaved. After saving,
trigger a deployment that includes the prepared repo revision. A redeploy of the
old GitHub commit will still return `{"status":"ok"}` at `/health` and
`not_found` at `/v1/health`.

After redeploy, rerun the verification commands above.

## Rollback

If the production deploy is unhealthy:

1. Roll traffic back to the previous Railway deployment.
2. Keep the custom domain attached only after `/health` is green again.
3. If the issue is DNS-related, revert the changed `api.agentrail.app` record to
   the last known-good target.

## References

- Railway custom domains: https://docs.railway.com/networking/domains/working-with-domains
- Cloudflare DNS records: https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/
