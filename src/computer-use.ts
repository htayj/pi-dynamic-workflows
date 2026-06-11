import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_GAUNTLET_TIMEOUT_MS = 120_000;
const DEFAULT_MIN_SCORE = 0.75;
const PROCESS_OUTPUT_LIMIT = 80_000;
const DEFAULT_SCREEN_SIZE = "1280x900x24";

export type ComputerUseCommandName = "gimp" | "xvfb-run" | "Xvfb" | "xdotool" | "magick" | "import" | "python3";

export interface CommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface CommandRunnerOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly input?: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: CommandRunnerOptions): Promise<CommandResult>;
}

export interface CommandProbe {
  readonly name: ComputerUseCommandName;
  readonly found: boolean;
  readonly path?: string;
  readonly version?: string;
  readonly diagnostics: readonly string[];
}

export interface PillowProbe {
  readonly found: boolean;
  readonly version?: string;
  readonly diagnostics: readonly string[];
}

export interface ComputerUseDependencyProbe {
  readonly commands: Readonly<Record<ComputerUseCommandName, CommandProbe>>;
  readonly pillow: PillowProbe;
  readonly displayMode: "xvfb-run" | "xvfb" | "existing-display" | "missing";
  readonly screenshotMode: "magick" | "import" | "pillow-imagegrab" | "missing";
  readonly diagnostics: readonly string[];
}

export interface GimpGauntletArtifacts {
  readonly dir: string;
  readonly reportJson: string;
  readonly reportMarkdown: string;
  readonly inputCanvas?: string;
  readonly beforeScreenshot?: string;
  readonly afterScreenshot?: string;
  readonly analysisJson?: string;
  readonly driverScript?: string;
  readonly xvfbWrapperScript?: string;
  readonly driverStdout?: string;
  readonly driverStderr?: string;
}

export interface ImagePairAnalysis {
  readonly width: number;
  readonly height: number;
  readonly changedPixels: number;
  readonly changedRatio: number;
  readonly averageDiff: number;
  readonly diffBoundingBox: readonly [number, number, number, number] | null;
  readonly afterUniqueColorsSample: number;
  readonly afterDarkRatio: number;
  readonly afterColorfulRatio: number;
}

export interface GimpGauntletCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly score: number;
  readonly maxScore: number;
  readonly diagnostic: string;
  readonly improvementHint?: string;
}

