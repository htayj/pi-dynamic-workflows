/**
 * "Workflows mode" input affordance, à la a smart input box:
 *
 *  - While the editor text contains the word `workflow`/`workflows`, those letters
 *    render as a flowing rainbow, signalling that submitting will engage a workflow.
 *  - Pressing Backspace immediately after such a word toggles the highlight OFF
 *    (the word stays, but turns plain white) — a non-destructive "don't run a
 *    workflow after all". Re-typing a fresh trigger word turns it back on.
 *  - When the highlight is ON at submit time, the user's message is transformed to
 *    instruct Pi to actually run the workflow tool.
 *
 * Implementation: we replace the core editor with a thin subclass of the exported
 * `CustomEditor` (which itself extends pi-tui's `Editor`), overriding only
 * `render()` (to colorize) and `handleInput()` (for the Backspace toggle). All
 * other editor behavior — history, autocomplete, paste, undo, multiline — is
 * inherited untouched.
 */

import { CustomEditor, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

/** Matches a trigger anywhere in the text (substring, case-insensitive). */
const TRIGGER = /workflows?/i;
/** Global variant for finding every occurrence to colorize. */
const TRIGGER_G = /workflows?/gi;
/** True when the text immediately before the cursor ends with a trigger word. */
const TRIGGER_AT_END = /workflows?$/i;

/** 256-color ring cycling through the spectrum — shifted by a tick to "flow". */
export const RAINBOW = [
  196, 160, 202, 166, 208, 172, 214, 178, 220, 184, 226, 190, 118, 82, 46, 47, 48, 49, 50, 51, 45, 39, 33, 27, 21, 57,
  93, 129, 165, 201, 198, 197,
];

export function hasTrigger(text: string): boolean {
  return TRIGGER.test(text);
}

export function endsWithTrigger(textBeforeCursor: string): boolean {
  return TRIGGER_AT_END.test(textBeforeCursor);
}

/** Shared, mutable view of whether "workflows mode" is currently armed. */
export interface WorkflowModeState {
  active: boolean;
}

interface AnsiToken {
  esc?: string;
  ch?: string;
}

/**
 * Split a rendered line into ANSI-escape tokens (passed through verbatim) and
 * single visible-character tokens. Handles CSI sequences (`\x1b[…m`, e.g. the
 * cursor's inverse-video) and APC/OSC string sequences (e.g. the zero-width
 * `CURSOR_MARKER` = `\x1b_pi:c\x07`) so colorization never corrupts them.
 */
export function tokenizeAnsi(line: string): AnsiToken[] {
  const tokens: AnsiToken[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      let j = i + 1;
      const next = line[j];
      if (next === "[") {
        // CSI: ends at a final byte in 0x40–0x7e.
        j++;
        while (j < line.length && !(line[j] >= "@" && line[j] <= "~")) j++;
        j++;
      } else if (next === "]" || next === "_" || next === "P" || next === "^") {
        // String sequence: ends at BEL (\x07) or ST (\x1b\\).
        j++;
        while (j < line.length && line[j] !== "\x07" && !(line[j] === "\x1b" && line[j + 1] === "\\")) j++;
        if (line[j] === "\x07") j++;
        else if (line[j] === "\x1b") j += 2;
      } else {
        j++; // lone ESC + one byte
      }
      tokens.push({ esc: line.slice(i, j) });
      i = j;
    } else {
      tokens.push({ ch: line[i] });
      i++;
    }
  }
  return tokens;
}

/**
 * Colorize every `workflow`/`workflows` occurrence in a rendered line with a
 * flowing rainbow, leaving all ANSI escapes (cursor, markers) intact. Returns the
 * line unchanged when it contains no trigger.
 */
