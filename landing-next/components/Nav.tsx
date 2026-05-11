"use client";

import { cn } from "@/lib/utils";

export default function Nav() {
  return (
    <header
      className="sticky top-0 z-50 border-b"
      style={{
        backdropFilter: "blur(14px)",
        background: "rgba(230,235,240,0.82)",
        borderColor: "var(--line)",
        height: "56px",
      }}
    >
      <div
        className="max-w-[1320px] mx-auto px-8 h-full grid items-center"
        style={{ gridTemplateColumns: "1fr auto 1fr" }}
      >
        {/* Left: Wordmark */}
        <div className="flex items-center gap-2.5">
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
            className="font-semibold tracking-tight"
            style={{ fontFamily: "var(--font-sans)", fontSize: "16px", color: "var(--ink)" }}
          >
            AgentRail
          </span>
          <span
            className="ml-1"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "10px",
              color: "var(--ink-3)",
              border: "1px solid var(--line-2)",
              padding: "2px 6px",
              borderRadius: "999px",
            }}
          >
            v0.1.0
          </span>
          {/* Live status pill */}
          <span
            className="hidden sm:inline-flex items-center gap-2 ml-2"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              letterSpacing: "0.04em",
              padding: "4px 10px 4px 8px",
              border: "1px solid var(--line-2)",
              borderRadius: "999px",
              color: "var(--ink-2)",
            }}
          >
            <span
              className="animate-pulse-dot"
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "999px",
                background: "var(--accent)",
                display: "inline-block",
                flexShrink: 0,
              }}
            />
            live
          </span>
        </div>

        {/* Center: Nav links */}
        <nav className="hidden md:flex items-center gap-7">
          {[
            { label: "Self-hosted", href: "#product" },
            { label: "Docs", href: "/docs" },
            { label: "GitHub", href: "https://github.com/oxnw/agentrail" },
          ].map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="transition-colors"
              style={{
                fontSize: "13.5px",
                color: "var(--ink-2)",
                fontFamily: "var(--font-sans)",
              }}
              onMouseEnter={(e) =>
                ((e.target as HTMLAnchorElement).style.color = "var(--ink)")
              }
              onMouseLeave={(e) =>
                ((e.target as HTMLAnchorElement).style.color = "var(--ink-2)")
              }
            >
              {link.label}
            </a>
          ))}
        </nav>

        {/* Right: CTAs */}
        <div className="justify-self-end flex items-center gap-3.5">
          <a
            href="https://github.com/oxnw/agentrail"
            className={cn(
              "hidden sm:inline-flex items-center gap-2 transition-colors",
              "border rounded-md"
            )}
            style={{
              fontSize: "13.5px",
              fontWeight: 500,
              padding: "8px 14px",
              border: "1px solid var(--line-2)",
              borderRadius: "6px",
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
            }}
          >
            Star on GitHub
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
          </a>
          <a
            href="#product"
            style={{
              fontSize: "13.5px",
              fontWeight: 500,
              padding: "8px 14px",
              borderRadius: "6px",
              background: "var(--accent)",
              color: "#ffffff",
              fontFamily: "var(--font-sans)",
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            Get started
          </a>
        </div>
      </div>
    </header>
  );
}
