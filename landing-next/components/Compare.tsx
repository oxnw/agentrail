"use client";

import { useState } from "react";

type CellValue =
  | { type: "yes"; label?: string }
  | { type: "no"; label?: string }
  | { type: "coming"; label: string };

type Row = {
  feature: string;
  oss: CellValue;
  cloud: CellValue;
};

const CheckIcon = ({ color }: { color: string }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke={color}
    strokeWidth="2"
    style={{ marginRight: "4px", flexShrink: 0 }}
  >
    <path d="M2 7l3 3 7-7" />
  </svg>
);

const DashIcon = ({ color }: { color: string }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke={color}
    strokeWidth="2"
    style={{ marginRight: "4px", flexShrink: 0 }}
  >
    <path d="M2 7h10" />
  </svg>
);

const rows: Row[] = [
  {
    feature: "Task lifecycle engine",
    oss: { type: "yes", label: "Yes" },
    cloud: { type: "yes", label: "Yes" },
  },
  {
    feature: "GitHub Issues + Linear intake",
    oss: { type: "yes", label: "Yes" },
    cloud: { type: "yes", label: "Yes" },
  },
  {
    feature: "GitHub Actions + CircleCI feedback",
    oss: { type: "yes", label: "Yes" },
    cloud: { type: "yes", label: "Yes" },
  },
  {
    feature: "PR review feedback (severity-ranked)",
    oss: { type: "yes", label: "Yes" },
    cloud: { type: "yes", label: "Yes" },
  },
  {
    feature: "Rules-based routing engine",
    oss: { type: "yes", label: "Yes" },
    cloud: { type: "yes", label: "Yes" },
  },
  {
    feature: "Per-agent scoped API keys",
    oss: { type: "yes", label: "Yes" },
    cloud: { type: "yes", label: "Yes" },
  },
  {
    feature: "SSE event stream + webhooks",
    oss: { type: "no", label: "—" },
    cloud: { type: "yes", label: "Yes" },
  },
  {
    feature: "TypeScript + Python SDKs",
    oss: { type: "yes", label: "Yes" },
    cloud: { type: "yes", label: "Yes" },
  },
  {
    feature: "Multi-agent fleet coordination",
    oss: { type: "no", label: "—" },
    cloud: { type: "coming", label: "Team workspace" },
  },
  {
    feature: "Run history + dashboards",
    oss: { type: "no", label: "—" },
    cloud: { type: "coming", label: "Hosted dashboards" },
  },
  {
    feature: "Managed connectors (Jira, GitLab…)",
    oss: { type: "no", label: "—" },
    cloud: { type: "coming", label: "Managed integrations" },
  },
  {
    feature: "Audit log + compliance",
    oss: { type: "no", label: "Local" },
    cloud: { type: "coming", label: "Managed audit trail" },
  },
  {
    feature: "Support",
    oss: { type: "no", label: "Community" },
    cloud: { type: "coming", label: "Planned team support" },
  },
];

function Cell({ val, isOss }: { val: CellValue; isOss: boolean }) {
  return (
    <div
      className="flex items-center flex-wrap gap-2"
      style={{
        padding: "18px 22px",
        borderRight: "1px solid var(--line)",
        fontSize: "14px",
        background: isOss ? "rgba(0,135,90,0.06)" : "transparent",
      }}
    >
      {val.type === "yes" && (
        <>
          <CheckIcon color="var(--accent)" />
          <span style={{ color: "var(--ink-2)" }}>{val.label}</span>
        </>
      )}
      {val.type === "no" && (
        <>
          <DashIcon color="#b3afa3" />
          <span style={{ color: "var(--ink-3)" }}>{val.label}</span>
        </>
      )}
      {val.type === "coming" && (
        <>
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
              color: "var(--warn)",
              background: "rgba(232,116,31,0.09)",
              border: "1px solid rgba(232,116,31,0.28)",
            }}
          >
            Coming soon
          </span>
          <span style={{ color: "var(--ink-3)", fontSize: "13px" }}>
            {val.label}
          </span>
        </>
      )}
    </div>
  );
}

