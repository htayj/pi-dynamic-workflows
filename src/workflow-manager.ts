/**
 * Workflow manager for background execution, pause/resume, and run management.
 */

import { EventEmitter } from "node:events";
import type { WorkflowAgent } from "./agent.js";
import { preview, type WorkflowSnapshot } from "./display.js";
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import {
  createRunPersistence,
  generateRunId,
  type PersistedRunState,
  type RunLease,
  type RunPersistence,
  type RunStatus,
} from "./run-persistence.js";
import {
  type JournalEntry,
  parseWorkflowScript,
  runWorkflow,
  type WorkflowMeta,
  type WorkflowRunResult,
} from "./workflow.js";
import {
  buildRecoveryContext,
  buildRecoveryWorkflowScript,
  normalizeRecoveryDecision,
  type WorkflowRecoveryState,
} from "./workflow-recovery.js";

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
  /** Automatic self-recovery state, persisted for /workflows visibility. */
  recovery?: WorkflowRecoveryState;
  /** Cross-process execution lease for this run, when it is actively executing. */
  lease?: RunLease;
  /**
   * True when the run was started in the background (or resumed) and the caller is
   * not awaiting its result inline. Only background runs deliver their result back
   * into the conversation; a foreground sync run already returns it as the tool
   * result, so re-delivering would duplicate it.
   */
  background: boolean;
}

/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
  /** Replay these journaled agent results for the unchanged prefix (resume). */
  resumeJournal?: Map<number, JournalEntry>;
  /** Cap on total agents for this run. */
  maxAgents?: number;
  /** Per-agent timeout in milliseconds. */
  agentTimeoutMs?: number;
  /** Host signal (e.g. tool/Esc) that should abort this run when fired. */
  externalSignal?: AbortSignal;
  /** Called with the live snapshot on every progress event. */
  onProgress?: (snapshot: WorkflowSnapshot) => void;
  /** Hard token budget for this run; once spent reaches it, agent() throws. */
  tokenBudget?: number | null;
  /** Resolve a checkpoint() question with a human reply (only for UI-bearing runs). */
  confirm?: (promptText: string, options: unknown) => Promise<unknown>;
  /** Automatic self-recovery attempts after a run failure. Default: 1. */
  maxRecoveryAttempts?: number;
}

export interface WorkflowManagerOptions {
  cwd?: string;
  concurrency?: number;
  /** Resolve a saved-workflow name to its script, enabling nested `workflow('name')`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /** Inject a custom agent runner (tests); defaults to a real subagent session. */
  agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  mainModel?: string;
  /** The pi session id to tag runs with (see setSessionId). */
  sessionId?: string;
}

