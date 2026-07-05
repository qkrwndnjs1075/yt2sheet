# End Overlay Gate Design

## Context

The extension captures a user-selected score ROI from a YouTube watch tab every second, fingerprints each ROI crop, clusters duplicate score images, and exports accepted unique score images to PNG/PDF. The default detector path is local and heuristic; it does not call Gemini, Claude, or another AI judge.

The current failure case is specific to the end of a YouTube video: the end screen or YouTuber profile overlay can cover the selected score ROI. That contaminated frame can look different from the previous score and become a new accepted cluster, which then appears in the exported PDF.

## Goal

Prevent YouTube end-screen/profile overlays from being exported as new score systems while still preserving legitimate score changes near the end of the video.

## Non-Goals

- Do not add default AI, Gemini, Claude, or network API judgment.
- Do not discard every frame near the end unconditionally.
- Do not add a user-facing confirmation dialog in the first implementation.
- Do not change the PDF/PNG export file format.
- Do not persist raw full frames.

## Chosen Approach

Use a rule-based end-candidate gate.

When a sample arrives near the end of the video and appears `different`, it is not immediately accepted as a new score cluster. Instead, it becomes a `pending_end_candidate`. If a second consecutive sample confirms the same score-like candidate, it is accepted. If it is not confirmed before capture stops, it remains visible in debug metadata but is excluded from PDF/PNG export.

This preserves real final score changes that last at least two samples while preventing one-off YouTube overlay/profile frames from entering the export.

## Alternatives Considered

### AI or Vision Judgment

AI could classify a final ROI as score or overlay, but it adds permissions, cost, latency, network failure modes, and key-management complexity. It also conflicts with the current product default of local heuristic processing. AI remains out of scope for the default path.

### Simple End-Window Discard

Discarding the last few seconds is simple and blocks overlays, but it can lose legitimate final score changes. The user explicitly chose final-score preservation over blanket end trimming.

### Rule-Based End-Candidate Gate

This is the selected design. It is local, deterministic, compatible with the existing ROI identity pipeline, and supports the user's chosen policy: preserve final scores, but require two confirmations before accepting ambiguous end-region candidates.

## Architecture

Add a small end-aware gate around ROI identity clustering:

- `video-probe` and background continue carrying video timing and end-state signals.
- Offscreen frame metadata exposes whether a sample is near the end or after an end signal.
- ROI fingerprinting and quality evaluation continue to run normally.
- An `EndCandidateGate` or equivalent logic decides whether a `different` sample can go directly to normal clustering or must be held as a final candidate.
- Normal samples use the existing `ScoreClusterer` behavior.
- Near-end `same` samples still merge into the matched cluster.
- Near-end `different` samples become pending final candidates unless visual confidence is clearly too low.
- Confirmed final candidates are accepted into the normal unique-score output.
- Unconfirmed or contaminated final candidates are debug-only and never exported.

## Data Flow

1. `video-probe` sends `VIDEO_PROBE_TICK` with `currentTimeSec` and `durationSec`.
2. When the video ends, `VIDEO_ENDED` is sent and capture begins stopping.
3. Any ROI frames that still arrive during this end window are processed through the end gate.
4. The sample is normalized and fingerprinted as usual.
5. Similarity is calculated against existing accepted clusters and any pending final candidate.
6. If the sample is not near the end, existing `same` / `maybe_same` / `different` behavior applies.
7. If the sample is near the end and `different`, the end gate holds it instead of immediately creating an accepted cluster.
8. If the next sample confirms the same pending final candidate, it is accepted.
9. If capture stops before confirmation, the pending candidate is reported in debug metadata and excluded from export.

## End Candidate Rules

A sample is treated as end-sensitive if either condition is true:

- Its timestamp is within a configured window before the video duration.
- A `VIDEO_ENDED` signal has been observed for the session.

A near-end `different` sample is held when it still looks score-like:

- At least three staff-row runs are detected.
- The score-content crop area differs by no more than 40% from the last accepted representative crop area.
- Ink density differs by no more than 0.18 from the last accepted representative.
- No single non-score connected dark/colored region dominates more than 35% of the ROI area.

A near-end candidate is discarded or left debug-only when:

- It appears only once.
- It arrives after the end signal and is not confirmed.
- Fewer than three staff-row runs are detected.
- Score-content crop area changes by more than 40% from the last accepted representative crop area.
- Ink density changes by more than 0.18 from the last accepted representative.
- Overlay contamination indicators exceed the configured threshold.

## Debug Metadata

Debug output must explain the end-gate decision. Required fields:

- `endGate=none`
- `endGate=held`
- `endGate=confirmed`
- `endGate=discarded_overlay`
- `endGate=discarded_unconfirmed`
- `exported=false`
- `pendingEndCandidateCount`

The goal is for a failed real-video test to show why a final frame was held, accepted, or excluded.

## Acceptance Criteria

- End-screen/profile overlay frames inside ROI do not become accepted unique score clusters.
- A real final score change near the end can still be accepted if two consecutive samples confirm the same score-like content.
- A single ambiguous end-region `different` sample is not immediately exported.
- Unconfirmed final candidates remain visible in debug metadata but are excluded from PDF/PNG export.
- Existing normal `A, A, B, B, C` clustering behavior remains intact.
- The implementation does not introduce default AI/API calls.
- Verification includes targeted tests and `npm run verify`.

## Test Cases

### End Overlay False Positive

Input sequence: `A, A, A, overlay`

Expected output: exported unique scores contain only `A`. The overlay is debug-only with an end-gate discard reason.

### Confirmed Final Score

Input sequence: `A, A, B, B`, where `B` appears near the end.

Expected output: exported unique scores contain `A, B`. The first `B` is held, and the second `B` confirms it.

### Unconfirmed Final Candidate

Input sequence: `A, A, B`, where `B` appears once near the end and capture stops.

Expected output: exported unique scores contain only `A`. `B` appears in debug metadata as unconfirmed and not exported.

### Normal Clustering Regression

Input sequence: `A, A, B, B, C`

Expected output: exported unique scores contain `A, B, C`.

## Implementation Constants

- `nearEndWindowMs`: `3000`
- `endCandidateRequiredConfirmations`: `2`
- `maxEndCandidateCropAreaDiff`: `0.40`
- `maxEndCandidateInkDensityDiff`: `0.18`
- `maxOverlayDominantRegionRatio`: `0.35`
- The end gate must be implemented as a small, independently testable unit, not folded into export code.
- The first implementation must prefer explicit debug evidence over hidden heuristics.