export interface GimpGauntletResult {
  readonly status: "passed" | "failed" | "skipped";
  readonly passed: boolean;
  readonly skipped: boolean;
  readonly score: number;
  readonly minScore: number;
  readonly summary: string;
  readonly diagnostics: readonly string[];
  readonly improvementHints: readonly string[];
  readonly checks: readonly GimpGauntletCheck[];
  readonly dependencies: ComputerUseDependencyProbe;
  readonly analysis?: ImagePairAnalysis;
  readonly artifacts: GimpGauntletArtifacts;
  readonly drawPrompt?: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

export interface GimpGauntletOptions {
  readonly cwd?: string;
  /** Defaults to .pi/workflow-artifacts/computer-use/<unique id> under cwd. */
  readonly artifactDir?: string;
  readonly drawPrompt?: string;
  readonly timeoutMs?: number;
  readonly minScore?: number;
  /** Default true: missing native GUI dependencies produce a skipped result instead of a failed one. */
  readonly skipIfMissing?: boolean;
  readonly signal?: AbortSignal;
  readonly runner?: CommandRunner;
  readonly env?: NodeJS.ProcessEnv;
}

interface ToolContextLike {
  readonly cwd?: string;
}

function limitOutput(text: string, limit = PROCESS_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.floor(limit / 2))}\n...[truncated ${text.length - limit} chars]...\n${text.slice(-Math.floor(limit / 2))}`;
}

export function createProcessCommandRunner(): CommandRunner {
  return {
    run(command: string, args: readonly string[], options: CommandRunnerOptions = {}): Promise<CommandResult> {
      const started = Date.now();
      return new Promise((resolvePromise) => {
        const detached = process.platform !== "win32";
        const child = spawn(command, [...args], {
          cwd: options.cwd,
          detached,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;

        const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          resolvePromise({
            command,
            args,
            exitCode,
            signal,
            stdout: limitOutput(stdout),
            stderr: limitOutput(stderr),
            durationMs: Date.now() - started,
            timedOut,
          });
        };

        const kill = (signal: NodeJS.Signals = "SIGTERM") => {
          try {
            if (detached && child.pid) {
              process.kill(-child.pid, signal);
            } else if (!child.killed) {
              child.kill(signal);
            }
          } catch {
            // Ignore process-tree races; close/error will settle the result.
          }
        };

        const abort = () => kill("SIGTERM");
        options.signal?.addEventListener("abort", abort, { once: true });

        const timer = options.timeoutMs
          ? setTimeout(() => {
              timedOut = true;
              kill("SIGTERM");
              setTimeout(() => kill("SIGKILL"), 2_000).unref?.();
            }, options.timeoutMs)
          : undefined;
        timer?.unref?.();

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout = limitOutput(stdout + chunk.toString("utf8"));
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = limitOutput(stderr + chunk.toString("utf8"));
        });
        child.on("error", (error) => {
          stderr = limitOutput(
            `${stderr}${stderr ? "\n" : ""}${error instanceof Error ? error.message : String(error)}`,
          );
          finish(127, null);
        });
        child.on("close", finish);

        if (options.input !== undefined) child.stdin?.write(options.input);
        child.stdin?.end();
      });
    },
  };
}

function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

async function findExecutable(name: ComputerUseCommandName, runner: CommandRunner, env?: NodeJS.ProcessEnv) {
  const result = await runner.run("bash", ["-lc", `command -v ${name}`], { env, timeoutMs: 5_000 });
  const path = firstNonEmptyLine(result.stdout);
  return result.exitCode === 0 && path ? path : undefined;
}

async function probeCommand(
  name: ComputerUseCommandName,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv | undefined,
  versionArgs: readonly string[] = [],
): Promise<CommandProbe> {
  const path = await findExecutable(name, runner, env);
  if (!path) return { name, found: false, diagnostics: [`${name} was not found on PATH.`] };

  if (versionArgs.length === 0) {
    return { name, found: true, path, diagnostics: [`${name} found at ${path}.`] };
  }

  const version = await runner.run(path, versionArgs, { env, timeoutMs: 8_000 });
  const line = firstNonEmptyLine(`${version.stdout}\n${version.stderr}`);
  return {
    name,
    found: true,
    path,
    version: line,
    diagnostics: [`${name} found at ${path}${line ? ` (${line})` : ""}.`],
  };
}

async function probePillow(
  python: CommandProbe,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv | undefined,
): Promise<PillowProbe> {
  if (!python.found || !python.path) {
    return { found: false, diagnostics: ["Pillow was not checked because python3 is missing."] };
  }
  const result = await runner.run(python.path, ["-c", "import PIL; print(PIL.__version__)"], { env, timeoutMs: 8_000 });
  const version = firstNonEmptyLine(result.stdout);
  if (result.exitCode === 0 && version) {
    return { found: true, version, diagnostics: [`Pillow/PIL ${version} is importable from ${python.path}.`] };
  }
  return {
    found: false,
    diagnostics: [
      `Pillow/PIL is not importable from ${python.path}: ${firstNonEmptyLine(result.stderr) ?? "unknown error"}`,
    ],
  };
}

export async function probeComputerUseDependencies(
  options: { readonly runner?: CommandRunner; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<ComputerUseDependencyProbe> {
  const runner = options.runner ?? createProcessCommandRunner();
  const env = options.env ?? process.env;
  const entries = await Promise.all([
    probeCommand("gimp", runner, env, ["--version"]),
    probeCommand("xvfb-run", runner, env),
    probeCommand("Xvfb", runner, env),
    probeCommand("xdotool", runner, env, ["--version"]),
    probeCommand("magick", runner, env, ["--version"]),
    probeCommand("import", runner, env, ["--version"]),
    probeCommand("python3", runner, env, ["--version"]),
  ]);
  const commands = Object.fromEntries(entries.map((entry) => [entry.name, entry])) as Record<
    ComputerUseCommandName,
    CommandProbe
  >;
  const pillow = await probePillow(commands.python3, runner, env);
  const displayMode = commands["xvfb-run"].found
    ? "xvfb-run"
    : commands.Xvfb.found
      ? "xvfb"
      : env.DISPLAY
        ? "existing-display"
        : "missing";
  const screenshotMode = commands.magick.found
    ? "magick"
    : commands.import.found
      ? "import"
      : pillow.found
        ? "pillow-imagegrab"
        : "missing";
  const diagnostics = [
    ...entries.flatMap((entry) => entry.diagnostics),
    ...pillow.diagnostics,
    `Display mode: ${displayMode}.`,
    `Screenshot mode: ${screenshotMode}.`,
  ];
  return { commands, pillow, displayMode, screenshotMode, diagnostics };
}

export function gimpGauntletDependencyIssues(probe: ComputerUseDependencyProbe): string[] {
  const issues: string[] = [];
  if (!probe.commands.gimp.found) issues.push("gimp is required to launch the GUI under test.");
  if (!probe.commands.xdotool.found) issues.push("xdotool is required to drive GIMP keyboard and pointer input.");
  if (probe.displayMode === "missing")
    issues.push("xvfb-run, Xvfb, or an existing DISPLAY is required for headless GUI use.");
  if (probe.screenshotMode === "missing")
    issues.push("ImageMagick (magick/import) or Pillow ImageGrab is required to capture screenshots.");
  if (!probe.commands.python3.found) issues.push("python3 is required to create canvases and analyze screenshots.");
  if (!probe.pillow.found) issues.push("Pillow/PIL is required for image analysis.");
  return issues;
}

function normalizeUserPath(cwd: string, maybePath: string): string {
  const path = maybePath.startsWith("@") ? maybePath.slice(1) : maybePath;
  return isAbsolute(path) ? path : resolve(cwd, path);
}

async function createArtifactPaths(cwd: string, artifactDir?: string): Promise<GimpGauntletArtifacts> {
  const id = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const dir = artifactDir
    ? normalizeUserPath(cwd, artifactDir)
    : resolve(cwd, ".pi", "workflow-artifacts", "computer-use", id);
  await mkdir(dir, { recursive: true });
  return {
    dir,
    reportJson: join(dir, "gauntlet-report.json"),
    reportMarkdown: join(dir, "gauntlet-report.md"),
    inputCanvas: join(dir, "input-canvas.png"),
    beforeScreenshot: join(dir, "before.png"),
    afterScreenshot: join(dir, "after.png"),
    analysisJson: join(dir, "image-analysis.json"),
    driverScript: join(dir, "drive-gimp.sh"),
    xvfbWrapperScript: join(dir, "run-xvfb.sh"),
    driverStdout: join(dir, "driver.stdout.log"),
    driverStderr: join(dir, "driver.stderr.log"),
  };
}

function clampTimeout(timeoutMs?: number): number {
  if (!Number.isFinite(timeoutMs)) return DEFAULT_GAUNTLET_TIMEOUT_MS;
  return Math.max(10_000, Math.min(Math.floor(timeoutMs ?? DEFAULT_GAUNTLET_TIMEOUT_MS), 600_000));
}

function clampScore(minScore?: number): number {
  if (!Number.isFinite(minScore)) return DEFAULT_MIN_SCORE;
  return Math.max(0, Math.min(minScore ?? DEFAULT_MIN_SCORE, 1));
}

const CREATE_CANVAS_PY = `
import sys
from PIL import Image, ImageDraw
path = sys.argv[1]
image = Image.new("RGB", (800, 560), "white")
draw = ImageDraw.Draw(image)
draw.rectangle((0, 0, 799, 559), outline=(225, 225, 225), width=2)
draw.text((24, 24), "pi computer-use gauntlet canvas", fill=(180, 180, 180))
image.save(path)
`;

const ANALYZE_PAIR_PY = `
import json
import sys
from PIL import Image, ImageChops, ImageStat
before_path, after_path, output_path = sys.argv[1:4]
before = Image.open(before_path).convert("RGB")
after = Image.open(after_path).convert("RGB")
width = min(before.width, after.width)
height = min(before.height, after.height)
before = before.crop((0, 0, width, height))
after = after.crop((0, 0, width, height))
diff = ImageChops.difference(before, after)
threshold = 20
changed = 0
for pixel in diff.getdata():
    if max(pixel) > threshold:
        changed += 1
