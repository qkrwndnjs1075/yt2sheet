# Lessons

- A score artifact cleaner must classify a whole nearby text group before erasing top-right components. Per-glyph edge thresholds can keep `Frédéric Chop` while silently deleting the trailing `in`; compare the normalized export to the exact source frame at text boundaries, not just staff completeness.

- Deduplication success is not score-quality success. When two captures share notation but one contains additional legitimate title, tempo, staff, or measure context, do not keep the earliest frame blindly; compare completeness inside the score region and retain the best representative before composing the PDF.

- When a user says a regenerated PDF still repeats a score sheet, inspect the exact new artifact and retain the accepted-frame quality report. A title appearing between frames can change outer crop height and a crop-derived staff-gap heuristic even when the staff notation is identical; compare identity and geometry within the detected staff rows, not the full frame bounds.

- When a user corrects a diagnosis with an exact CLI transcript, re-trace that exact command before relying on a similarly named web/backend path. For default output behavior, test two identical CLI invocations and verify both the reported paths and on-disk file identities; do not infer that UUID-backed internal artifacts prevent a deterministic user-facing destination from being overwritten.

- Do not report development servers as still running based only on an earlier listener check. Before the final handoff, launch them in a detached persistent process and perform fresh HTTP checks after the launch; an attached tool session may terminate when the turn ends.
- When a browser extension captures a whole tab but the user selects ROI over the HTML video element, always preserve the source video frame size and convert through `videoRect` plus viewport scale at crop time. Letterbox correction alone is not enough.
- When a Chrome extension uses `tabCapture.getMediaStreamId()` before an interactive ROI step, verify the later offscreen `getUserMedia()` redemption path too. If first redemption can fail after UI delay, keep startup failure single-sourced, retry with a fresh stream id once, and format DOMException-like causes before logging.
- Do not have untrusted content scripts read `chrome.storage.session` directly for extension-owned state. Use a background/runtime message bridge unless `storage.session.setAccessLevel()` is an intentional product decision.
- When a workflow requires a user answer and the structured question UI fails, times out, or is not visible, stop the workflow and ask the same question directly in chat. Do not infer an answer, continue to recommendations, or treat a pending OMX question record as user consent.
- When the user explicitly says to start working directly, do not keep narrating or enforcing a named execution workflow. Use the approved plan/spec as guidance, implement the change, and keep process chatter minimal.
- In requirements interviews, do not jump from a product-level boundary into a low-level selection algorithm before the user has agreed that the subdecision matters. If challenged, retract the detail and return to the main outcome/scope question.
- When a completion hook demands evidence under a specific directory, record a fresh direct verification artifact in that exact directory before claiming done, even if task-specific evidence already exists elsewhere.
- Do not present a DoneClaim when any user-required verification command exits nonzero, even if equivalent compiled or focused commands pass. Record the failing invocation as blocked, name the exact out-of-scope fix if scope prevents repair, and avoid completion wording.
- When a stop hook challenges a completion claim, run a fresh direct verification pass and write the transcript under `.omo/evidence/` before restating completion. Prior task-local evidence is not enough for the hook.
- Completion claims after subagent stop hooks must cite a fresh `.omo/evidence/` transcript from commands run after the hook, including binary pass/fail judgment and artifact non-empty checks.
- When the user reserves visual QA for themselves, do not run screenshot/browser visual review or spawn its required reviewer agents. Finish automated and non-visual flow verification, then leave the visual gate explicitly deferred to the user.
- When the user says not to run QA during a UI iteration, keep browser, screenshot, and manual interaction QA out of scope. Automated typecheck, regression tests, and build checks may still verify code integrity without claiming visual approval.
- When optimizing extension message payloads by sending large data only once, require an explicit receiver acknowledgement after durable persistence before marking that payload delivered, and serialize shutdown behind in-flight frame writes. A resolved fire-and-forget `runtime.sendMessage` is not proof that async background work finished.
- When splitting large fields out of browser session state, treat the compact state as an internal persistence format. Remove every direct consumer of that state and route reads through one hydration boundary; a successful metadata-only read is more dangerous than a thrown error because it silently bypasses the fallback that restores required data.
- When removing transient overlays from captured notation, never synthesize hidden music from a single frame. Retain several same-cluster frames with their real per-frame quality, modify a pixel only on strict paper-background consensus, preserve the stored originals, and reject persistent filled overlays that have no clean temporal evidence.
- Do not treat score-system height as a completeness invariant. YouTube creators legitimately publish compact single-staff or TAB strips alongside taller piano systems; use fixed-ROI width and actual notation/overlay evidence instead of a session-median height cutoff.
- A crop detector is not verified merely because a simplified solid-band fixture passes. Reproduce title glyph holes and assert the final export derivative's dimensions/data, because real overlay text can break a per-row density run even while validation still reports success.
- When an ROI contains YouTube page pixels outside the HTML video element, do not diagnose it as contamination inside the exported score. Verify the live DOM-to-tab-capture coordinate mapping and enforce the video element as a hard bitmap boundary before downstream cleanup.
- Do not paginate variable-height score images by a fixed item count. Scale each image to the printable width, account for gaps, and pack against the actual remaining page height so compact scores do not leave avoidable blank pages.
- When the desired PDF resembles a printed score sheet, greedy top-packing can still make the last page look unfinished. Preserve score aspect ratios and pagination, then distribute each page's remaining printable height between its score systems.
- Filling every page by distributing all remaining height conflicts with globally consistent sheet spacing. When constant gaps matter, keep the gap fixed and handle leftover height through page balancing or outer whitespace instead of inflating each page's inter-system gap independently.
- When removing content below the last detected staff, first verify that the nuisance itself was not promoted to a staff candidate. A dense full-width component touching the frame edge must constrain candidate selection before the crop's top and bottom staffs are chosen.
- A white score background requirement does not mean deleting every long dark run: staff lines and musical markings are legitimate. Classify removable black bands by border adjacency, thickness, near-full-width continuity, and lack of surrounding notation, then lock both removal and preservation with pixel-level tests.
- Do not equate a connected API key with an AI-backed review. Verify the stored `enabled` flag, host permission, actual HTTP/model response, confidence threshold, and fallback reason before explaining why the UI reports a local validator.
- When the user replaces an extension-first direction with a standalone-web direction, discard the popup architecture instead of carrying it forward implicitly. Preserve the extension as a regression boundary, create a separate web build, and make the browser depend on an honest backend job contract because normal pages cannot use `chrome.tabCapture` or offscreen extension processing.
- For a link-only end-to-end migration, do not describe a frontend and mocked job contract as the implemented product. Separate the UI foundation from the production media pipeline, and require real downloader, processor, API, and downloadable-artifact evidence before calling the link-to-result flow complete.
- A successful link-to-PDF smoke test is not evidence of score recall, crop purity, or readable resolution. For media extraction, verify sampling density against short-lived states, keep analysis resolution separate from export resolution, and measure accepted crop boundaries against non-score content before calling output quality complete.
- Removing a dark piano boundary is not enough to normalize score crops. White-background signatures and other disconnected text can survive paper-based expansion, while symmetric staff margins can simultaneously retain bottom noise and clip top musical context; verify staff-relative top/bottom ink extents and normalize internal whitespace before page layout.
- Do not claim a media-output defect is fixed from synthetic crop tests and score counts alone. Re-open the exact downloaded PDF, measure every embedded score region for edge-touching content and background chroma/luminance, and compare a fresh same-link artifact before reporting completion.
- A clean white PDF can still be wrong when score identity is computed from variable outer whitespace. For every reported media PDF, inspect sequential accepted states for staff-aligned duplicates, reject crop boundaries that stop on dense notation, and separately measure non-notation photographic components before claiming purity.
- Do not validate a backend fix only on a temporary server while leaving the user-facing server on an older non-watch process. Before handing off, identify the listener PID and launch command, restart or prove hot reload, and run the exact request against the port the frontend actually uses.
- When the active product request explicitly concerns the standalone frontend and backend, do not expand "all features" to dormant or separately shipped extension surfaces merely because they coexist in the repository. Confirm scope from the current product context, and keep extension code as an untouched regression boundary unless the user names it.
- A standalone PDF can have pure-white paper and still retain unrelated neutral-black watermark text because photo cleanup commonly gates on chroma. Inspect the actual rendered page, distinguish instrument/chord/tempo labels from detached footer signatures, and remove only ink separated below the last staff context rather than tightening the score crop or copying extension-only cleanup assumptions.
- A source-edge artifact can collapse into a short gray antialiased fragment after PDF scaling even when a synthetic full-height edge test passes. Re-render the real PDF, inspect blank outer margins at original resolution, and classify narrow boundary-connected components rather than relying only on per-column height coverage.
- When a user identifies a numbered missing score in a supplied PDF, treat the artifact's sequential notation order as the source of truth. Do not dismiss the report from server score counts or hash-cluster telemetry; inspect the exact PDF and map the claimed position to source-frame intervals before deciding there is no defect.
- When a user reports repeated score sheets, do not raise a whole-image hash threshold alone. Confirm the actual accepted-frame sequence, then combine a staff-line-suppressed notation-overlap signal with stable staff geometry so playback overlays collapse without merging distinct score systems that merely share musical shapes or use different staff spacing.
- When a YouTube job reports `MEDIA_PROCESSING_FAILED`, inspect the underlying media-stage error before changing score detection. For a confirmed HTTP 403, retry one bounded alternate player path with a clean partial-download restart; do not turn arbitrary downloader failures into blind retries.
- When a production log still contains the exact pre-fix signature, verify the deployed commit against `origin/main` before treating source changes as live. An uncommitted working-tree fix cannot affect Render; record deployment state separately from code/test state.
# 2026-07-24 - Keep PDF output singular unless formats are explicitly requested

