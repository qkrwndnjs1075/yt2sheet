# ROI Score Export Pipeline

# G070 Immediate Windows uninstall and PowerShell bootstrap repair (2026-07-31)

## Plan

- [x] Capture a failing-first Windows uninstall proof showing the current deferred outcome.
- [x] Reproduce the public raw `irm ... | iex` installer path in an isolated install root and record the current failure or a mutation proof.
- [x] Change Windows standalone uninstall to complete removal semantics without scheduled wording, while preserving Unix cleanup and npm fallback.
- [x] Make the raw PowerShell installer null-safe at its environment and URL boundaries and add the smallest regression contract.
- [x] Run focused tests, diagnostics, real Windows/PowerShell surface QA, and tear down every fixture.
- [x] Run full applicable verification over the mixed worktree, then bump and verify the next CLI patch release.
- [x] Commit and push all requested current changes on `main`, tag `cli-v0.2.3`, and verify the published release assets/checksums.

## Review

- Windows fixture red/green proof: the old implementation returned `deferred: true`; the fixed path returns `deferred: false` and removes the fixture root. The real `0.2.3` bundle uses the launcher handoff required by Windows file locks, returns uninstall exit code `0`, prints no scheduled-cleanup message, and removed its root after the lock-release window without user action.
- The PowerShell installer remains BOM-free and WebClient-based, now guards missing `LOCALAPPDATA`, release URL, and download-client disposal paths. The public `cli-v0.2.2` raw `irm | iex` flow completed all seven stages in an isolated root; the final `cli-v0.2.3` default flow is the post-publication gate.
- `npm run verify` passed: 313 tests passed, one Windows symlink fixture skipped because this host lacks symlink privilege, and CLI/web/extension builds passed. Focused uninstall/installer tests passed 3/3 with the same skip, and `node --check scripts/build-bundle.mjs` passed.
- Final release proof: `main` contains the requested changes, annotated tag `cli-v0.2.3` points to `873dea9`, workflow `30642292167` passed all four platform builds and published the four archives plus `checksums.txt`, and the Windows ZIP checksum matched.
- The exact public default `irm https://raw.githubusercontent.com/qkrwndnjs1075/yt2sheet/main/scripts/install.ps1 | iex` flow completed all seven stages in an isolated root; the installed launcher existed and `yt2 help` exited `0`.

# G069 Release every distribution-facing push (2026-07-31)

## Plan

- [x] Confirm the tag-triggered release workflow and current published version.
- [x] Bump the package and installer defaults to `0.2.2`, then verify the release inputs.
- [x] Commit, push, tag `cli-v0.2.2`, and verify the published cross-platform assets.

## Review

- `d758b0b` (`chore(release): bump cli to 0.2.2`) and annotated tag `cli-v0.2.2` are pushed. Release workflow `30638186114` passed all four platform builds and published the Windows x64, macOS Intel, macOS Apple Silicon, Linux x64 archives plus `checksums.txt`.
- `npm run verify` passed 313 tests with one Windows symlink-permission skip; package dry run reports `yt2sheet@0.2.2`; Git Bash installer syntax and UTF-8 PowerShell parser checks passed. The public raw installer is BOM-free, defaults to `cli-v0.2.2`, and uses `WebClient` rather than `Invoke-WebRequest`.

# G068 PowerShell release-asset download repair (2026-07-31)

## Plan

- [x] Reproduce the PowerShell 5.1 release-download failure against the public installer path.
- [x] Replace the unstable downloader with a .NET release-asset transfer and lock it with a regression test.
- [x] Verify the local raw `irm ... | iex` equivalent to completion in an isolated root.
- [x] Commit and push only the installer repair, then verify the published raw path.

## Review

- The PowerShell 5.1 `Invoke-WebRequest` release transfer stopped at 53,258,000 of 133,682,017 bytes. `System.Net.WebClient.DownloadFile` completed the isolated raw-script flow through stages 1/7 to 7/7; `yt2 help` exited 0. `npm run verify` passed 313 tests with one Windows symlink-permission skip.
- Commit `6465013` is pushed to `main`; GitHub raw content matches the QA-tested local script byte-for-byte, begins with `p` (no BOM), contains `System.Net.WebClient`, and contains no `Invoke-WebRequest`.

# 2026-07-31 Video-to-Score architecture review

## Plan

- [x] Compare the proposed independent video-score flow with the existing standalone image-to-PDF boundary.
- [x] Identify blocking lifecycle, contract, and notation-generation gaps without changing product code.
- [x] Record the review verdict and required design changes.

## Review

- Verdict: REQUEST CHANGES before implementation. The two analyzers and shared activation-to-note boundary are appropriate, but the proposed system needs a durable video-specific control plane instead of reusing the process-local score-job service.
- Required: versioned calibration/analysis state with explicit user-action blockers; dense frame observations that distinguish inactive, occluded, and unknown; a complete notation request (meter, beat origin, pickup and quantization policy); and a versioned worker/artifact protocol.
- Required: separate upload/object storage, ownership checks, resource limits, sandboxed media decoding, pinned worker/model/renderer dependencies, and independently downloadable MIDI, MusicXML and PDF artifacts.
- Important: keep physical and falling-bar calibration algorithms separate behind one output contract, snap partial-keyboard anchors to detected keys, preserve re-attacks across observed release gaps, and persist profile/model versions with confidence evidence.
- No product code, deployment configuration, tests, or runtime processes were changed for this review.

# 2026-07-31 Revised Video-to-Score architecture review

## Review

- Verdict: REQUEST CHANGES, narrowed to execution-completeness. The revision correctly adds a durable control plane, immutable calibration/analysis/notation revisions, PTS-keyed total observations, notation inputs, provenance, ownership, and source-disjoint acceptance gates.
- Required: define source-ingestion, calibration-suggestion, and render request/result messages plus their attempt/lease/retry records. The documented analysis messages alone cannot advance every declared phase.
- Required: make every worker write attempt-scoped immutable keys, use conditional object writes, and promote one result with a revision-scoped compare-and-set. A unique analysis fingerprint does not prevent concurrent at-least-once deliveries from writing the same `analysis/{revision}` prefix.
- Required: validate worker artifact prefixes, object metadata/checksums, IAM scope, and manifest schemas independently of worker-supplied fields; add cancellation, timeout, liveness recovery, expiration, and owner-initiated deletion semantics.
- Important: encode legal visibility/activation combinations as a discriminated schema, bound frame/chunk size and source duration, define hard quality-gate outcomes, and add token entropy/no-store/rate-limit rules plus an explicit calibration coordinate-space identifier.
- No product code, deployment configuration, tests, or runtime processes were changed for this review.

# 2026-07-29 Restart frontend and backend persistently

## Plan

- [x] Confirm ports 4173 and 4174 have no listeners and review the configured development commands.
- [x] Start frontend and backend in a detached persistent process.
- [x] Verify direct frontend, direct backend, and frontend-proxied backend responses; record the process receipt.

## Review

- Started one detached hidden `npm run dev` launcher, PID 23376, so the frontend and backend survive the tool session ending.
- Frontend is listening on `127.0.0.1:4173` with PID 22308; `GET /` returned HTTP 200.
- Backend is listening on `127.0.0.1:4174` with PID 8924; direct and frontend-proxied `GET /api/health` both returned HTTP 200 with `{"status":"ok"}`.
- Startup logs are recorded at `.omo/evidence/servers-20260729-195310.stdout.log`; stderr is empty.

# 2026-07-29 Fix malformed `vzPxNXOp7ac` PDF

## Plan

- [x] Preserve the dirty worktree and record the debugging environment and hypotheses.
- [x] Render and inspect the supplied PDF in page and score-system order.
- [x] Reproduce the exact video through the active standalone pipeline and distinguish extraction, crop, identity, and pagination causes.
- [x] Add a failing regression for the confirmed cause and implement the smallest TypeScript fix.
- [x] Restart the user-facing backend, regenerate the exact video, and compare the fresh PDF against the supplied artifact.
- [x] Run focused checks, `npm run verify`, changed-file diagnostics, final PDF rendering, and artifact cleanup.

## Review

- Root cause: transient colored intro overlays passed score detection as distinct candidates, while full-width crops retained the video's pillarboxes. The pipeline now rejects candidates whose detected paper contains a large colored overlay and narrows accepted crops to the horizontal paper bounds.
- Regression coverage includes a large translucent intro overlay, clean pillarboxed notation, and colored source margins. Focused TypeScript plus processor tests passed 14/14.
- Exact active-API job `915b1412-f729-4433-8bc3-ef907b1fe12b` accepted only frames 7 and 46 out of 85 and produced one 1200x1700 page. Pipeline processing took 20,442 ms after reusing the analysis RGB buffer.
- The final PDF is `C:\Users\qkrwn\Downloads\yt2sheet-vzPxNXOp7ac-fixed.pdf`, 268,718 bytes, SHA-256 `735471E357688DF803062ED334B180254BA3C9820B36851E3918B0FF4F703C72`. Fresh rendering confirmed ordered notation with no intro overlays or source pillarboxes.
- Final verification passed TypeScript, 316/316 tests, the 105-module standalone web build, the 225-module extension build, changed-file diagnostics, and `git diff --check`. Frontend PID 28208 remains on port 4173 and backend PID 24608 remains on port 4174.

# 2026-07-29 Start Frontend and Backend Servers (current run)

## Plan

- [x] Confirm the configured frontend/backend commands and ports.
- [x] Start the backend server and verify its response.
- [x] Start the frontend server and verify its response.
- [x] Record the review evidence.

## Review

- Backend is running on `127.0.0.1:4174` and `GET /api/health` returns HTTP 200 with `{"status":"ok"}`.
- Frontend is running on `127.0.0.1:4173`; `GET /` returns HTTP 200 and `/api/health` succeeds through the Vite proxy.
- Active terminal sessions: backend `3308`, frontend `51528`.


# 2026-07-29 Near-Perfect Score Extraction Research

## Plan

- [x] Map the current standalone extraction pipeline, test corpus, and known failure modes.
- [x] Research current academic and open-source methods for temporal sampling, score-region detection, normalization, OMR-aware identity, and confidence estimation.
- [x] Challenge feasibility claims and define measurable quality targets with abstention/review boundaries.
- [x] Synthesize a staged architecture and implementation roadmap for yt2sheet.

## Review

- The primary bottlenecks are uniform temporal sampling and global first-wins identity; page packing preserves the accepted order and is not the first optimization target.
- Recommended architecture: adaptive candidate generation, score-region/state tracking, rollback-safe scroll mosaicing, staff-normalized multi-channel identity, quality representative selection, immutable provenance, and calibrated `PASS / REVIEW / FAIL` gates.
- Quality claims remain disabled until a source-disjoint real-video corpus evaluates actual crop, identity, occurrence order, PDF artifacts, runtime, selective risk, and worst-group performance.
- Detailed synthesis: `.omo/ulw-research/20260729-133841/SYNTHESIS.md`; responsive HTML summary and fresh captures: `REPORT.html`, `report-desktop.png`, and `report-mobile.png` in the same directory.
- This research task changed no production frontend or backend code.

# 2026-07-29 Start Frontend and Backend Servers

## Plan

- [x] Confirm the configured frontend/backend commands and ports.
- [x] Start the frontend and backend development servers.
- [x] Verify both listeners and HTTP responses.

## Review

- Existing listeners were reused: Vite frontend PID 25288 on `127.0.0.1:4173` and tsx backend PID 27308 on `127.0.0.1:4174`.
- `GET /` returned HTTP 200 from the frontend.
- `GET /api/health` returned `{"status":"ok"}` directly and through the frontend proxy.

# 2026-07-29 Phase 0 Benchmark Claim Gate

## Active implementation

- [x] Lock the quality-sidecar/benchmark boundary: current benchmark evidence records sampling only and cannot authorize quality claims.
- [x] Extend the benchmark CLI regression with manifest-backed group, split, and tag facts plus an external-gated underqualification path.

## Review

- [x] Parsed benchmark run, summary, case, evidence, and failure artifacts in the focused CLI test; the smoke corpus remains mechanics-only with quality claims disabled.
- [x] Recorded focused build/test/typecheck results and artifact facts in `.omo/evidence/score-quality-baseline/task-5-claim-gate.json`.

# G050 Restore Single Legacy PDF Output (2026-07-24)

## Plan

- [x] Add failing contracts that reject PDF-format selection and require one legacy 1200x1700 output.
- [x] Remove A4/Letter/Legacy selection from the standalone UI and request/API types.
- [x] Collapse server PDF generation to the previous single 1200x1700 layout without changing extension export behavior.
- [x] Update the standalone design contract and remove obsolete preset-specific styling/tests.
- [x] Run focused tests, full verification, confirm the dev servers, and inspect the live page at mobile and desktop widths.

## Review

- The standalone web form now exposes one PDF action only; A4, Letter, and legacy-format selection no longer exists in the UI or request contract.
- The server always renders the established 1200x1700 page with 40px padding, 16px score gap, and 72 DPI metadata while extension export geometry and occurrence order remain unchanged.
- The live frontend on port 4173 has no select element or horizontal overflow at 1280px and 375px; both frontend and backend remain listening, and the live API rejects the removed `pdfPreset` field with HTTP 400.
- Verification passed: TypeScript no-excuse audit (15 files), `npm run verify`, 289/289 tests, standalone web build, and extension build. Browser screenshots are in `.omo/evidence/single-pdf/`.
- Independent subagent visual review was intentionally not run because the user explicitly requested no more subagents; manual browser QA was completed directly in this session.

# G049 Standalone PDF Detached Text Cleanup (2026-07-23)

## Plan

- [x] Render the latest standalone PDF and identify the repeated unrelated text separately from score labels and tempo/chord context.
- [x] Confirm the root cause across the server crop, normalization, and paper-threshold paths.
- [x] Add failing-first regressions for detached bottom watermark removal and musical-context preservation.
- [x] Apply the smallest staff-context-aware cleanup in the shared server normalizer.
- [x] Regenerate the same video through the live backend and verify every PDF page.
- [x] Run targeted/full verification, independent review, and artifact cleanup.

## Review

- Root cause: the standalone server normalizer removed only chromatic photo components, so neutral-black detached watermarks survived; narrow source-edge remnants also survived and became faint gray antialiasing after PDF scaling.
- The server now cleans detached bottom ink independently across horizontal score regions and removes only narrow connected foreground components attached to an image edge, preserving staff lines, tempo/chord text, internal barlines, and notation tails.
- RED-to-GREEN coverage locks detached caption removal, musical-context preservation, horizontally decoupled low notation, full-height edges, and short edge fragments; 29/29 focused frontend-independent PDF/server regressions pass.
- Live port-4174 regeneration of `08NPrnMV9r4` succeeded as a parseable 1,341,267-byte, three-page PDF. Original-resolution review found no `Pianoin U` watermark, no detached gray edge fragment, no piano/photo band, and no clipped musical ink.
- Verification passed: clean LSP diagnostics, TypeScript no-excuse audit, `tsc --noEmit`, 197/197 repository tests, standalone web build, diff check, and live frontend/backend HTTP checks on 4173/4174.
- Independent code review returned CLEAR/APPROVE with no findings after rechecking the focused/full suites, web build, scoped diff, evidence, and rendered final PDF pages.

# G048 Consistent Visible Score-Sheet Spacing (2026-07-23)

## Plan

- [x] Reproduce the uneven visible spacing in the latest generated PDF and distinguish image-box gaps from ink-to-ink gaps.
- [x] Add a failing-first regression that measures the user-visible spacing contract independently of production constants.
- [x] Apply the smallest shared layout or normalization fix so adjacent score sheets have consistent visible spacing.
- [x] Run targeted and full verification, regenerate a real PDF, and measure every adjacent gap.
- [x] Remove debug artifacts and record the final evidence.

## Review

- Root cause: production used each frame's independently detected staff gap as top/bottom paper padding, so the effective score-sheet separation was two variable paddings plus the fixed layout gap.
- The server now derives normalization padding from crop width and the fixed page content geometry, making the rendered padding resolution- and detection-independent.
- The failing-first production-path PDF reported `42,54` pixel gaps before the change and equal gaps after it.
- Live port-4174 regeneration of `08NPrnMV9r4` succeeded with a parseable 1,450,468-byte, four-page PDF; original-resolution inspection found no spacing-related clipping.
- Verification passed: 23/23 targeted tests, 192/192 full tests, TypeScript, standalone web build, diff check, and TypeScript no-excuse audit.

# G047 Full-Surface ULW QA Loop (2026-07-23)

## Plan

- [x] Map every supported standalone frontend, API, job, media, and PDF surface to an observable QA criterion; explicitly exclude the separately shipped extension.
- [x] Run deterministic browser, HTTP, media, and rendered-PDF scenarios with cleanup receipts.
- [x] Add failing-first regressions and minimally repair every confirmed defect.
- [x] Repeat focused and full verification until no criterion regresses.
- [x] Complete independent code review, manual QA, and final gate review.

## Review

