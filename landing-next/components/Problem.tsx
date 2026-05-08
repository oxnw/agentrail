"use client";

export default function Problem() {
  const problems = [
    {
      num: "i.",
      title: "No lifecycle, just a prompt and a prayer.",
      body: "Agents lose context between turns, retry on wrong commits, and re-ask the same questions because nothing tracks state across the issue → PR → merge loop.",
    },
    {
      num: "ii.",
      title: "Personal access tokens with full repo scope.",
      body: "Most agent stacks hand the developer's GitHub PAT straight to the agent — full org access, no expiry, no audit trail. One compromised run exposes everything.",
    },
    {
      num: "iii.",
      title: "CI is a wall, not a feedback loop.",
      body: "Test failures arrive as raw logs ten minutes after the agent moved on. There's no structured signal — the agent can't reason over a wall of text.",
    },
  ];

  return (
    <section
      id="problem"
      style={{
        background: "linear-gradient(180deg, transparent, rgba(12,20,32,0.025))",
        borderTop: "1px solid var(--line)",
        borderBottom: "1px solid var(--line)",
        padding: "100px 0",
      }}
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
                01 / The problem
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
                textWrap: "balance",
              }}
            >
              Coding agents are{" "}
              <em
                style={{
                  fontFamily: "var(--font-serif)",
                  fontStyle: "italic",
                  fontWeight: 300,
                  color: "var(--accent)",
                }}
              >
                brilliant
              </em>{" "}
              at writing code.
              <br />
              Less so at closing tickets.
            </h2>
          </div>
          <p
            style={{
              fontSize: "17px",
              color: "var(--ink-2)",
              maxWidth: "540px",
            }}
          >
            Today&apos;s coding agents handle the easy part — writing code. The
            hard part is everything around it: picking up the right ticket,
            watching CI, acting on review feedback, and merging cleanly. That
            loop is still broken.
          </p>
        </div>

        {/* Problem grid */}
        <div
          className="grid"
          style={{
            gridTemplateColumns: "repeat(3, 1fr)",
            borderLeft: "1px solid var(--line)",
          }}
        >
          {problems.map((p) => (
            <div
              key={p.num}
              className="relative flex flex-col justify-between"
              style={{
                borderRight: "1px solid var(--line)",
                padding: "36px 28px 40px",
                minHeight: "240px",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  right: "22px",
                  top: "22px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "10px",
                  color: "var(--ink-3)",
                  letterSpacing: "0.06em",
                }}
              >
                PROBLEM
              </span>
              <div>
                <div
                  style={{
                    fontFamily: "var(--font-serif)",
                    fontStyle: "italic",
                    fontSize: "36px",
                    color: "var(--accent)",
                    fontWeight: 300,
                  }}
                >
                  {p.num}
                </div>
                <h3
                  style={{
                    fontFamily: "var(--font-sans)",
                    fontWeight: 500,
                    fontSize: "22px",
                    lineHeight: 1.2,
                    letterSpacing: "-0.015em",
                    color: "var(--ink)",
                    marginTop: "16px",
                  }}
                >
                  {p.title}
                </h3>
                <p
                  style={{
                    color: "var(--ink-2)",
                    fontSize: "14.5px",
                    marginTop: "12px",
                  }}
                >
                  {p.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
