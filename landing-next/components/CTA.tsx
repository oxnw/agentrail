import Link from "next/link";

export default function CTA() {
  return (
    <section
      style={{
        padding: "140px 0 120px",
        textAlign: "center",
        position: "relative",
        overflow: "hidden",
        borderTop: "1px solid var(--line)",
      }}
    >
      {/* Rail line */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: "50%",
          height: "1px",
          background: "var(--line)",
          pointerEvents: "none",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "-3px",
            left: "8%",
            width: "7px",
            height: "7px",
            background: "var(--accent)",
            borderRadius: "999px",
            display: "block",
          }}
        />
        <span
          style={{
            position: "absolute",
            top: "-3px",
            right: "8%",
            width: "7px",
            height: "7px",
            background: "var(--accent)",
            borderRadius: "999px",
            display: "block",
          }}
        />
      </div>

      <div className="max-w-[1320px] mx-auto px-8 relative" style={{ zIndex: 1 }}>
        <h2
          style={{
            fontFamily: "var(--font-sans)",
            fontWeight: 400,
            fontSize: "clamp(48px, 6vw, 88px)",
            lineHeight: 0.96,
            letterSpacing: "-0.035em",
            textWrap: "balance",
            maxWidth: "900px",
            margin: "0 auto",
            color: "var(--ink)",
          }}
        >
          Give your agents
          <br />
          the full{" "}
          <span
            style={{
              color: "#ffffff",
              background: "var(--accent)",
              padding: "0 0.12em",
            }}
          >
            dev loop.
          </span>
        </h2>

        <p
          style={{
            color: "var(--ink-2)",
            fontSize: "17px",
            marginTop: "24px",
          }}
        >
          MIT licensed. One npm install. No account required.
        </p>

        {/* Install card */}
        <div
          style={{
            display: "inline-block",
            margin: "28px auto 0",
            background: "var(--code-bg)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: "8px",
            padding: "14px 24px",
            fontFamily: "var(--font-mono)",
            fontSize: "14px",
            color: "var(--code-ink)",
            letterSpacing: "0.02em",
          }}
        >
          <span style={{ color: "var(--ink-3)", userSelect: "none" }}>$ </span>
          npm install @agentrail-core/cli
        </div>

        <div
          className="flex gap-3 justify-center mt-10 relative"
          style={{ zIndex: 1 }}
        >
          <a
            href="https://github.com/oxnw/agentrail"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              padding: "12px 20px",
              borderRadius: "6px",
              background: "var(--accent)",
              color: "#ffffff",
              fontFamily: "var(--font-sans)",
              fontSize: "14px",
              fontWeight: 500,
            }}
          >
            View on GitHub
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
          <Link
            href="/docs"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              padding: "12px 20px",
              borderRadius: "6px",
              border: "1px solid var(--line-2)",
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: "14px",
              fontWeight: 500,
            }}
          >
            Read the docs
          </Link>
        </div>
      </div>
    </section>
  );
}