- Fixed three confirmed lifecycle defects: running progress can no longer decrease, Windows timeouts now terminate the complete child-process tree, and startup removes only owned orphan work directories while preserving results and linked external data.
- Independent review found that unconditional startup cleanup could delete another live server's work when both used the same data root. Work directories now encode their owner PID; cleanup preserves live owners and removes legacy or dead-owner directories.
- Cleanup recognizes only the processor's legacy UUID directories and new PID-owned UUID directories. Unknown or user-managed directories under `work` are preserved instead of being treated as owned orphans.
- The real current-tree API produced a parseable 1,078,974-byte, three-page PDF for `dX4RlolT9O0`. Original-resolution page inspection found ordered readable scores, white paper, no clipped musical ink, and no piano/keyboard/photo band.
- PDF layout verification proves every sheet-placement gap is exactly 16 pixels and sparse pages keep unused space in balanced outer margins. Visible ink spacing can still differ with musical content, but normalized sheet boundaries and placement spacing are fixed.
- Production browser QA passed malformed-input focus/alert with no POST, sanitized failure, enabled retry, success with one named PDF link, zero console warnings/errors, and three stable geometry/ARIA passes at each of 375, 768, and 1280 pixels without overlap or horizontal overflow.
- Frozen-tree verification passed `tsc --noEmit`, all 191 repository tests, 36 targeted frontend/backend/PDF regressions, the standalone Vite build, `git diff --check`, the TypeScript escape-hatch audit, and a fresh browser-result PDF parse. MV3 installation, loading, and production build were intentionally not performed; the repository-wide test command only exercised existing unit tests.
- QA-only ports 4475/4476/4477 are free. The requested frontend and backend remain listening on ports 4173 and 4174; exact owning PIDs are kept in the final runtime receipt because watch-mode restarts can change them.

# Git Bash MCP Connection Diagnosis (2026-07-23)

## Plan

- [x] Capture the active MCP registration, Git Bash launcher resolution, and bootstrap evidence.
- [x] Confirm the connection failure's root cause and select the smallest safe recovery action.
- [x] Verify the Git Bash MCP server directly and document the exact session-restart boundary.

## Review

- `git_bash` is enabled in Codex and points to `C:\Users\qkrwn\AppData\Local\Programs\Git\bin\bash.exe`; the executable exists and the bootstrap completed successfully at session start.
- The current Codex session has no `git-bash-mcp` child process, so the tool cannot be exposed in this already-created tool registry. MCP discovery is session-start-bound; configuration is not hot-connected mid-session.
- Directly launching the configured MCP command returned `ready` for the resolved Git Bash path and executed `printf '%s\\n' git-bash-mcp-ok` with exit code 0. No product-code or configuration change is needed; restart Codex/open a fresh session, then retry `git_bash`.

# G043 Live Backend Media Processing Failure

## Plan

- [x] Reproduce the reported failure against the currently listening backend and capture the job result/runtime state.
- [x] Distinguish stale process, stale tool environment, and current downloader regression.
- [x] Apply the smallest runtime or code fix and lock any missing regression.
- [x] Run the same link through the actual frontend API backend, download the PDF, and verify the artifact.
- [x] Run full verification and remove debug artifacts.

## Review

- Root cause: the server's normal media configuration uses the bare PATH command `ffmpeg`, but the downloader adapter passed that command name as `yt-dlp --ffmpeg-location ffmpeg`. yt-dlp interpreted it as a nonexistent path, exited successfully after downloading split streams, and reported a merged MP4 path that did not exist.
- The adapter now emits `--ffmpeg-location` only for configured values that contain an actual path. Bare commands are resolved by yt-dlp from the same PATH that already passed server startup validation.
- Red/green regression: `lets yt-dlp resolve a bare ffmpeg command from PATH` failed before the fix and all three downloader/frame-extraction tests passed afterward.
- Live QA: the same link failed on the frontend backend port 4174 before the change (`MEDIA_PROCESSING_FAILED`) and succeeded afterward with progress 100, two PDF pages, and a 602,337-byte downloadable result.
- Verification: `npm run verify` passed typecheck and 180/180 tests plus web/extension builds; TypeScript no-excuse audit passed both changed files.

# G042 Photo Contamination, Duplicate Sheets, And Two-Staff Crop Completeness

## Plan

- [x] Inspect the exact `yt2sheet-pDkESH-ItxQ.pdf` output and extracted score images to classify photo contamination, duplicate sheets, and top/bottom notation clipping.
- [x] Add failing-first regressions that reproduce the observed photo-like candidate, overlapping duplicate state, and two-staff boundary loss.
- [x] Implement the smallest shared server crop and identity fix without excluding legitimate compact or piano notation.
- [x] Regenerate the same YouTube link and compare accepted score count, duplicate similarity, photographic content, and edge-touching notation.
- [x] Run focused tests, full verification, TypeScript no-excuse audit, PDF QA, cleanup, and record the result.

## Review

- Root causes: a three-row musical beam was misclassified as a non-paper boundary; whole-crop hashes changed with title/padding; photo removal erased only the connected dark/color component and left a disconnected pale halo.
- The crop boundary now requires eight consecutive non-paper rows, duplicate comparison includes a dominant-notation hash, and score normalization removes qualifying photographic component bounds with enough padding to clear halos while preserving titles and colored notation.
- Failing-first evidence: the crop fixture stopped at row 65 and lost row 45; the padding/title duplicate fixture returned two scores; the photo-halo fixture retained 16 non-white pixels before the padded bounds fix.
- Focused verification: 19/19 server analysis and video-processor tests passed.
- Full verification: `npm run verify` passed typecheck, 179/179 tests, web production build, and extension production build; the TypeScript no-excuse audit reported no violations in seven changed files.
- End-to-end QA also exposed and fixed a downloader integration bug: `yt-dlp` could not see the configured FFmpeg binary, returned a nonexistent merged MP4 path, and made the API job fail. The processor now passes `--ffmpeg-location` explicitly and locks it with a regression test.
- Exact-artifact QA: POSTing the same YouTube link to a fresh API server succeeded, reported two pages, and downloaded a 602,337-byte PDF containing 11 distinct score systems. Rendered page inspection confirmed no photographic residue, no repeated systems, no page overlap, and complete upper/lower piano staves.

# G022 Transient YouTube Overlay Suppression

## Plan

- [x] Lock a failing regression contract that capture start suppresses YouTube player controls and the volume bezel.
- [x] Restore the player UI when capture stops, errors, is restarted, or reaches the natural video end.
- [x] Keep the dynamically injected video probe self-contained and safe across repeated injection.
- [x] Run the focused regression, TypeScript diagnostics, no-excuse audit, full `npm run verify`, and built-content-script checks without Visual QA.

## Review

- Root cause: the tab-capture stream included YouTube's DOM player chrome before ROI sampling, so the same notation could be fingerprinted and stored once with controls and once without them. The small volume tooltip could also survive as part of the representative image.
- The video probe now injects capture-scoped suppression for top/bottom chrome, gradients, tooltips, and the volume bezel before its first timing tick.
- Every probe stop path removes the suppression style, including restart, explicit stop/error cleanup, and natural video end.
- Regression proof: the focused lifecycle test failed before the implementation and passed afterward.
- Verification: no-excuse audit passed for both changed TypeScript files; `npm run verify` passed with typecheck, 147 tests, and the Vite production build; the built script passed `node --check`, contained all required selectors, had no static imports, and passed a nonvisual START/STOP VM lifecycle harness.
- Visual QA was intentionally not run per the user's request.

## Plan

- [x] Inspect the existing ROI identity implementation and tests.
- [x] Add explicit score identity config, feature flags, and shared capture/page types.
- [x] Add repository/service surfaces for accepted cluster upsert and representative image handling.
- [x] Add page chunking, page rendering, PNG export, and PDF export.
- [x] Add a ScoreIdentityDetector orchestrator that connects fingerprint, quality, blob storage, clustering, capture, and debug logging.
- [x] Add regression tests for unique cluster storage, five-per-page chunking, PNG/PDF export, and orchestrator behavior.
- [x] Run typecheck, tests, and build.
- [x] Run final cleanup/review gate and checkpoint OMX ultragoal.

## Review

- Added explicit ROI identity config and feature flags.
- Added capture/page output types, accepted-cluster repositories, thumbnail generation, unique capture upsert, page chunking/rendering, PNG export, PDF export, and ScoreIdentityDetector orchestration.
- Updated ScoreClusterer to carry actual representative image blob IDs through pending and representative replacement paths.
- Added regression tests for config flags, representative blob IDs, clusterId upsert, five-per-page dedupe, PNG/PDF export, and duplicate raw sample cleanup.
- Review follow-ups resolved: export orchestration, missing metadata failure, explicit pending resolution, export page image boundary, stale representative thumbnail cleanup, and pending duplicate image cleanup.
- Verification: `npm run verify` passed after cleanup with typecheck, 57 tests, and Vite build.

# User-Facing Export UI

## Plan

- [x] Inspect the existing capture stop flow and debug-state score storage.
- [x] Add a user-facing export-ready message after capture stops.
- [x] Add a YouTube-page export panel with PDF and PNG actions.
- [x] Generate downloadable PDF/PNG files from accepted unique score images.
- [x] Store representative ROI images at export quality instead of preview quality.
- [x] Add focused regression tests for export chunking and PDF creation.
- [x] Run typecheck, tests, and build.

## Review

- Added a YouTube-page export panel that appears after capture stops with PDF and PNG buttons.
- Added background export handling that downloads one PDF or multiple PNG page files through Chrome downloads.
- Added the `downloads` extension permission for user-initiated export files.
- Changed accepted representative score images from reduced JPEG previews to full ROI PNG data URLs for export quality.
- Added regression tests for export dedupe/sort/chunk behavior, PDF generation, and filename sanitizing.
- Verification: `npm run verify` passed with typecheck, 60 tests, and Vite production build.

# G009 User PDF Quality Fixes

## Best-Practice Research

- MuseScore Studio Handbook, "Score size and spacing" / "Pages and vertical spacing": page layout should control margins, staff size, and vertical spacing; sparse pages can look awkward when systems are spread out to fill the page, and reducing system distance or forcing extra space to the bottom is a supported approach.
- LilyPond Notation Reference 2.26/2.27: vertical spacing is governed by page size/margins, system spacing, and staff spacing; flexible spacing uses `basic-distance`, `minimum-distance`, and `padding`, so spacing should compress within safe whitespace instead of uniformly stretching sparse pages.

## Plan

- [x] Add G009 ultragoal story for user-facing PDF quality issues.
- [x] Fix ROI coordinate conversion to account for the actual rendered video content box.
- [x] Crop accepted export representatives to staff-line anchored score content inside ROI.
- [x] Make fingerprint comparison use staff-line anchored content so side/decorative image changes do not create duplicate clusters.
- [x] Replace fixed-slot page layout with actual score-height stacking and bounded gaps.
- [x] Add regression tests for ROI letterbox mapping, side-image duplicate robustness, staff-content export cropping, and compact page layout.
- [x] Run `npm run verify`.
- [x] Run final cleanup/review gate.
- [x] Checkpoint G009.

## Review

- Added actual-video content rectangle mapping so manual ROI coordinates ignore YouTube letterbox/pillarbox bars.
- Added staff-line anchored score-content extraction for fingerprinting and representative export images.
- Added compact page placement shared by PDF/PNG export paths, using bounded configured gaps instead of sparse page justification.
- Added regression tests for letterbox ROI mapping, side-image duplicate robustness, staff-content cropping, compact page layout, and production ROI export-image cropping.
- Verification: `npm run verify` passed with typecheck, 66 tests, and Vite production build after the final review follow-up.
- Review gate: ai-slop-cleaner scoped scan found no fallback/workaround/TODO slop in changed files; independent code-reviewer found no blocking code issues after follow-up; independent architect returned CLEAR.
- Ultragoal checkpoint: G009 completed; microgoal ledger is 9/9 complete.

# G010 ROI Normal Mode and False Duplicate Fixes

## Plan

- [x] Re-check the current ROI crop, score identity, and page layout implementation against the user's reproduced PDF issues.
- [x] Map manual video-frame ROI coordinates into the actual tab-capture bitmap before cropping.
- [x] Preserve backward compatibility for existing stored ROI configs that do not include source frame dimensions.
- [x] Tighten same-score matching so visually different notation does not silently replace an existing representative image.
- [x] Keep compact print layout behavior and add regression coverage for it where needed.
- [x] Run targeted tests and full verification.

## Review

- Added `frameSize` to newly saved manual ROI configs so frame-space selections can be mapped back into tab-capture bitmap coordinates.
- Added shared ROI geometry conversion from video frame coordinates to viewport and capture bitmap coordinates.
- Updated ROI cropping to use `videoRect`, `viewport`, and stored source frame dimensions when available, with fallback for older stored ROI configs.
- Tightened `same` matching with a separate horizontal projection threshold, while keeping side imagery outside staff content ignored.
- Reduced score page gap from 24px to 16px for denser print output.
- Added regression coverage for normal YouTube layout ROI offset cropping and changed-notation false duplicate prevention.
- Verification: `npm run verify` passed with typecheck, 69 tests, and Vite production build.

# G011 End Overlay Export Gate

## Plan

- [x] Add configurable near-end gate thresholds for rule-first duplicate/export handling.
- [x] Pass video duration and near-end metadata from frame sampling into ROI identity.
- [x] Add a local end-candidate gate before cluster creation so near-end `different` samples are held.
- [x] Confirm genuine end-score changes only after a consecutive score-like sample.
- [x] Discard overlay-like or unconfirmed end candidates from PDF/PNG export while keeping debug metadata.
- [x] Add regression tests for held, confirmed, overlay-discarded, and stop-flushed end candidates.
- [x] Run full verification.

## Review

- Added a local end-candidate gate before accepted cluster creation.
- Near-end `different` samples are now held until one consecutive score-like confirmation.
- Overlay-like end samples and unconfirmed stop-time candidates are excluded from export.
- Debug identity metadata now includes `endGate`, `endGateReason`, `exported`, and pending end-candidate count.
- Verification: `npm run verify` passed with typecheck, 76 tests, and Vite production build.

# G012 ROI Drag Selection Regression

## Plan

- [x] Inspect the current ROI selection overlay and drag event flow.
- [x] Compare recent changes that could block pointer/mouse interaction.
- [x] Reproduce or simulate the broken drag path with a focused regression test.
- [x] Fix the root cause with the smallest scoped change.
- [x] Run targeted tests and full verification.

## Review

- Root cause: the built dynamic content script `dist/src/content/roi-selector.js` started with a static ES module import from a shared asset chunk, but it is injected with `chrome.scripting.executeScript({ files })`; that can prevent the ROI selector listener/overlay drag code from running as a self-contained injected script.
- Kept the ROI selector self-contained by moving the small drag and ROI geometry helpers it needs into `src/content/roi-selector.ts`, while preserving type-only imports.
- Added a regression test that fails if dynamically injected content script sources add runtime imports.
- Verification: `npm run typecheck`, `npm test` with 77 passing tests, `npm run build`, no static import in `dist/src/content/roi-selector.js` or `dist/src/content/video-probe.js`, `node --check` for both built content scripts, and final `npm run verify` all passed.

# G013 ROI Selector Not Appearing Follow-up

## Plan

- [x] Re-check the complete start-to-selector path after the user reports the selector still does not appear.
- [x] Harden the selector overlay so the UI appears even if stylesheet injection fails.
- [x] Make stale active session state recoverable instead of silently preventing a new selector.
- [x] Add focused regression coverage for the hardened behavior.
- [x] Run full verification.

## Review

- Added inline fallback styles to the ROI selector overlay, selection rectangle, toolbar, and buttons so the area picker is visible even if `chrome.scripting.insertCSS` does not apply the stylesheet.
- Added stale transitional session recovery for `starting`/`stopping` sessions older than 60 seconds, so an interrupted previous start cannot silently block a new ROI selector.
- Added regression coverage that dynamically injected content scripts remain self-contained and the ROI selector keeps inline fallback styles.
- Verification: `npm run typecheck`, `npm test` with 78 passing tests, `npm run build`, built content scripts with 0 static imports, `node --check` for built content scripts, and final `npm run verify` all passed.

# G014 Repeated Content Script Injection SyntaxError

## Plan

- [x] Use the reported `Identifier has already been declared` stack trace to identify the exact injection failure.
- [x] Wrap dynamically injected content script bundles in an isolated function scope so repeated injection cannot redeclare top-level identifiers.
- [x] Add regression coverage against unwrapped built content script output.
- [x] Run build and full verification.

## Review

- Root cause: `chrome.scripting.executeScript` can inject the same content script into the same YouTube tab more than once, and the built classic scripts had top-level `const`/`function` declarations such as `n` and `I`, causing `Identifier has already been declared` before the listeners could run.
- Added a Vite build plugin that wraps `src/content/video-probe.js` and `src/content/roi-selector.js` in an IIFE, isolating minified identifiers on every injection.
- Added regression coverage that the wrapper remains configured for both dynamically injected content script bundles.
- Verification: `npm run typecheck`, `npm test` with 79 passing tests, `npm run build`, built content scripts start with `(()=>{...})();`, built content scripts have 0 static imports, `node --check` passed for both built content scripts, and final `npm run verify` passed.

# G015 Tab Capture Startup After ROI Selection

## Plan

