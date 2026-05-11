"use client";

export default function Footer() {
  return (
    <footer
      style={{
        borderTop: "1px solid var(--line)",
        padding: "48px 0 32px",
      }}
    >
      <div className="max-w-[1320px] mx-auto px-8">
        <div
          className="grid gap-12"
          style={{ gridTemplateColumns: "1.4fr 1fr 1fr 1fr 1fr" }}
        >
          {/* Brand col */}
          <div>
            <div className="flex items-center gap-2.5 mb-3.5">
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
                style={{ color: "var(--ink)" }}
              >
                <line x1="2" y1="8" x2="22" y2="8" />
                <line x1="2" y1="16" x2="22" y2="16" />
                <circle cx="6" cy="8" r="1.5" fill="currentColor" />
                <circle cx="12" cy="8" r="1.5" fill="currentColor" />
                <circle cx="18" cy="8" r="1.5" fill="currentColor" />
                <circle cx="6" cy="16" r="1.5" fill="currentColor" />
                <circle cx="12" cy="16" r="1.5" fill="#c8ff3e" stroke="#c8ff3e" />
                <circle cx="18" cy="16" r="1.5" fill="currentColor" />
              </svg>
              <span
                style={{
                  fontFamily: "var(--font-sans)",
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  fontSize: "16px",
                  color: "var(--ink)",
                }}
              >
                AgentRail
              </span>
            </div>
            <p
              style={{
                color: "var(--ink-3)",
                fontSize: "13px",
                maxWidth: "280px",
              }}
            >
              The API that connects coding agents to GitHub, Linear, and CI —
              closing the full loop from ticket to merge.
            </p>
          </div>

          {/* Product */}
          <div>
            <h5
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--ink-3)",
                marginBottom: "14px",
              }}
            >
              Product
            </h5>
            {[
              { label: "Self-hosted", href: "#product" },
              { label: "Cloud waitlist", href: "#cloud-waitlist" },
              { label: "Lifecycle", href: "#lifecycle" },
              { label: "SDK", href: "#sdk" },
            ].map((l) => (
              <a
                key={l.label}
                href={l.href}
                style={{
                  display: "block",
                  color: "var(--ink-2)",
                  fontSize: "13.5px",
                  padding: "4px 0",
                  transition: "color 0.15s",
                }}
                onMouseEnter={(e) =>
                  ((e.target as HTMLAnchorElement).style.color = "var(--ink)")
                }
                onMouseLeave={(e) =>
                  ((e.target as HTMLAnchorElement).style.color = "var(--ink-2)")
                }
              >
                {l.label}
              </a>
            ))}
          </div>

          {/* Developers */}
          <div>
            <h5
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--ink-3)",
                marginBottom: "14px",
              }}
            >
              Developers
            </h5>
            {[
              { label: "Docs", href: "/docs" },
              {
                label: "API reference",
                href: "https://github.com/oxnw/agentrail/blob/main/docs/api/task-lifecycle.openapi.yaml",
              },
              {
                label: "Examples",
                href: "https://github.com/oxnw/agentrail/tree/main/examples",
              },
              {
                label: "Changelog",
                href: "https://github.com/oxnw/agentrail/releases",
              },
            ].map((l) => (
              <a
                key={l.label}
                href={l.href}
                style={{
                  display: "block",
                  color: "var(--ink-2)",
                  fontSize: "13.5px",
                  padding: "4px 0",
                  transition: "color 0.15s",
                }}
                onMouseEnter={(e) =>
                  ((e.target as HTMLAnchorElement).style.color = "var(--ink)")
                }
                onMouseLeave={(e) =>
                  ((e.target as HTMLAnchorElement).style.color = "var(--ink-2)")
                }
              >
                {l.label}
              </a>
            ))}
          </div>

          {/* Community */}
          <div>
            <h5
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--ink-3)",
                marginBottom: "14px",
              }}
            >
              Community
            </h5>
            {[
              { label: "GitHub", href: "https://github.com/oxnw/agentrail" },
              {
                label: "Issues",
                href: "https://github.com/oxnw/agentrail/issues",
              },
              {
                label: "Contributing",
                href: "https://github.com/oxnw/agentrail/blob/main/CONTRIBUTING.md",
              },
            ].map((l) => (
              <a
                key={l.label}
                href={l.href}
                style={{
                  display: "block",
                  color: "var(--ink-2)",
                  fontSize: "13.5px",
                  padding: "4px 0",
                  transition: "color 0.15s",
                }}
                onMouseEnter={(e) =>
                  ((e.target as HTMLAnchorElement).style.color = "var(--ink)")
                }
                onMouseLeave={(e) =>
                  ((e.target as HTMLAnchorElement).style.color = "var(--ink-2)")
                }
              >
                {l.label}
              </a>
            ))}
          </div>

          {/* Company */}
          <div>
            <h5
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--ink-3)",
                marginBottom: "14px",
              }}
            >
              Company
            </h5>
            {[
              { label: "About", href: "https://github.com/oxnw/agentrail" },
              {
                label: "Security",
                href: "https://github.com/oxnw/agentrail/blob/main/SECURITY.md",
              },
            ].map((l) => (
              <a
                key={l.label}
                href={l.href}
                style={{
                  display: "block",
                  color: "var(--ink-2)",
                  fontSize: "13.5px",
                  padding: "4px 0",
                  transition: "color 0.15s",
                }}
                onMouseEnter={(e) =>
                  ((e.target as HTMLAnchorElement).style.color = "var(--ink)")
                }
                onMouseLeave={(e) =>
                  ((e.target as HTMLAnchorElement).style.color = "var(--ink-2)")
                }
              >
                {l.label}
              </a>
            ))}
          </div>
        </div>

        {/* Footer bottom */}
        <div
          className="flex justify-between items-center mt-14 pt-5"
          style={{
            borderTop: "1px solid var(--line)",
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            color: "var(--ink-3)",
          }}
        >
          <span>© 2026 AgentRail · All rights reserved.</span>
          <span>cloud waitlist open ●</span>
        </div>
      </div>
    </footer>
  );
}