- A research-backed optional format is not automatically a product requirement. Do not surface A4/Letter/legacy choices unless the user explicitly asks for selectable formats.
- When the user says "전처럼 PDF만", restore the full contract boundary, not only the visible control: UI, request schema, domain type, renderer, fixtures, tests, and design documentation should all describe one output.
- Preserve the prior standalone geometry (`1200x1700`) and keep the separately shipped extension behavior unchanged.

# 2026-07-31 - Use the user's requested Chrome surface for deployment

- When the user explicitly asks for Chrome control, use the connected user Chrome session rather than a separate browser automation session. Keep authentication, OTP, and provider permission approvals with the user.

# 2026-07-31 - Keep YouTube authentication scoped to the processing user

- A Render `YT_DLP_COOKIES_PATH` secret is one server-wide account credential, not per-user authentication. For a multi-user product, prefer local processing or an explicit user-scoped authentication design; never treat a shared cookie as the public-service auth model.

# 2026-07-31 - Prefer a local CLI when the requested product needs no GUI

- If the user wants cross-platform local execution and does not need an interactive UI, expose the existing processing engine through an npm CLI before proposing a desktop wrapper. Keep the server UI out of the critical path and make user-owned authentication local and opt-in.

# 2026-07-31 - Separate developer npm distribution from general-user installation