export class WorkflowManager extends EventEmitter {
  private runs = new Map<string, ManagedRun>();
  private persistence: RunPersistence;
  private cwd: string;
  private concurrency: number;
  private loadSavedWorkflow?: (name: string) => string | undefined;
  private agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  private mainModel?: string;
  /** The current pi session id; runs are stamped with it and listRuns() filters by it. */
  private sessionId?: string;

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.agent = options.agent;
    this.mainModel = options.mainModel;
    this.sessionId = options.sessionId;
    this.persistence = createRunPersistence(this.cwd);
    this.recoverStaleRuns();
  }

  /** Bind the manager to the current pi session, so new runs are tagged with it and
   * the navigator/task-panel show only this session's runs (set on session_start). */
  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  /**
   * On startup, any persisted run still marked "running" belongs to a process
   * that died mid-run (this fresh manager has it nowhere in memory). Reconcile it
   * to "paused" — never "failed" — so its journal is preserved and resume() can
   * replay the completed prefix and finish the rest.
   */
  private recoverStaleRuns(): void {
    try {
      for (const p of this.listAllRuns()) {
        if (p.status === "running" && !this.runs.has(p.runId)) {
          const lease = this.persistence.acquireRunLease(p.runId);
          if (!lease) continue;
          try {
            this.persistence.save({ ...p, status: "paused" });
          } finally {
            this.persistence.releaseRunLease(lease);
          }
        }
      }
    } catch {
      // Recovery is best-effort; never let it block manager construction.
    }
  }

  /** Set the session's main model (provider/id). Used to auto-tier explore agents. */
  setMainModel(spec: string | undefined): void {
    this.mainModel = spec;
  }

  /**
   * Start a workflow in the background.
   * Returns immediately with a run ID; the workflow executes asynchronously.
   */
  startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const runId = generateRunId();
    const controller = new AbortController();
    const meta = safeParseWorkflowMeta(script);
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${runId}`);

    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: createInitialSnapshot(meta),
      controller,
      startedAt: new Date(),
      script,
      args,
      journal: [],
      background: true,
      lease,
    };

    this.runs.set(runId, managed);

    try {
      // Persist initial state
      this.persistence.save({
        runId,
        workflowName: meta.name,
        script,
        args,
        sessionId: this.sessionId,
        status: "running",
        phases: managed.snapshot.phases,
        agents: [],
        logs: [],
        startedAt: managed.startedAt.toISOString(),
        updatedAt: managed.startedAt.toISOString(),
      });
    } catch (err) {
      this.releaseRunLease(managed);
      this.runs.delete(runId);
      throw err;
    }

    // Run workflow asynchronously.
    // Attach a side-channel catch to prevent Node.js unhandled-rejection crashes
    // when a workflow is aborted/paused/stopped — executeRun()'s catch block
    // already records status/event/persist, but the promise still rejects.
    // The original promise is returned so callers can await it in try/catch.
    const promise = this.executeRun(managed, script, args, exec);
    promise.catch(() => {});

    return { runId, promise };
  }

  /**
   * Execute a workflow synchronously (blocking) while still tracking it like a
   * background run, so the `/workflows` navigator and the live task panel see it.
   * `onProgress` fires on every progress event with the current snapshot, letting
   * a caller (e.g. the workflow tool) drive its own inline display.
   */
  async runSync(script: string, args?: unknown, exec: ExecOptions = {}): Promise<WorkflowRunResult> {
    const managed = this.createManaged(script, args);
    const lease = this.persistence.acquireRunLease(managed.runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${managed.runId}`);
    managed.lease = lease;
    this.runs.set(managed.runId, managed);
    // Persist the initial state immediately so listRuns()/the task panel can see
    // the run the moment it starts, not only after the first agent journals.
    this.persistRun(managed);
    return this.executeRun(managed, script, args, exec);
  }

  /** Build a fresh managed run with an empty snapshot. */
  private createManaged(script: string, args?: unknown): ManagedRun {
    const meta = safeParseWorkflowMeta(script);
    return {
      runId: generateRunId(),
      status: "running",
      snapshot: createInitialSnapshot(meta),
      controller: new AbortController(),
      startedAt: new Date(),
      script,
      args,
      journal: [],
      background: false,
    };
  }

  private async executeRun(
    managed: ManagedRun,
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): Promise<WorkflowRunResult> {
    const { resumeJournal, externalSignal, onProgress } = exec;
    const progress = () => onProgress?.(managed.snapshot);
    // Let a host abort (e.g. Esc during a blocking tool call) cancel this run.
    if (externalSignal) {
      if (externalSignal.aborted) managed.controller.abort();
      else externalSignal.addEventListener("abort", () => managed.controller.abort(), { once: true });
    }

    try {
      const result = await this.runWorkflowForManaged(managed, script, args, exec, {
        runId: managed.runId,
        resumeJournal,
        resumeFromRunId: resumeJournal ? managed.runId : undefined,
        persistJournal: true,
        progress,
      });
      this.completeRun(managed, result);
      return result;
    } catch (error) {
      const workflowError = error instanceof WorkflowError ? error : wrapError(error);
      let finalError = workflowError;

      if (!managed.controller.signal.aborted && workflowError.code !== WorkflowErrorCode.WORKFLOW_ABORTED) {
        try {
          const recovered = await this.tryRecoverRun(managed, script, args, workflowError, exec, progress);
          if (recovered) {
            this.completeRun(managed, recovered);
            return recovered;
          }
        } catch (recoveryError) {
          finalError = recoveryError instanceof WorkflowError ? recoveryError : wrapError(recoveryError);
        }
      }

      this.failRun(managed, finalError);
      throw finalError;
    }
  }

  private async runWorkflowForManaged(
    managed: ManagedRun,
    script: string,
    args: unknown,
    exec: ExecOptions,
    options: {
      runId: string;
      resumeJournal?: Map<number, JournalEntry>;
      resumeFromRunId?: string;
      persistJournal: boolean;
      persistLogs?: boolean;
      maxAgents?: number;
      agentTimeoutMs?: number;
      tokenBudget?: number | null;
      progress: () => void;
    },
  ): Promise<WorkflowRunResult> {
    const maxAgents = options.maxAgents ?? exec.maxAgents;
    const agentTimeoutMs = options.agentTimeoutMs ?? exec.agentTimeoutMs;
    const tokenBudget = options.tokenBudget !== undefined ? options.tokenBudget : exec.tokenBudget;

    return runWorkflow(script, {
      cwd: this.cwd,
      args,
      agent: this.agent,
      mainModel: this.mainModel,
      signal: managed.controller.signal,
      concurrency: this.concurrency,
      maxAgents,
      agentTimeoutMs,
      tokenBudget,
      confirm: exec.confirm,
      loadSavedWorkflow: this.loadSavedWorkflow,
      resumeJournal: options.resumeJournal,
      resumeFromRunId: options.resumeFromRunId,
      runId: options.runId,
      persistLogs: options.persistLogs,
      onAgentJournal: options.persistJournal
        ? (entry) => {
            // Append (crash-safe-ish): keep the latest entry per index, then persist.
            managed.journal = managed.journal.filter((e) => e.index !== entry.index);
            managed.journal.push(entry);
            this.persistRun(managed);
          }
        : undefined,
      onLog: (message) => {
        managed.snapshot.logs.push(message);
        this.emit("log", { runId: managed.runId, message });
        options.progress();
      },
      onPhase: (title) => {
        managed.snapshot.currentPhase = title;
        if (!managed.snapshot.phases.includes(title)) {
          managed.snapshot.phases.push(title);
        }
        this.emit("phase", { runId: managed.runId, title });
        options.progress();
      },
      onAgentStart: (event) => {
        managed.snapshot.agents.push({
          id: managed.snapshot.agents.length + 1,
          label: event.label,
          phase: event.phase,
          prompt: event.prompt,
          status: "running",
          model: event.model,
        });
        this.emit("agentStart", { runId: managed.runId, ...event });
        options.progress();
      },
      onAgentEnd: (event) => {
        const agent = [...managed.snapshot.agents]
          .reverse()
          .find((a) => a.label === event.label && a.status === "running");
        if (agent) {
          agent.status = event.result === null ? "error" : "done";
          agent.resultPreview = preview(event.result);
          agent.error = event.error;
          agent.errorCode = event.errorCode;
          agent.recoverable = event.recoverable;
          agent.tokens = event.tokens;
          if (event.model) agent.model = event.model;
        }
        this.emit("agentEnd", { runId: managed.runId, ...event });
        options.progress();
      },
      onAgentHistory: (event) => {
        const agent = [...managed.snapshot.agents]
          .reverse()
          .find((a) => a.label === event.label && a.status === "running");
        if (agent) {
          agent.history = event.history;
        }
        this.emit("agentHistory", { runId: managed.runId, ...event });
        options.progress();
      },
      onTokenUsage: (usage) => {
        managed.snapshot.tokenUsage = usage;
        this.emit("tokenUsage", { runId: managed.runId, usage });
        options.progress();
      },
    });
  }

  private async tryRecoverRun(
    managed: ManagedRun,
    script: string,
    args: unknown,
    originalError: WorkflowError,
    exec: ExecOptions,
    progress: () => void,
  ): Promise<WorkflowRunResult | null> {
    const maxAttempts = exec.maxRecoveryAttempts ?? 1;
    const attempts = managed.recovery?.attempts ?? 0;
    if (maxAttempts <= 0 || attempts >= maxAttempts) return null;
    if (managed.controller.signal.aborted || managed.status === "paused" || managed.status === "aborted") return null;

    const startedAt = new Date().toISOString();
    managed.recovery = {
      attempts: attempts + 1,
      maxAttempts,
      status: "diagnosing",
      startedAt,
      originalError: originalError.message,
      originalErrorCode: originalError.code,
    };
    managed.snapshot.logs.push(
      `Automatic recovery attempt ${attempts + 1}/${maxAttempts}: diagnosing ${originalError.code} (${originalError.message})`,
    );
    this.emit("recovery", { runId: managed.runId, recovery: managed.recovery });
    this.persistRun(managed);
    progress();

    const diagnosisArgs = {
      context: buildRecoveryContext({
        script,
        args,
        error: originalError,
        logs: managed.snapshot.logs,
        agents: managed.snapshot.agents,
      }),
    };

    let diagnosis: WorkflowRunResult;
    try {
      diagnosis = await this.runWorkflowForManaged(managed, buildRecoveryWorkflowScript(), diagnosisArgs, exec, {
        runId: `${managed.runId}-recovery-${attempts + 1}`,
        persistJournal: false,
        persistLogs: false,
        maxAgents: Math.max(1, Math.min(2, exec.maxAgents ?? 2)),
        agentTimeoutMs: Math.min(exec.agentTimeoutMs ?? 90_000, 90_000),
        tokenBudget: Math.min(exec.tokenBudget ?? 6_000, 6_000),
        progress,
      });
    } catch (error) {
      if (managed.controller.signal.aborted) throw error;
      const recoveryError = error instanceof WorkflowError ? error : wrapError(error);
      managed.recovery = {
        ...managed.recovery,
        status: "failed",
        completedAt: new Date().toISOString(),
        reason: "Recovery diagnosis failed before it could produce a decision.",
        lastError: recoveryError.message,
      };
      this.emit("recovery", { runId: managed.runId, recovery: managed.recovery });
      this.persistRun(managed);
      progress();
      throw new WorkflowError(
        `Workflow failed; automatic recovery diagnosis also failed: ${recoveryError.message}`,
        originalError.code,
        { recoverable: false, details: { originalError, recoveryError } },
      );
    }

    const decision = normalizeRecoveryDecision(diagnosis.result);
    if (!decision) {
      managed.recovery = {
        ...managed.recovery,
        status: "failed",
        completedAt: new Date().toISOString(),
        reason: "Recovery diagnosis returned an invalid decision.",
        lastError: preview(diagnosis.result),
      };
      this.emit("recovery", { runId: managed.runId, recovery: managed.recovery });
      this.persistRun(managed);
      progress();
      throw new WorkflowError(
        "Workflow failed; automatic recovery returned an invalid diagnosis decision",
        originalError.code,
        {
          recoverable: false,
          details: { originalError, diagnosis: diagnosis.result },
        },
      );
    }

    if (!decision.recoverable) {
      managed.recovery = {
        ...managed.recovery,
        status: "unrecoverable",
        completedAt: new Date().toISOString(),
        reason: decision.reason,
        strategy: decision.strategy,
      };
      this.emit("recovery", { runId: managed.runId, recovery: managed.recovery });
      this.persistRun(managed);
      progress();
      throw new WorkflowError(
        `Workflow failed and automatic recovery found it unrecoverable: ${decision.reason}`,
        originalError.code,
        {
          recoverable: false,
          details: { originalError, recovery: decision },
        },
      );
    }

    if (!decision.correctedScript) {
      managed.recovery = {
        ...managed.recovery,
        status: "failed",
        completedAt: new Date().toISOString(),
        reason: decision.reason,
        strategy: decision.strategy,
        lastError: "Recovery marked the task recoverable but did not provide correctedScript.",
      };
      this.emit("recovery", { runId: managed.runId, recovery: managed.recovery });
      this.persistRun(managed);
      progress();
      throw new WorkflowError(
        "Workflow failed; automatic recovery marked the task recoverable but did not provide correctedScript",
        originalError.code,
        { recoverable: false, details: { originalError, recovery: decision } },
      );
    }

    let correctedMeta: WorkflowMeta;
    try {
      correctedMeta = parseWorkflowScript(decision.correctedScript).meta;
    } catch (error) {
      const parseError = error instanceof WorkflowError ? error : wrapError(error);
      managed.recovery = {
        ...managed.recovery,
        status: "failed",
        completedAt: new Date().toISOString(),
        reason: decision.reason,
        strategy: decision.strategy,
        lastError: `Corrected workflow did not validate: ${parseError.message}`,
      };
      this.emit("recovery", { runId: managed.runId, recovery: managed.recovery });
      this.persistRun(managed);
      progress();
      throw new WorkflowError(
        `Workflow failed; automatic recovery produced an invalid corrected workflow: ${parseError.message}`,
        originalError.code,
        { recoverable: false, details: { originalError, recovery: decision, parseError } },
      );
    }

    managed.recovery = {
      ...managed.recovery,
      status: "rerunning",
      reason: decision.reason,
      strategy: decision.strategy,
      correctedWorkflowName: correctedMeta.name,
    };
    managed.snapshot.logs.push(
      `Automatic recovery running corrected workflow "${correctedMeta.name}": ${decision.reason}`,
    );
    appendMetaPhases(managed, correctedMeta);
    this.emit("recovery", { runId: managed.runId, recovery: managed.recovery });
    this.persistRun(managed);
    progress();

    try {
      const corrected = await this.runWorkflowForManaged(managed, decision.correctedScript, args, exec, {
        runId: `${managed.runId}-recovered-${attempts + 1}`,
        persistJournal: false,
        progress,
      });
      if (corrected.agentCount === 0) {
        throw new WorkflowError(
          "Corrected workflow completed without calling agent(); recovery workflows must run at least one agent",
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false },
        );
      }
      managed.recovery = {
        ...managed.recovery,
        status: "recovered",
        completedAt: new Date().toISOString(),
        correctedWorkflowName: corrected.meta.name,
      };
      this.emit("recovery", { runId: managed.runId, recovery: managed.recovery });
      this.persistRun(managed);
      progress();
      return { ...corrected, runId: managed.runId };
    } catch (error) {
      if (managed.controller.signal.aborted) throw error;
      const correctedError = error instanceof WorkflowError ? error : wrapError(error);
      managed.recovery = {
        ...managed.recovery,
        status: "failed",
        completedAt: new Date().toISOString(),
        lastError: correctedError.message,
      };
      this.emit("recovery", { runId: managed.runId, recovery: managed.recovery });
      this.persistRun(managed);
      progress();
      throw new WorkflowError(
        `Workflow failed; automatic recovery attempted one corrected workflow but it also failed: ${correctedError.message}`,
        correctedError.code,
        { recoverable: false, details: { originalError, recovery: decision, correctedError } },
      );
    }
  }

  private completeRun(managed: ManagedRun, result: WorkflowRunResult): void {
    managed.status = "completed";
    managed.result = result;
    this.emit("complete", { runId: managed.runId, result });

    // Persist final state
    this.persistRun(managed);
    this.releaseRunLease(managed);
  }

  private failRun(managed: ManagedRun, workflowError: WorkflowError): void {
    if (managed.controller.signal.aborted) {
      // Intentional abort (pause/stop/Esc) — preserve status set by pause()/stop()
      if (managed.status === "running") {
        managed.status = "aborted";
      }
    } else {
      managed.status = "failed";
    }
    managed.error = workflowError;
    this.emit("error", { runId: managed.runId, error: workflowError });

    // Persist final state
    this.persistRun(managed);
    this.releaseRunLease(managed);
  }

  private releaseRunLease(managed: ManagedRun): void {
    if (!managed.lease) return;
    this.persistence.releaseRunLease(managed.lease);
    managed.lease = undefined;
  }

  private persistRun(managed: ManagedRun) {
    try {
      this.persistence.save({
        runId: managed.runId,
        workflowName: managed.snapshot.name,
        // Persist the real script + journal so the run can be resumed. Runs live
        // under .pi/workflows/runs/ — protect via directory permissions, not blanking.
        script: managed.script,
        args: managed.args,
        sessionId: this.sessionId,
        journal: managed.journal,
        recovery: managed.recovery,
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
        tokenUsage: managed.snapshot.tokenUsage
          ? {
              input: managed.snapshot.tokenUsage.input,
              output: managed.snapshot.tokenUsage.output,
              total: managed.snapshot.tokenUsage.total,
              cost: managed.snapshot.tokenUsage.cost,
              cacheRead: managed.snapshot.tokenUsage.cacheRead,
              cacheWrite: managed.snapshot.tokenUsage.cacheWrite,
            }
          : undefined,
        startedAt: managed.startedAt.toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: managed.status === "completed" ? new Date().toISOString() : undefined,
        durationMs: managed.result?.durationMs,
      });
    } catch (err) {
      // Persistence is best-effort: the run is still healthy in memory.
      // Log so an operator debugging state-loss has a lead, but never crash
      // the workflow over a disk-full situation.
      console.warn("[workflow-manager] Persist run failed:", err);
    }
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
    this.releaseRunLease(managed);
    return true;
  }

  /**
   * Resume an interrupted run: replay journaled results for the unchanged prefix
   * and run the rest live. Returns false if there is nothing resumable.
   */
  async resume(runId: string): Promise<boolean> {
    // Guard: refuse to resume a run that is already running, or one that was
    // intentionally aborted (pause/stop/Esc). Paused and failed runs can restart.
    const active = this.runs.get(runId);
    if (active?.status === "running") return false;
    if (active?.status === "aborted") return false;

    const persisted = this.persistence.load(runId);
    if (!persisted?.script || persisted.status === "completed" || persisted.status === "aborted") return false;
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;

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
      recovery: persisted.recovery,
      background: true,
      lease,
    };
    this.runs.set(runId, managed);

    const resumeJournal = new Map((persisted.journal ?? []).map((e) => [e.index, e] as const));
    this.emit("resumed", { runId });
    // Run in the background; executeRun records status/errors on the managed run.
    void this.executeRun(managed, persisted.script, persisted.args, { resumeJournal }).catch(() => {});
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
    this.releaseRunLease(managed);
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
  /**
   * Runs for the navigator/task panel. Once bound to a session (setSessionId), only
   * that session's runs are returned — runs from other sessions stay on disk and
   * reappear when you switch back. Unbound (tests/legacy) returns everything.
   */
  listRuns(): PersistedRunState[] {
    const all = this.persistence.list();
    return this.sessionId ? all.filter((r) => r.sessionId === this.sessionId) : all;
  }

  /** All persisted runs regardless of session (used by cross-session recovery). */
  listAllRuns(): PersistedRunState[] {
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
    const managed = this.runs.get(runId);
    if (managed) this.releaseRunLease(managed);
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

function safeParseWorkflowMeta(script: string): WorkflowMeta {
  try {
    return parseWorkflowScript(script).meta;
  } catch {
    return { name: "workflow", description: "Workflow pending validation/recovery", phases: [] };
  }
}

function createInitialSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
  return {
    name: meta.name,
    description: meta.description,
    phases: meta.phases?.map((p) => p.title) ?? [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  };
}

function appendMetaPhases(managed: ManagedRun, meta: WorkflowMeta): void {
  managed.snapshot.name = meta.name;
  managed.snapshot.description = meta.description;
  for (const phase of meta.phases ?? []) {
    if (!managed.snapshot.phases.includes(phase.title)) managed.snapshot.phases.push(phase.title);
  }
}