export default function Compare() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch("/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const text = await res.text();
      let data: { alreadyExists?: boolean; error?: { message?: string } } = {};
      try {
        data = text.trim().length > 0 ? JSON.parse(text) : {};
      } catch {
        data = {};
      }
      if (res.ok) {
        setMessage(
          data.alreadyExists
            ? "You're already on the list — we'll be in touch!"
            : "You're on the list. We'll reach out when Cloud opens."
        );
        if (!data.alreadyExists) setEmail("");
      } else {
        setMessage(data.error?.message || "Something went wrong. Please try again.");
      }
    } catch {
      setMessage("Network error. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section
      id="compare"
      style={{ padding: "100px 0", borderTop: "1px solid var(--line)" }}
    >
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
                06 / Source-available vs Cloud waitlist
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
              Start free.
              <br />
              Join the{" "}
              <em
                style={{
                  fontFamily: "var(--font-serif)",
                  fontStyle: "italic",
                  fontWeight: 300,
                  color: "var(--accent)",
                }}
              >
                Cloud waitlist.
              </em>
            </h2>
          </div>
          <p style={{ fontSize: "17px", color: "var(--ink-2)", maxWidth: "540px" }}>
            Everything you need to run coding agents ships in the source-available
            package. Cloud team features are on the roadmap and waitlist-gated
            until the managed service is ready.
          </p>
        </div>

        {/* Table */}
        <div
          style={{
            border: "1px solid var(--line)",
            borderRadius: "10px",
            overflow: "hidden",
          }}
        >
          {/* Header row */}
          <div
            className="grid"
            style={{
              gridTemplateColumns: "1.35fr 1fr 1.18fr",
              borderBottom: "1px solid var(--line)",
            }}
          >
            <div
              style={{
                padding: "18px 22px",
                borderRight: "1px solid var(--line)",
                background: "rgba(12,20,32,0.035)",
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                color: "var(--ink-3)",
              }}
            >
              Feature
            </div>
            <div
              style={{
                padding: "18px 22px",
                borderRight: "1px solid var(--line)",
                background: "rgba(12,20,32,0.035)",
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                color: "var(--accent)",
              }}
            >
              Source-available
            </div>
            <div
              style={{
                padding: "18px 22px",
                background: "rgba(12,20,32,0.035)",
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                color: "var(--ink-3)",
              }}
            >
              Cloud waitlist
            </div>
          </div>

          {/* Data rows */}
          {rows.map((row, i) => (
            <div
              key={row.feature}
              className="grid"
              style={{
                gridTemplateColumns: "1.35fr 1fr 1.18fr",
                borderBottom:
                  i < rows.length - 1 ? "1px solid var(--line)" : "none",
              }}
            >
              <div
                style={{
                  padding: "18px 22px",
                  borderRight: "1px solid var(--line)",
                  fontSize: "14px",
                  fontWeight: 500,
                  color: "var(--ink)",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                {row.feature}
              </div>
              <Cell val={row.oss} isOss={true} />
              <div
                className="flex items-center flex-wrap gap-2"
                style={{ padding: "18px 22px", fontSize: "14px" }}
              >
                {row.cloud.type === "yes" && (
                  <>
                    <CheckIcon color="var(--accent)" />
                    <span style={{ color: "var(--ink-2)" }}>{row.cloud.label}</span>
                  </>
                )}
                {row.cloud.type === "no" && (
                  <>
                    <DashIcon color="#b3afa3" />
                    <span style={{ color: "var(--ink-3)" }}>{row.cloud.label}</span>
                  </>
                )}
                {row.cloud.type === "coming" && (
                  <>
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
                        color: "var(--warn)",
                        background: "rgba(232,116,31,0.09)",
                        border: "1px solid rgba(232,116,31,0.28)",
                      }}
                    >
                      Coming soon
                    </span>
                    <span style={{ color: "var(--ink-3)", fontSize: "13px" }}>
                      {row.cloud.label}
                    </span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Waitlist panel */}
        <div
          id="cloud-waitlist"
          className="grid gap-7 mt-7 items-center"
          style={{
            gridTemplateColumns: "1.1fr 0.9fr",
            border: "1px solid var(--line)",
            borderRadius: "10px",
            background: "rgba(244,246,249,0.72)",
            padding: "24px",
          }}
        >
          <div>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: "var(--accent)",
              }}
            >
              Cloud waitlist
            </span>
            <h3
              style={{
                fontSize: "24px",
                lineHeight: 1.15,
                fontWeight: 500,
                letterSpacing: "-0.015em",
                marginTop: "8px",
                color: "var(--ink)",
              }}
            >
              Cloud is coming, not live.
            </h3>
            <p
              style={{
                color: "var(--ink-2)",
                fontSize: "14px",
                marginTop: "10px",
                maxWidth: "560px",
              }}
            >
              Join the list for hosted sync, team memory, managed integrations,
              and compliance workflow updates. The source-available package is ready
              to install today.
            </p>
          </div>
          <form onSubmit={handleSubmit}>
            <div
              className="grid gap-2.5"
              style={{ gridTemplateColumns: "minmax(220px, 1fr) auto" }}
            >
              <label className="sr-only" htmlFor="cloud-email">
                Email address
              </label>
              <input
                id="cloud-email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{
                  width: "100%",
                  minHeight: "38px",
                  border: "1px solid var(--line-2)",
                  borderRadius: "6px",
                  background: "rgba(244,246,249,0.86)",
                  color: "var(--ink)",
                  fontFamily: "var(--font-sans)",
                  fontSize: "13.5px",
                  padding: "8px 12px",
                  outline: "none",
                }}
              />
              <button
                type="submit"
                disabled={loading}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "8px 14px",
                  borderRadius: "6px",
                  background: "var(--accent)",
                  color: "#ffffff",
                  fontFamily: "var(--font-sans)",
                  fontSize: "13.5px",
                  fontWeight: 500,
                  cursor: loading ? "not-allowed" : "pointer",
                  opacity: loading ? 0.7 : 1,
                  whiteSpace: "nowrap",
                }}
              >
                Join waitlist
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M3 6h6m0 0L6 3m3 3L6 9" />
                </svg>
              </button>
            </div>
            {message && (
              <p
                style={{
                  marginTop: "6px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "10.5px",
                  letterSpacing: "0.04em",
                  color: "var(--accent)",
                  minHeight: "18px",
                }}
              >
                {message}
              </p>
            )}
          </form>
        </div>
      </div>
    </section>
  );
}
