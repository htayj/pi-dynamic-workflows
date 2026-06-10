import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowError } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-recovery-"));
    try {
      await fn(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

const correctedScript = `export const meta = { name: 'fixed_workflow', description: 'fixed recovery workflow', phases: [{ title: 'Work' }] }
phase('Work')
const answer = await agent('satisfy the original task with the corrected workflow', { label: 'fixed agent', tier: 'small' })
return { answer }`;

test(
  "automatic recovery repairs a failed foreground workflow and returns the corrected result",
  withTempCwd(async (cwd) => {
    const calls: string[] = [];
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string, options: { label?: string; onUsage?: (u: AgentUsage) => void }) {
          calls.push(options.label ?? "(none)");
          options.onUsage?.({ input: 10, output: 5, total: 15, cost: 0, cacheRead: 0, cacheWrite: 0 });
          if (options.label === "recovery diagnosis") {
            assert.match(prompt, /failed workflow script/i, "diagnosis prompt should include failed-script context");
            return {
              recoverable: true,
              reason: "The submitted script is missing the required meta export, but the task can be run safely.",
              strategy: "Replace it with a minimal valid workflow that performs the requested work.",
              correctedScript,
            };
          }
          return `fixed result for: ${prompt}`;
        },
      },
    });
    manager.on("error", () => {});

    const result = await manager.runSync("const notAWorkflow = true");

    assert.equal(result.meta.name, "fixed_workflow");
    assert.equal(
      (result.result as { answer?: string }).answer,
      "fixed result for: satisfy the original task with the corrected workflow",
    );
    assert.deepEqual(calls, ["recovery diagnosis", "fixed agent"]);

    const persisted = manager.listRuns().find((run) => run.runId === result.runId);
    assert.equal(persisted?.status, "completed");
    assert.equal(persisted?.recovery?.status, "recovered");
    assert.equal(persisted?.recovery?.attempts, 1);
    assert.equal(persisted?.recovery?.correctedWorkflowName, "fixed_workflow");
  }),
);

test(
  "automatic recovery surfaces an unrecoverable diagnosis as a clear final failure",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          return {
            recoverable: false,
            reason: "The task requires unavailable credentials and no safe workflow can satisfy it.",
            strategy: "Ask the user for a non-secret, testable substitute input.",
          };
        },
      },
    });
    manager.on("error", () => {});

    await assert.rejects(
      () => manager.runSync("export const meta = { name: 'bad', description: 'bad' }\nthrow new Error('boom')"),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.match(error.message, /unrecoverable/i);
        assert.match(error.message, /unavailable credentials/i);
        return true;
      },
    );

    const [persisted] = manager.listRuns();
    assert.equal(persisted?.status, "failed");
    assert.equal(persisted?.recovery?.status, "unrecoverable");
    assert.equal(
      persisted?.recovery?.reason,
      "The task requires unavailable credentials and no safe workflow can satisfy it.",
    );
  }),
);

test(
  "automatic recovery is skipped for an intentional stop/abort",
  withTempCwd(async (cwd) => {
    let resolveAgent: ((value: unknown) => void) | undefined;
    const calls: string[] = [];
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(_prompt: string, options: { label?: string }) {
          calls.push(options.label ?? "(none)");
          return new Promise((resolve) => {
            resolveAgent = resolve;
          });
        },
      },
    });
    manager.on("error", () => {});

    const script = `export const meta = { name: 'abort_demo', description: 'abort demo' }
const value = await agent('wait', { label: 'slow agent' })
return { value }`;
    const { runId, promise } = manager.startInBackground(script);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(manager.stop(runId), true);
    resolveAgent?.("late result");
    await promise.catch(() => {});

    const persisted = manager.listRuns().find((run) => run.runId === runId);
    assert.equal(persisted?.status, "aborted");
    assert.equal(persisted?.recovery, undefined);
    assert.deepEqual(calls, ["slow agent"]);
  }),
);

test(
  "automatic recovery does not recurse when the corrected workflow also fails",
  withTempCwd(async (cwd) => {
    let diagnosisCalls = 0;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(_prompt: string, options: { label?: string }) {
          if (options.label === "recovery diagnosis") diagnosisCalls++;
          return {
            recoverable: true,
            reason: "Try a syntactically valid replacement.",
            strategy: "Return a replacement that unfortunately still fails.",
            correctedScript:
              "export const meta = { name: 'still_bad', description: 'still bad' }\nthrow new Error('still broken')",
          };
        },
      },
    });
    manager.on("error", () => {});

    await assert.rejects(
      () =>
        manager.runSync("export const meta = { name: 'bad', description: 'bad' }\nthrow new Error('original broken')"),
      /corrected workflow.*failed|also failed/i,
    );

    assert.equal(diagnosisCalls, 1, "recovery diagnosis should run at most once");
    const [persisted] = manager.listRuns();
    assert.equal(persisted?.status, "failed");
    assert.equal(persisted?.recovery?.attempts, 1);
    assert.equal(persisted?.recovery?.status, "failed");
    assert.match(persisted?.recovery?.lastError ?? "", /still broken/);
  }),
);
