"use client";

const logos = [
  {
    name: "GitHub",
    status: "live",
    svg: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.009-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
      </svg>
    ),
  },
  {
    name: "Linear",
    status: "live",
    svg: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M3.28 16.31L7.7 20.73a10 10 0 0 0 8.56-2.93L3.28 16.31zM2.5 14.9l6.62 1.6L2.5 9.87v5.03zM2.94 8.3l12.77 6.16a9.95 9.95 0 0 0 .85-4.01c0-2.1-.65-4.05-1.76-5.66L2.94 8.3zM15.7 4.3A9.97 9.97 0 0 0 9.1 2.5c-.54 0-1.07.04-1.58.12L15.7 4.3z" />
      </svg>
    ),
  },
  {
    name: "CircleCI",
    status: "live",
    svg: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 9.84a2.16 2.16 0 1 1 0 4.32 2.16 2.16 0 0 1 0-4.32zM2 12C2 6.48 6.48 2 12 2c3.69 0 6.92 1.99 8.7 4.97l-2.04 1.18A7.5 7.5 0 0 0 4.5 12a7.5 7.5 0 0 0 14.16 3.85l2.04 1.18A10 10 0 0 1 2 12z" />
      </svg>
    ),
  },
  {
    name: "GitHub Actions",
    status: "live",
    svg: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" />
      </svg>
    ),
  },
  {
    name: "Jira",
    status: "soon",
    svg: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M11.53 2.01L5.91 7.62a.93.93 0 0 0 0 1.31l2.6 2.6 5.03-5.03 5.55 5.55a.93.93 0 0 0 1.31 0l.59-.59a.93.93 0 0 0 0-1.31L12.84 2.01a.93.93 0 0 0-1.31 0zM12.47 10.52l-5.03 5.03-2.6-2.6a.93.93 0 0 0-1.31 0l-.59.59a.93.93 0 0 0 0 1.31l8.15 8.14a.93.93 0 0 0 1.31 0l5.62-5.62a.93.93 0 0 0 0-1.31l-2.6-2.6-2.95 2.95-5.55-5.55 5.55-5.55z" />
      </svg>
    ),
  },
  {
    name: "GitLab",
    status: "soon",
    svg: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51a.42.42 0 0 1 .82 0l2.44 7.51H16.03l2.44-7.51a.42.42 0 0 1 .82 0l2.44 7.51 1.22 3.78a.84.84 0 0 1-.3.94z" />
      </svg>
    ),
  },
];

export default function LogoCloud() {
  return (
    <section
      style={{
        borderTop: "1px solid var(--line)",
        borderBottom: "1px solid var(--line)",
        padding: "64px 0",
        background: "linear-gradient(180deg, transparent, rgba(12,20,32,0.02))",
      }}
    >
      <div className="max-w-[1320px] mx-auto px-8">
        <p
          className="text-center mb-12"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--ink-3)",
          }}
        >
          Connects to your existing stack
        </p>

        <div className="flex flex-wrap justify-center items-center gap-16">
          {logos.map((logo) => (
            <div
              key={logo.name}
              className="flex flex-col items-center gap-3.5 cursor-default transition-opacity hover:opacity-70"
              style={{
                color: "var(--ink-2)",
                opacity: logo.status === "soon" ? 0.4 : 1,
              }}
              onMouseEnter={(e) => {
                if (logo.status !== "soon")
                  (e.currentTarget as HTMLDivElement).style.opacity = "0.7";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.opacity =
                  logo.status === "soon" ? "0.4" : "1";
              }}
            >
              <div style={{ width: "48px", height: "48px", flexShrink: 0 }}>
                {logo.svg}
              </div>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "11px",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--ink-3)",
                }}
              >
                {logo.name}
              </span>
              <span
                className="flex items-center gap-1.5"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "9.5px",
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  color: logo.status === "live" ? "var(--accent)" : "var(--warn)",
                }}
              >
                <span
                  style={{
                    width: "5px",
                    height: "5px",
                    borderRadius: "999px",
                    background:
                      logo.status === "live" ? "var(--accent)" : "var(--warn)",
                    display: "inline-block",
                  }}
                />
                {logo.status === "live" ? "Live" : "Soon"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
