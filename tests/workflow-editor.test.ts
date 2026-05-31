import assert from "node:assert/strict";
import test from "node:test";
import {
  buildForcedWorkflowPrompt,
  colorizeWorkflow,
  endsWithTrigger,
  hasTrigger,
  installWorkflowEditor,
  RAINBOW,
  tokenizeAnsi,
} from "../src/workflow-editor.js";

const CURSOR_MARKER = "\x1b_pi:c\x07";
// Built from escaped source so the regex literal carries no raw control bytes.
const ANSI_RE = new RegExp("\\u001b\\[[0-9;]*[A-Za-z]|\\u001b_[^\\u0007]*\\u0007", "g");
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

test("hasTrigger matches workflow/workflows anywhere, case-insensitive", () => {
  for (const t of ["run a workflow", "WORKFLOWS", "myworkflow", "the Workflow tool"]) {
    assert.equal(hasTrigger(t), true, t);
  }
  for (const t of ["workflo", "flow", "work", ""]) {
    assert.equal(hasTrigger(t), false, t);
  }
});

test("endsWithTrigger detects a trigger immediately before the cursor", () => {
  assert.equal(endsWithTrigger("please run workflow"), true);
  assert.equal(endsWithTrigger("workflows"), true);
  assert.equal(endsWithTrigger("workflow now"), false);
  assert.equal(endsWithTrigger("work"), false);
});

test("tokenizeAnsi keeps CSI and APC sequences as single escape tokens", () => {
  const line = `a\x1b[7mb\x1b[0m${CURSOR_MARKER}c`;
  const tokens = tokenizeAnsi(line);
  const escs = tokens.filter((t) => t.esc !== undefined).map((t) => t.esc);
  assert.deepEqual(escs, ["\x1b[7m", "\x1b[0m", CURSOR_MARKER]);
  const visible = tokens
    .filter((t) => t.ch !== undefined)
    .map((t) => t.ch)
    .join("");
  assert.equal(visible, "abc");
});

test("colorizeWorkflow paints the trigger and preserves visible text + escapes", () => {
  const input = `please run workflow now`;
  const out = colorizeWorkflow(input, 0);
  assert.match(out, new RegExp("\\u001b\\[38;5;\\d+m"), "applies a 256-color foreground");
  assert.equal(stripAnsi(out), input, "visible text is unchanged");
});

test("colorizeWorkflow leaves non-trigger lines untouched", () => {
  const input = "just some plain text";
  assert.equal(colorizeWorkflow(input, 3), input);
});

test("colorizeWorkflow does not corrupt the cursor escape or CURSOR_MARKER", () => {
  // Cursor sits on the 'f' of workflow: inverse-video around that grapheme.
  const input = `workflow ${CURSOR_MARKER}\x1b[7m \x1b[0m`;
  const out = colorizeWorkflow(input, 2);
  assert.ok(out.includes(CURSOR_MARKER), "marker survives");
  assert.ok(out.includes("\x1b[7m"), "inverse-video survives");
  assert.equal(stripAnsi(out), "workflow  ");
});

test("colorizeWorkflow flows: a tick shift changes the colors", () => {
  const a = colorizeWorkflow("workflow", 0);
  const b = colorizeWorkflow("workflow", 1);
  assert.notEqual(a, b);
  assert.ok(RAINBOW.length > 1);
});

test("buildForcedWorkflowPrompt keeps the user's text and adds the directive", () => {
  const out = buildForcedWorkflowPrompt("audit the routes");
  assert.match(out, /audit the routes/);
  assert.match(out, /workflows mode/);
  assert.match(out, /`workflow` tool/);
});

test("installWorkflowEditor transforms interactive input only when armed", () => {
  let inputHandler: ((e: any) => any) | undefined;
  let editorFactory: unknown;
  const pi: any = {
    on: (event: string, handler: any) => {
      if (event === "input") inputHandler = handler;
    },
  };
  const ui: any = { setEditorComponent: (f: unknown) => (editorFactory = f) };

  const state = installWorkflowEditor(pi, ui);
  assert.equal(typeof editorFactory, "function", "registers a custom editor factory");
  assert.equal(typeof inputHandler, "function", "registers an input hook");

  // Disarmed → passthrough.
  assert.deepEqual(inputHandler!({ source: "interactive", text: "hi" }), { action: "continue" });

  // Armed → transform and consume the arm.
  state.active = true;
  const res = inputHandler!({ source: "interactive", text: "do it" });
  assert.equal(res.action, "transform");
  assert.match(res.text, /do it/);
  assert.match(res.text, /workflows mode/);
  assert.equal(state.active, false, "arm is consumed after submit");

  // Non-interactive sources are never transformed even if armed.
  state.active = true;
  assert.deepEqual(inputHandler!({ source: "rpc", text: "workflow" }), { action: "continue" });
});