export function colorizeWorkflow(line: string, tick: number, palette: number[] = RAINBOW): string {
  const tokens = tokenizeAnsi(line);
  const visible = tokens
    .filter((t) => t.ch !== undefined)
    .map((t) => t.ch)
    .join("");
  if (!TRIGGER.test(visible)) return line;

  const ranges: Array<[number, number]> = [];
  TRIGGER_G.lastIndex = 0;
  for (let m = TRIGGER_G.exec(visible); m; m = TRIGGER_G.exec(visible)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  const inRange = (idx: number) => ranges.some(([s, e]) => idx >= s && idx < e);

  let out = "";
  let vi = 0;
  for (const t of tokens) {
    if (t.esc !== undefined) {
      out += t.esc;
      continue;
    }
    if (inRange(vi)) {
      const color = palette[(vi + tick) % palette.length];
      // Reset only the foreground (39) afterwards so a surrounding inverse-video
      // (the cursor) is preserved.
      out += `\x1b[38;5;${color}m${t.ch}\x1b[39m`;
    } else {
      out += t.ch ?? "";
    }
    vi++;
  }
  return out;
}

/** Backspace arrives as DEL (0x7f) or BS (0x08) depending on the terminal. */
function isBackspace(data: string): boolean {
  return data === "\x7f" || data === "\b";
}

/**
 * Editor that paints the trigger words and owns the on/off toggle. Reads/writes
 * `state.active` so the extension's `input` handler can decide whether to force a
 * workflow at submit time.
 */
export class WorkflowEditor extends CustomEditor {
  private tick = 0;
  private timer?: ReturnType<typeof setInterval>;
  /** Toggled off by Backspace-after-word; re-armed when a fresh trigger appears. */
  private disabled = false;
  private wasTriggered = false;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    private readonly modeState: WorkflowModeState,
  ) {
    super(tui, theme, keybindings);
  }

  /** Highlighted/armed: a trigger is present and the user hasn't toggled it off. */
  isActive(): boolean {
    return !this.disabled && hasTrigger(this.getText());
  }

  override handleInput(data: string): void {
    // First Backspace right after a trigger word disarms (non-destructive).
    if (isBackspace(data) && this.isActive() && this.cursorAfterTrigger()) {
      this.disabled = true;
      this.syncState();
      this.tui.requestRender();
      return;
    }
    const before = this.getText();
    super.handleInput(data);
    const after = this.getText();
    if (after !== before) {
      const now = hasTrigger(after);
      // A freshly typed trigger re-arms a previously disabled box.
      if (now && !this.wasTriggered) this.disabled = false;
      this.wasTriggered = now;
    }
    this.syncState();
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    // Keep the shared state current even for non-keystroke changes (history
    // recall, programmatic setText) so the submit hook reads the right value.
    this.syncState();
    this.reconcileAnimation();
    if (!this.isActive() || lines.length === 0) return lines;
    // First and last lines are the editor's horizontal borders; only the text
    // lines in between are colorized.
    return lines.map((ln, i) => (i === 0 || i === lines.length - 1 ? ln : colorizeWorkflow(ln, this.tick)));
  }

  /** Absolute text before the cursor, used to detect "right after the word". */
  private cursorAfterTrigger(): boolean {
    const lines = this.getLines();
    const { line, col } = this.getCursor();
    const before = lines.slice(0, line).join("\n") + (line > 0 ? "\n" : "") + (lines[line] ?? "").slice(0, col);
    return endsWithTrigger(before);
  }

  private syncState(): void {
    this.modeState.active = this.isActive();
  }

  private reconcileAnimation(): void {
    const shouldRun = this.isActive() && this.focused;
    if (shouldRun && !this.timer) {
      this.timer = setInterval(() => {
        this.tick = (this.tick + 1) % (RAINBOW.length * 6);
        this.tui.requestRender();
      }, 90);
      // Don't keep the process alive for the animation.
      (this.timer as { unref?: () => void }).unref?.();
    } else if (!shouldRun && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/** The directive appended to a submitted message when workflows mode is armed. */
export function buildForcedWorkflowPrompt(text: string): string {
  return [
    text,
    "",
    "[workflows mode] The user armed workflows mode for this message. Handle it by",
    "running the `workflow` tool: decompose the request and orchestrate subagents",
    "with a workflow script, rather than answering directly.",
  ].join("\n");
}

/**
 * Install the workflows-mode editor and the submit-time forcing hook.
 * Call once with the UI context (e.g. in `session_start`).
 */
export function installWorkflowEditor(pi: ExtensionAPI, ui: ExtensionUIContext): WorkflowModeState {
  const state: WorkflowModeState = { active: false };

  ui.setEditorComponent((tui, theme, keybindings) => new WorkflowEditor(tui, theme, keybindings, state));

  // When armed at submit time, rewrite the user's message to force a workflow.
  pi.on("input", (event: { source?: string; text?: string }) => {
    if (event.source !== "interactive" || !state.active || !event.text) return { action: "continue" } as const;
    state.active = false; // consume the arm for this submission
    return { action: "transform", text: buildForcedWorkflowPrompt(event.text) } as const;
  });

  return state;
}