- `npm`/`npx` still require Node.js, so they are a developer distribution path rather than a complete general-user installation experience. Keep the npm CLI, but add signed OS-specific installers or standalone executables for users who should not install Node manually.

# 2026-07-31 - Use one download link as the general-user installer entrypoint

- A single download URL can detect OS and architecture and route to the matching installer, but browsers and operating systems still require the user to download, launch, and approve installation. Describe this as one-click installation, not silent installation.

# 2026-07-31 - Use a command bootstrapper when the user wants OMO-style installation

- If the desired experience is one pasted command rather than npm, host signed OS-aware installer scripts that download prebuilt `yt2` artifacts and register the command; the command must bundle its own runtime and must not require Node.js first.

# 2026-07-31 - Remove dormant integrations from a local-only product path

- A disabled feature flag does not make an integration absent. When the product is explicitly local-only, remove its settings, network calls, permissions, runtime messages, debug controls, and tests, then verify the remaining source has no live references.

# 2026-07-31 - Keep a user-facing README limited to the requested path

- When the user asks for only service identity and installation, omit implementation details, test commands, developer package instructions, troubleshooting, and auxiliary CLI help from the README.

- When the user narrows that request to installation only, remove the service description and post-install usage as well.

- When the user says the README is too brief, restore a plain-language service description and first-use example, while keeping developer and test instructions out.

