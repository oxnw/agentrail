"use client";

import Nav from "@/components/Nav";
import Hero from "@/components/Hero";
import Problem from "@/components/Problem";
import BeforeAfter from "@/components/BeforeAfter";
import LogoCloud from "@/components/LogoCloud";
import Capabilities from "@/components/Capabilities";
import Lifecycle from "@/components/Lifecycle";
import SDK from "@/components/SDK";
import Compare from "@/components/Compare";
import CTA from "@/components/CTA";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Problem />
        <BeforeAfter />
        <LogoCloud />
        <Capabilities />
        <Lifecycle />
        <SDK />

        {/* 05 / Availability metrics */}
        <section
          id="metrics"
          style={{ padding: "100px 0", borderTop: "1px solid var(--line)" }}
        >
          <div className="max-w-[1320px] mx-auto px-8">
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
                    05 / Availability
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
                  What ships today.
                  <br />
                  What waits for{" "}
                  <em
                    style={{
                      fontFamily: "var(--font-serif)",
                      fontStyle: "italic",
                      fontWeight: 300,
                      color: "var(--accent)",
                    }}
                  >
                    Cloud.
                  </em>
                </h2>
              </div>
              <p
                style={{
                  fontSize: "17px",
                  color: "var(--ink-2)",
                  maxWidth: "540px",
                }}
              >
                The open-source package separates what ships now from planned
                managed features. Cloud roadmap items are waitlist-only until the
                hosted service is ready.
              </p>
            </div>

            <div
              className="grid"
              style={{
                gridTemplateColumns: "repeat(4, 1fr)",
                borderTop: "1px solid var(--line)",
                borderLeft: "1px solid var(--line)",
              }}
            >
              {[
                {
                  word: "Today",
                  desc: "GitHub, Linear, CircleCI, and GitHub Actions integrations ship in the open-source package. Install and run in minutes.",
                  src: "OSS package",
                },
                {
                  word: "Typed",
                  desc: "Every task, event, and CI result is a typed discriminated union. Agents reason over data structures, not raw text.",
                  src: "TypeScript + Python SDKs",
                },
                {
                  word: "Scoped",
                  desc: "Per-agent API keys with narrow scopes replace org-wide PATs. Each agent sees only what its tasks require.",
                  src: "OSS credential model",
                },
                {
                  word: null,
                  wordEm: "Waitlist",
                  desc: "Hosted Cloud — team workspaces, managed integrations, dashboards, and compliance — is on the roadmap. Join the list.",
                  src: "Cloud roadmap",
                },
              ].map((m, i) => (
                <div
                  key={i}
                  style={{
                    borderRight: "1px solid var(--line)",
                    borderBottom: "1px solid var(--line)",
                    padding: "32px 28px",
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--font-sans)",
                      fontWeight: 300,
                      fontSize: "clamp(34px, 4vw, 48px)",
                      letterSpacing: "-0.025em",
                      lineHeight: 1,
                      color: "var(--ink)",
                    }}
                  >
                    {m.wordEm ? (
                      <em
                        style={{
                          fontFamily: "var(--font-serif)",
                          fontStyle: "italic",
                          color: "var(--accent)",
                          fontWeight: 300,
                        }}
                      >
                        {m.wordEm}
                      </em>
                    ) : (
                      m.word
                    )}
                  </div>
                  <p
                    style={{
                      color: "var(--ink-2)",
                      fontSize: "13.5px",
                      marginTop: "14px",
                      maxWidth: "220px",
                    }}
                  >
                    {m.desc}
                  </p>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "10px",
                      color: "var(--ink-3)",
                      marginTop: "10px",
                      letterSpacing: "0.04em",
                    }}
                  >
                    {m.src}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <Compare />

        {/* Quote */}
        <section
          style={{
            padding: "120px 0",
            borderTop: "1px solid var(--line)",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <div
            className="max-w-[1320px] mx-auto px-8 grid gap-12 items-center"
            style={{ gridTemplateColumns: "200px 1fr 200px" }}
          >
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                color: "var(--ink-3)",
                letterSpacing: "0.06em",
              }}
            >
              07&nbsp;/&nbsp;Field notes
            </div>
            <blockquote
              style={{
                fontFamily: "var(--font-serif)",
                fontStyle: "italic",
                fontWeight: 300,
                fontSize: "clamp(28px, 3vw, 40px)",
                lineHeight: 1.25,
                color: "var(--accent)",
                letterSpacing: "-0.01em",
                textWrap: "balance",
              }}
            >
              <span
                style={{
                  fontStyle: "normal",
                  fontFamily: "var(--font-sans)",
                  opacity: 0.4,
                }}
              >
                &ldquo;
              </span>
              The bottleneck isn&apos;t AI writing code. It&apos;s AI navigating
              the systems around code — the tickets, the CI, the reviews, the
              merge. That&apos;s the loop AgentRail closes.
              <span
                style={{
                  fontStyle: "normal",
                  fontFamily: "var(--font-sans)",
                  opacity: 0.4,
                }}
              >
                &rdquo;
              </span>
            </blockquote>
            <div />
          </div>
        </section>

        <CTA />
      </main>
      <Footer />
    </>
  );
}