- [x] Use the reported background error context to identify the post-ROI startup failure.
- [x] Move tab capture stream-id acquisition into the extension action user-gesture window before ROI selection.
- [x] Improve CaptureError logging so object errors do not appear as `[object Object]`.
- [x] Add focused regression coverage for the call order and error formatting.
- [x] Run full verification.

## Review

- Root cause: `chrome.tabCapture.getMediaStreamId()` was called only after the user completed ROI selection. Chrome requires tabCapture to be called after extension invocation/user gesture, so delaying it past the ROI interaction can fail with `TAB_CAPTURE_DENIED`.
- Moved stream-id acquisition to the start of `startSession`, before content script injection and ROI selection, then reused that stream id when starting offscreen capture.
- Improved `toErrorMessage` so CaptureError objects log as `CODE: message (cause: ..., session: ...)` instead of `[object Object]`.
- Added regression coverage for tab capture call ordering and CaptureError formatting.
- Verification: official Chrome tabCapture docs checked for user-invocation requirement; `npm run typecheck`, `npm test` with 81 passing tests, `npm run build`, and final `npm run verify` all passed.

# G016 ROI Cancellation Logging

## Plan

- [x] Identify why `ROI_SELECTION_CANCELLED` is shown as `Action click failed`.
- [x] Treat ROI cancellation as a normal user stop rather than an action failure.
- [x] Add regression coverage for cancellation log handling.
- [x] Run full verification.

## Review

- `ROI_SELECTION_CANCELLED` is now treated as a normal user stop in `handleActionClick`, so it returns before recording a debug error or logging `Action click failed`.
- Added regression coverage that the cancellation branch precedes action-failure recording.
- Verification: `npm run typecheck`, `npm test` with 82 passing tests, `npm run build`, and final `npm run verify` all passed.

# G017 Export Review Before PDF

## Plan

- [x] Inspect the current user-facing export panel, debug score state, and PDF/PNG export ordering.
- [x] Add a final review panel before export with duplicate cluster visibility, include/exclude controls, and reorder controls.
- [x] Pass the confirmed cluster order into PDF/PNG export without changing the default automatic export behavior.
- [x] Add regression tests for user-specified export order and fallback sorting.
- [x] Run typecheck, tests, build, and final verification.

## Design Notes

- Design read: internal product review UI for score export, focused on scanning and correction rather than marketing polish.
- Dials: `DESIGN_VARIANCE 4`, `MOTION_INTENSITY 2`, `VISUAL_DENSITY 7`.
- Success criteria: PDF/PNG export does not start until the user confirms the reviewed list, duplicate clusters are visibly flagged, selected items can be moved up/down, and the generated files use the confirmed order.

## Review

- Replaced the export-ready path with a final review panel that reads captured score thumbnails from session storage.
- Added include/exclude checkboxes, up/down order controls, duplicate cluster badges, selected-count page estimates, and Korean status text.
- Added optional `scoreOrder` to export messages and made PDF/PNG chunking honor the reviewed cluster order while preserving default first-seen sorting when no order is supplied.
- Propagated cluster `seenCount` into exported score metadata so the review panel can flag automatically merged duplicates, not just accidental duplicate rows.
- Added regression tests for reviewed ordering, missing/duplicate reviewed IDs, and content-script routing to the review panel.
- Verification: `npm run verify` passed with typecheck, 85 tests, and Vite production build. Built `dist/src/content/roi-selector.js` passed `node --check`, remains IIFE-wrapped, and contains the new review panel path with no static import.

# G018 Offscreen Capture Startup and Log Clarity

## Plan

- [x] Inspect the reported offscreen `GET_USER_MEDIA_FAILED`, `[object Object]`, and `No current offscreen document` paths.
- [x] Compare the current tabCapture stream-id timing against official Chrome offscreen capture guidance.
- [x] Avoid duplicate startup failure handling from offscreen start errors.
- [x] Retry startup once with a fresh stream id when the first offscreen `getUserMedia()` redemption fails.
- [x] Normalize logged errors so CaptureError, DOMException, and plain objects do not print as `[object Object]`.
- [x] Run targeted regression tests and full verification.

## Review

- Root cause path: the review/edit panel could not appear because capture startup failed first while the offscreen document was redeeming the tab capture stream with `getUserMedia()`.
- Background startup now retries `START_CAPTURE` once with a freshly acquired stream id when the first offscreen redemption returns `GET_USER_MEDIA_FAILED`.
- Offscreen startup failures no longer emit a duplicate `CAPTURE_ERROR`; the command response path owns startup failure handling.
- Offscreen cleanup now ignores the benign `No current offscreen document` race if the document is already gone.
- Logger/error formatting now prints CaptureError, Error, DOMException-like objects, and plain objects as readable text instead of `[object Object]`.
- Verification: official Chrome tabCapture/offscreen guidance checked; `npm run verify` passed with typecheck, 89 tests, and Vite production build; built background/offscreen/content scripts passed `node --check`.

# G019 Export Review Loading Hang

## Plan

- [x] Trace the review panel loading path after `SCORE_EXPORT_READY`.
- [x] Compare the content-script data access path against Chrome `storage.session` access rules.
- [x] Move export review data loading behind a background runtime message.
- [x] Add regression coverage so the content script does not read `storage.session` directly.
- [x] Run full verification.

## Review

- Root cause: the review panel was waiting for data from `chrome.storage.session` in a YouTube content script, but Chrome restricts `storage.session` to trusted extension contexts by default.
- Added a `GET_EXPORT_REVIEW_DATA` runtime message so the background service worker reads the captured score list and returns it to the panel.
- Updated the review panel loader to request data through background, then render the include/exclude, duplicate, and ordering UI from that response.
- Added regression tests that the content script uses `GET_EXPORT_REVIEW_DATA` and does not call `chrome.storage.session.get` directly.
- Verification: official Chrome storage docs checked; `npm run verify` passed with typecheck, 90 tests, and Vite production build; built background/content/offscreen scripts passed `node --check`; built content script contains `GET_EXPORT_REVIEW_DATA` and no direct `chrome.storage.session.get`.

# G020 Export Review Large Payload Fix

## Plan

- [x] Re-check the current export review panel loading path after the user reports the review/edit window still fails.
- [x] Identify why `GET_EXPORT_REVIEW_DATA` can still produce `검토 목록을 불러오지 못했습니다`.
- [x] Avoid transferring full score PNG data URLs through runtime message responses.
- [x] Keep a fallback path for older loaded extension instances.
- [x] Add regression coverage for the direct session-storage review path and access-level setup.
- [x] Run full verification and inspect built extension output.

## Review

- Root cause: the review panel requested the full captured score list, including export-quality PNG data URLs, through `chrome.runtime.sendMessage`; larger captures can make the message response fail or arrive as `undefined`, which falls into the generic “검토 목록을 불러오지 못했습니다” state.
- Background startup now exposes `chrome.storage.session` to content scripts with `TRUSTED_AND_UNTRUSTED_CONTEXTS`, matching Chrome's documented access-level mechanism for session storage.
- The export review panel now reads the completed capture state directly from `chrome.storage.session` first, so the edit/review window does not depend on a large runtime message payload.
- Kept `GET_EXPORT_REVIEW_DATA` as a fallback for older already-loaded extension instances.
- Verification: official Chrome storage docs checked; `npm run typecheck` passed; `npm test` passed with 90 tests; `npm run verify` passed with typecheck, 90 tests, and Vite production build; built content/background scripts passed `node --check`; built content script is still IIFE-wrapped and includes direct `chrome.storage.session.get`; built background script includes `setAccessLevel` and `TRUSTED_AND_UNTRUSTED_CONTEXTS`.

# G021 PDF Final AI Review Gate

## Plan

- [x] Add a final export validator before PDF/PNG generation that checks selected captures for score validity and overlay contamination.
- [x] Use configured Gemini/proxy AI validation when available, with local pixel rules as the non-blocking fallback.
- [x] Replace contaminated captures with clean same-cluster candidates when available; otherwise exclude them from export.
- [x] Preserve duplicate candidate images per cluster so the final gate has replacement options.
- [x] Surface replaced/excluded validation results in the export review panel before PDF/PNG save buttons are enabled.
- [x] Add regression tests for replacement, exclusion, AI fallback, fail-closed local validation, and content-script status wiring.
- [x] Run full verification and inspect built extension output.

## Review

- Added `src/background/export-score-validator.ts` and wired it into the background `EXPORT_SCORE_CAPTURE` path before PDF/PNG chunking.
- Offscreen capture now retains bounded same-cluster export candidates, while the stored debug state exposes both selected unique scores and replacement candidates.
- The final gate exports only `valid` inspection results; contaminated, uncertain, unreadable, missing-canvas, and local-analysis failure paths fail closed unless a clean replacement is found.
- The export review panel now calls `VALIDATE_EXPORT_REVIEW` while loading, keeps PDF/PNG buttons disabled until validation finishes, swaps replaced rows to replacement images, and locks excluded rows unchecked.
- The export success message still reports final validation results after the background export path revalidates before file generation.
- Removed a dead legacy export panel implementation so the review panel has one export success path.
- Verification: `npm run typecheck` passed; `npm test` passed with 97 tests; `npm run verify` passed with typecheck, 97 tests, and Vite production build; built content/background/offscreen scripts passed `node --check`; built content contains `VALIDATE_EXPORT_REVIEW`, `AI 최종 검토 완료`, `AI 검토: 제외됨`, `AI 검토: 대체됨`, `validationDetails`, and `replacementScoreId`; built background contains `VALIDATE_EXPORT_REVIEW`, `local canvas unavailable`, and `exportCandidates`.

# W1A Occurrence-Aware Capture State

## Plan

- [x] Read scoped product/test files and Wave 1 implementation plan.
- [x] Run baseline `npm test -- tests/debug-frame-sink.test.ts`.
- [x] Add failing-first test for `A,A,A,B,A,A,C -> A,B,A,C`.
- [x] Add typed occurrence metadata while preserving legacy `uniqueScores` and `exportCandidates`.
- [x] Run `npm test -- tests/debug-frame-sink.test.ts` and `npm run typecheck`.
- [x] Capture manual QA/evidence artifact with command output, expected vs actual sequence, git status, and cleanup receipt.

## Review

- Added optional `exportOccurrences` message/state support with `occurrenceId` and `occurrenceOrder`.
- `uniqueScores` remains cluster-first for legacy compatibility; `exportCandidates` remains same-cluster replacement data.
- Added sink coverage for `A,A,A,B,A,A,C -> A,B,A,C`, plus empty and single-cluster occurrence coverage.
- Verification: `npm run typecheck` passed; `node --test build-test\tests\debug-frame-sink.test.js` passed with 8 tests; `npm test` passed with 100 tests. The exact command `npm test -- tests/debug-frame-sink.test.ts` still fails after compiled tests pass because the repo script appends a raw `.ts` path to Node, producing `ERR_UNKNOWN_FILE_EXTENSION`.
- Evidence: `.omo/ulw-loop/repeated-score-occurrence-review-20260707-v2/evidence/W1A-occurrence-state.txt`.

# Task 1 Shared Occurrence Contract

## Plan

- [x] Record dirty worktree status and baseline legacy export ordering output.
- [x] Add failing-first `tests/score-occurrences.test.ts` for occurrence collapse/order semantics.
- [x] Add optional occurrence fields to shared capture/message contracts.
- [x] Implement pure JSON-safe occurrence ordering helpers in `src/shared/score-occurrences.ts`.
- [x] Run RED/GREEN verification commands and typecheck.
- [x] Capture manual QA artifact with expected vs actual sequences, occurrence ids, command output, git status, and cleanup receipt.

## Review

- Baseline: `task-1-baseline.txt` captures `npm run build:test`, package type write, and `score-export-download.test.js` passing 6/6.
- RED: `task-1-red.txt` captures compile-clean failing assertions for missing occurrence behavior.
- GREEN/manual QA: `task-1-occurrence-contract.txt` captures expected vs actual `A,B,A,C`, distinct A occurrence ids, legacy `scoreOrder`, malformed input edges, final PASS output, git status before/after, and cleanup receipt.
- No commit made: shared worktree has broad unrelated/untracked state, so staging an atomic commit was not safe in this environment.

# Task 3 Occurrence-Aware Validation And Replacement

## Plan

- [x] Record dirty worktree status and baseline validator output.
- [x] Add failing-first validator tests for occurrence order, legacy scoreOrder fallback, targeted replacement, and targeted exclusion.
- [x] Implement occurrence-aware selection and replacement in `src/background/export-score-validator.ts`.
- [x] Run required GREEN verification commands.
- [x] Capture C002 manual QA artifact with expected/actual arrays, decision objects, adversarial notes, status before/after, and cleanup receipt.

## Review

- Baseline: `task-3-baseline.txt` captures `npm run build:test`, package type write, and `export-score-validator.test.js` passing 7/7 before Task 3 edits.
- RED: `task-3-red.txt` captures compile-clean failures where the second A occurrence disappeared and occurrence decision metadata was missing.
- GREEN: `task-3-green.txt` captures `npm run build:test`, package type write, `export-score-validator.test.js`, `score-occurrences.test.js`, and `npm run typecheck` all exiting 0.
- Manual QA: `C002-validation-edge.txt` captures expected vs actual arrays, summary counts, full decision objects, adversarial notes, git status before/after, and cleanup receipt.
- Scope note: no commit made because the worktree is broadly untracked/dirty and the task did not request committing.

# Task 4 Occurrence-Aware PDF/PNG Page Ordering

## Plan

- [x] Record dirty worktree status and baseline active/offscreen export test output.
- [x] Add failing-first tests for occurrence-aware active chunking, legacy scoreOrder fallback, and offscreen chunker parity.
- [x] Implement occurrenceOrder-aware selection in active background export chunking.
- [x] Implement occurrence-aware page creation in dormant offscreen ScorePageChunker.
- [x] Run required GREEN verification commands and typecheck.
- [x] Capture C001 manual QA artifact with expected/actual page sequences, command output, adversarial notes, status before/after, and cleanup receipt.

## Review

- Baseline: `task-4-baseline.txt` captures `npm run build:test`, package type write, and both target compiled export test files passing before Task 4 changes.
- RED: `task-4-red.txt` captures intended failures where active and offscreen chunking collapsed `A,B,A,C` to `A,B,C`, and active `occurrenceOrder` returned no rows.
- GREEN: `task-4-green.txt` captures `npm run build:test`, package type write, both target compiled export test files, and `npm run typecheck` all exiting 0.
- Manual QA: `C001-occurrence-flow.txt` captures expected vs actual active/offscreen page clusters, occurrence ids, page count, adversarial probes, git status before/after, and cleanup receipt.
- Review: `task-4-code-review-and-slop-report.txt` captures the `omo:programming` post-write review and explicit `omo:remove-ai-slops` category pass for the Task 4 scoped files.

# Task 5 Background Occurrence Plumbing And Preview API

## Plan

- [x] Record dirty worktree status and baseline output in `task-5-baseline.txt`.
- [x] Add failing-first source-scan assertions for preview routing and occurrence plumbing.
- [x] Thread `occurrenceOrder` through background validation/export messages.
- [x] Add JSON-safe `PREVIEW_SCORE_EXPORT` handling with PNG data URL page previews and no downloads.
- [x] Use validated occurrence ids for final export ordering, with legacy `scoreOrder` fallback.
- [x] Update export-ready counts to prefer occurrence count when occurrence metadata exists.
- [x] Run required GREEN verification commands and capture manual preview artifact.

## Review

- Baseline: `task-5-baseline.txt` captures dirty status, build-test, package marker, and focused startup/export tests before Task 5 edits.
- RED: `task-5-red.txt` captures missing preview routing and occurrence plumbing assertions before implementation.
- GREEN: `task-5-green.txt` captures build-test, package marker, focused background/export tests, and typecheck passing.
- Preview QA: `task-5-background-preview.txt` captures JSON-safe preview response behavior, no-download preview routing, occurrence-order payloads, and cleanup receipt.
- Orchestrator verification: `orchestrator-task-5-verification.txt` records the resumed verification pass.

# Final Review Blocker: Metadata-Free Replacement Occurrences

## Plan

- [x] Record initial git status and evidence target.
- [x] Add a failing regression where A2 is replaced by a clean same-cluster candidate without occurrence metadata.
- [x] Preserve the original occurrence identity/order/repeat linkage on the validated replacement score.
- [x] Prove validator decisions and export chunking keep `A,B,A,C`.
- [x] Run required verification commands and write `.omo/ulw-loop/repeated-score-occurrence-review-20260707-v2/evidence/final-review-blocker-fix.txt`.

## Review

- Added validator coverage for `A,B,A,C` where A2 is contaminated and the only clean replacement candidate is cluster-level with no occurrence metadata.
- `scoreForReplacementOccurrence` now returns the candidate id/image while overlaying the original occurrence identity, order, repeat index/count, and neighbor occurrence linkage when present.
- The regression asserts validation decisions stay keyed to A2, `replacementScoreId` stays the candidate id, validated clusters remain `A,B,A,C`, and `chunkScorePages(report.scores)` emits `A,B,A,C`.
- Verification passed: `npm run build:test`, package marker write, focused validator/export chunk tests, `npm test` with 114 tests, `npm run typecheck`, and `npm run build`.
- Cleanup: no runtime resources spawned; no downloads started; no object URLs created; worker agent closed by orchestrator.

