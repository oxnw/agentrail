"use client";

const caps = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="4" width="18" height="5" rx="1" />
        <rect x="3" y="11" width="18" height="5" rx="1" />
        <rect x="3" y="18" width="18" height="2" rx="1" />
        <circle cx="7" cy="6.5" r="0.8" fill="currentColor" />
        <circle cx="7" cy="13.5" r="0.8" fill="currentColor" />
      </svg>
    ),
    title: "Tasks",
    desc: "Structured lifecycle objects with state, retries, and idempotent transitions. The unit of work for every agent.",
    endpoint: { verb: "POST", path: "/v1/tasks" },
    badge: null,
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
        <path d="M8 12l3 3 5-5" />
      </svg>
    ),
    title: "Issue Intake",
    desc: "GitHub Issues and Linear tickets become AgentRail tasks automatically via webhook — with routing decisions already baked in.",
    endpoint: { verb: "POST", path: "/intake/github" },
    badge: null,
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18M9 3v18" />
        <path d="M13 14l2 2 4-4" stroke="#c8ff3e" />
      </svg>
    ),
    title: "CI Feedback",
    desc: "GitHub Actions and CircleCI results stream back as typed events with structured summaries — not raw log walls for the agent to parse.",
    endpoint: { verb: "GET", path: "/tasks/:id/ci-status" },
    badge: null,
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="4" y="10" width="16" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        <circle cx="12" cy="15.5" r="1.2" fill="currentColor" />
      </svg>
    ),
    title: "Scoped Auth",
    desc: "Per-agent API keys with narrow scopes — not org-wide PATs. Each agent gets only the access its tasks require, with usage tracked per operation.",
    endpoint: { verb: "POST", path: "/agent-api-keys" },
    badge: null,
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M3 12h4l2-7 4 14 2-7h6" />
      </svg>
    ),
    title: "Event Stream",
    desc: "Server-sent events for every state change — task assigned, CI failed, review requested. Agents subscribe once and react in real time, no polling required.",
    endpoint: { verb: "GET", path: "/tasks/events" },
    badge: "Cloud",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="6" r="2.5" />
        <circle cx="12" cy="18" r="2.5" />
        <path d="M8 7l3 9M16 7l-3 9" />
      </svg>
    ),
    title: "Webhooks",
    desc: "HMAC-signed delivery with exponential backoff retries. Subscribe to task events and wire AgentRail into the rest of your delivery pipeline.",
    endpoint: { verb: "POST", path: "/webhook-subscriptions" },
    badge: "Cloud",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M4 7h16M4 12h16M4 17h10" />
        <circle cx="19" cy="17" r="2" />
      </svg>
    ),
    title: "Review Feedback",
    desc: "PR review comments from GitHub come back as severity-ranked structured events — blocking vs. advisory — so the agent knows exactly what to fix.",
    endpoint: { verb: "GET", path: "/tasks/:id/review-feedback" },
    badge: null,
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="5" cy="12" r="2" />
        <circle cx="19" cy="6" r="2" />
        <circle cx="19" cy="18" r="2" />
        <path d="M7 11.5l10-4M7 12.5l10 4" />
      </svg>
    ),
    title: "Routing Engine",
    desc: "Rules-based assignment: match incoming issues by label, project, or priority and route them to the right agent automatically.",
    endpoint: { verb: "POST", path: "/intake/routing-rules" },
    badge: null,
  },
];

export default function Capabilities() {
  return (
    <section id="product" style={{ padding: "100px 0" }}>
      <div className="max-w-[1320px] mx-auto px-8">
        {/* Section header */}
        <div
          className="grid gap-16 items-end mb-14 pb-7"
          style={{
            gridTemplateColumns: "1fr 1.6fr",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <div>
            <div className="flex items-center gap-2.5 mb-3.5">
              <span
                style={{
                  width: "28px",
                  height: "1px",
                  background: "var(--accent)",
                  display: "inline-block",
                }}
              />
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "11px",
                  letterSpacing: "0.08em",
                  color: "var(--accent)",
                }}
              >
                02 / The platform
              </span>
            </div>
            <h2
              style={{
                fontFamily: "var(--font-sans)",
                fontWeight: 400,
                fontSize: "clamp(36px, 4.4vw, 60px)",
                lineHeight: 1.0,
                letterSpacing: "-0.025em",
                color: "var(--ink)",
              }}
            >
              Eight primitives.
              <br />
              One{" "}
              <em
                style={{
                  fontFamily: "var(--font-serif)",
                  fontStyle: "italic",
                  fontWeight: 300,
                  color: "var(--accent)",
                }}
              >
                open-source
              </em>{" "}
              backbone.
            </h2>
          </div>
          <p
            style={{
              fontSize: "17px",
              color: "var(--ink-2)",
              maxWidth: "540px",
            }}
          >
            AgentRail connects your coding agents to GitHub, Linear, and your CI
            system. Each primitive is a narrow, typed API — run it locally, own
            your data, extend it freely.
          </p>
        </div>

        {/* Caps grid */}
        <div
          className="grid"
          style={{
            gridTemplateColumns: "repeat(4, 1fr)",
            borderTop: "1px solid var(--line)",
            borderLeft: "1px solid var(--line)",
          }}
        >
          {caps.map((cap) => (
            <div
              key={cap.title}
              className="flex flex-col justify-between relative"
              style={{
                padding: "32px 24px",
                borderRight: "1px solid var(--line)",
                borderBottom: "1px solid var(--line)",
                minHeight: "200px",
                transition: "background 0.2s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background =
                  "rgba(0,135,90,0.05)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background =
                  "transparent";
              }}
            >
              <div>
                <div
                  style={{
                    width: "32px",
                    height: "32px",
                    color: "var(--accent)",
                    marginBottom: "18px",
                  }}
                >
                  {cap.icon}
                </div>
                <h4
                  style={{
                    fontSize: "17px",
                    fontWeight: 500,
                    letterSpacing: "-0.01em",
                    color: "var(--ink)",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  {cap.title}
                  {cap.badge && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        fontFamily: "var(--font-mono)",
                        fontSize: "9.5px",
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        padding: "3px 6px",
                        borderRadius: "4px",
                        color: "#3b82f6",
                        background: "rgba(59,130,246,0.08)",
                        border: "1px solid rgba(59,130,246,0.25)",
                      }}
                    >
                      {cap.badge}
                    </span>
                  )}
                </h4>
                <p
                  style={{
                    fontSize: "13.5px",
                    color: "var(--ink-2)",
                    marginTop: "8px",
                    lineHeight: 1.5,
                  }}
                >
                  {cap.desc}
                </p>
              </div>
              <div
                style={{
                  marginTop: "16px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "11px",
                  color: "var(--ink-3)",
                }}
              >
                <span style={{ color: "var(--accent)" }}>{cap.endpoint.verb}</span>
                &nbsp;{cap.endpoint.path}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
