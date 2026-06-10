/**
 * Standing `/effort` control (pi's answer to CC's ultracode): substantive
 * interactive messages auto-arm a workflow by default, with effort-tier guidance
 * nudging fan-out breadth and the hard caps (tokenBudget / maxAgents) the model
 * should set on the workflow tool call. `/effort off` disables that automatic
 * substantive-message forcing for the session; a raw `noflow` word disables it
 * for one message in the workflow-editor input hook.
 *
 * Honest scope: the runtime cannot enforce "reviewer N / loop K" — those live in
 * the script the model writes — so the tiers are guidance plus the model setting
 * the real hard caps (tokenBudget/maxAgents are genuine runtime ceilings). The
 * pre-flight ceiling-confirm dialog (roadmap P1-5 #4) is a downscope point: an
 * `input` hook transforms synchronously and can't await a confirm.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type EffortLevel = "off" | "high" | "ultra";

/** Default automatic workflow effort for substantive interactive messages. */
export const DEFAULT_EFFORT_LEVEL: EffortLevel = "high";

export interface EffortState {
  level: EffortLevel;
}

export function createEffortState(): EffortState {
  return { level: DEFAULT_EFFORT_LEVEL };
}

const HIGH_DIRECTIVE =
  "Effort: HIGH. Be thorough — use a few parallel reviewers/perspectives and an adversarial verify pass (see verify()/judgePanel()); set a moderate tokenBudget and maxAgents on the workflow tool call.";
const ULTRA_DIRECTIVE =
  "Effort: ULTRA. Be exhaustive — fan out widely (more reviewers/judges, deeper loopUntilDry rounds, a completenessCheck at the end), set a generous tokenBudget and a high maxAgents on the workflow tool call, and prefer the big tier for synthesis.";

/** The extra directive appended to the forced-workflow prompt for an effort level. */
export function effortDirective(level: EffortLevel): string | undefined {
  if (level === "high") return HIGH_DIRECTIVE;
  if (level === "ultra") return ULTRA_DIRECTIVE;
  return undefined;
}

/**
 * Whether a message should auto-arm under effort mode: a real interactive request,
 * not a terse acknowledgement or a slash command. (hasTrigger handles the explicit
 * "workflow(s)" keyword separately.)
 */
export function isSubstantive(text: string): boolean {
  const t = text.trim();
  return t.length >= 16 && !t.startsWith("/");
}

export function registerEffortCommand(pi: ExtensionAPI, state: EffortState): void {
  pi.registerCommand("effort", {
    description: "Standing workflow effort: off | high | ultra — controls automatic workflows for substantive messages",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const arg = args.trim().toLowerCase();
      const say = (content: string) => pi.sendMessage({ customType: "effort", content, display: true });
      if (arg === "off" || arg === "high" || arg === "ultra") {
        state.level = arg;
        await say(
          arg === "off"
            ? "Effort off — substantive messages are no longer auto-armed as workflows. Add noflow to any single message to bypass all workflow forcing."
            : `Effort ${arg} — substantive messages auto-arm a workflow (${arg === "ultra" ? "exhaustive" : "thorough"} fan-out). Use /effort off to stop, or add noflow to bypass one message.`,
        );
        return;
      }
      await say(`Effort is currently "${state.level}". Usage: /effort off | high | ultra`);
    },
  });

  // `/ultracode` — the headline name for the maximal-effort mode (Pi's ultracode):
  // `/ultracode` raises automatic workflows to ultra, `/ultracode off` turns them off.
  pi.registerCommand("ultracode", {
    description:
      "Ultracode: standing maximal-effort mode — auto-arms an exhaustive workflow for substantive messages. /ultracode off to stop.",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const arg = args.trim().toLowerCase();
      const say = (content: string) => pi.sendMessage({ customType: "effort", content, display: true });
      if (arg === "off") {
        state.level = "off";
        await say("Ultracode off — substantive messages are no longer auto-armed as workflows.");
        return;
      }
      state.level = "ultra";
      await say(
        "Ultracode ON — substantive messages now auto-arm an exhaustive workflow (wide fan-out, big-tier synthesis). Use /ultracode off to stop.",
      );
    },
  });
}