# Task 7 Content Review Workspace UI And Browser QA

## Plan

- [x] Load `omo:programming`, `omo:frontend`, `omo:visual-qa`, `DESIGN.md`, and Task 7 implementation plan.
- [x] Record baseline `git status --short`, build-test, content-script source tests, and production build.
- [x] Add failing-first source-scan assertions for occurrence review UI, preview, and legacy storage loading.
- [x] Implement occurrence-aware review rows, selected score, comparison strip, and preview-before-export controls.
- [x] Run green verification commands and `node --check` on the built content script.
- [x] Drive browser/content QA harness and write C003 evidence with cleanup receipt.

## Review

- Baseline: `.omo/ulw-loop/repeated-score-occurrence-review-20260707-v2/evidence/task-7-baseline.txt` captures dirty status, `npm run build:test`, package marker, focused content-script bundle test, and production build passing before Task 7 edits.
- RED: `.omo/ulw-loop/repeated-score-occurrence-review-20260707-v2/evidence/task-7-red.txt` captures the added source scan failing on the cluster-only review panel before implementation.
- GREEN: `.omo/ulw-loop/repeated-score-occurrence-review-20260707-v2/evidence/task-7-green.txt` captures build-test, package marker, focused content-script bundle test, typecheck, production build, and built content-script syntax check passing.
- C003: `.omo/ulw-loop/repeated-score-occurrence-review-20260707-v2/evidence/C003-review-ui.txt` captures a built content-script/CSS Node VM DOM harness with `A,B,A,C`, distinct A occurrence ids, replacement/exclusion decisions, preview data URL, preview/export payload assertions, adversarial notes, and cleanup receipt.
- Screenshot note: no screenshot captured because `browser:control-in-app-browser`, Playwright/jsdom/happy-dom, and local Chrome/Edge commands were unavailable; fallback is recorded in C003.
- Commit: no commit made because the workspace has broad unrelated untracked/dirty state, making atomic staging unsafe.

# G021 Plugin UX Improvements

## Plan

- [x] Read `DESIGN.md`, active UI skills, and the existing task history before implementation.
- [x] Locate the plugin UX surface and identify the highest-impact friction points.
- [x] Improve the export review panel scan path, primary actions, status feedback, and accessible controls without introducing a new visual language.
- [x] Add focused regression coverage for the improved review UX.
- [x] Run typecheck, tests, build, and targeted content-script QA.
- [x] Document results and remaining risks in this review section.

## Design Notes

- Design read: operational Chrome-extension plugin UI for repeated score-export review, not a landing page or brand surface.
- Dials: `DESIGN_VARIANCE 5`, `MOTION_INTENSITY 3`, `VISUAL_DENSITY 7`.
- Source of truth: existing `DESIGN.md` and `.score-export-panel` BEM contract. The `ui-ux-pro-max` generated recommendation drifted toward marketing/video hero patterns, so it is not used as the implementation direction.
- Success criteria: users can quickly see what will export, what needs attention, what the next action is, and how preview/export status changed.

## Review

- Changed `src/content/roi-selector.ts` and `src/content/roi-selector.css` to add a compact review summary strip, explicit include/exclude state, live status semantics, visible focus states, viewport-bounded panel scrolling, and export buttons that can auto-run preview before PDF/PNG save.
- Updated `DESIGN.md` with the review summary and export action flow contract so the plugin UX remains aligned with the existing operational design system.
- Added regression coverage in `tests/content-script-bundle.test.ts` for summary rendering, export action enablement before manual preview, accessible status roles, and small-viewport CSS constraints.
- Added evidence harnesses under `.omo/evidence/`: `g021-plugin-ux-harness.mjs` validates the content-script export flow, and `g021-plugin-ux-visual-qa.mjs` drives the built panel through headless Chrome screenshots at 375, 768, and 1280 px.
- Verification passed: `npm run verify` completed with typecheck, 115 passing tests, and Vite build; `node .omo/evidence/g021-plugin-ux-harness.mjs` passed; `node .omo/evidence/g021-plugin-ux-visual-qa.mjs` passed with panel-in-viewport and no horizontal overflow at all tested widths.
- Remaining risk: visual QA used a deterministic YouTube-like fixture with the built content script, not a manually installed extension session on a live YouTube tab.

# G022 Export Review Panel UX Redesign

## Plan

- [x] Redesign the post-capture export review panel (`src/content/roi-selector.ts` + `roi-selector.css`) for end-user friendliness: persistent header/footer, single scroll body, jargon-free Korean labels, m:ss timing, and all-page preview.
- [x] Keep every source/CSS contract asserted in `tests/content-script-bundle.test.ts` and the `DESIGN.md` token/BEM family.
- [x] Run `npm run verify` (typecheck + tests + build) green.
- [ ] Run browser Visual QA at 375/768/1280 px. Deferred because the user will perform this step directly.
- [x] Document results and remaining risks in the review section below.

## Review

- The review panel now keeps its header, live status bar, and export actions visible while one body region scrolls. It uses user-facing Korean score numbers, `m:ss` timing, repeat and validation badges, and hides internal occurrence ids in tooltips.
- Preview renders every generated page in order. PDF and PNG remain available without a manual preview step because export creates the current preview first when needed.
- Updated `DESIGN.md` to match the implemented 560px/12px shell, status bar, single scroll owner, fixed footer, user-facing selected-score metadata, and all-page preview contract.
- Updated `.omo/evidence/g021-plugin-ux-harness.mjs` so its fake DOM supports `createTextNode` and verifies preview page structure instead of Korean prose. The harness passed the validation, preview, and export message flow with occurrence order `A,B,A`.
- Verification: `.omo/evidence/g022-verification.txt` records `npm run verify` passing TypeScript, all 115 tests, and the Vite production build. `.omo/evidence/g022-flow-harness.txt` records the non-visual flow harness passing.
- Static review: `src/content` LSP diagnostics reported 0 errors, the TypeScript no-excuse checker reported 0 violations, and `node --check` passed for the harness and built content script. The inherited content script remains above the 250 LOC guideline under its existing `SIZE_OK` injection constraint.
- Browser Visual QA and screenshots were not run, as requested. No browser or background QA process was started.

# G023 Generated Score PDF Diagnosis

## Plan

- [x] Inspect the supplied PDF metadata, rendered pages, and embedded image bounds for clipping or missing systems.
- [x] Trace the current capture, crop, deduplication, validation, review, and PDF layout path from the indexed source.
- [x] Compare observed PDF defects with the code and tests to confirm which stage introduces or fails to reject them.
- [x] Document the confirmed causes, current extraction method, and verification limits in the review section.

## Review

- The supplied PDF is structurally valid: 3 pages at 1200x1700, 11 embedded RGB raster images, and every image is placed within the PDF page bounds. The PDF assembly stage does not crop the images.
- Five embedded source images are already vertically truncated before PDF placement: page 1 has a 1322x94 fragment, page 2 has 1322x122, 1322x122, and 1322x125 fragments, and page 3 has a 1322x107 fragment. They preserve only part of the upper staff and omit the lower staff and/or code area. The first image also contains the YouTube play overlay, and the 347px-tall images include the AR keyboard strip.
- The active production path is manual YouTube ROI selection -> full-tab capture sampled every second -> ROI crop -> normalized fingerprint and perceptual-hash clustering -> occurrence ordering -> horizontal staff-line heuristic crop -> optional Gemini/local validation -> review/preview -> pdf-lib bitmap placement. It does not run OCR/OMR, transcribe notes, reconstruct notation, or use the legacy dynamic layout detector.
- The damage conclusively occurs before PDF assembly. The export-time staff crop is the strongest code-level suspect because it accepts any three long dark horizontal runs and crops around their first/last rows with fixed padding, without requiring a complete grand staff or checking pixels cut at the crop edges. The retained raw ROI frames are unavailable, so this artifact cannot conclusively separate a too-small original ROI from over-cropping.
- The validation gap is reproduced on the actual 11 embedded images: applying the current local pixel rules classifies all 11 as `valid`, including the five truncated fragments and the play-overlay/keyboard-contaminated captures. Gemini validation is disabled by default; the fallback checks only overall darkness, a large dark band, and a weak staff-row proxy.
- The review UI can label kept items as `AI`-reviewed even when the local fallback decided them. Export auto-generates a preview when absent but immediately continues to download without a separate user approval gate; preview and export each re-run validation independently.
- Existing verification remains green despite the defect: `npm run verify` passed typecheck, all 115 tests, and the Vite production build. Current PDF tests assert the MIME/header and sparse layout gap, but do not rasterize final pages or check crop completeness, edge contact, grand-staff preservation, overlays, image/page bounds, or preview-to-PDF identity.
- Verification limit: the completed browser capture session and uncropped ROI frames were not retained, so the exact timestamp-level before/after crop toggle cannot be replayed from this PDF alone. Diagnosis used the final PDF, its embedded source bitmaps, page content transforms, the active source path, the current local validation algorithm, and the full test/build suite.

# G024 Complete Score Capture And Approved Export

## Plan

- [x] Record the implementation contract in `DESIGN.md` and debugging evidence before changing runtime behavior.
- [x] Add failing regressions for full-ROI export images, paused-frame rejection, two-observation stability, and approved-preview export payloads.
- [x] Preserve full ROI images for export while keeping staff-content normalization limited to score identity comparison.
- [x] Ignore paused samples and require two consistent observations before accepting a newly changed score.
- [x] Require explicit preview approval and export the exact approved preview pages for both PDF and PNG.
- [x] Run typecheck, the full test suite, production build, and a non-visual export-flow harness.
- [x] Document results and leave browser Visual QA deferred to the user as requested.

## Review

- Export images now preserve the complete manually selected ROI. Staff-content extraction remains only in fingerprint generation, so the permissive staff-line crop can no longer remove lower staves before PDF composition.
- Frame collection waits for a non-paused playback tick, and every new score needs two matching observations. Unconfirmed transition frames are replaced in the pending buffer instead of becoming export clusters.
- Export validation now rejects clear geometry fragments below 75% of the selected-session median before AI inspection. This specifically covers mixed full-height/truncated captures while avoiding assumptions about a single score's notation type.
- PDF and PNG actions remain disabled until a generated preview is explicitly approved. Final export consumes the approved preview page data URLs, so it does not re-run validation or page composition after approval.
- Review badges and status copy now identify the actual `AI` or `로컬` decision source.
- Verification passed: `npm run verify` completed with clean typecheck, 121 passing tests, and a Vite production build. The built content-script Node VM harness passed approval-gate and frozen-page payload checks, and `node --check` passed for the built content script.
- Browser Visual QA was not run because the user explicitly reserved that check. The remaining manual gate is to reload the extension, repeat the same YouTube capture, inspect every preview page, approve it, and compare the resulting PDF.
- The repository was already broadly dirty/untracked before this task; unrelated files were preserved and no commit was made.

# G025 Review Image Zoom And Readability

## Plan

- [x] Define the larger review hierarchy and reusable image viewer contract in `DESIGN.md`.
- [x] Add failing regression coverage for zoom entry points, keyboard controls, modal accessibility, and larger image sizing.
- [x] Add a shared image viewer for selected scores, occurrence thumbnails, and generated preview pages.
- [x] Increase the panel, selected score, occurrence thumbnail, and page preview display sizes.
- [x] Run typecheck, automated tests, and production build without browser or screenshot QA.

## Review

- Enlarged the review panel from 560px to 760px, the selected score to a 320px maximum height, and occurrence thumbnails to 160x96px on desktop.
- Removed the small fixed-height cap from generated PDF page previews so each page uses the available panel width.
- Added one accessible image viewer shared by the selected score, captured occurrences, and generated preview pages, with 50-300% zoom, 25% steps, width fit, keyboard controls, focus trapping, and focus restoration.
- `npm run verify` passed: TypeScript typecheck, 122 automated tests, and the Vite production build.
- Browser, screenshot, manual interaction, and visual QA were intentionally not run per user request; visual approval remains with the user.

# G026 Sequential Score Preservation

## Plan

- [x] Reproduce a `1,2,3,4,5` score stream collapsing to `1,5` with a failing regression.
- [x] Confirm whether the loss occurs in transition buffering, occurrence ordering, or representative image lookup.
- [x] Fix the root cause while retaining noise rejection for isolated transition frames.
- [x] Run targeted tests, typecheck, full tests, production build, and a non-visual export-flow harness.
- [x] Record the verification evidence and cleanup result.

## Review

- Root cause: once the first score was accepted, every one-sample `different` candidate replaced the previous pending candidate. Scores 2-4 therefore never became clusters, so occurrence ordering and image export never received them.
- The clusterer now promotes a pending different score after one configured stable sampling interval when the following sample is also unrelated to every accepted score, and carries the following sample forward as the next pending transition.
- Returning to an already accepted score still takes the existing match branch and discards the isolated pending frame, preserving transient-noise rejection.
- Red regression observed only hashes 1 and 5; the fixed suite passes all 123 tests.
- Verification: `npm run typecheck` passed, `npm test` passed 123/123, `npm run build` passed, and the built non-visual capture/export harness reported `accepted: 5`, `exported: 5`, in cluster order 1-5.
- Browser and screenshot Visual QA were intentionally not run per user request.

# G027 Long Capture Persistence

## Plan

- [x] Reproduce the growing session-storage payload and repeated sink failure behavior with automated tests.
- [x] Move full score images out of the bounded session-state object while preserving review/export hydration.
- [x] Correct consecutive sampling-error accounting so persistent delivery failures surface.
- [x] Run targeted tests, a non-visual long-capture harness, typecheck, the full test suite, and production build.
- [x] Record the root cause, verification evidence, and remaining limits below.

## Review

- Root cause: each one-second frame carried cumulative full-resolution PNGs in `uniqueScores`, `exportOccurrences`, and `exportCandidates`, and the background rewrote those duplicates into `chrome.storage.session`. The session area has a fixed 10 MB quota, so writes eventually rejected and later frames disappeared from state.
- A second defect hid the failure: `consecutiveSampleErrors` was reset before the awaited frame delivery. Every rejected delivery therefore looked like the first failure and the capture kept dropping frames without reaching its error threshold.
- Full images are now deduplicated by session/image id in `chrome.storage.local`; `storage.session` contains only bounded metadata and recent small previews. Review, validation, preview, and the debug page hydrate the images on demand. The manifest requests `unlimitedStorage` for this intentionally large local capture data.
- Offscreen transport sends each full export image only once. Later cumulative messages contain metadata plus at most a newly retained candidate, avoiding a second growth point before storage.
- Playback gating now applies to sampling rather than `stop()`, so pausing does not create captures and cannot prevent cleanup.
- Red regressions reproduced a state larger than 10,485,760 bytes and the misplaced error reset. The fixed two-minute simulation added one score per second, kept session metadata below 1 MB, restored all 120 images, and rewrote no existing image.
- Final verification passed: `npm run verify` completed typecheck, all 130 tests, and the Vite production build.
- Browser, screenshot, and visual QA were not run per the user's instruction. The extension must be reloaded because `manifest.json` and built service-worker behavior changed.

# G028 Export Ready Notification Regression

## Plan

- [x] Reproduce the missing export-ready notification through the built runtime-message path without visual QA.
- [x] Confirm whether frame persistence can finish after capture shutdown and leave the export count at zero.
- [x] Serialize capture messages and acknowledge persisted frames before the offscreen sender drops image payloads.
- [x] Run targeted red/green tests, typecheck, the full suite, production build, and a non-visual message-flow harness.
- [x] Record the confirmed cause, verification evidence, and remaining manual reload requirement.

## Review

- Root cause: `FRAME_SAMPLED` was handled as a fire-and-forget background message. After full images moved to asynchronous local storage, `CAPTURE_STOPPED` could finalize the session and read an empty score state before frame persistence completed. The offscreen sink simultaneously marked its one-time image payload delivered without a persistence acknowledgement.
- A second ordering gap existed inside `FrameInputCollector.stop()`: it could null collector state and send `CAPTURE_STOPPED` while `sink.onFrame()` was still in flight, causing the late frame to be ignored after session cleanup.
- Background frame/stop events now run in one serialized queue and return an explicit `CaptureCommandResponse`. The sink marks image payloads delivered only after an `{ ok: true }` acknowledgement, and queue failures are recoverable rather than poisoning later messages.
- Normal capture shutdown now awaits an active frame delivery before emitting `CAPTURE_STOPPED`. Error-triggered shutdown avoids awaiting itself and therefore does not deadlock.
- Silent notification exits now log the session id for zero persisted scores or a failed content-tab delivery, closing the observability gap that made this regression appear as “nothing happens.”
- Red tests failed at 130/131 and 131/132 respectively before each fix. Final `npm run verify` passed typecheck, all 132 tests, and the production build.
- The built non-visual service-worker harness delayed the image write, confirmed stop stayed pending, then observed `SCORE_EXPORT_READY` with `scoreCount: 1`, `pageCount: 1`, and the image present in local storage.
- Browser, screenshot, and visual QA were not run per the user's instruction. Reload the unpacked extension before retesting because the built service worker and offscreen bundle changed.

# G029 Empty Export Images Regression

## Plan

