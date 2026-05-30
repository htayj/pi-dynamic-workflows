import assert from "node:assert/strict";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";

/** Agent runner that counts real invocations and echoes a per-call result. */
function countingAgent() {
  const state = { calls: 0 };
  return {
    state,
    runner: {
      async run(prompt: string) {
        state.calls++;
        return `ran:${prompt}`;
      },
    },
  };
}

/** Minimal fake agent runner that reports a fixed usage via onUsage. */
function fakeAgent(usage: Partial<AgentUsage>, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  };
}

const twoAgentScript = `export const meta = { name: 'usage_demo', description: 'two agents' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

test("runWorkflow accumulates real per-agent usage", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ input: 100, output: 40, total: 140, cost: 0.002 }),
    persistLogs: false,
  });

  assert.equal(result.agentCount, 2);
  assert.equal(result.tokenUsage?.input, 200);
  assert.equal(result.tokenUsage?.output, 80);
  assert.equal(result.tokenUsage?.total, 280);
  assert.ok(Math.abs((result.tokenUsage?.cost ?? 0) - 0.004) < 1e-9);
});

test("runWorkflow falls back to an estimate when provider reports total === 0", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ total: 0 }, "a result string"),
    persistLogs: false,
  });

  // No real usage -> input/output stay 0, but total is a positive estimate.
  assert.equal(result.tokenUsage?.input, 0);
  assert.equal(result.tokenUsage?.output, 0);
  assert.ok((result.tokenUsage?.total ?? 0) > 0, "estimate should be positive");
  assert.equal(result.tokenUsage?.cost, 0);
});

test("runWorkflow routes models: explicit opts.model > phase model > default", async () => {
  const seen: Array<string | undefined> = [];
  const capturingAgent = {
    async run(_prompt: string, options: { model?: string; onUsage?: (u: AgentUsage) => void }) {
      seen.push(options.model);
      return "ok";
    },
  };

  const script = `export const meta = {
    name: 'routing', description: 'model routing',
    phases: [{ title: 'A', model: 'phase-a-model' }, { title: 'B' }]
  }
  phase('A')
  await agent('explicit wins', { label: 'e', model: 'explicit-model' })
  await agent('phase routed', { label: 'p' })
  phase('B')
  await agent('no model -> default', { label: 'n' })
  return {}`;

  await runWorkflow(script, { agent: capturingAgent, persistLogs: false });

  assert.deepEqual(seen, ["explicit-model", "phase-a-model", undefined]);
});

const resumeScript = `export const meta = { name: 'resume_demo', description: 'resume' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

test("resume replays cached results without re-running agents", async () => {
  // First run: capture the journal.
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  const r1 = await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 2);
  assert.equal(journal.length, 2);
  assert.deepEqual(
    journal.map((e) => e.index),
    [0, 1],
  );

  // Resume: same script, all calls cached -> agent runner never invoked.
  const second = countingAgent();
  const r2 = await runWorkflow(resumeScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 0, "no live runs on a full cache hit");
  // Compare by value: results are created in separate vm realms, so deepStrictEqual
  // would reject them on prototype identity alone.
  assert.equal(JSON.stringify(r2.result), JSON.stringify(r1.result));
});

test("resume re-runs only the changed call (hash mismatch)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });

  // Edit the second agent's prompt; its hash changes, so only it re-runs.
  const editedScript = resumeScript.replace("'second'", "'second-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 1, "only the edited call re-runs");
});

test("callSeq is deterministic under parallel()", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'par', description: 'parallel order' }
  const xs = await parallel(['p0','p1','p2'].map((p) => () => agent(p, { label: p })))
  return xs`;
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.deepEqual(
    journal.map((e) => e.index).sort((a, b) => a - b),
    [0, 1, 2],
  );
});

test("runWorkflow budget gates on accumulated tokens", async () => {
  // Each agent reports 100 tokens; a 100 budget allows one then exhausts
  // (the next agent sees remaining() === 0 at start and throws).
  const script = `export const meta = { name: 'budget_demo', description: 'budget' }
const a = await agent('first', { label: 'a' })
let second = null
try { second = await agent('second', { label: 'b' }) } catch (e) { second = 'blocked' }
return { a, second }`;

  const result = await runWorkflow<{ a: unknown; second: unknown }>(script, {
    agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
    tokenBudget: 100,
    persistLogs: false,
  });

  assert.equal(result.result.second, "blocked");
});
