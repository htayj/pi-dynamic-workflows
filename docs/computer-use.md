# Computer-use GIMP gauntlet

`pi-dynamic-workflows` ships two native GUI verification tools for workflow subagents and top-level Pi sessions:

- `computer_use_probe` checks dependency availability.
- `computer_use_gimp_gauntlet` launches GIMP in an isolated GUI session, drives it with `xdotool`, captures before/after screenshots, analyzes the image delta, and writes machine-readable artifacts.

The gauntlet is intended for `Use Verification` phases where a workflow needs non-destructive evidence that GUI computer-use is possible.

## Dependencies

The full gauntlet needs:

- `gimp`
- `xvfb-run`, raw `Xvfb`, or an existing `DISPLAY`
- `xdotool`
- ImageMagick `magick` or `import`
- `python3`
- Pillow/PIL importable from `python3`

If any required dependency is missing, the tool returns `status: "skipped"` by default and writes reports explaining the missing dependency. Pass `skipIfMissing: false` to turn missing dependencies into a failed result.

## Artifacts

By default artifacts are written under:

```text
.pi/workflow-artifacts/computer-use/<run-id>/
```

This path is ignored by this repository's `.gitignore`; do not commit generated gauntlet artifacts. A custom `artifactDir` may be supplied when a workflow wants a stable path.

Each run writes:

- `gauntlet-report.json` — status, score, checks, diagnostics, dependencies, artifact paths, and improvement hints.
- `gauntlet-report.md` — human-readable version suitable for workflow summaries.
- `before.png` and `after.png` when the GUI driver runs far enough to capture screenshots.
- `image-analysis.json` when Pillow can compare the captured screenshots.
- `driver.stdout.log` / `driver.stderr.log` for debugging failed GUI startup or window targeting.

## Scoring

The score is 0–1 and is intentionally autoimprove-loop friendly. It is the sum of five weighted checks:

1. dependencies available
2. GIMP/Xvfb/xdotool driver exited successfully
3. comparable screenshots captured
4. screenshot appears to contain a visible non-empty GUI
5. before/after image delta indicates the xdotool drawing gesture changed the GUI

Failed checks include improvement hints that workflows can feed into later attempts.

## Manual run

```bash
npm run test:gauntlet
```

On machines without GIMP this should skip gracefully and still write JSON/Markdown reports under `.pi/workflow-artifacts/`.
