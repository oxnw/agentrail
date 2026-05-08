"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

type Stage = {
  num: string;
  name: string;
  titleHtml: string;
  blurb: string;
  code: string;
};

const STAGES: Stage[] = [
  {
    num: "01",
    name: "Intake",
    titleHtml: "Intake — <em>issues become tasks automatically</em>",
    blurb:
      "A GitHub Issue or Linear ticket arrives via webhook and becomes a structured AgentRail task — with a stable ID, typed payload, and routing decision already attached. No polling. No parsing.",
    code: `// GitHub / Linear webhook → task created automatically
{
  id: "tsk_8Hk2bV",
  identifier: "AGEA-41",
  title: "Migrate auth handler to v2 API",
  status: "todo",
  assigneeAgentId: "agt_claude-code",
  availableActions: ["start"],
}`,
  },
  {
    num: "02",
    name: "Route",
    titleHtml: "Route — <em>the right task to the right agent</em>",
    blurb:
      "Routing rules match incoming issues by label, project key, priority, or provider — and assign them to the right agent automatically. Configure via API or CLI, no YAML required.",
    code: `// Route Linear backend issues to claude-code
await agentrail.routingRules.create({
  conditions: {
    provider: "linear",
    labels: ["backend"],
    priority: "high",
  },
  target: { agentId: "agt_claude-code" },
});
// → AGEA-41 auto-assigned to claude-code`,
  },
  {
    num: "03",
    name: "Claim",
    titleHtml: "Claim — <em>the agent picks it up and starts</em>",
    blurb:
      "Agents poll for assigned work — or subscribe to push events via SSE on Cloud. Every task exposes availableActions — so the agent always knows exactly what to do next.",
    code: `// Agent polls for assigned work
const tasks = await client.getMyTasks({ status: "todo" });

await client.startTask(tasks[0].id, {
  idempotencyKey: "start-AGEA-41",
});
// → status = "in_progress"
// → availableActions = ["submit", "block"]`,
  },
  {
    num: "04",
    name: "Review",
    titleHtml: "Review — <em>CI and code review as typed events</em>",
    blurb:
      "GitHub Actions and CircleCI results come back as discriminated-union events with structured summaries. PR review comments come back severity-ranked — blocking vs. advisory. Push delivery via SSE available on Cloud.",
    code: `// CI + review signals as typed events (SSE on Cloud)
for await (const event of client.streamEvents()) {
  if (event.type === "ci_status_changed") {
    // Structured summary — not raw logs
    console.log(event.data.status, event.data.summary);
  }
  if (event.type === "review_feedback") {
    console.log(event.data.severity); // "blocking"
  }
}`,
  },
  {
    num: "05",
    name: "Ship",
    titleHtml: "Ship — <em>merge when it's ready</em>",
    blurb:
      "Once CI passes and review approves, the agent ships in one call. AgentRail merges via your branch protection policy and closes the upstream Linear or GitHub issue automatically.",
    code: `// Agent ships when CI passes + review approves
await client.shipTask(task.id, {
  idempotencyKey: "ship-AGEA-41",
});
// → status = "done"
// → GitHub PR merged
// → Linear issue closed`,
  },
];

function CodeBlock({ code }: { code: string }) {
  // Very simple syntax highlighting
  const highlighted = code
    .replace(/\/\/.*/g, (m) => `<span style="color:#6b716f;font-style:italic">${m}</span>`)
    .replace(/"([^"]*)"/g, '<span style="color:#c8ff3e">"$1"</span>')
    .replace(/\b(await|const|for|if|of)\b/g, '<span style="color:#c8a8ff">$1</span>');

  return (
    <pre
      style={{
        marginTop: "auto",
        background: "var(--code-bg)",
        border: "1px solid rgba(255,255,255,0.05)",
        borderRadius: "6px",
        padding: "16px 18px",
        fontFamily: "var(--font-mono)",
        fontSize: "12.5px",
        lineHeight: 1.7,
        color: "#a8aeac",
        whiteSpace: "pre",
        overflowX: "auto",
      }}
      dangerouslySetInnerHTML={{ __html: highlighted }}
    />
  );
}

