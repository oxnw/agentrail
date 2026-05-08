export default function SDK() {
  return (
    <section
      id="sdk"
      style={{
        padding: "120px 0",
        borderTop: "1px solid var(--line)",
      }}
    >
      <div className="max-w-[1320px] mx-auto px-8">
        <div
          className="grid gap-20 items-center"
          style={{ gridTemplateColumns: "1fr 1.2fr" }}
        >
          {/* Left: copy */}
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
                04 / SDK
              </span>
            </div>
            <h2
              style={{
                fontFamily: "var(--font-sans)",
                fontWeight: 400,
                fontSize: "clamp(36px, 4vw, 52px)",
                lineHeight: 1.0,
                letterSpacing: "-0.025em",
                color: "var(--ink)",
              }}
            >
              A{" "}
              <em
                style={{
                  fontFamily: "var(--font-serif)",
                  fontStyle: "italic",
                  fontWeight: 300,
                  color: "var(--accent)",
                }}
              >
                typed
              </em>{" "}
              SDK,
              <br />
              not a wrapper.
            </h2>
            <p
              style={{
                fontSize: "17px",
                color: "var(--ink-2)",
                marginTop: "24px",
                maxWidth: "480px",
              }}
            >
              First-class TypeScript and Python clients generated from the
              OpenAPI contract — streaming, retries, and idempotency baked in.
              Every event is a typed discriminated union — no{" "}
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "13px",
                  color: "var(--accent)",
                  background: "var(--bg-3)",
                  padding: "1px 6px",
                  borderRadius: "3px",
                }}
              >
                any
              </code>{" "}
              escape hatches. Runs locally against your own keys with no
              external dependency.
            </p>
            <div
              className="flex gap-6 mt-8"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                color: "var(--ink-3)",
                letterSpacing: "0.04em",
              }}
            >
              <span>◆ TypeScript 5.4+</span>
              <span>◇ Python 3.10+</span>
              <span>◆ ESM &amp; CJS</span>
            </div>
          </div>

          {/* Right: code window */}
          <div
            style={{
              border: "1px solid #0a0b0a",
              borderRadius: "10px",
              overflow: "hidden",
              background: "var(--code-bg)",
              boxShadow: "0 30px 60px -30px rgba(12,20,32,0.5)",
            }}
          >
            {/* Tabs */}
            <div
              style={{
                display: "flex",
                borderBottom: "1px solid #0a0b0a",
                background: "#0d0e0d",
              }}
            >
              {["index.ts", "agent.py", "schema.ts"].map((tab, i) => (
                <div
                  key={tab}
                  style={{
                    padding: "11px 18px",
                    fontFamily: "var(--font-mono)",
                    fontSize: "11.5px",
                    letterSpacing: "0.04em",
                    color: i === 0 ? "var(--code-ink)" : "#6b716f",
                    background: i === 0 ? "var(--code-bg)" : "transparent",
                    borderRight: "1px solid #232624",
                    position: "relative",
                  }}
                >
                  {tab}
                  {i === 0 && (
                    <span
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        bottom: "-1px",
                        height: "1px",
                        background: "#c8ff3e",
                        display: "block",
                      }}
                    />
                  )}
                </div>
              ))}
            </div>

            {/* Code body */}
            <pre
              style={{
                padding: "22px 24px 26px",
                fontFamily: "var(--font-mono)",
                fontSize: "13px",
                lineHeight: 1.75,
                color: "var(--code-ink)",
                whiteSpace: "pre",
                overflowX: "auto",
                margin: 0,
              }}
            >
              <span style={{ display: "block" }}>
                <span style={{ color: "#c8a8ff" }}>import</span>
                {" { AgentRailClient } "}
                <span style={{ color: "#c8a8ff" }}>from</span>
                {" "}
                <span style={{ color: "#c8ff3e" }}>&quot;agentrail&quot;</span>
                <span style={{ color: "#a8aeac" }}>;</span>
              </span>
              <span style={{ display: "block" }}>&nbsp;</span>
              <span style={{ display: "block" }}>
                <span style={{ color: "#c8a8ff" }}>const</span>
                {" client "}
                <span style={{ color: "#a8aeac" }}>=</span>
                {" "}
                <span style={{ color: "#c8a8ff" }}>new</span>
                {" "}
                <span style={{ color: "#7ad4ff" }}>AgentRailClient</span>
                <span style={{ color: "#a8aeac" }}>(&#123;</span>
              </span>
              <span style={{ display: "block" }}>
                {"  baseUrl"}
                <span style={{ color: "#a8aeac" }}>:</span>
                {" "}
                <span style={{ color: "#c8ff3e" }}>&quot;http://127.0.0.1:3000&quot;</span>
                <span style={{ color: "#a8aeac" }}>,</span>
              </span>
              <span style={{ display: "block" }}>
                {"  apiKey"}
                <span style={{ color: "#a8aeac" }}>:</span>
                {" process"}
                <span style={{ color: "#a8aeac" }}>.</span>
                {"env"}
                <span style={{ color: "#a8aeac" }}>.</span>
                {"AGENTRAIL_API_KEY"}
                <span style={{ color: "#a8aeac" }}>,</span>
              </span>
              <span style={{ display: "block" }}>
                <span style={{ color: "#a8aeac" }}>&#125;);</span>
              </span>
              <span style={{ display: "block" }}>&nbsp;</span>
              <span style={{ display: "block" }}>
                <span style={{ color: "#6b716f", fontStyle: "italic" }}>
                  {"// React to typed CI and review events (Cloud — SSE push)"}
                </span>
              </span>
              <span style={{ display: "block" }}>
                <span style={{ color: "#c8a8ff" }}>for</span>
                {" "}
                <span style={{ color: "#c8a8ff" }}>await</span>
                {" "}
                <span style={{ color: "#a8aeac" }}>(</span>
                <span style={{ color: "#c8a8ff" }}>const</span>
                {" event "}
                <span style={{ color: "#c8a8ff" }}>of</span>
                {" client"}
                <span style={{ color: "#a8aeac" }}>.</span>
                <span style={{ color: "#f0e6d2" }}>streamEvents</span>
                <span style={{ color: "#a8aeac" }}>()) &#123;</span>
              </span>
              <span style={{ display: "block" }}>
                {"  "}
                <span style={{ color: "#c8a8ff" }}>switch</span>
                {" "}
                <span style={{ color: "#a8aeac" }}>(</span>
                {"event"}
                <span style={{ color: "#a8aeac" }}>.</span>
                {"type"}
                <span style={{ color: "#a8aeac" }}>) &#123;</span>
              </span>
              <span style={{ display: "block" }}>
                {"    "}
                <span style={{ color: "#c8a8ff" }}>case</span>
                {" "}
                <span style={{ color: "#c8ff3e" }}>&quot;ci_status_changed&quot;</span>
                <span style={{ color: "#a8aeac" }}>:</span>
              </span>
              <span style={{ display: "block" }}>
                {"      "}
                <span style={{ color: "#6b716f", fontStyle: "italic" }}>
                  {"// Structured summary — not raw log scraping"}
                </span>
              </span>
              <span style={{ display: "block" }}>
                {"      "}
                <span style={{ color: "#f0e6d2" }}>console</span>
                <span style={{ color: "#a8aeac" }}>.</span>
                <span style={{ color: "#f0e6d2" }}>log</span>
                <span style={{ color: "#a8aeac" }}>(</span>
                {"event"}
                <span style={{ color: "#a8aeac" }}>.</span>
                {"data"}
                <span style={{ color: "#a8aeac" }}>.</span>
                {"status"}
                <span style={{ color: "#a8aeac" }}>,</span>
                {" event"}
                <span style={{ color: "#a8aeac" }}>.</span>
                {"data"}
                <span style={{ color: "#a8aeac" }}>.</span>
                {"summary"}
                <span style={{ color: "#a8aeac" }}>);</span>
              </span>
              <span style={{ display: "block" }}>
                {"      "}
                <span style={{ color: "#c8a8ff" }}>break</span>
                <span style={{ color: "#a8aeac" }}>;</span>
              </span>
              <span style={{ display: "block" }}>
                {"    "}
                <span style={{ color: "#c8a8ff" }}>case</span>
                {" "}
                <span style={{ color: "#c8ff3e" }}>&quot;review_feedback&quot;</span>
                <span style={{ color: "#a8aeac" }}>:</span>
              </span>
              <span style={{ display: "block" }}>
                {"      "}
                <span style={{ color: "#6b716f", fontStyle: "italic" }}>
                  {"// Severity-ranked: \"blocking\" | \"advisory\""}
                </span>
              </span>
              <span style={{ display: "block" }}>
                {"      "}
                <span style={{ color: "#f0e6d2" }}>console</span>
                <span style={{ color: "#a8aeac" }}>.</span>
                <span style={{ color: "#f0e6d2" }}>log</span>
                <span style={{ color: "#a8aeac" }}>(</span>
                {"event"}
                <span style={{ color: "#a8aeac" }}>.</span>
                {"data"}
                <span style={{ color: "#a8aeac" }}>.</span>
                {"severity"}
                <span style={{ color: "#a8aeac" }}>,</span>
                {" event"}
                <span style={{ color: "#a8aeac" }}>.</span>
                {"data"}
                <span style={{ color: "#a8aeac" }}>.</span>
                {"comments"}
                <span style={{ color: "#a8aeac" }}>);</span>
              </span>
              <span style={{ display: "block" }}>
                {"      "}
                <span style={{ color: "#c8a8ff" }}>break</span>
                <span style={{ color: "#a8aeac" }}>;</span>
              </span>
              <span style={{ display: "block" }}>
                {"  "}
                <span style={{ color: "#a8aeac" }}>&#125;</span>
              </span>
              <span style={{ display: "block" }}>
                <span style={{ color: "#a8aeac" }}>&#125;</span>
              </span>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}