- [x] Reproduce the review panel's `내보낼 수 있는 악보 이미지가 없습니다.` branch from persisted capture state.
- [x] Confirm whether image loss occurs during local persistence, hydration, background response transport, or content-side mapping.
- [x] Add a failing regression and apply the smallest root-cause fix.
- [x] Run targeted tests, typecheck, the full suite, production build, and a non-visual export-review harness.
- [x] Record the confirmed cause, verification evidence, and reload requirement.

## Review

- Root cause: the content script read compact `chrome.storage.session` state before calling the background review API. G027 intentionally removed every full `image.dataUrl` from that state, so the direct read succeeded with metadata-only scores and `toReviewedScores()` filtered the entire list.
- The review panel now has one data source: `GET_EXPORT_REVIEW_DATA`. The background hydrates score images from `chrome.storage.local` before responding. The obsolete untrusted-content access to `storage.session` and its `setAccessLevel()` exposure were removed.
- The failing-first bundle regression observed 6/8 passing tests and found both obsolete direct-read paths. After the fix, the targeted capture/background/content suite passed 20/20.
- `npm run verify` passed typecheck, all 132 tests, and the Vite production build.
- The built non-visual DOM harness used compact session records with no `dataUrl`, received hydrated images only through `GET_EXPORT_REVIEW_DATA`, rendered 3/3 score rows, generated a preview, and sent the approved PDF export payload.
- Browser, screenshot, and visual QA were not run per the user's instruction. Reload the unpacked extension before retesting because the content-script and service-worker bundles changed.

# G030 Safe ROI Contamination Cleanup

## Plan

- [x] Trace retained same-score candidates and choose the narrowest export-time cleanup seam.
- [x] Add failing pixel regressions for transient overlay removal, persistent notation preservation, safe outer whitespace/band trimming, and unrecoverable contamination rejection.
- [x] Implement non-generative temporal cleanup and guarded edge trimming before validation/page composition.
- [x] Keep original stored ROI images unchanged and feed only cleaned derivatives to preview/PDF/PNG.
- [x] Run targeted tests, typecheck, the full suite, production build, and a non-visual pixel/export harness.
- [x] Document behavior, limits, and extension reload requirement.

## Review

- Root cause: the full selected ROI was intentionally copied byte-for-byte into export candidates, and validation/page composition had no cleanup stage. A second defect recorded every non-representative temporal candidate with quality `0`, so a later clean frame could be pushed out of the four-frame candidate pool.
- Export validation now creates an in-memory derivative before inspection. With at least three distinct same-cluster, same-size frames, it replaces only pixels where a strict majority shows low-chroma paper; persistent staff, note, and color pixels remain unchanged.
- Outer vertical whitespace plus multi-row uniform dark or colored bands are trimmed only when a plausible repeated staff-row pattern is present. The algorithm does not crop to the staff box and does not remove internal gaps.
- A filled dark or high-chroma component that remains after cleanup is classified as unrecoverable by the local validator, so it is replaced by a clean candidate or excluded with a recapture-required reason instead of being invented.
- Stored ROI images and occurrence metadata are never mutated. The cleaned derivative is inspected and passed into the existing approved-preview PNG path; the final PDF already embeds those exact approved page PNGs.
- Candidate retention now carries each frame's measured quality instead of `0`, preserving later clean frames for temporal cleanup.
- Red evidence: the cleanup module was absent (`TS2307`), the validator had no `imageCleaner` seam, and a bright yellow transient overlay remained `[250,240,80,255]`. Green pixel/export regressions pass 37/37.
- Final verification: `npm run verify` passed TypeScript typecheck, all 137 tests, and the Vite production build. The non-visual export regressions also confirm that approved preview PNGs are the exact inputs embedded into the final PDF.
- Browser, screenshot, and visual QA were not run per the user's instruction. Reload the unpacked extension before retesting so the rebuilt background service worker and offscreen bundle are active.

# G031 Short TAB Score And Bottom Overlay

## Plan

- [x] Reproduce a valid full-width 1322x222 score being excluded by the session-median height heuristic.
- [x] Lock a synthetic TAB regression that removes an outer YouTube title band without cropping notation.
- [x] Replace the height-based completeness heuristic with evidence that does not penalize legitimate compact score layouts.
- [x] Run targeted tests, the full verification suite, and production build without Visual QA.
- [x] Document the root cause, limits, and extension reload requirement.

## Review

- Root cause: export geometry validation compared every score's height with the session median. A legitimate 1322x222 single-line TAB strip was only 64% as tall as 1322x347 peers, so it was excluded before the local or AI content inspector could evaluate it.
- Geometry validation now treats only invalid dimensions and severe width loss as incomplete. Height is intentionally not used because a fixed YouTube ROI can legitimately contain piano systems, single staffs, and compact TAB strips of very different heights.
- Width-truncated 500px captures remain excluded against a 1322px session median, so removing the height gate does not disable the reliable fixed-ROI completeness check.
- Bottom overlay detection now recognizes only thick row runs connected to the top or bottom edge. Its ink threshold tolerates white YouTube title text inside a dark band, while one-pixel TAB/staff lines and dense internal notation cannot qualify as an edge band.
- Red evidence: the compact-score regression omitted `score-B-compact-tab`; the title-bearing band regression returned crop bottom 222 instead of below row 182. After the fixes, the targeted suite passed 20/20.
- Final verification: `npm run verify` passed TypeScript typecheck, all 139 tests, and the Vite production build.
- Browser, screenshot, and Visual QA were not run per the user's instruction. Reload the unpacked extension before retesting so the rebuilt background service worker is active.

# G032 Export Crop Application Regression

## Plan

- [x] Reproduce the reported 1322x222 title-bearing bottom overlay through the crop and export-validation paths.
- [x] Confirm whether detection, derivative propagation, or browser encoding is the failing boundary.
- [x] Add a failing regression and implement the smallest root-cause fix.
- [x] Run targeted tests, the complete verification suite, and a non-visual export-path harness.
- [x] Record evidence, limits, and the extension reload requirement.

## Review

- Root cause: the solid-band detector correctly found the title overlay beginning at row 182, but small rounded-edge pixels immediately above it became the last content row at 181. The generic 9px content padding then extended the crop through row 190, re-including nine rows of the band it had just excluded.
- Crop padding is now clamped to the nearest detected top/bottom solid-band boundary. Padding remains around notation and ordinary margins but can no longer cross into a confirmed outer overlay.
- The exact uploaded 1322x222 screenshot reproduced `{x:0,y:0,width:1322,height:191}` before the fix and `{x:0,y:0,width:1322,height:182}` after it, matching the first overlay row exactly.
- The failing-first synthetic compact TAB regression reproduced bottom 191; after the change all targeted cleanup tests passed 5/5.
- Export-path audit confirmed the cleaned score object flows through `validation.scores` into page PNG rendering, and final PDF embeds those approved preview PNGs rather than the stored original.
- Final verification: `npm run verify` passed TypeScript typecheck, all 139 tests, and the Vite production build. Browser/screenshot Visual QA was not run per the user's instruction.
- Reload the unpacked extension before retesting so the rebuilt background service worker is active.

# G033 Clamp ROI Capture To Live Video Element

## Plan

- [x] Reproduce an ROI crop whose lower edge extends beyond the HTML video element into the YouTube page title.
- [x] Trace live `videoRect`, viewport, and tab-capture bitmap metadata into `RoiCropper` and isolate the boundary failure.
- [x] Add a failing lower-bound regression and implement the smallest geometry fix.
- [x] Run targeted tests, typecheck, the full suite, and production build without Visual QA.
- [x] Record the confirmed root cause, verification evidence, and extension reload requirement.

## Review

- Root cause: `frameRectToCaptureBitmapRect()` independently stretched DOM viewport X/Y over the entire tab-capture bitmap. Chrome capture frames can preserve a fixed output aspect ratio and center the actual tab content with letterbox space, so a proportionally taller capture frame expanded the ROI below the video into the YouTube page title.
- Live geometry transport was not the defect: `videoRect` and viewport flow from the content probe through the background and collector into every `RoiCropper` frame.
- The mapping now uses one aspect-preserving scale plus centered capture-content offsets. Matching-aspect captures keep their original coordinates; mismatched captures stay inside the actual centered tab content.
- Red evidence: the regression mapped a 600px-high video in a 1600x900 viewport / 1280x1024 capture down to about row 683, crossing the real row-632 video boundary. After the fix it maps to `{ x: 0, y: 152, width: 1280, height: 480 }` and ends exactly at row 632.
- Targeted verification passed 22/22. Final `npm run verify` passed TypeScript typecheck, all 140 tests, and the Vite production build.
- Browser, screenshot, and Visual QA were not run per the user's instruction. Reload the unpacked extension before retesting so the rebuilt offscreen capture bundle is active.

# G034 Dynamic Height-Based PDF Pagination

## Plan

- [x] Reproduce the fixed five-score split despite sufficient remaining page height.
- [x] Replace count-based chunking with shared width-scaled height packing across preview, PDF, PNG, and offscreen paths.
- [x] Keep every placed score within page padding and start a new page only when the next score does not fit.
- [x] Run targeted tests, typecheck, the full suite, and production build without Visual QA.
- [x] Record verification evidence and the extension reload requirement.

## Review

- Root cause: preview/download/offscreen chunkers and the review panel treated five scores as a page regardless of each width-fitted score height, creating avoidable blank space and inconsistent page counts.
- Fix: added shared remaining-height packing, routed background/offscreen chunkers and ready notifications through it, and supplied the same page layout metrics to the no-runtime-import review panel.
- Boundary fixes: extremely tall single scores are compressed inside printable bounds, renderer placement uses persisted score dimensions like the chunker, and missing-image entries are excluded consistently before ready/preview calculation.
- Regression evidence: compact `1600x180` scores pack `11 + 1`, a generated twelve-score PDF has two pages, taller `512x160` fixtures pack `4 + 2`, and an extreme tall-image placement remains inside the bottom padding.
- Verification: `npm run verify` passed (`143/143` tests, TypeScript typecheck, and Vite production build). Visual QA was intentionally not run per the user's instruction.
- Runtime note: reload the unpacked extension before the next capture/export so Chrome uses the rebuilt content and background scripts; previously generated PDFs are unchanged.

# G035 Remove Non-Notation Black ROI Lines

## Plan

- [x] Reproduce a long black ROI separator surviving the real cleanup/export derivative path.
- [x] Confirm whether the line originates in cleanup, temporal consensus, or page rendering.
- [x] Remove only non-notation border/separator bands while preserving staff lines, barlines, notes, text, and symbols.
- [x] Add unit and integration regressions for black-line removal and notation preservation.
- [x] Run targeted tests, no-excuse audit, full verification, and production build without Visual QA.

## Review

- Root cause: persistent separators survive temporal paper-background consensus, and the cropper only handles edge-adjacent bands without whitening their pixels.
- Fix: whiten 3+ row bands covering at least 90% of ROI width, normalize paper-like pixels to pure white, and clean replacement candidates through the same path.
- Regression evidence: targeted cleanup/validator suite passed 23/23; direct pixel scenario produced white separator and paper pixels while retaining staff and barline pixels.
- Full verification: `npm run verify` passed typecheck, 146/146 tests, and the production Vite build.
- Visual QA intentionally not run per user request.
- The no-excuse audit found one pre-existing intentional AI-fallback empty catch at `export-score-validator.ts:145`; no new violation was introduced by this fix.

# G036 Diagnose AI Review Falling Back to Local

## Plan

- [x] Confirm the stored-key path, enabled flag, host permission, and model endpoint independently.
- [x] Trace every AI-to-local fallback condition and the review UI label source.
- [x] Identify the observed root cause or the exact missing runtime evidence without exposing the API key.
- [x] Record the diagnosis and any required fix scope.

## Review

- Observed: `.env` contains a non-empty `GEMINI_API_KEY`, and the key successfully queried `models/gemini-3.1-flash-lite` with HTTP 200.
- Root cause: extension runtime never reads `GEMINI_API_KEY`; export validation reads only `chrome.storage.local.aiJudgeSettings`, whose default is disabled.
- Observability gap: AI configuration errors, HTTP failures, uncertain results, and confidence below 0.65 all silently fall back to the local inspector, so the review UI cannot show the actual reason.
- Verification: the two existing AI-failure/uncertain fallback regressions passed.
- No product source was changed because the user requested a diagnosis. Do not bundle the `.env` key into extension JavaScript; configure extension storage or use a proxy instead.

# G037 Standalone Link-to-Score Frontend Foundation

## Plan

- [x] Preserve the existing MV3 extension build and capture behavior as a regression boundary.
- [x] Define the standalone page design contract, inclusive personas, responsive states, and API boundary before UI code.
- [x] Add failing-first coverage for valid YouTube input, malformed input, and score-job response states.
- [x] Add an isolated Vite web build that outputs to `dist-web` and never overwrites extension `dist`.
- [x] Implement a Korean link-only page that submits a real score job, polls progress, and shows results only after backend success.
- [x] Verify malformed input and backend failure recover without fabricated output.
- [x] Run typecheck, focused tests, the standalone web build, and the complete extension verification suite.
- [x] Run real-browser happy/error flows, responsive/keyboard/accessibility checks, and visual QA at 375, 768, and 1280 pixels.
- [x] Complete independent visual and implementation review gates and record evidence.

## Review

- Added a separate `web/` Vite surface and `dist-web` build. Existing `manifest.json`, `vite.config.ts`, and extension runtime entrypoints remain unchanged.
- The page accepts standard YouTube, Shorts, embed, and youtu.be links through the shared parser, canonicalizes the video ID, posts a typed score job, polls queued/running states, and exposes a download only after a validated succeeded response.
- Contract RED/GREEN evidence covers malformed input, all job states, required result metadata, typed malformed-URL failure, immutable job identity, and rejection of non-HTTP download URLs. Final verification passed TypeScript, 156/156 tests, the standalone production build, and the MV3 production build.
- Real-browser QA passed invalid-input focus/no-request behavior, queued/running progress, real QA response download, backend failure/retry, keyboard Tab/Enter, reduced motion, 375/768/1280 responsive layouts, and 640 CSS-pixel 200-percent-zoom equivalence without horizontal overflow.
- Three mobile and three desktop Lighthouse runs on the final build scored 100 for performance, accessibility, best practices, and SEO. `npm audit` reports zero vulnerabilities.
- Two fresh independent Visual QA reviewers passed all 15 final state/breakpoint captures plus keyboard, 640px boundary, and 600px stacked-form evidence for source revision `5558168902617662678ee333f65db0a9d6ec2f5a756456ba4637da0acbb37a36`; no recapture is required.
- QA-only API and preview processes were closed; ports 4173 and 4174 have zero listeners. The production backend remains the explicit next migration layer and no fake success path ships in the frontend.
- `WEB-001` remains open for the production backend: authenticated job ownership, server-side YouTube retrieval, frame/score processing, result storage, rate limits, and authorized downloads.

# G038 Local YouTube Link-to-Score Backend

## Plan

- [x] Confirm the standalone frontend contract and identify the Node-safe score-processing seams.
- [x] Install and verify `yt-dlp`, `ffmpeg`, and `ffprobe` on this Windows user account.
- [x] Add failing-first API, media-processing, deduplication, and PDF-result coverage.
- [x] Implement a local HTTP job service that validates YouTube links, runs one bounded job at a time, and exposes downloadable results.
- [x] Implement real `yt-dlp` retrieval, `ffmpeg` frame extraction, notation detection, duplicate suppression, page composition, and PDF output.
- [x] Connect repository scripts and the existing Vite proxy to the backend without changing the extension build.
- [x] Run typecheck, focused tests, full verification, CLI smoke tests, and a non-visual HTTP end-to-end scenario.
- [x] Record the implementation and verification evidence; do not run Visual QA.

## Review

- Installed `yt-dlp` 2026.07.04 plus `ffmpeg`/`ffprobe` N-125365-g9a01c1cb6a for the current Windows user and verified all three executables after refreshing the user PATH.
- Added a local-only Hono job API on `127.0.0.1:4174` with strict YouTube URL/video identity validation, serialized processing, progress states, typed failures, and job-bound PDF downloads.
- Added the real media pipeline: `yt-dlp` metadata/download, two-hour and 2 GB limits, `ffprobe` duration validation, bounded `ffmpeg` sampling, Sharp-backed staff analysis, perceptual duplicate suppression, shared page packing, and `pdf-lib` output.
- Added `npm run dev` to start the API and standalone Vite frontend together while leaving the MV3 extension build unchanged.
- Failing-first and green coverage now includes API identity, job lifecycle, authorized result serving, staff/blank discrimination, perceptual duplicate handling, and non-empty PDF composition.
- Real end-to-end evidence: public 22-second score video `lNh9zuETjlc` completed through the HTTP API and downloaded a parseable 170,789-byte, one-page PDF.
- Final verification: `npm run verify` passed typecheck, all 162 tests, standalone web build, and extension build; `npm audit --audit-level=high` reports zero vulnerabilities; the no-excuse audit and `git diff --check` passed.
- Non-visual runtime check passed through the Vite proxy (`/` HTTP 200 with app root; `/api/health` returned `ok`). Visual QA was intentionally not run per the user's instruction.

# G039 Server Score Recall, Crop Purity, And Export Quality

## Plan

