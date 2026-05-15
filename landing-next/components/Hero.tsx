"use client";

import Link from "next/link";

export default function Hero() {
  return (
    <div
      className="flex flex-col"
      style={{ minHeight: "calc(100vh - 56px)" }}
    >
      {/* ── Hero body ── */}
      <section className="flex-1 relative" style={{ padding: "96px 0 56px" }}>
        {/* Subtle grid background */}
        <div
          aria-hidden="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 0,
            pointerEvents: "none",
            backgroundImage:
              "linear-gradient(to right, rgba(12,20,32,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(12,20,32,0.05) 1px, transparent 1px)",
            backgroundSize: "88px 88px",
            maskImage:
              "radial-gradient(ellipse 80% 60% at 50% 30%, black 40%, transparent 100%)",
          }}
        />

        <div
          className="relative z-10 max-w-[1320px] mx-auto px-8"
          style={{ position: "relative", zIndex: 1 }}
        >
          {/* Eyebrow */}
          <div className="flex items-center gap-3.5 mb-9">
            <span
              className="inline-flex items-center gap-2"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                letterSpacing: "0.04em",
                padding: "5px 10px 5px 8px",
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
              Now in open beta · source-available
            </span>
            <span
              style={{
                flex: 1,
                height: "1px",
                background:
                  "linear-gradient(to right, var(--line-2), transparent)",
              }}
            />
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--ink-3)",
              }}
            >
              A&nbsp;·&nbsp;R&nbsp;/&nbsp;Q2&nbsp;2026
            </span>
          </div>

          {/* Two-column grid */}
          <div
            className="grid gap-16 items-end"
            style={{ gridTemplateColumns: "1.05fr 0.95fr" }}
          >
            {/* Left */}
            <div>
              <h1
                style={{
                  fontFamily: "var(--font-sans)",
                  fontWeight: 400,
                  fontSize: "clamp(48px, 6vw, 88px)",
                  lineHeight: 0.96,
                  letterSpacing: "-0.035em",
                  color: "var(--ink)",
                  textWrap: "balance",
                }}
              >
                Coding agents
                <br />
                that{" "}
                <em
                  style={{
                    fontFamily: "var(--font-serif)",
                    fontStyle: "italic",
                    fontWeight: 300,
                    color: "var(--accent)",
                  }}
                >
                  close tickets,
                </em>
                <br />
                end-to-end.
              </h1>

              <p
                style={{
                  marginTop: "28px",
                  maxWidth: "520px",
                  fontSize: "18px",
                  lineHeight: 1.5,
                  color: "var(--ink-2)",
                }}
              >
                Coding agents can write the code. The hard part is everything
                around it: picking up the right ticket, watching CI,
                incorporating review feedback, and merging when it&apos;s ready.
                AgentRail connects your agents to GitHub, Linear, and CircleCI —
                and handles the full loop.
              </p>

              <div className="flex items-center gap-3 mt-9">
                <a
                  href="https://github.com/oxnw/agentrail"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "10px 18px",
                    borderRadius: "6px",
                    background: "var(--accent)",
                    color: "#ffffff",
                    fontFamily: "var(--font-sans)",
                    fontSize: "14px",
                    fontWeight: 500,
                  }}
                >
                  Get started free
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
                    padding: "10px 18px",
                    borderRadius: "6px",
                    border: "1px solid var(--line-2)",
                    color: "var(--ink)",
                    fontFamily: "var(--font-sans)",
                    fontSize: "14px",
                    fontWeight: 500,
                  }}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 13 13"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M4 3l-3 3.5L4 10M9 3l3 3.5L9 10" />
                  </svg>
                  Read the docs
                </Link>
              </div>

              <div
                className="flex items-center gap-6 mt-7"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "11px",
                  color: "var(--ink-3)",
                }}
              >
                <span>npm i @agentrail-core/cli · pip install agentrail · Source-available license</span>
              </div>
                <a
                  href="https://www.producthunt.com/products/agentrail?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-agentrail"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="AgentRail on Product Hunt"
                  style={{ display: "inline-block", marginTop: "22px" }}
                >
                  <img
                    alt="AgentRail - A local control plane for AI coding agents | Product Hunt"
                    width={250}
                    height={54}
                    src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1146987&theme=neutral&t=1778801921835"
                    style={{ display: "block" }}
                  />
                </a>
            </div>

            {/* Right: Workflow card */}
            <div
              style={{
                border: "1px solid var(--line)",
                background: "var(--bg-2)",
                borderRadius: "12px",
                overflow: "hidden",
                boxShadow:
                  "0 30px 60px -30px rgba(12,20,32,0.22), 0 1px 0 rgba(12,20,32,0.05)",
              }}
            >
              {/* Card header */}
              <div
                className="flex items-center justify-between"
                style={{
                  padding: "12px 16px",
                  borderBottom: "1px solid var(--line)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "11px",
                  color: "var(--ink-3)",
                }}
              >
                <div className="flex items-center gap-3.5">
                  <div className="flex gap-1.5">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        style={{
                          width: "9px",
                          height: "9px",
                          borderRadius: "999px",
                          background: "var(--line-2)",
                          display: "inline-block",
                        }}
                      />
                    ))}
                  </div>
                  <span>agentrail · runs / live</span>
                </div>
                <span style={{ color: "var(--accent)" }}>● 12 active</span>
              </div>

              {/* Card body */}
              <div style={{ padding: "18px 18px 22px" }}>
                {/* Rail */}
                <div className="relative" style={{ padding: "8px 4px 4px" }}>
                  <div
                    style={{
                      position: "absolute",
                      left: "16px",
                      right: "16px",
                      top: "26px",
                      height: "2px",
                      background:
                        "repeating-linear-gradient(to right, var(--line-2) 0 6px, transparent 6px 10px)",
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      left: "16px",
                      top: "26px",
                      height: "2px",
                      background: "var(--accent)",
                      width: "62%",
                    }}
                  />
                  <div
                    className="relative grid"
                    style={{ gridTemplateColumns: "repeat(5, 1fr)" }}
                  >
                    {[
                      { label: "Intake", state: "done" },
                      { label: "Route", state: "done" },
                      { label: "Claim", state: "done" },
                      { label: "Review", state: "active" },
                      { label: "Ship", state: "idle" },
                    ].map((s) => (
                      <div
                        key={s.label}
                        className="flex flex-col items-center gap-2"
                        style={{ paddingTop: "18px" }}
                      >
                        <div
                          style={{
                            width: "16px",
                            height: "16px",
                            borderRadius: "999px",
                            zIndex: 1,
                            background:
                              s.state === "done"
                                ? "var(--accent)"
                                : "var(--bg-2)",
                            border:
                              s.state === "done"
                                ? "2px solid var(--accent)"
                                : s.state === "active"
                                ? "2px solid var(--accent)"
                                : "2px solid var(--line-2)",
                            boxShadow:
                              s.state === "active"
                                ? "0 0 0 4px rgba(0,135,90,0.2)"
                                : "none",
                          }}
                        />
                        <span
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: "10px",
                            letterSpacing: "0.05em",
                            textTransform: "uppercase",
                            color:
                              s.state === "idle"
                                ? "var(--ink-3)"
                                : "var(--ink)",
                          }}
                        >
                          {s.label}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Task list */}
                <div
                  style={{ marginTop: "22px", borderTop: "1px solid var(--line)" }}
                >
                  {[
                    {
                      id: "AGEA-41",
                      title: "Migrate auth handler to v2 API",
                      repo: "acme/payments",
                      status: "review",
                      statusLabel: "In review",
                      agent: "claude-code",
                    },
                    {
                      id: "AGEA-40",
                      title: "Fix flaky test in checkout suite",
                      repo: "acme/web",
                      status: "running",
                      statusLabel: "Running",
                      agent: "cursor-agent",
                    },
                    {
                      id: "AGEA-39",
                      title: "Add Linear webhook for billing events",
                      repo: "acme/billing",
                      status: "merged",
                      statusLabel: "Merged",
                      agent: "codex-prod",
                    },
                    {
                      id: "AGEA-38",
                      title: "Refactor rate limiter to token bucket",
                      repo: "acme/api",
                      status: "queued",
                      statusLabel: "Queued",
                      agent: "claude-code",
                    },
                  ].map((task, i, arr) => (
                    <div
                      key={task.id}
                      className="grid items-center gap-3.5"
                      style={{
                        gridTemplateColumns: "24px 1fr auto auto",
                        padding: "12px 4px",
                        borderBottom:
                          i < arr.length - 1
                            ? "1px solid var(--line)"
                            : "none",
                        fontSize: "13.5px",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "11px",
                          color: "var(--ink-3)",
                        }}
                      >
                        {task.id.split("-")[1]}
                      </span>
                      <div style={{ color: "var(--ink)" }}>
                        {task.title}
                        <span
                          style={{
                            color: "var(--ink-3)",
                            fontFamily: "var(--font-mono)",
                            fontSize: "11px",
                            marginLeft: "8px",
                          }}
                        >
                          {task.repo}
                        </span>
                      </div>
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "10px",
                          letterSpacing: "0.06em",
                          textTransform: "uppercase",
                          padding: "3px 7px",
                          borderRadius: "4px",
                          ...(task.status === "running"
                            ? {
                                color: "var(--accent)",
                                background: "rgba(0,135,90,0.08)",
                                border: "1px solid rgba(0,135,90,0.25)",
                              }
                            : task.status === "review"
                            ? {
                                color: "#ff5a3d",
                                background: "rgba(255,90,61,0.08)",
                                border: "1px solid rgba(255,90,61,0.28)",
                              }
                            : task.status === "merged"
                            ? {
                                color: "var(--ink-2)",
                                background: "rgba(12,20,32,0.04)",
                                border: "1px solid var(--line-2)",
                              }
                            : {
                                color: "var(--ink-3)",
                                background: "transparent",
                                border: "1px solid var(--line-2)",
                              }),
                        }}
                      >
                        {task.statusLabel}
                      </span>
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "11px",
                          color: "var(--ink-3)",
                          display: "flex",
                          alignItems: "center",
                        }}
                      >
                        <span
                          style={{
                            display: "inline-block",
                            width: "16px",
                            height: "16px",
                            borderRadius: "4px",
                            background:
                              "linear-gradient(135deg, #c4bdac, #8a8f93)",
                            marginRight: "6px",
                            border: "1px solid var(--line-2)",
                            flexShrink: 0,
                          }}
                        />
                        {task.agent}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Marquee strip ── */}
      <div
        aria-hidden="true"
        style={{
          borderTop: "1px solid var(--line)",
          borderBottom: "1px solid var(--line)",
          padding: "18px 0",
          overflow: "hidden",
          background: "rgba(12,20,32,0.03)",
        }}
      >
        <div
          className="animate-marquee"
          style={{
            display: "flex",
            gap: "56px",
            width: "max-content",
            fontFamily: "var(--font-mono)",
            fontSize: "11.5px",
            color: "var(--ink-3)",
            letterSpacing: "0.04em",
          }}
        >
          {[
            { glyph: "◆", text: "source-available" },
            { glyph: "◇", text: "custom license" },
            { glyph: "◆", text: "GitHub + Linear intake" },
            { glyph: "◇", text: "GitHub Actions + CircleCI" },
            { glyph: "◆", text: "rules-based routing" },
            { glyph: "◇", text: "structured CI feedback" },
            { glyph: "◆", text: "per-agent scoped auth" },
            { glyph: "◇", text: "SSE event stream · cloud" },
            { glyph: "◆", text: "TypeScript + Python SDK" },
            { glyph: "◇", text: "runs locally · bring your own keys" },
            // Duplicate for seamless loop
            { glyph: "◆", text: "source-available" },
            { glyph: "◇", text: "custom license" },
            { glyph: "◆", text: "GitHub + Linear intake" },
            { glyph: "◇", text: "GitHub Actions + CircleCI" },
            { glyph: "◆", text: "rules-based routing" },
            { glyph: "◇", text: "structured CI feedback" },
            { glyph: "◆", text: "per-agent scoped auth" },
            { glyph: "◇", text: "SSE event stream · cloud" },
            { glyph: "◆", text: "TypeScript + Python SDK" },
            { glyph: "◇", text: "runs locally · bring your own keys" },
          ].map((item, i) => (
            <span key={i} className="inline-flex items-center gap-3.5">
              <span style={{ color: "var(--accent)" }}>{item.glyph}</span>
              {item.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