pixels = max(width * height, 1)
small_width = 180
small_height = max(1, int(height * (small_width / max(width, 1))))
small = after.resize((small_width, small_height))
colors = small.getcolors(maxcolors=1_000_000) or []
dark = 0
colorful = 0
for r, g, b in after.getdata():
    if r + g + b < 150:
        dark += 1
    if max(r, g, b) - min(r, g, b) > 35:
        colorful += 1
bbox = diff.getbbox()
result = {
    "width": width,
    "height": height,
    "changedPixels": changed,
    "changedRatio": changed / pixels,
    "averageDiff": sum(ImageStat.Stat(diff).mean) / 3,
    "diffBoundingBox": list(bbox) if bbox else None,
    "afterUniqueColorsSample": len(colors),
    "afterDarkRatio": dark / pixels,
    "afterColorfulRatio": colorful / pixels,
}
with open(output_path, "w", encoding="utf-8") as f:
    json.dump(result, f, indent=2, sort_keys=True)
`;

const DRIVER_SCRIPT = String.raw`#!/usr/bin/env bash
set -u

log() { printf '%s\n' "$*"; }

capture_root() {
  local target="$1"
  if [ -n "$MAGICK_BIN" ]; then
    "$MAGICK_BIN" import -window root "$target"
  elif [ -n "$IMPORT_BIN" ]; then
    "$IMPORT_BIN" -window root "$target"
  else
    "$PYTHON_BIN" - "$target" <<'PY'
import sys
from PIL import ImageGrab
ImageGrab.grab().save(sys.argv[1])
PY
  fi
}

focus_gimp_window() {
  "$XDOTOOL_BIN" windowraise "$win" >/dev/null 2>&1 || true
  "$XDOTOOL_BIN" windowfocus --sync "$win" >/dev/null 2>&1 || "$XDOTOOL_BIN" windowfocus "$win" >/dev/null 2>&1 || true
}

find_gimp_window() {
  local ids
  ids="$("$XDOTOOL_BIN" search --onlyvisible --class gimp 2>/dev/null || true)
$("$XDOTOOL_BIN" search --onlyvisible --name 'GIMP|GNU Image Manipulation Program|input-canvas' 2>/dev/null || true)"
  local best=""
  local best_area=0
  local candidate
  for candidate in $ids; do
    local geometry=""
    geometry="$("$XDOTOOL_BIN" getwindowgeometry --shell "$candidate" 2>/dev/null)" || continue
    local key=""
    local value=""
    local width=0
    local height=0
    while IFS='=' read -r key value; do
      case "$key" in
        WIDTH)
          if [[ "$value" =~ ^[0-9]+$ ]]; then width="$value"; fi
          ;;
        HEIGHT)
          if [[ "$value" =~ ^[0-9]+$ ]]; then height="$value"; fi
          ;;
      esac
    done <<< "$geometry"
    if [ "$width" -lt 500 ] || [ "$height" -lt 350 ]; then
      continue
    fi
    local area=$((width * height))
    if [ "$area" -gt "$best_area" ]; then
      best="$candidate"
      best_area="$area"
    fi
  done
  if [ -n "$best" ]; then
    printf '%s\n' "$best"
  fi
}