- [x] Compare the user's runtime video under current and denser sampling, recording valid score states, crop bounds, hash distances, and accepted image dimensions.
- [x] Add failing-first regressions for sub-two-second score changes, piano-adjacent crop exclusion, and export paths that never upscale analysis-sized images.
- [x] Preserve high-resolution source frames while using a bounded analysis copy for staff detection and identity.
- [x] Tighten score-panel crop margins and identity rules without excluding compact single-staff or TAB scores.
- [x] Reprocess the real video and compare score count, non-paper crop contamination, embedded image dimensions, and PDF readability metrics.
- [x] Run focused tests, full verification, no-excuse audit, and non-visual HTTP QA; do not run Visual QA.

## Review

- Runtime evidence on `08NPrnMV9r4`: the old 2-second/960px path extracted 79 frames and exported 12 scores across 3 pages. Half-second native-resolution extraction plus the corrected identity boundary exported 19 scores across 4 pages.
- Root causes: the two-second interval skipped short score states; ffmpeg permanently reduced source frames to 960px; the 15-bit global dHash threshold merged distinct notation; and the fixed crop margin crossed the white score panel into dark piano rows.
- Frame extraction now keeps native dimensions as high-quality JPEG, samples short videos at 0.5 seconds, and stays bounded to 3,600 frames for long videos.
- Score analysis uses a separate maximum-1280px grayscale copy, maps the detected crop back to the original frame, and keeps the original-width PNG for PDF composition.
- Crop detection excludes staff candidates without a paper-bright background and stops after a sustained non-paper boundary. On the real repro, maximum dark padding below the last staff fell from 85 analysis rows to 9.
- Server dHash matching now uses the established 10-bit distance instead of 15. On the real dense sample, the toggle separated 17 states instead of 15 before the additional 1280px analysis improvement.
- The corrected real API result is a parseable 2,025,145-byte, four-page PDF. The old result was three pages; source score crops are now 1920px instead of being enlarged from 960px to the 1120px printable width.
- Final verification: `npm run verify` passed typecheck, all 166 tests, standalone web build, and extension build. Focused no-excuse audit passed all six changed TypeScript files. Visual QA was intentionally not run.

# G040 Staff-Anchored Crop And Consistent Score Spacing

## Plan

- [x] Measure staff-relative content bounds and disconnected ink components in the two reported output images.
- [x] Add failing-first regressions for preserved top musical context, excluded bottom signatures, and normalized inner score padding.
- [x] Replace symmetric paper expansion with staff-anchored asymmetric content bounds that preserve notation and chord/tempo labels.
- [x] Keep the shared page gap fixed while ensuring accepted score images no longer carry variable outer whitespace.
- [x] Reprocess the real video and compare crop components, staff-to-edge padding, page spacing, and PDF structure.
- [x] Run focused tests, full verification, no-excuse audit, and non-visual API QA; do not run Visual QA.

## Review

- Root cause: score crops used effectively symmetric outer whitespace and accepted low-regularity sliding staff candidates. This clipped tempo/clef context above the staff, let disconnected signature text extend the bottom crop, and made the fixed 16px page gap look inconsistent.
- Crop selection now prefers regular staff candidates when available, preserves nine staff gaps above for musical context, and limits the bottom to two gaps. The page layout's existing fixed gap remains unchanged.
- Failing-first coverage reproduced the signature retention (`crop bottom 140 retained signature text at row 105`). Green coverage confirms signatures do not change crop height, vertically shifted equivalent systems produce equal crop heights, top context remains included, and dark piano boundaries stay excluded.
- Real non-visual API QA on `08NPrnMV9r4` completed with 19 score images across 3 pages. The previous quality pass also found 19 images but required 4 pages because of excess internal whitespace; the intermediate over-aggressive rejection attempts produced 9 and 1 images and were removed.
- Final verification: `npm run verify` passed typecheck, all 170 tests, standalone web build, and extension build. The TypeScript no-excuse audit passed both changed files. Visual QA was intentionally not run per the user's instruction.

# G041 Complete White Score Sheets From Server PDF

## Plan

- [x] Extract and numerically profile every page and score region in the user's exact downloaded PDF.
- [x] Trace clipped bounds and non-white pixels back through source crop, cleanup, and page composition.
- [x] Add failing-first regressions using the observed edge and background characteristics.
- [x] Implement the smallest shared server-pipeline fix for complete crops and white paper normalization.
- [x] Regenerate the same YouTube link and compare score count, edge clipping, background purity, and PDF structure.
- [x] Run focused tests, full verification, TypeScript audit, and non-visual HTTP/PDF QA.

## Review

- The user's exact three-page PDF contained a 222/222/222 gray first sheet and multiple crops whose musical ink continued beyond the exported edge. The server had no background normalization and used fixed staff-gap margins before page composition.
- Crop bounds now retain a larger top semantic margin and expand through the connected paper-backed notation component, while large blank gaps still exclude signatures and non-paper rows still stop at piano/video boundaries.
- Bright neutral paper pixels normalize to pure white before hashing and export. Colored notation is preserved, and fractional analysis-to-source bottom coordinates round inward so a colored boundary row cannot leak into the score.
- Failing-first evidence: crop top 54 removed row 45, crop bottom 146 removed row 165, gray paper stayed `[222,222,222]`, and a 604.5px paper boundary rounded outward to 605. All four regressions pass after the fix.
- Real same-link HTTP QA job `4bfb8883-c5e6-4133-af4e-e14a84a390d9` succeeded with 18 unique scores and 4 pages. Preserved score analysis found 0 top-edge and 0 bottom-edge dark crops, 0 low-white sheets, and minimum per-score white ratio 0.897. Every API PDF page has no near-solid non-white row and at most a two-row staff-line run.
- The previous nineteenth item was not lost notation: `frame-000170` is a padding-induced duplicate of `frame-000162` at dHash distance 2.
- Final verification: `npm run verify` passed typecheck, all 174 tests, standalone web build, and extension build. The TypeScript no-excuse audit passed all four changed files. Visual QA was intentionally not run.

# G042 Full-Page Server PDF Layout

## Plan

- [x] Compare `1.pdf` and `yt2sheet-pDkESH-ItxQ (3).pdf` using PDF page/image geometry and identify the exact layout difference without visual QA.
- [x] Trace the standalone server PDF composer, its page-size/margin/packing constants, and focused regression coverage.
- [x] Add a failing regression that requires score content to use the available page area like the reference PDF.
- [x] Implement the smallest shared page-composition change that fills the sheet while preserving aspect ratio and pagination.
- [x] Run the focused automated tests, TypeScript checks, project verification, and diff review; do not run browser, screenshot, or manual PDF QA.

## Review

- Structural comparison found the reference A4 PDF uses about 92.4-95.6% of each page height, while the reported server PDF's second 1200x1700 page used about 69.7%. The shared layout fitted every score to the printable width but always stacked from the top with a fixed 16px gap.
- `computeScorePagePlacements` now keeps the existing width fit, aspect ratio, pagination, minimum gap, and tall-image compression while distributing each page's remaining printable height between score systems.
- The new regression failed against the previous layout with a last-system bottom of 308 instead of 1660, then passed after the change. The focused file passed 13/13 tests.
- Final automated verification passed TypeScript, all 180 tests, the standalone web build, the extension build, the two-file no-excuse audit, and `git diff --check`. Browser, screenshot, manual PDF review, and regenerated-output QA were intentionally not run per the user's instruction.

# G044 Reported PDF Spacing And Piano Diagnosis

## Plan

- [x] Profile every page and score region in `yt2sheet-dX4RlolT9O0 (1).pdf`, including inter-system gaps and non-paper components.
- [x] Trace the current server page packing and placement path to explain why visible gaps differ.
- [x] Trace score detection, piano-boundary cropping, normalization, and rejection rules against the reported artifact.
- [x] Document the confirmed current behavior and root causes without changing product code.

## Review

- The specified file is a stale one-page 2400 x 3400 artifact created at 10:11, before the current server started. The current server generated 20 scores over seven 1200 x 1700 pages for the same video at 10:43.
- Page packing is greedy by width-fitted score height. Placement then recalculates `resolvedGap` independently per page from all unused printable height, so it does not provide one global fixed sheet gap. Retained top/bottom whitespace inside each crop further changes the visible ink-to-ink distance.
- The reported file's main retained component spans 92.0% of the page width and is neutral rather than colored. The current result also contains 93.4%-wide, 128-pixel-high photographic/keyboard bands on multiple pages.
- Crop boundary detection treats rows with at least 55% bright pixels as paper and needs eight consecutive darker rows to stop. White keyboard rows can pass that gate. The later normalizer removes only compact colored components no wider than 30% of the score image, so a wide black-and-white piano is not removed.
- No product code, tests, server state, or user files were changed during this diagnosis.

# G045 Consistent Sheet Spacing And Piano Exclusion Design

## Plan

- [x] Define one page-layout policy that preserves aspect ratio and uses a globally constant sheet gap without inflating sparse pages.
- [x] Define staff-anchored vertical padding normalization so visible ink spacing matches placement spacing.
- [x] Define a piano-boundary classifier that crops wide keyboards before normalization without erasing staff lines or musical context.
- [x] Specify failing-first fixtures, integration coverage, and same-video acceptance metrics for implementation.

## Review

- Piano exclusion belongs in `server/score-analysis.ts`, before normalization. Below the last detected staff, cut at the first connected non-notation band that spans at least 70% of the frame width and is at least two staff gaps tall, or at a sustained non-paper window. This catches wide neutral and colored keyboards while preserving thin staff lines, beams, barlines, and isolated musical tails.
- Keep `removePhotographicComponents` for compact side logos only. Expanding it to erase wide components would also classify legitimate full-width staff systems as removable and can destroy notation.
- After piano exclusion and paper normalization, trim only blank outer rows around the remaining musical ink and add one fixed staff-relative top/bottom padding. Page packing must use these normalized dimensions so equal placement gaps also become equal visible ink gaps.
- Replace per-page `resolvedGap` expansion with one fixed PDF-space gap. Greedily pack by actual normalized height, rebalance adjacent pages only when moving a trailing score reduces height imbalance, and place the whole fixed-gap group within the page's outer whitespace. A sparse final page keeps outer whitespace instead of inventing a larger inter-score gap.
- RED fixtures must use real-derived characteristics from `dX4RlolT9O0`: a 92%-wide neutral keyboard, a 93.4%-wide colored keyboard, shifted equivalent scores with different outer whitespace, and multiple pages with different score heights. Preservation fixtures must cover full-width staff lines, beams, colored notation, tempo/chord text, and low musical tails.
- Same-video acceptance: zero retained non-notation components wider than 70% below the last staff; every normalized score has identical staff-relative outer padding within one pixel; every inter-score placement gap is the configured constant within one pixel; no musical ink touches a crop edge; score order and aspect ratios remain unchanged. The final page may retain outer whitespace when content is insufficient.
- This is an implementation specification only; no product code was changed.

# G046 Consistent Sheet Spacing And Piano Exclusion Implementation

## Plan

- [x] Add failing regressions for wide neutral/colored piano boundaries, normalized vertical whitespace, and fixed cross-page score gaps.
- [x] Crop wide keyboard bands below the last detected staff before score normalization while preserving low musical content.
- [x] Normalize blank outer rows to fixed staff-relative padding before hashing and page packing.
- [x] Replace per-page expanded gaps with one fixed gap and balanced outer whitespace without changing score aspect ratios or order.
- [x] Run focused RED/GREEN tests, TypeScript diagnostics, the full verification gate, and nonvisual same-video PDF metrics; do not run browser, screenshot, or manual QA.

## Review

- Root causes: white-key rows passed the paper-brightness gate, and transition frames let a dense keyboard touching the lower frame edge become a standalone staff candidate. Per-page `resolvedGap` also inflated each page's score gap independently, while variable blank crop rows changed visible spacing again.
- Crop analysis now finds wide connected components once per frame. A dense component touching the lower edge becomes a hard piano boundary before staff selection, candidates inside it are rejected, and a wide component below valid staffs truncates the crop without removing low musical tails.
- Score normalization trims only outer blank rows after compact-photo cleanup and restores one source-scaled staff gap above and below the remaining ink. Hashing and page packing therefore use stable normalized dimensions.
- Page placement keeps the configured 16px gap on every page and divides unused printable height equally between the top and bottom outer margins. Score order, aspect ratio, greedy height packing, and tall-image compression remain unchanged.
- RED evidence: the old layout produced a 1,368px gap instead of 16px; the wide colored keyboard left 5,838 colored pixels; equivalent notation normalized to heights 120 and 220. The actual video also exposed keyboard-only frames at rows 615-719 that were accepted as staffs.
- GREEN evidence: 36/36 focused tests passed. Reprocessing all 495 frames from `dX4RlolT9O0` reduced 23 contaminated candidates to 16 score-only candidates; every retained image had zero colored piano pixels and score-like dark-pixel density 0.089-0.116. The three PDF pages used exact 16px gaps and equal top/bottom outer margins on each page.
- Final verification: `npm run verify` passed TypeScript, 184/184 tests, the standalone web build, and the extension build. Browser, screenshot, and manual visual QA were not run per the user's instruction.

# G047 ULW Research: Next Improvement Opportunities

## Plan

- [x] Establish the current product intent, architecture, dirty-worktree boundary, and auditable research ledgers.
- [x] Saturate 14 independent codebase, research, OSS, product, platform, UX, and red-team axes in parallel.
- [x] Run at least two EXPAND waves and close every returned lead as investigated, duplicate, or dead end.
- [x] Empirically verify contested quality, performance, compatibility, and operational claims.
- [x] Rank improvements by user impact, confidence, implementation effort, and dependency order.
- [x] Produce and validate cited Markdown, HTML, and PDF research artifacts without changing product code.

## Review

- Completed four research waves across 14 independent axes. The observation manifest closes O-001 through O-034, and the expansion log has no remaining unchecked lead.
- Highest-confidence P0 findings are the standalone UTF-8/markup/abort baseline and the local-only versus remote job-processing boundary. P1 follows with an explicit PDF physical-size/DPI contract and a rights-cleared, replayable corpus before broader quality tuning.
- Product semantics remain intentionally split: the extension preserves non-consecutive occurrences and context, while standalone suppresses globally repeated score systems. The report does not relabel this boundary as an identity bug.
- Repository verification remained green: TypeScript, 197/197 Node tests, standalone build (105 modules), extension build (225 modules), and `git diff --check` all exited 0. Browser/CDP verification of the product UI itself remained unavailable and is not claimed.
- Research artifacts: `.omo/ulw-research/20260724-004000/SYNTHESIS.md`, `REPORT.html`, `REPORT.pdf`, and `VALIDATION.md`. The final PDF is 8 tagged A4 pages; exact 375/768/1280 captures and all 8 PDF rasters passed fresh independent integrity and Korean/CJK visual gates.
- No product source or test file was changed by this research task; pre-existing dirty-worktree changes were preserved.
# G048 Working-Tree Fingerprint Baseline

## Plan

- [x] Seal the pre-edit baseline with inventory, scoped diffs, ownership hashes, and TEMP inventory.
- [x] Add a RED-first deterministic cached-and-untracked working-tree fingerprint CLI and isolated mutation tests.
- [x] Capture repeatable execution fingerprints and final scope evidence.

## Review

- Placeholder for caller review; execution evidence is recorded under the active attempt baseline directory.

# G049 GqPLC0J4cKs Missing Standalone Score Sheet

## Plan

- [x] Capture the exact video through the existing local API and classify every sampled frame as rejected, accepted, or duplicate with stable runtime metrics.
- [x] Confirm whether a shared omission boundary exists before changing production code.
- [x] Reprocess the exact URL through the API and inspect its nonvisual PDF structure. Do not run Visual QA or use subagents.

## Review

- The existing local API completed the exact URL twice with 18 scores across 3 pages; the downloaded PDF is 1,649,139 bytes, valid `%PDF-1.7`, and has 3 PDF pages.
- The source has 585 half-second samples. 139 frames had no staff candidate, and the remaining 446 frames form exactly 18 accepted consecutive score ranges plus 428 duplicates. Every duplicate lies within its own accepted range; no later different score was merged into an earlier one.
- The no-staff spans are 87-98.5s, 165-176.5s, 189-200.5s, and 247-276.5s; no rejected frame there contains a raw staff candidate. The only paper rejection is the final fade at 289.5s.
- `packScorePages` appends every accepted score to exactly one page and the exact job reported 18 accepted scores, so the server did not discard an accepted sheet during PDF composition.
- No product code or test was changed because the supplied URL did not exhibit a false duplicate, crop rejection, or layout drop in the current local pipeline. A timestamp or expected sequence position is needed to identify the different missing sheet without visual QA.

# G050 Verify Missing 23rd Score In Supplied GqPLC0J4cKs PDF

## Plan

- [x] Render and inspect the supplied PDF's score systems in sequential notation order, locating the missing 23rd position.
- [x] Map the missing notation state to its source-video frames, add a failing regression, and apply the smallest server-side preservation fix.
- [x] Regenerate the exact URL and verify the ordered score sequence plus automated project checks; do not invoke the Visual QA workflow or subagents.

## Review

