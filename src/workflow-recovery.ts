import type { WorkflowAgentSnapshot } from "./display.js";
import type { WorkflowError, WorkflowErrorCode } from "./errors.js";
import type { PersistedAgentState } from "./run-persistence.js";

export type WorkflowRecoveryStatus = "diagnosing" | "rerunning" | "recovered" | "unrecoverable" | "failed" | "skipped";

export interface WorkflowRecoveryState {
  attempts: number;
  maxAttempts: number;
  status: WorkflowRecoveryStatus;
  startedAt?: string;
  completedAt?: string;
  originalError?: string;
  originalErrorCode?: WorkflowErrorCode;
  reason?: string;
  strategy?: string;
  correctedWorkflowName?: string;
  lastError?: string;
}

export interface WorkflowRecoveryContext {
  script: string;
  args?: unknown;
  error: {
    message: string;
    code?: WorkflowErrorCode;
    recoverable?: boolean;
    agentLabel?: string;
  };
  logs: string[];
  agentFailures: Array<{
    id: number;
    label: string;
    phase?: string;
    prompt: string;
    error?: string;
    errorCode?: WorkflowErrorCode;
    recoverable?: boolean;
  }>;
}

export interface WorkflowRecoveryDecision {
  recoverable: boolean;
  reason: string;
  strategy?: string;
  correctedScript?: string;
}

export const RECOVERY_DECISION_SCHEMA = {
  type: "object",
  properties: {
    recoverable: { type: "boolean" },
    reason: { type: "string" },
    strategy: { type: "string" },
    correctedScript: { type: "string" },
  },
  required: ["recoverable", "reason"],
  additionalProperties: false,
};

const MAX_CONTEXT_CHARS = 32_000;
const MAX_SCRIPT_CHARS = 18_000;
const MAX_PROMPT_CHARS = 2_000;
const MAX_LOGS = 80;
const MAX_FAILURES = 30;

/**
 * A tiny workflow, run by the normal workflow runtime, that diagnoses a failed
 * workflow and returns a machine-readable recovery decision. Keeping this as a
 * workflow (rather than a direct model call) makes recovery visible in the same
 * event stream and keeps model routing/tooling semantics consistent.
 */
export function buildRecoveryWorkflowScript(): string {
  return `export const meta = { name: 'workflow_recovery_diagnosis', description: 'Diagnose a failed workflow and propose one safe corrected workflow', phases: [{ title: 'Diagnosis' }] }
phase('Diagnosis')
const context = JSON.stringify(args.context, null, 2).slice(0, ${MAX_CONTEXT_CHARS})
const decision = await agent(\`A deterministic Pi workflow failed before it could deliver a useful final result. Diagnose whether the user's task can still be satisfied by rewriting or adjusting the workflow, then return a JSON object matching the provided schema.

Inputs you must analyze:
- failed workflow script
- workflow args
- thrown error (message/code/recoverable/agent label)
- workflow logs
- failed agent diagnostics

Hard recovery rules:
- Set recoverable=false if the task cannot be satisfied by a workflow, if the failure was an intentional abort/stop/pause, or if a safe corrected workflow is not possible.
- If recoverable=true, correctedScript must be a complete raw JavaScript workflow script, not Markdown.
- The corrected script's first statement must be: export const meta = { name, description, phases? }.
- The corrected script must call agent() at least once, use unique 2-5 word labels, and tag every agent with tier: 'small' | 'medium' | 'big'.
- Keep the corrected workflow conservative: fewer agents, bounded fan-out, no infinite loops, no nested recovery, no wall-clock timestamps, no randomness, no imports/require/fs/network in script code.
- If the original failed because an agent result can be null, make the corrected workflow explicitly handle nulls.
- If the original failed from syntax/validation, produce a syntactically valid deterministic workflow.

Return only the schema fields. The reason should explain why recovery can or cannot satisfy the task. The strategy should summarize the rewrite.

Failure context:
\${context}\`, { label: 'recovery diagnosis', tier: 'medium', schema: ${JSON.stringify(RECOVERY_DECISION_SCHEMA)} })
return decision`;
}

export function buildRecoveryContext(params: {
  script: string;
  args?: unknown;
  error: WorkflowError;
  logs: string[];
  agents: Array<WorkflowAgentSnapshot | PersistedAgentState>;
}): WorkflowRecoveryContext {
  return {
    script: truncate(params.script, MAX_SCRIPT_CHARS),
    args: params.args,
    error: {
      message: params.error.message,
      code: params.error.code,
      recoverable: params.error.recoverable,
      agentLabel: params.error.agentLabel,
    },
    logs: params.logs.slice(-MAX_LOGS).map((line) => truncate(line, 1_000)),
    agentFailures: params.agents
      .filter((agent) => agent.status === "error" || agent.error)
      .slice(-MAX_FAILURES)
      .map((agent) => ({
        id: agent.id,
        label: agent.label,
        phase: agent.phase,
        prompt: truncate(agent.prompt, MAX_PROMPT_CHARS),
        error: agent.error,
        errorCode: agent.errorCode,
        recoverable: agent.recoverable,
      })),
  };
}

export function normalizeRecoveryDecision(value: unknown): WorkflowRecoveryDecision | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.recoverable !== "boolean") return null;
  if (typeof obj.reason !== "string" || !obj.reason.trim()) return null;
  const decision: WorkflowRecoveryDecision = {
    recoverable: obj.recoverable,
    reason: obj.reason.trim(),
  };
  if (typeof obj.strategy === "string" && obj.strategy.trim()) decision.strategy = obj.strategy.trim();
  if (typeof obj.correctedScript === "string" && obj.correctedScript.trim()) {
    decision.correctedScript = stripMarkdownFence(obj.correctedScript.trim());
  }
  return decision;
}

function stripMarkdownFence(script: string): string {
  const fence = script.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  return fence ? fence[1].trim() : script;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
}
