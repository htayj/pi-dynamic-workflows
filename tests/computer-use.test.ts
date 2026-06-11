import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkflowAgentTools } from "../src/agent.js";
import type { CommandProbe, CommandResult, CommandRunner, ComputerUseCommandName } from "../src/computer-use.js";
import {
  buildDependencyProbeMarkdown,
  buildGimpGauntletMarkdown,
  createComputerUseTools,
  gimpGauntletDependencyIssues,
  runGimpGauntlet,
  scoreGimpGauntlet,
  summarizeGimpGauntletResult,
} from "../src/computer-use.js";

function commandProbe(name: ComputerUseCommandName, found: boolean, path?: string): CommandProbe {
  return found
    ? { name, found: true, path, diagnostics: [`${name} found`] }
    : { name, found: false, diagnostics: [`${name} missing`] };
}

function fakeResult(
  command: string,
  args: readonly string[],
  exitCode: number,
  stdout = "",
  stderr = "",
): CommandResult {
  return { command, args, exitCode, signal: null, stdout, stderr, durationMs: 1, timedOut: false };
}

const allCommandNames: readonly ComputerUseCommandName[] = [
  "gimp",
  "xvfb-run",
  "Xvfb",
  "xdotool",
  "magick",
  "import",
  "python3",
];

const missingRunner: CommandRunner = {
  async run(command, args) {
    return fakeResult(command, args, 1, "", "missing");
  },
};

test("createComputerUseTools exposes probe and GIMP gauntlet tools", () => {
  const tools = createComputerUseTools("/tmp");
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["computer_use_probe", "computer_use_gimp_gauntlet"],
  );
  for (const tool of tools) {
    assert.ok(tool.label);
    assert.ok(tool.description);
    assert.ok(tool.promptSnippet);
    assert.equal(typeof tool.execute, "function");
  }
});

test("default workflow agent tools include computer-use tools for subagents", () => {
  const names = createWorkflowAgentTools("/tmp").map((tool) => tool.name);
  assert.ok(names.includes("computer_use_probe"), "workflow subagents should be able to probe GUI deps");
  assert.ok(names.includes("computer_use_gimp_gauntlet"), "workflow subagents should be able to run the GIMP gauntlet");
});

test("gimpGauntletDependencyIssues reports missing required pieces", () => {
  const commands = Object.fromEntries(allCommandNames.map((name) => [name, commandProbe(name, false)])) as Record<
    ComputerUseCommandName,
    CommandProbe
  >;
  const issues = gimpGauntletDependencyIssues({
    commands,
    pillow: { found: false, diagnostics: ["pillow missing"] },
    displayMode: "missing",
    screenshotMode: "missing",
    diagnostics: [],
  });
  assert.ok(issues.some((issue) => issue.includes("gimp")));
  assert.ok(issues.some((issue) => issue.includes("xdotool")));
  assert.ok(issues.some((issue) => issue.includes("xvfb-run")));
  assert.ok(issues.some((issue) => issue.includes("Pillow")));
});

test("gimpGauntletDependencyIssues accepts practical screenshot and display fallbacks", () => {
  const commands = Object.fromEntries(
    allCommandNames.map((name) => [name, commandProbe(name, true, `/usr/bin/${name}`)]),
  ) as Record<ComputerUseCommandName, CommandProbe>;
  for (const displayMode of ["existing-display", "xvfb"] as const) {
    const issues = gimpGauntletDependencyIssues({
      commands,
      pillow: { found: true, version: "12.2.0", diagnostics: ["pillow found"] },
      displayMode,
      screenshotMode: "import",
      diagnostics: [],
    });
    assert.deepEqual(issues, []);
  }
});

