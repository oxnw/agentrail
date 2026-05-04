import { TaskPriority, TaskStatus } from "./types";

// Maps GitHub label names (lowercase) to AgentRail priority
const PRIORITY_LABEL_MAP: Record<string, TaskPriority> = {
  "priority: critical": "critical",
  "priority:critical": "critical",
  "critical": "critical",
  "p0": "critical",
  "priority: high": "high",
  "priority:high": "high",
  "high": "high",
  "p1": "high",
  "priority: medium": "medium",
  "priority:medium": "medium",
  "medium": "medium",
  "p2": "medium",
  "priority: low": "low",
  "priority:low": "low",
  "low": "low",
  "p3": "low",
};

// Maps GitHub issue state + labels to AgentRail status
const STATUS_LABEL_MAP: Record<string, TaskStatus> = {
  "in progress": "in_progress",
  "in-progress": "in_progress",
  "wip": "in_progress",
  "in review": "in_review",
  "in-review": "in_review",
  "needs review": "in_review",
  "needs-review": "in_review",
  "blocked": "blocked",
  "done": "done",
};

export function mapPriority(labels: string[]): TaskPriority {
  for (const label of labels) {
    const normalized = label.toLowerCase().trim();
    if (PRIORITY_LABEL_MAP[normalized]) {
      return PRIORITY_LABEL_MAP[normalized];
    }
  }
  return "medium";
}

export function mapStatus(state: string, labels: string[]): TaskStatus {
  if (state === "closed") return "done";

  for (const label of labels) {
    const normalized = label.toLowerCase().trim();
    if (STATUS_LABEL_MAP[normalized]) {
      return STATUS_LABEL_MAP[normalized];
    }
  }
  return "todo";
}

// Extracts acceptance criteria from issue body (looks for checklist or AC section)
export function extractAcceptanceCriteria(body: string | null): string[] {
  if (!body) return [];

  const criteria: string[] = [];

  // Match "## Acceptance Criteria" or "## AC" sections and extract checklist items
  const acSectionMatch = body.match(
    /#+\s*(acceptance criteria|ac|done when|definition of done)[^\n]*\n([\s\S]*?)(?=\n#+|$)/i
  );

  if (acSectionMatch) {
    const section = acSectionMatch[2];
    const lines = section.split("\n");
    for (const line of lines) {
      const checklistMatch = line.match(/^\s*-\s*\[[ xX]\]\s*(.+)/);
      if (checklistMatch) {
        criteria.push(checklistMatch[1].trim());
      } else {
        const bulletMatch = line.match(/^\s*[-*]\s+(.+)/);
        if (bulletMatch) {
          criteria.push(bulletMatch[1].trim());
        }
      }
    }
    return criteria;
  }

  // Fallback: any checklist items in the body
  const checklistMatches = body.matchAll(/^\s*-\s*\[[ xX]\]\s*(.+)/gm);
  for (const match of checklistMatches) {
    criteria.push(match[1].trim());
  }

  return criteria;
}

export function computeAvailableActions(status: TaskStatus): string[] {
  const base = ["GET /tasks/{id}"];
  switch (status) {
    case "todo":
    case "in_progress":
      return [...base, "POST /tasks/{id}/submit"];
    case "in_review":
      return [...base, "GET /tasks/{id}/review-feedback", "POST /tasks/{id}/ship"];
    case "done":
      return [...base];
    case "blocked":
      return [...base];
    default:
      return base;
  }
}