export default function Lifecycle() {
  const [active, setActive] = useState(0);
  const stage = STAGES[active];

  return (
    <section
      id="lifecycle"
      style={{
        padding: "100px 0",
        borderTop: "1px solid var(--line)",
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
                03 / Task lifecycle
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
              Five stages.
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
                complete
              </em>{" "}
              loop.
            </h2>
          </div>
          <p style={{ fontSize: "17px", color: "var(--ink-2)", maxWidth: "540px" }}>
            Every task moves through five well-defined stages — from the moment
            a ticket arrives to the moment the PR merges. Transitions are
            atomic, idempotent, and observable at every step.
          </p>
        </div>

        {/* Lifecycle grid */}
        <div
          className="grid gap-16"
          style={{ gridTemplateColumns: "280px 1fr" }}
        >
          {/* Stage list */}
          <div
            style={{ borderTop: "1px solid var(--line)" }}
          >
            {STAGES.map((s, i) => (
              <button
                key={s.num}
                onClick={() => setActive(i)}
                className="w-full text-left"
                style={{
                  display: "grid",
                  gridTemplateColumns: "36px 1fr 14px",
                  gap: "16px",
                  alignItems: "center",
                  padding: "18px 4px",
                  borderBottom: "1px solid var(--line)",
                  cursor: "pointer",
                  background:
                    active === i ? "rgba(0,135,90,0.07)" : "transparent",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => {
                  if (active !== i)
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "rgba(12,20,32,0.03)";
                }}
                onMouseLeave={(e) => {
                  if (active !== i)
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "transparent";
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "11px",
                    color: active === i ? "var(--accent)" : "var(--ink-3)",
                  }}
                >
                  {s.num}
                </span>
                <span
                  style={{
                    fontSize: "16px",
                    fontWeight: 500,
                    letterSpacing: "-0.01em",
                    color: active === i ? "var(--ink)" : "var(--ink-2)",
                  }}
                >
                  {s.name}
                </span>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  style={{
                    color: active === i ? "var(--accent)" : "var(--ink-3)",
                    transform:
                      active === i ? "translateX(2px)" : "none",
                    transition: "transform 0.15s, color 0.15s",
                  }}
                >
                  <path d="M3 6h6m0 0L6 3m3 3L6 9" />
                </svg>
              </button>
            ))}
          </div>

          {/* Stage detail */}
          <AnimatePresence mode="wait">
            <motion.div
              key={active}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.25 }}
              style={{
                border: "1px solid var(--line)",
                borderRadius: "8px",
                padding: "32px",
                background: "var(--bg-2)",
                minHeight: "380px",
                display: "flex",
                flexDirection: "column",
                boxShadow: "0 1px 0 rgba(12,20,32,0.04)",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-serif)",
                  fontStyle: "italic",
                  fontSize: "64px",
                  fontWeight: 300,
                  color: "var(--accent)",
                  lineHeight: 1,
                  opacity: 0.5,
                }}
              >
                {stage.num}
              </div>
              <h3
                style={{
                  fontFamily: "var(--font-sans)",
                  fontWeight: 500,
                  fontSize: "32px",
                  letterSpacing: "-0.02em",
                  marginTop: "8px",
                  color: "var(--ink)",
                }}
                dangerouslySetInnerHTML={{
                  __html: stage.titleHtml.replace(
                    /<em>(.*?)<\/em>/g,
                    `<em style="font-family:var(--font-serif);font-style:italic;font-weight:300;color:var(--accent)">$1</em>`
                  ),
                }}
              />
              <p
                style={{
                  color: "var(--ink-2)",
                  fontSize: "15.5px",
                  marginTop: "14px",
                  maxWidth: "540px",
                }}
              >
                {stage.blurb}
              </p>
              <CodeBlock code={stage.code} />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}