test("scoreGimpGauntlet produces passable score and diagnostics for a visible draw delta", () => {
  const scored = scoreGimpGauntlet({
    dependenciesOk: true,
    driverOk: true,
    analysis: {
      width: 1280,
      height: 900,
      changedPixels: 12_000,
      changedRatio: 0.0104,
      averageDiff: 3.2,
      diffBoundingBox: [200, 200, 600, 500],
      afterUniqueColorsSample: 250,
      afterDarkRatio: 0.04,
      afterColorfulRatio: 0.02,
    },
  });
  assert.equal(scored.score, 1);
  assert.equal(scored.hints.length, 0);
  assert.ok(scored.checks.every((check) => check.passed));
});

test("scoreGimpGauntlet returns improvement hints for weak image evidence", () => {
  const scored = scoreGimpGauntlet({
    dependenciesOk: true,
    driverOk: true,
    analysis: {
      width: 1280,
      height: 900,
      changedPixels: 4,
      changedRatio: 0.000001,
      averageDiff: 0.01,
      diffBoundingBox: null,
      afterUniqueColorsSample: 2,
      afterDarkRatio: 0,
      afterColorfulRatio: 0,
    },
  });
  assert.ok(scored.score < 1);
  assert.ok(scored.hints.some((hint) => hint.includes("canvas targeting") || hint.includes("visible")));
});

test("markdown builders include scores, diagnostics, and improvement hints", () => {
  const commands = Object.fromEntries(
    allCommandNames.map((name) => [name, commandProbe(name, name !== "gimp")]),
  ) as Record<ComputerUseCommandName, CommandProbe>;
  const dependencies = {
    commands,
    pillow: { found: true, version: "12.2.0", diagnostics: ["pillow found"] },
    displayMode: "xvfb-run" as const,
    screenshotMode: "magick" as const,
    diagnostics: ["diag one"],
  };
  const dependencyMarkdown = buildDependencyProbeMarkdown(dependencies);
  assert.match(dependencyMarkdown, /Display mode/);
  assert.match(dependencyMarkdown, /gimp: missing/);

  const result = {
    status: "skipped" as const,
    passed: false,
    skipped: true,
    score: 0,
    minScore: 0.75,
    summary: "Skipped because GIMP is missing.",
    diagnostics: ["gimp missing"],
    improvementHints: ["Install gimp"],
    checks: [
      {
        name: "dependencies",
        passed: false,
        score: 0,
        maxScore: 1,
        diagnostic: "gimp missing",
        improvementHint: "Install gimp",
      },
    ],
    dependencies,
    artifacts: {
      dir: "/tmp/artifacts",
      reportJson: "/tmp/artifacts/gauntlet-report.json",
      reportMarkdown: "/tmp/artifacts/gauntlet-report.md",
    },
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
  };
  const reportMarkdown = buildGimpGauntletMarkdown(result);
  assert.match(reportMarkdown, /Score:/);
  assert.match(reportMarkdown, /Install gimp/);
  assert.match(reportMarkdown, /gimp missing/);
  assert.match(summarizeGimpGauntletResult(result), /gauntlet-report.json/);
});