- The supplied PDF's second page jumps from measure 19 directly to measure 26; measures 23 through 25 are absent.
- The source frame at roughly 87 seconds begins at measure 23, but the low-threshold row-line peak merged dense notation with the five staff lines and produced no staff candidate.
- `StaffCandidateDetector` now preserves the original low-threshold behavior and retries with a dense-notation threshold only when that first pass produces no candidate. The focused regression was red before the fix and green after it; the smaller YouTube tab capture regression remains covered.
- The exact local API job `c5237534-de19-4498-a373-0c234d4b672a` produced a four-page PDF. Its second rendered page is ordered 19, 23, 26, so the missing system is restored.
- `npm run verify` passed: typecheck, 291 tests, standalone web build, and extension build. The Visual QA workflow and subagents were not used, per request.

# G051 Harden Standalone Score Generation Across Score Styles

## Plan

- [x] Reproduce the supplied `eKz46zfMMT8` job through the active API and capture the exact failure stage plus generated artifact state.
- [x] Trace the shared extraction, crop, normalization, deduplication, and PDF boundaries; add a failing regression for the confirmed general cause.
- [x] Implement the smallest generalizable correction and verify the supplied URL plus the existing representative score-processing suite and full project gate. Do not invoke Visual QA or subagents.

## Review

- The active API initially returned `NO_SCORE_FOUND` for `eKz46zfMMT8`; video acquisition and frame extraction succeeded.
- A TAB over an on-camera performance contained a dense, frame-spanning dark component from row zero through the lower screen edge. The cropper mistook it for a piano boundary and removed all otherwise paper-backed staff candidates.
- The boundary now applies only to components that begin below the first paper-backed staff. A new regression fails without that condition and passes with it, while the existing dark-piano, white-key-piano, dense-notation, standard-staff, and TAB checks remain green.
- The exact local API job `a8816604-287b-49c7-957b-1397221576b1` now produced a parseable three-page, 1,224,224-byte PDF; its first page contains the expected staff notation and TAB.
- `npm run verify` passed: typecheck, 292 tests, standalone web build, and extension build. The Visual QA workflow and subagents were not used.

# G052 Detection and Processing Boundary Hardening

## Plan

- [x] Define supported visible-score detection boundaries, reproduce the low-contrast and request-boundary failures with focused RED tests, and preserve the existing staff/TAB/piano regressions.
- [x] Add adaptive bright-panel detection, strict job-request guards, and a narrow YouTube 403 media fallback without broadening the media-processing trust boundary.
- [x] Re-run the two reported YouTube jobs through the active API, inspect PDF structure, run the full verification gate, and clean only G052 diagnostic artifacts. Do not invoke Visual QA or use subagents.

## Review

- A bright 245-gray paper panel with 210-gray staff ink reproduced a real detection blind spot: the previous adaptive threshold could never rise above 180. The threshold now remains relative to sampled luminance up to 235, while the existing paper, regularity, and piano-boundary classifiers remain the acceptance safeguards.
- The request endpoint now accepts only `application/json`, streams at most 4 KiB before parsing, and caps the URL field at 2 KiB. RED cases showed `text/plain` was previously admitted as a 202 job and an oversized request had no dedicated boundary; GREEN coverage proves both are rejected before processor admission.
- The supplied `eKz46zfMMT8` retry first exposed a separate downloader boundary: `yt-dlp` returned HTTP 403 while media download began. The processor retries exactly that 403 once with `youtube:player_js_version=actual` and a clean restart; non-403 download errors remain one-attempt failures.
- Active HTTP jobs: `GqPLC0J4cKs` job `604857c9-7db9-4d3b-b0dd-5f905fd115b8` succeeded with a four-page 1200x1700 PDF; `eKz46zfMMT8` job `f0a73ac6-5cc7-4628-8383-a14a3a816984` succeeded after the controlled 403 retry with a three-page 1200x1700 PDF. Streaming `pdfinfo` and `pdfimages -list` confirmed valid PDF 1.7 structure and one embedded rendered page image per page without retaining debug PDF files.
- Final verification: `npm run verify` passed typecheck, all 296 tests, standalone web build, and extension build. Changed-file LSP diagnostics are clean. Visual QA and subagents were not used, per request.

# G053 Repeated Score Sheets In eKz46zfMMT8 PDF

## Plan

- [x] Inspect the supplied PDF in page and score-system order, quantify repeated notation states, and trace its actual accepted-score source boundary without Visual QA or subagents.
- [x] Add a failing regression for the confirmed repeat mechanism and make the smallest shared standalone-pipeline correction.
- [x] Regenerate the exact URL through the active API, compare repeated-score metrics against the supplied PDF, run full verification, and remove only G053 diagnostic artifacts.

## Review

- Root cause: the global duplicate set only compared full-frame and dominant-component 128-bit hashes. A moving playback overlay changed both enough for the same notation to be accepted again; `eKz46zfMMT8` therefore produced 14 score systems from 305 two-fps frames.
- Fix: keep the existing hashes as fast first-pass checks, then use a staff-line-suppressed 96x48 notation identity only for near-hash candidates. It requires at least 60% aligned notation overlap and staff-gap agreement within 8%, so differently spaced or genuinely changed score systems remain separate.
- Regression: the new moving-playback-overlay fixture failed RED at two accepted scores and passes GREEN at one. The established unequal-staff-gap PDF regression still keeps three distinct score sheets.
- Exact active-backend proof: job `35a33bf0-f3e4-4762-8f12-de1bb8bb3d60` succeeded through port 4174 with three 1200x1700 pages and 13 score systems (5+5+3); the maximum remaining notation overlap is 40.02%, below the 60% duplicate threshold. No Visual QA or subagents were used.
- Final verification: `npm run verify` passed typecheck, 297/297 tests, standalone-web build, and extension build; `git diff --check` and changed-file LSP diagnostics are clean.

# G054 Free Hosting Deployment Advice (2026-07-31)

## Plan

- [x] Map the current standalone web/backend runtime and deployment constraints.
- [x] Verify current free-tier hosting constraints from official provider documentation.
- [x] Record the recommended split deployment and practical next steps.

## Review

- Recommended split: deploy `dist-web` as a static site on Cloudflare Pages and run the Node/Hono media backend as a Docker service on Render for a hobby prototype or Cloud Run when jobs need a longer managed request window.
- Current backend blockers are `127.0.0.1` binding, required `yt-dlp`/`ffmpeg`/`ffprobe` executables, process-local job state, and ephemeral local result files. Separate hosting therefore needs a public backend URL plus frontend API-base/CORS configuration; horizontal scaling is not safe yet.
- Render Free is suitable only for testing because it sleeps after 15 minutes idle and loses local files on restart/redeploy. Cloud Run supports custom containers and up to 60-minute request timeouts, but its local filesystem is temporary and usage beyond its free tier can incur charges.
- True always-free VM option: Oracle Cloud Always Free, with more server administration and capacity/reclamation risk. No production deployment was performed in this advice-only task.

# G055 Single-server web/API deployment (2026-07-31)

## Plan

- [x] Preserve the API-only app boundary and define the production web/API composition.
- [x] Add a regression for serving `dist-web` and keeping `/api` behavior unchanged.
- [x] Connect production static serving and configurable host/web-root environment variables.
- [x] Add the single-container deployment files and concise deployment documentation.
- [x] Run focused and full verification plus a real local HTTP smoke check.

## Review

- Added `server/web-app.ts`, which preserves `createScoreJobApp()` as an API-only test/fixture boundary and conditionally serves the built `dist-web` directory from the same Hono app.
- Added `HOST` and `YT2SHEET_WEB_ROOT` configuration while keeping local defaults compatible with the existing `127.0.0.1:4174` API workflow.
- Added `Dockerfile` and `.dockerignore`; the image builds the web bundle, installs `yt-dlp`/`ffmpeg`/`ffprobe`, exposes port 8080, and mounts `.yt2sheet-data` as a volume for single-instance operation.
- Added `tests/server-web-app.test.ts`: 317/317 tests pass. `npm run verify` passes typecheck, tests, standalone web build, and extension build. Changed-file LSP diagnostics and `git diff --check` are clean.
- Live smoke check passed on port 4478: `/` HTTP 200 with HTML, generated asset HTTP 200, and `/api/health` returned `{"status":"ok"}`. Docker image build was not run because Docker Desktop's Linux engine was unavailable; Dockerfile LSP was unavailable and its install was declined, while manual escape-hatch scan passed.

# G056 Render deployment (2026-07-31)

## Plan

- [x] Connect to the user's authenticated Chrome Render dashboard.
- [x] Confirm the GitHub remote contains the current standalone Docker deployment code.
- [x] Create the Render Docker Web Service and configure the health check.
- [x] Verify the deployed URL and `/api/health`.

## Review

