import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../src/workflow.js";

// Fake agents return a schema-shaped object when a schema is requested.
const yesAgent = {
  async run(_p: string, o: { schema?: unknown }) {
    return o?.schema ? { real: true } : "ok";
  },
};

test("verify(): parallel reviewers + threshold → real", async () => {
  const script = `export const meta = { name: 'v', description: 'verify' }
const r = await verify('the sky is blue', { reviewers: 3 })
return r`;
  const res = await runWorkflow<{ real: boolean; total: number }>(script, { agent: yesAgent, persistLogs: false });
  assert.equal(res.result.real, true);
  assert.equal(res.result.total, 3, "all three reviewers voted");
});

test("verify(): below threshold → not real", async () => {
  // 1 yes / 2 no with threshold 0.75 → not real.
  let n = 0;
  const mixed = {
    async run(_p: string, o: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      n++;
      return { real: n === 1 };
    },
  };
  const script = `export const meta = { name: 'v', description: 'verify' }
return await verify('claim', { reviewers: 3, threshold: 0.75 })`;
  const res = await runWorkflow<{ real: boolean; realCount: number }>(script, { agent: mixed, persistLogs: false });
  assert.equal(res.result.realCount, 1);
  assert.equal(res.result.real, false);
});

test("judgePanel(): picks the highest-mean-score attempt", async () => {
  const scorer = {
    async run(p: string, o: { schema?: unknown }) {
      if (!o?.schema) return "ok";
      return { score: /WIN/.test(p) ? 0.9 : 0.1 };
    },
  };
  const script = `export const meta = { name: 'j', description: 'judge' }
const r = await judgePanel(['lose one', 'WIN candidate', 'lose two'], { judges: 2 })
return { index: r.index, score: r.score }`;
  const res = await runWorkflow<{ index: number; score: number }>(script, { agent: scorer, persistLogs: false });
  assert.equal(res.result.index, 1, "the WIN candidate wins");
});

test("loopUntilDry(): dedupes by key and stops after K empty rounds", async () => {
  const script = `export const meta = { name: 'l', description: 'loop' }
const out = await loopUntilDry({
  round: (r) => {
    if (r === 0) return [1, 2]
    if (r === 1) return [2, 3]
    return []
  },
  consecutiveEmpty: 2,
})
return out`;
  const res = await runWorkflow<number[]>(script, { agent: yesAgent, persistLogs: false });
  assert.deepEqual([...res.result], [1, 2, 3], "deduped union across rounds");
});

test("loopUntilDry(): returns partial results when a round hits the budget", async () => {
  const script = `export const meta = { name: 'lp', description: 'loop partial' }
const out = await loopUntilDry({
  round: (r) => {
    if (r === 0) return [1]
    throw { code: 'TOKEN_BUDGET_EXHAUSTED' }
  },
})
return out`;
  const res = await runWorkflow<number[]>(script, { agent: yesAgent, persistLogs: false });
  assert.deepEqual([...res.result], [1], "partial result returned, not an abort");
});

test("completenessCheck(): returns the critic's structured verdict", async () => {
  const critic = {
    async run(_p: string, o: { schema?: unknown }) {
      return o?.schema ? { complete: false, missing: ["x"] } : "ok";
    },
  };
  const script = `export const meta = { name: 'c', description: 'critic' }
return await completenessCheck({ task: 1 }, [{ done: true }])`;
  const res = await runWorkflow<{ complete: boolean; missing: string[] }>(script, {
    agent: critic,
    persistLogs: false,
  });
  assert.equal(res.result.complete, false);
  assert.deepEqual([...res.result.missing], ["x"]);
});
