/**
 * Workflow manager for background execution, pause/resume, and run management.
 */

import { EventEmitter } from "node:events";
import type { WorkflowSnapshot } from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import {
  createRunPersistence,
  generateRunId,
  type PersistedRunState,
  type RunPersistence,
  type RunStatus,
} from "./run-persistence.js";
import { type JournalEntry, parseWorkflowScript, runWorkflow, type WorkflowRunResult } from "./workflow.js";

export interface ManagedRun {
  runId: string;
  status: RunStatus;
  snapshot: WorkflowSnapshot;
  result?: WorkflowRunResult;
  error?: WorkflowError;
  controller: AbortController;
  startedAt: Date;
  /** The real script, kept so the run can be resumed. */
  script: string;
  args?: unknown;
  /** Accumulated agent results for resume (deterministic call index -> result). */
  journal: JournalEntry[];
}

export interface WorkflowManagerOptions {
  cwd?: string;
  concurrency?: number;
}

export class WorkflowManager extends EventEmitter {
  private runs = new Map<string, ManagedRun>();
  private persistence: RunPersistence;
  private cwd: string;
  private concurrency: number;

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = options.concurrency ?? 8;
    this.persistence = createRunPersistence(this.cwd);
  }

  /**
   * Start a workflow in the background.
   * Returns immediately with a run ID; the workflow executes asynchronously.
   */
  startInBackground(script: string, args?: unknown): { runId: string; promise: Promise<WorkflowRunResult> } {
    const runId = generateRunId();
    const controller = new AbortController();
    const parsed = parseWorkflowScript(script);

    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller,
      startedAt: new Date(),
      script,
      args,
      journal: [],
    };

    this.runs.set(runId, managed);

    // Persist initial state
    this.persistence.save({
      runId,
      workflowName: parsed.meta.name,
      script,
      args,
      status: "running",
      phases: managed.snapshot.phases,
      agents: [],
      logs: [],
      startedAt: managed.startedAt.toISOString(),
      updatedAt: managed.startedAt.toISOString(),
    });

    // Run workflow asynchronously
    const promise = this.executeRun(managed, script, args);

    return { runId, promise };
  }

  /**
   * Execute a workflow synchronously (blocking).
   */
  async runSync(script: string, args?: unknown): Promise<WorkflowRunResult> {
    const runId = generateRunId();
    const controller = new AbortController();
    const parsed = parseWorkflowScript(script);

    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller,
      startedAt: new Date(),
      script,
      args,
      journal: [],
    };

    this.runs.set(runId, managed);
    return this.executeRun(managed, script, args);
  }

  private async executeRun(
    managed: ManagedRun,
    script: string,
    args?: unknown,
    resumeJournal?: Map<number, JournalEntry>,
  ): Promise<WorkflowRunResult> {
    try {
      const result = await runWorkflow(script, {
        cwd: this.cwd,
        args,
        signal: managed.controller.signal,
        concurrency: this.concurrency,
        resumeJournal,
        resumeFromRunId: resumeJournal ? managed.runId : undefined,
        onAgentJournal: (entry) => {
          // Append (crash-safe-ish): keep the latest entry per index, then persist.
          managed.journal = managed.journal.filter((e) => e.index !== entry.index);
          managed.journal.push(entry);
          this.persistRun(managed);
        },
        onLog: (message) => {
          managed.snapshot.logs.push(message);
          this.emit("log", { runId: managed.runId, message });
        },
        onPhase: (title) => {
          managed.snapshot.currentPhase = title;
          if (!managed.snapshot.phases.includes(title)) {
            managed.snapshot.phases.push(title);
          }
          this.emit("phase", { runId: managed.runId, title });
        },
        onAgentStart: (event) => {
          managed.snapshot.agents.push({
            id: managed.snapshot.agents.length + 1,
            label: event.label,
            phase: event.phase,
            prompt: event.prompt,
            status: "running",
          });
          this.emit("agentStart", { runId: managed.runId, ...event });
        },
        onAgentEnd: (event) => {
          const agent = [...managed.snapshot.agents]
            .reverse()
            .find((a) => a.label === event.label && a.status === "running");
          if (agent) {
            agent.status = event.result === null ? "error" : "done";
          }
          this.emit("agentEnd", { runId: managed.runId, ...event });
        },
      });

      managed.status = "completed";
      managed.result = result;
      this.emit("complete", { runId: managed.runId, result });

      // Persist final state
      this.persistRun(managed);

      return result;
    } catch (error) {
      const workflowError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(
              error instanceof Error ? error.message : String(error),
              WorkflowErrorCode.WORKFLOW_ABORTED,
              { recoverable: true },
            );

      if (managed.controller.signal.aborted) {
        managed.status = "aborted";
      } else {
        managed.status = "failed";
      }
      managed.error = workflowError;
      this.emit("error", { runId: managed.runId, error: workflowError });

      // Persist final state
      this.persistRun(managed);

      throw workflowError;
    }
  }

  private persistRun(managed: ManagedRun) {
    this.persistence.save({
      runId: managed.runId,
      workflowName: managed.snapshot.name,
      // Persist the real script + journal so the run can be resumed. Runs live
      // under .pi/workflows/runs/ — protect via directory permissions, not blanking.
      script: managed.script,
      args: managed.args,
      journal: managed.journal,
      status: managed.status,
      phases: managed.snapshot.phases,
      currentPhase: managed.snapshot.currentPhase,
      agents: managed.snapshot.agents.map((a) => ({
        ...a,
        startedAt: managed.startedAt.toISOString(),
        endedAt: new Date().toISOString(),
      })),
      logs: managed.snapshot.logs,
      result: managed.result?.result,
      startedAt: managed.startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: managed.status === "completed" ? new Date().toISOString() : undefined,
      durationMs: managed.result?.durationMs,
    });
  }

  /**
   * Pause a running workflow.
   */
  pause(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed?.status !== "running") return false;

    managed.controller.abort();
    managed.status = "paused";
    this.emit("paused", { runId });
    this.persistRun(managed);
    return true;
  }

  /**
   * Resume an interrupted run: replay journaled results for the unchanged prefix
   * and run the rest live. Returns false if there is nothing resumable.
   */
  async resume(runId: string): Promise<boolean> {
    const active = this.runs.get(runId);
    if (active?.status === "running") return false; // already running

    const persisted = this.persistence.load(runId);
    if (!persisted?.script || persisted.status === "completed") return false;

    const controller = new AbortController();
    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: persisted.workflowName,
        phases: persisted.phases ?? [],
        logs: persisted.logs ?? [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller,
      startedAt: new Date(),
      script: persisted.script,
      args: persisted.args,
      journal: persisted.journal ?? [],
    };
    this.runs.set(runId, managed);

    const resumeJournal = new Map((persisted.journal ?? []).map((e) => [e.index, e] as const));
    this.emit("resumed", { runId });
    // Run in the background; executeRun records status/errors on the managed run.
    void this.executeRun(managed, persisted.script, persisted.args, resumeJournal).catch(() => {});
    return true;
  }

  /**
   * Stop a running workflow.
   */
  stop(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (!managed || (managed.status !== "running" && managed.status !== "paused")) return false;

    managed.controller.abort();
    managed.status = "aborted";
    this.emit("stopped", { runId });
    this.persistRun(managed);
    return true;
  }

  /**
   * Get status of a specific run.
   */
  getRun(runId: string): ManagedRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * List all runs (active + persisted).
   */
  listRuns(): PersistedRunState[] {
    return this.persistence.list();
  }

  /**
   * Get snapshot of a run.
   */
  getSnapshot(runId: string): WorkflowSnapshot | null {
    return this.runs.get(runId)?.snapshot ?? null;
  }

  /**
   * Delete a persisted run.
   */
  deleteRun(runId: string): boolean {
    this.runs.delete(runId);
    return this.persistence.delete(runId);
  }

  /**
   * Get the persistence layer (for saving workflows).
   */
  getPersistence(): RunPersistence {
    return this.persistence;
  }
}