# 2026-07-31 - Keep raw PowerShell `irm | iex` installers BOM-free

- A UTF-8 BOM is consumed as file-encoding metadata only when PowerShell opens a file. In a raw HTTP string piped to `Invoke-Expression`, it becomes a leading `U+FEFF` character, changes `param` into an unknown command, and can still allow the remaining installer to continue. Keep the public pipe target BOM-free, regression-test its first code point, and keep all OS installers pointed at the latest published tag.

# 2026-07-31 - Avoid `Invoke-WebRequest` for large GitHub Release assets in PowerShell 5.1

- A successful first progress line does not prove the installer downloader works: PowerShell 5.1 can terminate mid-transfer and leave a partial archive. Use a .NET `WebClient` transfer for the standalone archive, keep checksum verification, and prove the raw `irm | iex` path completes all stages against the published asset.

# 2026-07-31 - Release every distribution-facing push

- When a pushed change affects an installer, packaged CLI, or release artifact, create the matching patch release in the same delivery flow: version and lockfile, installer default tags, commit, push, annotated tag, GitHub Release workflow, artifact checksums, and public installation verification.

# 2026-08-01 - Verify raw installers in the user's exact PowerShell scope

- A helper script or `-NoProfile` success is not sufficient evidence for a pasted `irm | iex` installer. Re-run the literal command in a profile-loaded PowerShell, capture the public payload identity and first failing inner line, and distinguish outer script-block scope failures from the interactive user path before declaring the installer fixed.
- A successful fresh-process public installer run does not close a failure that still reproduces in the user's already-open PowerShell session. Capture that session's full `$Error[0]` record and command-resolution state before publishing another fix; do not substitute a nearby scope defect for the reported `InvokeMethodOnNull` mechanism.

# 2026-08-01 - Keep public bootstrap commands stable

- Do not expose a cache-busting release version in the user-facing raw installer URL when the product contract is "install latest." Keep the pasted command stable, resolve `releases/latest/download` inside the bootstrap, and preserve an explicit release-tag override only for diagnostics and reproducible installs.
- When explaining a PowerShell pipeline, visually verify the complete copied command. `irm <url>` only returns the payload; execution requires the trailing `| iex`.

# 2026-08-01 - Do not trust one Windows architecture API

- A local PowerShell 5.1 success does not prove `RuntimeInformation.OSArchitecture` is populated in every Windows host. For bootstrap compatibility, prefer the native WOW64/process architecture environment values, keep the runtime API as a fallback, and regression-test the exact empty-runtime case before releasing.

# 2026-08-01 - Test generated Windows launcher argument boundaries

- A quoted URL can still be split before a batch launcher receives it because PowerShell invokes `.cmd` through `cmd.exe`. Test the generated Windows launcher at both `cmd.exe` and PowerShell boundaries; use a native `.ps1` shim for PowerShell and forward each shifted batch argument inside explicit quotes. Keep the default output directory contract in the parser test and help text.

# 2026-08-01 - Confirm the requested surface before routing frontend work

- A repository can contain a web build while the requested feature targets the CLI. Confirm the user's product surface before loading frontend/UI skills; when the user says QA will be handled manually, do not run visual QA or browser screenshot reviews.

# 2026-08-01 - Regress media deduplication against the reported artifact shape

- Do not treat a passing synthetic full-height opaque tracker fixture as proof for a live score-video duplicate report. First inspect the supplied artifact and make the regression fixture match the real marker/overlay geometry; otherwise a released mask can be present yet never execute for the production signal.