test("runGimpGauntlet gracefully skips and writes JSON/Markdown artifacts when dependencies are missing", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-computer-use-test-"));
  try {
    const artifactsDir = join(temp, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const staleBefore = join(artifactsDir, "before.png");
    await writeFile(staleBefore, "stale screenshot from previous run");
    await utimes(staleBefore, new Date(0), new Date(0));

    const result = await runGimpGauntlet({ cwd: temp, runner: missingRunner, artifactDir: "artifacts" });
    assert.equal(result.status, "skipped");
    assert.equal(result.skipped, true);
    assert.equal(result.passed, false);
    assert.equal(result.score, 0);
    assert.ok(result.improvementHints.length > 0);
    assert.equal(result.artifacts.beforeScreenshot, undefined);
    assert.equal(result.artifacts.afterScreenshot, undefined);
    assert.equal(result.artifacts.driverScript, undefined);

    const json = JSON.parse(await readFile(result.artifacts.reportJson, "utf8")) as { status?: string; score?: number };
    assert.equal(json.status, "skipped");
    assert.equal(json.score, 0);

    const markdown = await readFile(result.artifacts.reportMarkdown, "utf8");
    assert.match(markdown, /Status: \*\*skipped\*\*/);
    assert.match(markdown, /Improvement hints/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("runGimpGauntlet uses raw Xvfb fallback without unsafe shell artifacts", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-computer-use-xvfb-test-"));
  const executablePaths: Partial<Record<ComputerUseCommandName, string>> = {
    gimp: "/usr/bin/gimp",
    Xvfb: "/usr/bin/Xvfb",
    xdotool: "/usr/bin/xdotool",
    import: "/usr/bin/import",
    python3: "/usr/bin/python3",
  };
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner: CommandRunner = {
    async run(command, args, options) {
      calls.push({ command, args });
      if (command === "bash" && args[0] === "-lc") {
        const match = /^command -v (.+)$/.exec(args[1] ?? "");
        const found = match ? executablePaths[match[1] as ComputerUseCommandName] : undefined;
        return found ? fakeResult(command, args, 0, `${found}\n`) : fakeResult(command, args, 1, "", "missing");
      }
      if (command === executablePaths.gimp) return fakeResult(command, args, 0, "GNU Image Manipulation Program 2.10");
      if (command === executablePaths.xdotool) return fakeResult(command, args, 0, "xdotool version 3.20211022.1");
      if (command === executablePaths.import) return fakeResult(command, args, 0, "Version: ImageMagick 6.9");
      if (command === executablePaths.python3 && args[0] === "--version") {
        return fakeResult(command, args, 0, "Python 3.12.0");
      }
      if (command === executablePaths.python3 && args[0] === "-c" && String(args[1]).includes("import PIL")) {
        return fakeResult(command, args, 0, "12.2.0");
      }
      if (command === executablePaths.python3 && args[0] === "-c" && String(args[1]).includes("Image.new")) {
        await writeFile(args[2] ?? join(temp, "missing-canvas"), "fake canvas");
        return fakeResult(command, args, 0);
      }
      if (command === "bash" && String(args[0]).endsWith("run-xvfb.sh")) {
        const before = options?.env?.BEFORE_PATH;
        const after = options?.env?.AFTER_PATH;
        if (before) await writeFile(before, "before");
        if (after) await writeFile(after, "after");
        return fakeResult(command, args, 0, "driver ok");
      }
      if (command === executablePaths.python3 && args[0] === "-c" && String(args[1]).includes("ImageChops")) {
        await writeFile(
          args[4] ?? join(temp, "missing-analysis.json"),
          JSON.stringify({
            width: 1280,
            height: 900,
            changedPixels: 12000,
            changedRatio: 0.0104,
            averageDiff: 3.2,
            diffBoundingBox: [200, 200, 600, 500],
            afterUniqueColorsSample: 250,
            afterDarkRatio: 0.04,
            afterColorfulRatio: 0.02,
          }),
        );
        return fakeResult(command, args, 0);
      }
      return fakeResult(command, args, 1, "", `unexpected command: ${command} ${args.join(" ")}`);
    },
  };

  try {
    const result = await runGimpGauntlet({ cwd: temp, runner, artifactDir: "artifacts" });
    assert.equal(result.status, "passed");
    assert.equal(result.dependencies.displayMode, "xvfb");
    assert.ok(calls.some((call) => call.command === "bash" && String(call.args[0]).endsWith("run-xvfb.sh")));
    assert.ok(result.artifacts.beforeScreenshot);
    assert.ok(result.artifacts.afterScreenshot);
    assert.ok(result.artifacts.driverScript);
    assert.ok(result.artifacts.xvfbWrapperScript);

    const driverScript = await readFile(result.artifacts.driverScript, "utf8");
    const wrapperScript = await readFile(result.artifacts.xvfbWrapperScript, "utf8");
    assert.doesNotMatch(driverScript, /eval/);
    assert.doesNotMatch(driverScript, /pi-gimp-gauntlet\.gimp/);
    assert.doesNotMatch(driverScript, /\\\$\{MAGICK_BIN/);
    assert.doesNotMatch(wrapperScript, /pi-gimp-gauntlet\.xvfb/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