locate_canvas_box() {
  local mode_arg="fallback"
  if [ "$#" -gt 0 ]; then mode_arg="$1"; fi
  "$PYTHON_BIN" - "$BEFORE_PATH" "$X" "$Y" "$WIDTH" "$HEIGHT" "$mode_arg" <<'PY'
import sys
from PIL import Image

path, wx, wy, ww, wh, mode = sys.argv[1:7]
wx, wy, ww, wh = [int(v) for v in (wx, wy, ww, wh)]
require_found = mode == "required"
image = Image.open(path).convert("RGB")
left = max(0, wx)
top = max(0, wy)
right = min(image.width, wx + ww)
bottom = min(image.height, wy + wh)

# Prefer the actual white image drawable rather than the GIMP window center.
# GIMP 3.x first-run/welcome surfaces and dark chrome contain scattered bright
# text/icons, but not a large dense neutral rectangle like the generated canvas.
best = None
pixels = image.load()
for threshold in (245, 230, 210, 190, 170):
    xs = []
    ys = []
    for y in range(top, bottom):
        for x in range(left, right):
            r, g, b = pixels[x, y]
            if r >= threshold and g >= threshold and b >= threshold and max(r, g, b) - min(r, g, b) <= 48:
                xs.append(x)
                ys.append(y)
    if not xs:
        continue
    box = (min(xs), min(ys), max(xs), max(ys))
    area = max((box[2] - box[0] + 1) * (box[3] - box[1] + 1), 1)
    density = len(xs) / area
    if len(xs) >= 8000 and area >= 25000 and density >= 0.18:
        best = box
        break

if best is None:
    if require_found:
        sys.exit(3)
    # Conservative fallback: center of the likely image workspace, avoiding
    # menus/toolboxes/status bars better than a raw window-center stroke.
    inset_x = max(90, ww // 4)
    inset_top = max(110, wh // 4)
    inset_bottom = max(90, wh // 5)
    best = (wx + inset_x, wy + inset_top, wx + ww - inset_x, wy + wh - inset_bottom)

l, t, r, b = best
# Stay inside the drawable/padding so rulers, scrollbars, and status bars are
# not mistaken for the canvas target.
pad_x = max(8, (r - l) // 20)
pad_y = max(8, (b - t) // 20)
l = max(0, min(image.width - 1, l + pad_x))
t = max(0, min(image.height - 1, t + pad_y))
r = max(l + 1, min(image.width - 1, r - pad_x))
b = max(t + 1, min(image.height - 1, b - pad_y))
print(l, t, r, b)
PY
}

export HOME="$TMP_HOME/home"
export XDG_CONFIG_HOME="$TMP_HOME/xdg-config"
export XDG_CACHE_HOME="$TMP_HOME/xdg-cache"
export XDG_DATA_HOME="$TMP_HOME/xdg-data"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"

gimp_stdout="$TMP_HOME/gimp.stdout.log"
gimp_stderr="$TMP_HOME/gimp.stderr.log"

cat >"$TMP_HOME/gimprc" <<'EOF'
(show-welcome-dialog no)
(initial-zoom-to-fit yes)
(default-show-all no)
EOF

log "Launching GIMP with isolated HOME=$HOME"
"$GIMP_BIN" --new-instance --no-splash --gimprc "$TMP_HOME/gimprc" "$CANVAS_PATH" >"$gimp_stdout" 2>"$gimp_stderr" &
gimp_pid=$!

cleanup() {
  if kill -0 "$gimp_pid" >/dev/null 2>&1; then
    kill "$gimp_pid" >/dev/null 2>&1 || true
    sleep 1
    kill -9 "$gimp_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

win=""
for _ in $(seq 1 75); do
  win="$(find_gimp_window || true)"
  if [ -n "$win" ]; then break; fi
  if ! kill -0 "$gimp_pid" >/dev/null 2>&1; then
    log "GIMP exited before a visible window appeared"
    cat "$gimp_stderr" >&2 || true
    exit 21
  fi
  sleep 1
done

if [ -z "$win" ]; then
  log "Timed out waiting for a visible GIMP window" >&2
  cat "$gimp_stderr" >&2 || true
  exit 22
fi

log "Driving GIMP window $win"
focus_gimp_window
sleep 1
"$XDOTOOL_BIN" key --clearmodifiers Escape >/dev/null 2>&1 || true
sleep 0.5
refreshed_win="$(find_gimp_window || true)"
if [ -n "$refreshed_win" ]; then
  win="$refreshed_win"
fi

geometry="$("$XDOTOOL_BIN" getwindowgeometry --shell "$win")" || {
  log "Failed to read GIMP window geometry" >&2
  exit 23
}
X=0
Y=0
WIDTH=0
HEIGHT=0
while IFS='=' read -r key value; do
  case "$key" in
    X|Y|WIDTH|HEIGHT)
      if [[ "$value" =~ ^-?[0-9]+$ ]]; then
        printf -v "$key" '%s' "$value"
      fi
      ;;
  esac
done <<< "$geometry"
if [ "$WIDTH" -le 0 ] || [ "$HEIGHT" -le 0 ]; then
  log "Invalid GIMP window geometry: $geometry" >&2
  exit 24
fi

canvas_box=""
for _ in $(seq 1 40); do
  if ! capture_root "$BEFORE_PATH"; then
    log "Failed to capture before screenshot" >&2
    exit 31
  fi
  if canvas_box="$(locate_canvas_box required 2>/dev/null)" && [ -n "$canvas_box" ]; then
    break
  fi
  focus_gimp_window
  "$XDOTOOL_BIN" key --clearmodifiers Escape >/dev/null 2>&1 || true
  sleep 0.5
done
if [ -z "$canvas_box" ]; then
  log "Timed out waiting for the input canvas to become visible" >&2
  exit 25
fi
read -r canvas_left canvas_top canvas_right canvas_bottom <<< "$canvas_box"
log "Targeting canvas box $canvas_left,$canvas_top to $canvas_right,$canvas_bottom"
canvas_width=$((canvas_right - canvas_left))
canvas_height=$((canvas_bottom - canvas_top))
if [ "$canvas_width" -le 20 ] || [ "$canvas_height" -le 20 ]; then
  log "Invalid canvas target: $canvas_box" >&2
  exit 26
fi

focus_gimp_window
cx=$((canvas_left + canvas_width / 2))
cy=$((canvas_top + canvas_height / 2))
"$XDOTOOL_BIN" mousemove --sync "$cx" "$cy"
"$XDOTOOL_BIN" click --clearmodifiers 1
sleep 0.3

# Select/configure paintbrush with real focused keyboard events. Avoid sending
# keys directly to a top-level GTK window: under bare Xvfb that path can miss
# GIMP's canvas widget even when the process window is visible.
focus_gimp_window
"$XDOTOOL_BIN" key --clearmodifiers d || true
sleep 0.1
"$XDOTOOL_BIN" key --clearmodifiers p || true
sleep 0.2
for _ in $(seq 1 12); do
  "$XDOTOOL_BIN" key --clearmodifiers bracketright >/dev/null 2>&1 || true
  sleep 0.02
done
sleep 0.3

stroke() {
  local x1="$1"
  local y1="$2"
  local x2="$3"
  local y2="$4"
  "$XDOTOOL_BIN" mousemove --sync "$x1" "$y1"
  sleep 0.05
  "$XDOTOOL_BIN" mousedown 1
  sleep 0.08
  for step in $(seq 1 24); do
    local x=$((x1 + (x2 - x1) * step / 24))
    local y=$((y1 + (y2 - y1) * step / 24))
    "$XDOTOOL_BIN" mousemove --sync "$x" "$y"
    sleep 0.015
  done
  sleep 0.05
  "$XDOTOOL_BIN" mouseup 1
  sleep 0.1
}

x1=$((canvas_left + canvas_width / 6))
y1=$((canvas_top + canvas_height / 4))
x2=$((canvas_right - canvas_width / 6))
y2=$((canvas_bottom - canvas_height / 4))
x3=$((canvas_left + canvas_width / 5))
y3=$((canvas_bottom - canvas_height / 5))
x4=$((canvas_right - canvas_width / 5))
y4=$((canvas_top + canvas_height / 5))
x5=$((canvas_left + canvas_width / 4))
y5=$cy
x6=$((canvas_right - canvas_width / 4))
y6=$cy

stroke "$x1" "$y1" "$x2" "$y2"
stroke "$x3" "$y3" "$x4" "$y4"
stroke "$x5" "$y5" "$x6" "$y6"
sleep 1
if ! capture_root "$AFTER_PATH"; then
  log "Failed to capture after screenshot" >&2
  exit 32
fi

log "Captured before and after screenshots"
`;

const XVFB_WRAPPER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

display_num=""
for candidate in $(seq 99 140); do
  if [ ! -e "/tmp/.X11-unix/X$candidate" ]; then
    display_num="$candidate"
    break
  fi
done

if [ -z "$display_num" ]; then
  echo "No free Xvfb display number found" >&2
  exit 31
fi

xvfb_stdout="$TMP_HOME/xvfb.stdout.log"
xvfb_stderr="$TMP_HOME/xvfb.stderr.log"

"$XVFB_BIN" ":$display_num" -screen 0 "$SCREEN_SIZE" -nolisten tcp >"$xvfb_stdout" 2>"$xvfb_stderr" &
xvfb_pid=$!
cleanup() {
  if kill -0 "$xvfb_pid" >/dev/null 2>&1; then
    kill "$xvfb_pid" >/dev/null 2>&1 || true
    sleep 1
    kill -9 "$xvfb_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

export DISPLAY=":$display_num"
display_ready=0
for _ in $(seq 1 50); do
  if "$XDOTOOL_BIN" getdisplaygeometry >/dev/null 2>&1; then
    display_ready=1
    break
  fi
  if ! kill -0 "$xvfb_pid" >/dev/null 2>&1; then
    echo "Xvfb exited before accepting connections" >&2
    cat "$xvfb_stderr" >&2 || true
    exit 32
  fi
  sleep 0.1
done
if [ "$display_ready" -ne 1 ]; then
  echo "Timed out waiting for Xvfb display :$display_num" >&2
  cat "$xvfb_stderr" >&2 || true
  exit 33
fi

bash "$DRIVER_SCRIPT_PATH"
`;

function asImagePairAnalysis(value: unknown): ImagePairAnalysis | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const bbox = record.diffBoundingBox;
  return {
    width: Number(record.width ?? 0),
    height: Number(record.height ?? 0),
    changedPixels: Number(record.changedPixels ?? 0),
    changedRatio: Number(record.changedRatio ?? 0),
    averageDiff: Number(record.averageDiff ?? 0),
    diffBoundingBox:
      Array.isArray(bbox) && bbox.length === 4
        ? ([Number(bbox[0]), Number(bbox[1]), Number(bbox[2]), Number(bbox[3])] as const)
        : null,
    afterUniqueColorsSample: Number(record.afterUniqueColorsSample ?? 0),
    afterDarkRatio: Number(record.afterDarkRatio ?? 0),
    afterColorfulRatio: Number(record.afterColorfulRatio ?? 0),
  };
}

export function scoreGimpGauntlet(args: {
  readonly dependenciesOk: boolean;
  readonly driverOk: boolean;
  readonly analysis?: ImagePairAnalysis;
}): { readonly score: number; readonly checks: readonly GimpGauntletCheck[]; readonly hints: readonly string[] } {
  const analysis = args.analysis;
  const checks: GimpGauntletCheck[] = [];
  const add = (check: GimpGauntletCheck) => checks.push(check);

  add({
    name: "dependencies",
    passed: args.dependenciesOk,
    score: args.dependenciesOk ? 0.2 : 0,
    maxScore: 0.2,
    diagnostic: args.dependenciesOk
      ? "All required native GUI dependencies are available."
      : "Native GUI dependencies are missing.",
    improvementHint: args.dependenciesOk
      ? undefined
      : "Install missing packages or run on a host with Xvfb, xdotool, GIMP, ImageMagick, python3, and Pillow.",
  });

  add({
    name: "gimp-driver-exit",
    passed: args.driverOk,
    score: args.driverOk ? 0.2 : 0,
    maxScore: 0.2,
    diagnostic: args.driverOk
      ? "The Xvfb/xdotool GIMP driver exited successfully."
      : "The Xvfb/xdotool GIMP driver failed.",
    improvementHint: args.driverOk
      ? undefined
      : "Inspect driver stdout/stderr artifacts; GIMP startup timing or window matching may need tuning.",
  });

  const screenshotsOk = Boolean(analysis && analysis.width >= 320 && analysis.height >= 240);
  add({
    name: "screenshots-captured",
    passed: screenshotsOk,
    score: screenshotsOk ? 0.2 : 0,
    maxScore: 0.2,
    diagnostic: screenshotsOk
      ? `Captured comparable screenshots at ${analysis?.width}x${analysis?.height}.`
      : "Comparable before/after screenshots were not captured.",
    improvementHint: screenshotsOk
      ? undefined
      : "Verify ImageMagick import works inside the selected display and that GIMP opens a visible window.",
  });

  const visibleGui = Boolean(
    analysis &&
      analysis.afterUniqueColorsSample >= 24 &&
      (analysis.afterDarkRatio > 0.005 || analysis.afterColorfulRatio > 0.005),
  );
  add({
    name: "visible-gui-state",
    passed: visibleGui,
    score: visibleGui ? 0.2 : 0,
    maxScore: 0.2,
    diagnostic: visibleGui
      ? `Screenshot has ${analysis?.afterUniqueColorsSample} sampled colors, dark ratio ${analysis?.afterDarkRatio.toFixed(4)}, colorful ratio ${analysis?.afterColorfulRatio.toFixed(4)}.`
      : "Screenshot does not look like a visible, non-empty GUI.",
    improvementHint: visibleGui
      ? undefined
      : "Capture the root window after GIMP is activated; increase wait time if the UI is still blank.",
  });

  const drawDelta = Boolean(
    analysis && analysis.changedPixels >= 500 && analysis.changedRatio >= 0.0005 && analysis.averageDiff >= 0.25,
  );
  add({
    name: "xdotool-draw-delta",
    passed: drawDelta,
    score: drawDelta ? 0.2 : 0,
    maxScore: 0.2,
    diagnostic: drawDelta
      ? `Before/after changed ${analysis?.changedPixels} pixels (${analysis?.changedRatio.toFixed(6)}), average diff ${analysis?.averageDiff.toFixed(3)}.`
      : "Before/after screenshots do not show enough visual change from the drawing gesture.",
    improvementHint: drawDelta
      ? undefined
      : "Adjust canvas targeting, select a brush/tool explicitly, or increase the xdotool stroke size/duration.",
  });

  const score = Number(checks.reduce((sum, check) => sum + check.score, 0).toFixed(3));
  const hints = checks.flatMap((check) => (check.improvementHint ? [check.improvementHint] : []));
  return { score, checks, hints };
}

function skippedResult(args: {
  readonly artifacts: GimpGauntletArtifacts;
  readonly dependencies: ComputerUseDependencyProbe;
  readonly issues: readonly string[];
  readonly minScore: number;
  readonly startedAt: string;
  readonly startedMs: number;
  readonly skipIfMissing: boolean;
  readonly drawPrompt?: string;
}): GimpGauntletResult {
  const completedAt = new Date().toISOString();
  const status = args.skipIfMissing ? "skipped" : "failed";
  const hints = args.issues.map((issue) => `Resolve dependency: ${issue}`);
  return {
    ...(args.drawPrompt ? { drawPrompt: args.drawPrompt } : {}),
    status,
    passed: false,
    skipped: args.skipIfMissing,
    score: 0,
    minScore: args.minScore,
    summary: args.skipIfMissing
      ? `Skipped GIMP computer-use gauntlet because ${args.issues.length} required dependency issue(s) were found.`
      : `Failed GIMP computer-use gauntlet because ${args.issues.length} required dependency issue(s) were found.`,
    diagnostics: [...args.issues, ...args.dependencies.diagnostics],
    improvementHints: hints,
    checks: [
      {
        name: "dependencies",
        passed: false,
        score: 0,
        maxScore: 1,
        diagnostic: args.issues.join(" "),
        improvementHint: hints.join(" "),
      },
    ],
    dependencies: args.dependencies,
    artifacts: args.artifacts,
    startedAt: args.startedAt,
    completedAt,
    durationMs: Date.now() - args.startedMs,
  };
}

async function writeGauntletArtifacts(result: GimpGauntletResult): Promise<void> {
  await mkdir(result.artifacts.dir, { recursive: true });
  await writeFile(result.artifacts.reportJson, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(result.artifacts.reportMarkdown, buildGimpGauntletMarkdown(result), "utf8");
}

async function pathExists(path?: string, modifiedSinceMs?: number): Promise<boolean> {
  if (!path) return false;
  try {
    const file = await stat(path);
    return modifiedSinceMs === undefined || file.mtimeMs >= modifiedSinceMs;
  } catch {
    return false;
  }
}

async function materializeArtifacts(
  artifacts: GimpGauntletArtifacts,
  modifiedSinceMs?: number,
): Promise<GimpGauntletArtifacts> {
  const [
    inputCanvas,
    beforeScreenshot,
    afterScreenshot,
    analysisJson,
    driverScript,
    xvfbWrapperScript,
    driverStdout,
    driverStderr,
  ] = await Promise.all([
    pathExists(artifacts.inputCanvas, modifiedSinceMs),
    pathExists(artifacts.beforeScreenshot, modifiedSinceMs),
    pathExists(artifacts.afterScreenshot, modifiedSinceMs),
    pathExists(artifacts.analysisJson, modifiedSinceMs),
    pathExists(artifacts.driverScript, modifiedSinceMs),
    pathExists(artifacts.xvfbWrapperScript, modifiedSinceMs),
    pathExists(artifacts.driverStdout, modifiedSinceMs),
    pathExists(artifacts.driverStderr, modifiedSinceMs),
  ]);
  return {
    dir: artifacts.dir,
    reportJson: artifacts.reportJson,
    reportMarkdown: artifacts.reportMarkdown,
    ...(inputCanvas && artifacts.inputCanvas ? { inputCanvas: artifacts.inputCanvas } : {}),
    ...(beforeScreenshot && artifacts.beforeScreenshot ? { beforeScreenshot: artifacts.beforeScreenshot } : {}),
    ...(afterScreenshot && artifacts.afterScreenshot ? { afterScreenshot: artifacts.afterScreenshot } : {}),
    ...(analysisJson && artifacts.analysisJson ? { analysisJson: artifacts.analysisJson } : {}),
    ...(driverScript && artifacts.driverScript ? { driverScript: artifacts.driverScript } : {}),
    ...(xvfbWrapperScript && artifacts.xvfbWrapperScript ? { xvfbWrapperScript: artifacts.xvfbWrapperScript } : {}),
    ...(driverStdout && artifacts.driverStdout ? { driverStdout: artifacts.driverStdout } : {}),
    ...(driverStderr && artifacts.driverStderr ? { driverStderr: artifacts.driverStderr } : {}),
  };
}

async function readAnalysis(path: string): Promise<ImagePairAnalysis | undefined> {
  try {
    return asImagePairAnalysis(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

export async function runGimpGauntlet(options: GimpGauntletOptions = {}): Promise<GimpGauntletResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const runner = options.runner ?? createProcessCommandRunner();
  const timeoutMs = clampTimeout(options.timeoutMs);
  const minScore = clampScore(options.minScore);
  const skipIfMissing = options.skipIfMissing ?? true;
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const artifacts = await createArtifactPaths(cwd, options.artifactDir);
  const dependencies = await probeComputerUseDependencies({ runner, env });
  const dependencyIssues = gimpGauntletDependencyIssues(dependencies);

  if (dependencyIssues.length > 0) {
    const result = skippedResult({
      artifacts: await materializeArtifacts(artifacts, startedMs),
      dependencies,
      issues: dependencyIssues,
      minScore,
      startedAt,
      startedMs,
      skipIfMissing,
      drawPrompt: options.drawPrompt,
    });
    await writeGauntletArtifacts(result);
    return result;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "pi-gimp-gauntlet-"));
  const diagnostics: string[] = [
    ...(options.drawPrompt ? [`Draw prompt: ${options.drawPrompt}`] : []),
    ...dependencies.diagnostics,
  ];
  const extraHints: string[] = [];
  let driverOk = false;
  let analysis: ImagePairAnalysis | undefined;

  try {
    const python = dependencies.commands.python3.path;
    const gimp = dependencies.commands.gimp.path;
    const xdotool = dependencies.commands.xdotool.path;
    if (!python || !gimp || !xdotool || !artifacts.inputCanvas || !artifacts.driverScript) {
      throw new Error("Internal dependency resolution error: missing command paths or artifact paths.");
    }

    const createCanvas = await runner.run(python, ["-c", CREATE_CANVAS_PY, artifacts.inputCanvas], {
      cwd,
      env,
      timeoutMs: 15_000,
      signal: options.signal,
    });
    if (createCanvas.exitCode !== 0) {
      const diagnostic = `Canvas creation failed: ${firstNonEmptyLine(createCanvas.stderr) ?? "unknown error"}`;
      diagnostics.push(diagnostic);
      extraHints.push("Verify Pillow can create PNG files in the artifact directory.");
      throw new Error(diagnostic);
    }

    await writeFile(artifacts.driverScript, DRIVER_SCRIPT, { encoding: "utf8", mode: 0o755 });
    if (artifacts.xvfbWrapperScript) {
      await writeFile(artifacts.xvfbWrapperScript, XVFB_WRAPPER_SCRIPT, { encoding: "utf8", mode: 0o755 });
    }

    const magick = dependencies.commands.magick.path ?? "";
    const importBin = dependencies.commands.import.path ?? "";
    const driverEnv: NodeJS.ProcessEnv = {
      ...env,
      TMP_HOME: tempDir,
      GIMP_BIN: gimp,
      XDOTOOL_BIN: xdotool,
      PYTHON_BIN: python,
      MAGICK_BIN: magick,
      IMPORT_BIN: importBin,
      CANVAS_PATH: artifacts.inputCanvas,
      BEFORE_PATH: artifacts.beforeScreenshot ?? join(artifacts.dir, "before.png"),
      AFTER_PATH: artifacts.afterScreenshot ?? join(artifacts.dir, "after.png"),
      DRIVER_SCRIPT_PATH: artifacts.driverScript,
      SCREEN_SIZE: DEFAULT_SCREEN_SIZE,
      XVFB_BIN: dependencies.commands.Xvfb.path ?? "",
    };

    const displayArgs = ["-screen", "0", DEFAULT_SCREEN_SIZE].join(" ");
    const useXvfbRun = dependencies.displayMode === "xvfb-run" && dependencies.commands["xvfb-run"].path;
    const useRawXvfb = dependencies.displayMode === "xvfb" && artifacts.xvfbWrapperScript;
    const driver = useXvfbRun
      ? await runner.run(
          dependencies.commands["xvfb-run"].path as string,
          ["-a", "-s", displayArgs, "bash", artifacts.driverScript],
          {
            cwd,
            env: driverEnv,
            timeoutMs,
            signal: options.signal,
          },
        )
      : useRawXvfb
        ? await runner.run("bash", [artifacts.xvfbWrapperScript as string], {
            cwd,
            env: driverEnv,
            timeoutMs,
            signal: options.signal,
          })
        : await runner.run("bash", [artifacts.driverScript], {
            cwd,
            env: driverEnv,
            timeoutMs,
            signal: options.signal,
          });

    await writeFile(artifacts.driverStdout ?? join(artifacts.dir, "driver.stdout.log"), driver.stdout, "utf8");
    await writeFile(artifacts.driverStderr ?? join(artifacts.dir, "driver.stderr.log"), driver.stderr, "utf8");
    driverOk = driver.exitCode === 0 && !driver.timedOut;
    diagnostics.push(
      `GIMP driver exited with code ${driver.exitCode ?? "null"}${driver.timedOut ? " after timing out" : ""}.`,
    );
    if (!driverOk) {
      extraHints.push("Open driver.stdout.log and driver.stderr.log to inspect GIMP startup/window matching failures.");
    }

    if (driverOk && artifacts.beforeScreenshot && artifacts.afterScreenshot && artifacts.analysisJson) {
      const analyze = await runner.run(
        python,
        ["-c", ANALYZE_PAIR_PY, artifacts.beforeScreenshot, artifacts.afterScreenshot, artifacts.analysisJson],
        {
          cwd,
          env,
          timeoutMs: 30_000,
          signal: options.signal,
        },
      );
      if (analyze.exitCode !== 0) {
        diagnostics.push(`Image analysis failed: ${firstNonEmptyLine(analyze.stderr) ?? "unknown error"}`);
        extraHints.push("Verify before.png and after.png are readable PNG files and Pillow can open them.");
      }
      analysis = await readAnalysis(artifacts.analysisJson);
    }
  } catch (error) {
    diagnostics.push(`Gauntlet exception: ${error instanceof Error ? error.message : String(error)}`);
    extraHints.push("Retry with a larger timeout or inspect generated artifacts for partial progress.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const scored = scoreGimpGauntlet({ dependenciesOk: dependencyIssues.length === 0, driverOk, analysis });
  const score = scored.score;
  const passed = score >= minScore && scored.checks.every((check) => check.passed) && driverOk;
  const completedAt = new Date().toISOString();
  const result: GimpGauntletResult = {
    ...(options.drawPrompt ? { drawPrompt: options.drawPrompt } : {}),
    status: passed ? "passed" : "failed",
    passed,
    skipped: false,
    score,
    minScore,
    summary: passed
      ? `Passed GIMP computer-use gauntlet with score ${score.toFixed(2)}.`
      : `Failed GIMP computer-use gauntlet with score ${score.toFixed(2)} (minimum ${minScore.toFixed(2)}).`,
    diagnostics,
    improvementHints: [...scored.hints, ...extraHints],
    checks: scored.checks,
    dependencies,
    analysis,
    artifacts: await materializeArtifacts(artifacts, startedMs),
    startedAt,
    completedAt,
    durationMs: Date.now() - startedMs,
  };
  await writeGauntletArtifacts(result);
  return result;
}

function formatCommandProbe(probe: CommandProbe): string {
  const status = probe.found ? "found" : "missing";
  const version = probe.version ? ` — ${probe.version}` : "";
  return `- ${probe.name}: ${status}${probe.path ? ` at ${probe.path}` : ""}${version}`;
}

export function buildDependencyProbeMarkdown(probe: ComputerUseDependencyProbe): string {
  return [
    "# Pi computer-use dependency probe",
    "",
    `Display mode: **${probe.displayMode}**`,
    `Screenshot mode: **${probe.screenshotMode}**`,
    "",
    "## Commands",
    ...Object.values(probe.commands).map(formatCommandProbe),
    "",
    "## Python imaging",
    `- Pillow/PIL: ${probe.pillow.found ? `found (${probe.pillow.version ?? "version unknown"})` : "missing"}`,
    "",
    "## Diagnostics",
    ...probe.diagnostics.map((line) => `- ${line}`),
  ].join("\n");
}

export function buildGimpGauntletMarkdown(result: GimpGauntletResult): string {
  const checkRows = result.checks.map(
    (check) =>
      `| ${check.name} | ${check.passed ? "pass" : "fail"} | ${check.score.toFixed(2)} / ${check.maxScore.toFixed(2)} | ${check.diagnostic.replace(/\|/g, "\\|")} |`,
  );
  const analysisLines = result.analysis
    ? [
        `- Size: ${result.analysis.width}x${result.analysis.height}`,
        `- Changed pixels: ${result.analysis.changedPixels} (${result.analysis.changedRatio.toFixed(6)})`,
        `- Average diff: ${result.analysis.averageDiff.toFixed(3)}`,
        `- Sampled colors: ${result.analysis.afterUniqueColorsSample}`,
      ]
    : ["- No image-pair analysis was available."];
  return [
    "# Pi computer-use GIMP gauntlet",
    "",
    `Status: **${result.status}**`,
    `Score: **${result.score.toFixed(2)} / 1.00** (minimum ${result.minScore.toFixed(2)})`,
    `Summary: ${result.summary}`,
    "",
    "## Checks",
    "| Check | Result | Score | Diagnostic |",
    "| --- | --- | ---: | --- |",
    ...checkRows,
    "",
    "## Image analysis",
    ...analysisLines,
    "",
    "## Improvement hints",
    ...(result.improvementHints.length ? result.improvementHints.map((hint) => `- ${hint}`) : ["- None."]),
    "",
    "## Diagnostics",
    ...(result.diagnostics.length ? result.diagnostics.map((line) => `- ${line}`) : ["- None."]),
    "",
    "## Dependencies",
    ...Object.values(result.dependencies.commands).map(formatCommandProbe),
    `- Pillow/PIL: ${result.dependencies.pillow.found ? `found (${result.dependencies.pillow.version ?? "version unknown"})` : "missing"}`,
    `- Display mode: ${result.dependencies.displayMode}`,
    `- Screenshot mode: ${result.dependencies.screenshotMode}`,
    "",
    "## Artifacts",
    `- Directory: ${result.artifacts.dir}`,
    `- JSON report: ${result.artifacts.reportJson}`,
    `- Markdown report: ${result.artifacts.reportMarkdown}`,
    result.artifacts.beforeScreenshot ? `- Before screenshot: ${result.artifacts.beforeScreenshot}` : undefined,
    result.artifacts.afterScreenshot ? `- After screenshot: ${result.artifacts.afterScreenshot}` : undefined,
    result.artifacts.analysisJson ? `- Image analysis JSON: ${result.artifacts.analysisJson}` : undefined,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

export function summarizeGimpGauntletResult(result: GimpGauntletResult): string {
  const hints = result.improvementHints
    .slice(0, 5)
    .map((hint) => `- ${hint}`)
    .join("\n");
  return [
    result.summary,
    `Status: ${result.status}; score ${result.score.toFixed(2)} / 1.00.`,
    `Artifacts: ${result.artifacts.reportJson} and ${result.artifacts.reportMarkdown}`,
    hints ? `Improvement hints:\n${hints}` : "Improvement hints: none.",
  ].join("\n");
}

function resolveToolCwd(defaultCwd: string, ctx?: ToolContextLike): string {
  return ctx?.cwd ? ctx.cwd : defaultCwd;
}

export function createComputerUseProbeTool(cwd = process.cwd()): ToolDefinition {
  return defineTool({
    name: "computer_use_probe",
    label: "Computer-Use Probe",
    description: "Check whether native GUI computer-use dependencies are available for Xvfb/xdotool verification.",
    promptSnippet: "Probe native GUI computer-use dependencies",
    promptGuidelines: [
      "Use computer_use_probe before GUI use-verification when dependency availability is uncertain.",
      "computer_use_probe is read-only and should be used to decide whether a GUI verification must be skipped gracefully.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const probe = await probeComputerUseDependencies({ env: process.env });
      return {
        content: [{ type: "text", text: buildDependencyProbeMarkdown(probe) }],
        details: { cwd: resolveToolCwd(cwd, ctx), probe },
      };
    },
  }) as unknown as ToolDefinition;
}

export function createGimpGauntletTool(cwd = process.cwd()): ToolDefinition {
  return defineTool({
    name: "computer_use_gimp_gauntlet",
    label: "GIMP Computer-Use Gauntlet",
    description:
      "Run a non-destructive Xvfb/xdotool GIMP gauntlet, capture screenshots, analyze the image delta, and write JSON/Markdown artifacts.",
    promptSnippet: "Run a non-destructive GIMP GUI computer-use gauntlet",
    promptGuidelines: [
      "Use computer_use_gimp_gauntlet in workflow Use Verification phases for GUI applications that need non-destructive computer-use evidence.",
      "computer_use_gimp_gauntlet writes artifacts under .pi/workflow-artifacts by default; do not commit those generated artifacts.",
      "If computer_use_gimp_gauntlet reports skipped, cite the missing dependency diagnostics instead of pretending GUI verification succeeded.",
    ],
    parameters: Type.Object({
      artifactDir: Type.Optional(
        Type.String({
          description: "Optional artifact directory. Relative paths resolve from the current working directory.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({ description: "Overall gauntlet timeout in milliseconds (default 120000)." }),
      ),
      minScore: Type.Optional(
        Type.Number({ description: "Minimum score from 0 to 1 required to pass (default 0.75)." }),
      ),
      drawPrompt: Type.Optional(
        Type.String({
          description: "Optional note describing what the gauntlet is trying to draw; recorded in artifacts.",
        }),
      ),
      skipIfMissing: Type.Optional(
        Type.Boolean({
          description: "Return skipped instead of failed when native dependencies are missing (default true).",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const toolCwd = resolveToolCwd(cwd, ctx);
      const result = await runGimpGauntlet({
        cwd: toolCwd,
        artifactDir: params.artifactDir,
        timeoutMs: params.timeoutMs,
        minScore: params.minScore,
        drawPrompt: params.drawPrompt,
        skipIfMissing: params.skipIfMissing,
        signal,
      });
      return {
        content: [{ type: "text", text: summarizeGimpGauntletResult(result) }],
        details: result,
      };
    },
  }) as unknown as ToolDefinition;
}

export function createComputerUseTools(cwd = process.cwd()): ToolDefinition[] {
  return [createComputerUseProbeTool(cwd), createGimpGauntletTool(cwd)];
}