- The first Render deployment at `46cf9a2` reached the runtime but failed with `sh: 1: tsx: not found`.
- Root cause: `NODE_ENV=production` caused the runtime `npm ci` to omit `tsx` from `devDependencies`; `af06c5b` changed it to `npm ci --include=dev` and added a regression test.
- `npm run verify` passed after the fix: typecheck, 318 tests, standalone web build, and extension build.
- Render redeploy at `af06c5b` is live in Singapore on the Free plan at [https://yt2sheet.onrender.com](https://yt2sheet.onrender.com). Logs show `host: 0.0.0.0`, `port: 10000`, and `Your service is live`.
- Manual public checks passed: Chrome rendered the landing page; the JS asset returned HTTP 200 with 105787 bytes; `/api/health` returned HTTP 200 and `{\"status\":\"ok\"}`. Direct health navigation in Chrome was blocked by the local client, so the endpoint response was verified with curl.
- Free Render instances can sleep and have ephemeral local storage; generated files are not durable across restarts.

# G057 YouTube downloader runtime and anti-bot handling (2026-07-31)

## Plan

- [x] Reproduce the Render failure as downloader and Docker runtime regressions.
- [x] Enable yt-dlp EJS through the Node runtime and optional private cookies path.
- [x] Classify YouTube 429 bot challenges without blind retries.
- [x] Run focused tests, full verification, and a same-link local yt-dlp metadata smoke check.

## Review

- Docker now installs `yt-dlp[default]` and sets `YT_DLP_JS_RUNTIME=node`; server calls forward `--js-runtimes` and optional `--cookies` flags.
- `YT_DLP_COOKIES_PATH` supports a private Netscape-format cookie file; Render Docker secret files are available under `/etc/secrets/`.
- HTTP 429 or `Sign in to confirm you're not a bot` now becomes `YOUTUBE_ACCESS_BLOCKED` instead of generic `MEDIA_PROCESSING_FAILED`; HTTP 403 keeps the existing one-time player-JavaScript fallback.
- `npm run verify` passed typecheck, 320 tests, standalone web build, and extension build. `git diff --check` is clean.
- Local same-link metadata smoke with `yt-dlp --js-runtimes node` returned duration `242`; the Render service was not redeployed in this code-only request, and no cookies were added.
- The provided no-excuse audit could not run because the project TypeScript installation does not expose `typescript/unstable/async`; `tsc` typecheck passed.

# G058 Render stale-image diagnosis (2026-07-31)

## Plan

- [x] Capture the repeated production signature and compare local, remote, and deployed-source boundaries.
- [x] Prove the current source assembles the Node runtime flags and retain a focused regression test.
- [x] Verify the current Docker runtime contract and same-link local API path.
- [x] Reconcile the task record and remove all temporary debug artifacts.

## Review

- The repeated Render log is from the pre-fix image: `origin/main` and local `HEAD` are still `e6038c0`, while the yt-dlp runtime fix remains uncommitted in the working tree.
- Before the user-authorized commit/push, `origin/main` was still `e6038c0`; the source fix is now ready for Render to rebuild from the pushed commit.

# G059 Cross-platform installable migration feasibility (2026-07-31)

## Plan

- [x] Confirm the current web/API process boundary and native media-tool dependencies.
- [x] Compare a single auto-detect download link with platform-specific installer/update channels.
- [x] Decide whether the first migration should be a desktop wrapper, a local agent, or a full native client.

## Review

- The current standalone path is one Node/Hono process serving `dist-web` and `/api`, with an in-memory two-job queue and local result files; the processor requires `yt-dlp`, `ffmpeg`, and `ffprobe`.
- Recommended first migration: an Electron desktop wrapper that starts the same local API on loopback, loads the existing web UI, and bundles platform-specific media binaries. This avoids a full native rewrite and removes Render's shared outbound-IP dependency from the main processing path.
- A single download URL can detect OS in a landing page and redirect to Windows NSIS, macOS DMG/ZIP, or Linux AppImage artifacts. It cannot silently install an application; the user must still approve the download and installation. CPU architecture and macOS signing/notarization need explicit release handling.
- Tauri or a PWA is not the first choice: Tauri adds a Rust host plus sidecar packaging around the existing Node processor, while a PWA leaves media processing on the blocked server.
- No product source or deployment configuration changed for this feasibility review; only this task record was updated.

# G060 Local npm CLI migration direction (2026-07-31)

## Plan

- [x] Confirm the existing standalone processor can be invoked without the web UI.
- [x] Define the local command and authentication boundary.
- [x] Choose the package, first-run dependency, and output-file delivery strategy.

## Review

- The existing server pipeline already has a clear input (`videoId`, `videoUrl`) and a concrete PDF result path, so it can be exposed through a CLI adapter without preserving the Hono server or browser UI.
- Proposed user contract: `npx @yt2sheet/cli <YouTube URL>` for no-install use, or `npm install -g @yt2sheet/cli` followed by `yt2 <YouTube URL>` for repeat use. The final npm package name must be checked before publishing.
- The CLI runs the current media pipeline on the user's own machine and writes `yt2sheet-<videoId>.pdf` to the current directory by default, with `--output` for an explicit path. Render remains optional only for documentation and release-file hosting.
- On first run, the package must obtain or include the correct platform/architecture `yt-dlp`, `ffmpeg`, and `ffprobe` executables with pinned versions and integrity checks; `sharp` also needs target-platform support. Do not require users to manually configure system PATH for the default path.
- Authentication is local and opt-in: normal videos use the local network identity; a blocked video can accept an explicitly supplied user-owned cookie file or browser-cookie option, never a shared server credential.
- No product code or deployment configuration changed for this direction decision.

# G061 Local npm CLI migration implementation (2026-07-31)

## Plan

- [x] Add the `yt2` command parser with default output, explicit output, cookies, help, and validation paths.
- [x] Reuse `YouTubeScoreProcessor` directly through a temporary local job runner and copy the resulting PDF to the requested path.
- [x] Add npm `bin`, CLI build output, postinstall bootstrap, platform media binaries, and package documentation.
- [x] Run the complete test/build/package verification and record a fresh real-link PDF smoke result.

## Review

- Added `yt2` as the package bin and `npx yt2sheet <URL>` as the one-off path; output defaults to `yt2sheet-<videoId>.pdf` and supports `--output`/`--cookies`.
- The CLI reuses `YouTubeScoreProcessor` directly, isolates each job in a temporary data root, cleans it on exit, and copies only the generated PDF to the requested path.
- FFmpeg 6.1.1 and ffprobe platform packages are resolved locally; yt-dlp 2026.07.04 is downloaded to an OS/architecture-specific cache and SHA-256 verified. Environment overrides remain available.
- `npm run verify` passed typecheck, all 327 tests, CLI build, standalone web build, and extension build. `npm pack --dry-run` and an actual packed-package `yt2 --help` smoke passed. `git diff --check` passed.
- Real local smoke with `https://www.youtube.com/watch?v=1yCkz9VT3ZA` produced a 5-page, 2,153,690-byte PDF beginning with `%PDF-`; the final CLI run had no stderr or server JSON log leakage.

# G062 One-command standalone CLI distribution (2026-07-31)

## Plan

- [x] Add a standalone bundle containing the Node runtime, production dependencies, FFmpeg/ffprobe, and yt-dlp.
- [x] Add OS-aware PowerShell and shell bootstrap installers with checksum verification and per-user PATH registration.
- [x] Add a tag-driven GitHub Release workflow for Windows x64, macOS Intel/Apple Silicon, and Linux x64 archives.
- [x] Run bundle, installer-script, workflow, and full project verification.

## Review

- `node --check scripts/build-bundle.mjs`, PowerShell parsing, `sh -n scripts/install.sh`, and `git diff --check` passed.
- A Windows standalone bundle generated its own Node runtime and ran `yt2 --help`; the same bundle processed `1yCkz9VT3ZA` into a 5-page, 2,153,690-byte PDF beginning with `%PDF-`.
- A local fake Release server passed the PowerShell installer's archive download, SHA-256 verification, extraction, per-user install path, and PATH registration flow; the test restored the original user PATH.
- `npm run verify` passed all 327 tests, typecheck, CLI build, standalone web build, and extension build. `npm pack --dry-run` passed.
- The `cli-v0.2.0` tag triggered run `30627640364`; all four platform build jobs passed. Its Release job initially failed because `gh release create --generate-notes` had no checkout, so `4056709` added checkout and was pushed to `main`.
- The verified artifacts were published at [https://github.com/qkrwndnjs1075/yt2sheet/releases/tag/cli-v0.2.0](https://github.com/qkrwndnjs1075/yt2sheet/releases/tag/cli-v0.2.0) with Windows x64, macOS Intel, macOS Apple Silicon, Linux x64, and `checksums.txt`. The uploaded checksums passed `sha256sum --check` before publication.

# G063 Remove remote AI integration and simplify README (2026-07-31)

## Plan

- [x] Remove remote AI settings, calls, permissions, and UI paths so score processing is local-only.
- [x] Reduce `README.md` to the service description and standalone installation instructions.
- [x] Run typecheck, tests, builds, static reference checks, and diff validation.

## Review

- Removed the remote AI settings module, candidate judge files/tests, export-network validator, host permissions, runtime messages, and debug settings UI. Export validation now uses the local inspector only.
- `README.md` now contains only the service description, automatic installer commands for Windows/macOS/Linux, and the `yt2` usage command.
- `npm run verify` passed: typecheck, 308 tests, CLI build, standalone web build, and Chrome extension build. Live source/manifest/dist reference audit and `git diff --check` passed. Changed TypeScript files had no LSP diagnostics.
- The no-excuse audit script was attempted but could not resolve the project's TypeScript 7 `unstable` API; the regular TypeScript compiler and full verification passed.

# G064 Friendly CLI help command (2026-07-31)

## Plan

- [x] Make `yt2 help`, `yt2 --help`, and `yt2 -h` display the same readable help output without starting a processing job.
- [x] Keep direct URL execution and existing output/cookie options unchanged, while making no-argument invocation discoverable.
- [x] Add parser regression coverage, compiled CLI smoke coverage, and document the command in the CLI installation guide.
- [x] Run focused tests, CLI typecheck/build/package smoke, installer syntax checks, and diff validation.

## Review

- `parseCliArguments` now treats `help`, `-h`, `--help`, and no arguments as the help path; direct YouTube URL parsing remains covered.
- The compiled CLI and a generated Windows standalone launcher returned identical help for `help`, `--help`, `-h`, and no arguments without starting a processing job.
- Focused parser tests passed 4/4; CLI-only TypeScript checking, CLI/build script checks, POSIX and PowerShell installer syntax, `npm pack --dry-run`, and `git diff --check` passed.
- Full `npm run verify` remains blocked by unrelated concurrent installer-progress edits: `cli/media-tools.ts:32` references `onInstallProgress` outside the `resolveYtDlpPath` scope; those files were not modified for this task.
- The OMO no-excuse audit could not resolve the TypeScript module from the caller project, so that audit was not completed.

# G064 Install Progress and PowerShell CLI Handoff (2026-07-31)

## Plan

- [x] Add regression coverage for staged installer progress, quoted URL guidance, and first-run yt-dlp progress.
- [x] Show `### [n/total]` progress through the Windows and POSIX installers and make archive handoff faster where safe.
- [x] Stream yt-dlp download progress through the local CLI and npm postinstall path without allowing progress to move backward.
- [x] Make the Windows installer validate the launcher, register PATH clearly, and explain the parent-shell/new-terminal boundary.
- [x] Update README examples so PowerShell always receives YouTube URLs as one quoted argument.
- [x] Run targeted tests, typecheck, CLI build, installer syntax checks, bundle help smoke, and the exact quoted-URL CLI path.

## Review

- Root causes were separate: a child PowerShell process cannot update the caller's PATH, PowerShell parses an unquoted `&` before `yt2` receives the URL, and the first-run yt-dlp download had no progress callback.
- `scripts/install.ps1` and `scripts/install.sh` now report seven staged `### [n/7]` markers, use a same-volume move with a cross-volume copy fallback, validate the launcher, and print current-shell/new-terminal guidance. The PowerShell script is UTF-8 with BOM so Windows PowerShell 5.1 parses it when piped through `iex`.
- `ensureYtDlpExecutable` now reports monotonic checking, download, checksum, verification, and ready progress to both the CLI and `scripts/install-cli.mjs`.
- README examples use the direct current-shell PowerShell installer and explicitly require quoting the entire URL when it contains `&`.
- Focused tests passed 4/4, `npm run build:test`, typecheck, LSP diagnostics, CLI/web/extension builds, installer syntax checks, and `git diff --check` passed. A fake-release installer run emitted 1/7 through 7/7 and restored the original user PATH. The exact quoted URL produced a valid two-page `%PDF-` artifact; the forced bootstrap path emitted `###` progress.
- `npm run verify` was attempted after concurrent standalone-uninstall files appeared and is currently blocked by the unrelated untracked `tests/cli-uninstall.test.ts` fixture (`ENOENT` while creating `install/app`). The earlier full suite passed 310/310 before those files appeared; the concurrent uninstall files were left untouched. The OMO no-excuse audit also remains unavailable because its script requires a TypeScript 7 unstable API that this repository does not expose.

# G065 Standalone CLI uninstall command (2026-07-31)

## Plan

- [x] Add `yt2 uninstall` with standalone ownership detection and an npm removal handoff.
- [x] Remove only the owned standalone root, launcher link, PATH entry, and installer-added profile line.
- [x] Cover Unix cleanup, Windows deferred cleanup, parser behavior, README, and installer completion guidance.
- [x] Run focused tests, CLI/build checks, uninstall fixture smoke, and diff validation.

## Review

- `yt2 uninstall` now validates the standalone `VERSION` and directory contract before removing anything; npm-managed installs receive `npm uninstall -g yt2sheet` instead.
- Windows schedules an independent hidden cleanup process through `cmd.exe start`; it invokes a temporary PowerShell script after the bundled runtime exits, uses `rmdir` for the bundle tree, and changes the user PATH only when the owned bundle path is present.
- Parser and uninstall tests passed, the Windows deferred-cleanup fixture removed its temporary root, compiled/source help and npm handoff smokes passed, and `npm run verify` passed with 313 tests plus one symlink-permission skip.
- POSIX/PowerShell installer syntax, CLI build/package contents, and `git diff --check` passed. A rebuilt Windows standalone bundle printed help and removed its full temporary install root. The Unix symlink fixture is skipped on this Windows host because Developer Mode or `SeCreateSymbolicLinkPrivilege` is unavailable.

# G066 Publish CLI v0.2.1 (2026-07-31)

## Plan

- [x] Bump the npm package and lockfile to `0.2.1` without staging unrelated worktree changes.
- [x] Run full verification and confirm the release workflow inputs.
- [x] Commit and push `main`, then tag `cli-v0.2.1`.
- [x] Publish platform archives, checksums, and user-facing release notes.

## Review

- `npm run verify` passed for `yt2sheet@0.2.1`: 313 tests passed, one Windows symlink fixture was skipped for missing symlink privilege, and CLI/web/extension builds passed.
- Commit `86f47c3` (`chore(release): bump cli to 0.2.1`) is pushed to `main`; annotated tag `cli-v0.2.1` resolves to the same commit.
- Release workflow `30633734526` passed all four platform builds and published [cli-v0.2.1](https://github.com/qkrwndnjs1075/yt2sheet/releases/tag/cli-v0.2.1) with Windows x64, macOS Intel, macOS Apple Silicon, Linux x64, and `checksums.txt`.
- All four downloaded release archives matched the published SHA-256 checksums. Existing unrelated layout/AI worktree changes remained unstaged.

# G067 Fix raw PowerShell installer BOM entry point (2026-07-31)

## Plan

- [x] Reproduce the reported `irm ... | iex` failure against the published raw script and confirm its mechanism.
- [x] Add regressions for a leading BOM and the public `release-assets/` checksum path.
- [x] Remove the BOM, update installer defaults to `cli-v0.2.1`, and accept the published checksum path.
- [x] Run the same raw installer command against the public release in an isolated install root, then publish the public-script fixes.

## Review

- Root cause one: the UTF-8 BOM in `install.ps1` survives `irm` as `U+FEFF`; when piped to `iex`, it makes the initial `param` an unknown command while the non-terminating error still lets the installer continue.
- Root cause two: the release workflow writes `release-assets/<archive>` in `checksums.txt`, while both installers previously accepted only the archive basename.
- `e6f7937` makes the raw PowerShell entrypoint BOM-free and advances both installer defaults to `cli-v0.2.1`; `144f6cb` accepts the release checksum path on Windows and Unix.
- `npm run verify` passed with 313 tests and one Windows symlink-permission skip. The exact public `irm https://raw.githubusercontent.com/qkrwndnjs1075/yt2sheet/main/scripts/install.ps1 | iex` command completed all seven stages in a temporary root, installed `yt2sheet 0.2.1 windows-x64`, and returned the expected `yt2 help` heading. The temporary root was moved to the Windows Recycle Bin and the user PATH was restored.

# G068 Recheck public PowerShell installer scope (2026-08-01)

## Plan

- [x] Compare the local installer with the public raw payload and record the exact PowerShell/runtime context.
- [x] Execute the literal `irm ... | iex` command in isolated fresh PowerShell processes with and without the user profile.
- [x] Reproduce the related outer-script-block scope and distinguish it from the literal interactive command.
- [x] Restore PATH and temporary roots, update the correction-prevention lesson, and document residual user-terminal evidence needed.

## Review

- The public and local `scripts/install.ps1` payloads are both 6000 bytes with SHA-256 `5adccb23b35e685a352726a053a254dc664f2d14f47f92469aa335709687fa54`; the public payload is BOM-free and contains the current WebClient null guard.
- The literal command completed all seven stages with exit code 0 in a profile-loaded PowerShell and in the isolated direct path. No exact null-valued-method failure was reproduced in the shared account environment.
- Wrapping the same pipeline in `& { ... }` reproduced a separate `Attempted to divide by zero` failure at `Write-InstallStep`, caused by the function's `$script:` progress variables not being available in that evaluation scope. This is a residual hardening issue, not proof that the user's literal prompt command is currently failing.
- All four profile files for the shared account were absent, so a function/alias override in the user's already-open terminal remains the unresolved difference. No installer source or release was changed in this review; only this review record and the correction lesson were updated.

# G071 Publish PowerShell scope hardening (2026-08-01)

## Plan

- [x] Replace the PowerShell installer progress counter's script-scope dependency with scope-safe state.
- [x] Add a regression contract for direct and outer-script-block `irm | iex` evaluation.
- [x] Run focused tests, full applicable verification, and real Windows installer/uninstall smoke coverage.
- [x] Bump the CLI patch version, commit and push the complete requested change set, tag the release, and verify published assets/checksums.

## Review

- Confirmed and closed the deployment gap: public `main` previously served `$script:currentStep/$script:totalSteps`; it now serves the scope-safe explicit `$progressState` implementation.
- Red/green proof: the committed/public implementation fails inside an outer PowerShell script block with `Attempted to divide by zero`; the worktree implementation emits `### [1/7] ... (14%)` and reaches the deliberately closed download endpoint.
- Added a Windows spawned-process regression that evaluates the UTF-8 installer through `Invoke-Expression` inside an outer script block. Focused coverage passed 2/2; final `npm run verify` passed 314 tests with one Windows symlink-permission skip, then built the CLI, standalone web app, and extension.
- Pushed `4813ee1` (`fix(installer): preserve progress state under iex`) and `23793b6` (`chore(release): bump cli to 0.2.4`) to `main`. Annotated tag `cli-v0.2.4` targets `23793b6`; release workflow `30680106055` passed all four platform builds and published the GitHub Release.
- All four archive digests match the public `checksums.txt`. The literal public `irm https://raw.githubusercontent.com/qkrwndnjs1075/yt2sheet/main/scripts/install.ps1 | iex` flow completed stages 1/7 through 7/7, installed `yt2sheet 0.2.4 windows-x64`, returned `yt2 help`, then `yt2 uninstall` removed the isolated root and restored the user PATH.

# G072 Diagnose persistent user-session PowerShell null failure (2026-08-01)

## Plan

- [x] Compare the current public payload with the reported failure and document the missing exact user-session error record.
- [x] Reproduce the reported `InvokeMethodOnNull` signature with the stale pre-guard installer body and add a RED diagnostic regression.
- [x] Isolate raw installer execution, remove nullable pre-progress instance calls, expose the inner failure line, and add a versioned cache key.
- [x] Run focused and full verification before publishing the patch release.
- [x] Publish `cli-v0.2.5`, verify its assets and checksums, then prove the versioned public install/help/uninstall flow.

## Review

- The exact `$Error[0]` record from the user's already-open terminal was not available, so the precise null receiver in that session is not claimed. The same `InvokeMethodOnNull` signature is reproducible with the stale pre-guard installer body when `New-Object` yields null; that body's unguarded `Dispose()` masked the earlier download-client failure.
- The fresh public `cli-v0.2.4` payload does not reproduce the null failure. GitHub raw responses are cacheable, so the documented command now uses a `?v=0.2.5` cache key instead of relying on the unchanged raw URL.
- The installer body now runs in its own parameterized script block and its top-level catch prints the inner PowerShell position and stack before rethrowing. The architecture, base-URL trim, and temporary-name setup no longer use nullable instance-method calls before progress begins.
- Failing-first coverage previously saw only the outer `Invoke-Expression` position; it now identifies `$client.DownloadFile(...)` and `Download-InstallFile` when the deliberate closed-endpoint failure occurs. Focused installer tests passed 2/2, and `npm run verify` exited 0 with 314 passing tests, one Windows symlink-permission skip, plus successful CLI, standalone web, and extension builds.
- Pushed `ad692d6` (`fix(installer): harden raw PowerShell bootstrap`) to `main` and tagged `cli-v0.2.5`. Release workflow `30681842359` completed all four platform builds and published the GitHub Release; every archive digest matches the public `checksums.txt`.
- A profile-loaded Windows PowerShell process ran `irm 'https://raw.githubusercontent.com/qkrwndnjs1075/yt2sheet/main/scripts/install.ps1?v=0.2.5' | iex` through stages 1/7 to 7/7, installed `yt2sheet 0.2.5 windows-x64`, returned the expected `yt2 help`, and removed the isolated install root through `yt2 uninstall` while restoring the user PATH.

# G073 Stable latest installer command (2026-08-01)

## Plan

- [x] Add a failing contract for an unversioned public command and dynamic latest-release downloads.
- [x] Make Windows and Unix installers use GitHub's latest-release redirect by default while preserving explicit tag and base-URL overrides.
- [x] Restore the unversioned README command and run focused plus full verification.
- [x] Publish the patch release, verify checksums, and prove the literal public install/help/uninstall flow.

## Review

- Root cause: the user's last command omitted `| iex`, so `irm` correctly printed the downloaded source instead of executing it. Separately, the installer and README pinned `cli-v0.2.5`, which contradicted the requested stable "install latest" contract.
- Both installers now use `https://github.com/<repository>/releases/latest/download` by default. `YT2SHEET_RELEASE_BASE_URL` remains the highest-priority override, and an explicit `ReleaseTag`/`YT2SHEET_RELEASE_TAG` still selects a reproducible tagged release.
- RED/GREEN evidence: the new unversioned/latest contract failed against the pinned implementation with no `releases/latest/download` path, then both focused installer tests passed after the change. `npm run verify` passed 314 tests with one Windows symlink-permission skip and built the CLI, standalone web app, and extension.
- Pushed `140414a` (`fix(installer): resolve latest release dynamically`) and tagged `cli-v0.2.6`. Release workflow `30682385003` completed every platform build and published the release; all four archive digests match the public latest `checksums.txt`.
- A profile-loaded Windows PowerShell process ran the literal unversioned `irm https://raw.githubusercontent.com/qkrwndnjs1075/yt2sheet/main/scripts/install.ps1 | iex`, completed stages 1/7 through 7/7, selected `yt2sheet 0.2.6 windows-x64`, returned `yt2 help`, and removed the isolated root through `yt2 uninstall` while restoring the user PATH.

# G074 Empty Windows architecture fallback (2026-08-01)

## Plan

- [x] Reproduce an empty `RuntimeInformation.OSArchitecture` with a Windows PowerShell regression.
- [x] Resolve native architecture from WOW64/process environment values before the runtime fallback.
- [x] Publish `cli-v0.2.7`, verify checksums, and prove the unchanged public command installs successfully.

## Review

- Root cause: the installer relied only on `RuntimeInformation.OSArchitecture`; the reported Windows PowerShell host converted it to an empty string and rejected the machine before download. The installer now resolves `PROCESSOR_ARCHITEW6432`, then `PROCESSOR_ARCHITECTURE`, then the runtime value, mapping both `AMD64` and `X64` to `windows-x64` while leaving unsupported architectures rejected.
- RED/GREEN evidence: forcing the runtime expression to `""` produced no installer progress before the fix; after the native-environment fallback, all three focused raw-installer tests passed and the forced-empty case reached stage 1/7. Full `npm run verify` passed 315 of 316 tests with one Windows symlink-permission skip and built the CLI, standalone web app, and extension.
- Pushed `5a4ecee` (`fix(installer): detect Windows architecture reliably`) and tagged `cli-v0.2.7`. Release workflow `30682830041` completed all four platform builds and the release job successfully; direct downloads of all four public archives matched the published latest `checksums.txt`.
- A profile-loaded Windows PowerShell process ran the literal unversioned `irm https://raw.githubusercontent.com/qkrwndnjs1075/yt2sheet/main/scripts/install.ps1 | iex`, completed stages 1/7 through 7/7, installed `yt2sheet 0.2.7 windows-x64`, returned `yt2 help`, and removed the isolated root through `yt2 uninstall` while restoring the user PATH.
