# Review Workspace Design System Contract

## 1. Atmosphere

The review workspace is a restrained Chrome-extension utility UI. It should feel operational, compact, and trustworthy: a fixed review surface over the current YouTube page that helps users scan captured score images, confirm inclusion, correct order, and export.

Use the existing `score-export-panel` BEM family as the contract root. New occurrence-aware UI should extend that family with descriptive element names instead of introducing a new visual language. The panel is not a landing page, dashboard, or brand moment. It should avoid decorative illustration, gradients, marketing copy, and oversized type.

The preferred density is high enough for repeated review work: thumbnail, identity, timing, duplicate or validation state, and controls should remain visible in one row where practical. Empty, loading, validation, and failure states should use direct status text in the same panel surface.

## 2. Color

Current CSS-derived tokens:

- `--review-bg`: `#ffffff`, used for the Export Panel and included Review Row surfaces.
- `--review-muted-bg`: `#f9fafb`, used for empty states and excluded rows.
- `--review-control-bg`: `#f3f4f6`, used for secondary Action Buttons.
- `--review-ink`: `#111827`, used for primary text and thumbnail backing.
- `--review-muted-ink`: `#4b5563`, used for meta, close control, and Status Text.
- `--review-disabled-ink`: `#9ca3af`, used for disabled Reorder Controls.
- `--review-success`: `#166534`, used for primary export action and clear validation/duplicate states.
- `--review-warning`: `#b45309`, used for duplicate and validation attention states.
- `--review-overlay-accent`: `#22c55e`, retained for the ROI selection rectangle only.
- `--review-border`: `rgba(17, 24, 39, 0.14)`, default panel and row border.
- `--review-border-strong`: `rgba(17, 24, 39, 0.18)`, compact control border.
- `--review-shadow`: `0 18px 50px rgba(15, 23, 42, 0.22)`, panel elevation.

Use semantic color sparingly. Green means ready, included, or clear. Amber means attention is required but not necessarily a blocking error. Muted gray means secondary information, disabled controls, or excluded material. Do not introduce a broad palette for occurrence work.

## 3. Typography

Current CSS-derived type contract:

- Font stack: `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.
- Base panel text: `13px/1.45`, color `#111827`.
- Export Panel title: `700 15px/1.25`.
- Action Buttons: `600 13px/1.2`.
- Reorder Controls: `600 12px/1`.
- Close control: `12px/1`.
- Review Row strong label: `13px`.

Text in dense components should truncate with `overflow: hidden`, `text-overflow: ellipsis`, and `white-space: nowrap` where row height must remain stable. Status Text may wrap with `overflow-wrap: anywhere` because it can contain extension, validation, or export errors.

Korean UI labels from the existing extension may remain Korean. New labels should be short command or state text, not instructional paragraphs.

## 4. Spacing

Current CSS-derived spacing and layout tokens:

- Panel inset desktop: `right: 24px`, `bottom: 24px`.
- Panel inset narrow viewport: `left: 12px`, `right: 12px`, `bottom: 12px`.
- Panel width: `760px`, capped by `max-width: calc(100vw - 32px)`.
- Panel radius: `12px`.
- Header padding: `14px 16px 12px`.
- Status bar padding: `8px 16px`.
- Scroll body padding: `12px 16px 16px`.
- Footer padding: `12px 16px`.
- Header gap: `12px`.
- Review list gap: `8px`.
- The panel body owns vertical scrolling; nested review and preview regions do not create competing scroll areas.
- Review Row gap: `12px`.
- Review Row padding: `10px`.
- Review Row min height: `112px`.
- Thumbnail size desktop: `160px x 96px`.
- Thumbnail size narrow viewport: `96px x 64px`.
- Reorder Controls gap: `4px`.
- Action Buttons grid gap: `8px`.
- Action Buttons min height: `38px`.

Use stable grid tracks for dense controls. Existing Review Row layout is `auto 72px minmax(0, 1fr) auto`; narrow viewport layout collapses to `auto 64px minmax(0, 1fr)` and moves reorder controls across columns `2 / 4`.

## 5. Components

Export Panel: Use `.score-export-panel` as a fixed 760px overlay shell with a white surface, 12px radius, `z-index: 2147483646`, and the existing shadow. The shell has four regions: header, status bar, scroll body, and footer. `.score-export-panel__body` owns vertical scrolling, while `.score-export-panel__header`, `.score-export-panel__statusbar`, and `.score-export-panel__footer` remain visible. Cap the shell height to the viewport so the panel never renders partly off-screen. Header uses `.score-export-panel__header`, `.score-export-panel__title`, `.score-export-panel__meta`, and `.score-export-panel__close`.

Review Row: Use `.score-export-panel__row` for each scannable item. The included state stays white. The excluded state uses `.score-export-panel__row--excluded`, muted background, and reduced opacity. Row contents should preserve the existing order: include/exclude input, preview image, details, then compact controls.

Selected Score: Represent the focused item as `.score-export-panel__selected-score`. The focused score image owns the full component width and may use up to 320px of height before the metadata row. Make the image a visible zoom action with a short `크게 보기` affordance. Show a user-facing score number, `m:ss` timing, inclusion state, repeat count, and validation state. Keep internal cluster and occurrence ids in the element tooltip instead of the visible scan path.

Occurrence List: Use `.score-export-panel__occurrence-list` as a dense list inside the review panel. Occurrence items should follow Review Row rhythm, support included and excluded states, and keep timing or occurrence metadata in muted text. Reuse `.score-export-panel__duplicate` and `.score-export-panel__duplicate--clear` semantics for repeat counts or clear states.

Review Summary: Use `.score-export-panel__summary` directly below the header when the review flow needs at-a-glance counts. It should be a compact strip of stable cells for total, included, excluded, attention, and page count. Cells use the existing muted background, border token, 6px radius, tabular numerals, and only the existing green/amber semantic colors for ready or attention states.

Comparison Strip: Use `.score-export-panel__comparison-strip` for adjacent or repeated occurrence context. It should be a compact horizontal or wrapping strip, not a decorative carousel. Use the same thumbnail background `#111827`, 6px image radius, and default border token.

Include/Exclude Controls: Use the existing checkbox pattern from `.score-export-panel__row input`: 18px square, zero margin, command label supplied by accessible name. Validation-excluded scores may disable the control.

Reorder Controls: Use `.score-export-panel__order` and its button style. Keep controls compact, grid-based, and text or icon-command driven. Disabled states use `#9ca3af` and `cursor: not-allowed`.

Preview Panel: Use `.score-export-panel__preview-panel` for generated export pages. Render every page at the available panel width without the previous 260px height cap, label each page position, and make each page a zoom action. The panel body scrolls through long previews without hiding the status bar or footer actions.

Image Viewer: Use one reusable `.score-image-viewer` modal for selected scores, occurrence thumbnails, and generated preview pages. It covers the viewport above the review panel, uses a dark neutral stage, and exposes close, zoom out, zoom percentage, zoom in, and width-fit controls. Open at 100% width, allow 50–300% zoom in 25% increments, and keep the enlarged image inside a two-axis scroll stage. `Escape` closes; `+`, `-`, and `0` control zoom; backdrop click closes; opening focus moves to the close button and closing restores the prior focus. Mark it `role="dialog"` and `aria-modal="true"`.

Status Bar: Use `.score-export-panel__statusbar` for loading and result feedback. `.score-export-panel__spinner` appears only while validation, preview generation, or export is active. `.score-export-panel__status` is a polite live region for loading, validation, export, empty, and failure messages. Keep muted text and wrapping, and describe the current operation or blocker directly.

Action Buttons: Keep `.score-export-panel__actions` inside `.score-export-panel__footer` so Preview, PDF, and PNG actions remain available while the body scrolls. Use `.score-export-panel__button` and `.score-export-panel__button--primary`; PDF is the green primary action. Secondary actions use the gray control background. Disabled export actions keep the existing progress cursor and `opacity: 0.64`.

Export Action Flow: Preview and explicit approval are required before saving. Generating a preview invalidates any prior approval; changing inclusion or order also invalidates the preview and approval. PDF and PNG actions stay disabled until the user marks the current preview as reviewed. Final export consumes the exact approved preview page images instead of re-running validation or page composition, so the downloaded file cannot differ from what the user approved.

Preview Approval: Place a compact approval checkbox inside the Preview Panel after successful page generation. Its label should state that every preview page has been checked. Keep it disabled or absent when there is no current preview. Validation labels must name the actual decision source (`AI` or `로컬`) and must not imply AI review when the local fallback made the decision.

Structural Completeness: Before AI or pixel inspection, compare selected score image geometry within the capture session. With at least three selected images, reject an image whose width or height is below 75% of the session median as an incomplete geometry outlier. This check protects against truncated export fragments while leaving single-image and genuinely mixed-format reviews to the preview approval step.

## 6. Motion

Keep motion minimal. The existing UI has no animation contract, so occurrence review additions should not introduce animated entrances, bouncy feedback, or background motion.

Allowed interaction feedback is stateful and direct: checkbox changes update the row state, disabled controls visibly disable, order controls move rows immediately, validation updates duplicate or validation labels, and Status Text changes in place. Any future transition should be short, functional, and optional; no workflow should depend on animation to communicate state.

## 7. Depth

Depth is limited to the fixed Export Panel shadow and thin borders on surfaces and controls. The current elevation contract is:

- Export Panel: `0 18px 50px rgba(15, 23, 42, 0.22)`.
- Panel, Review Row, empty state, thumbnail, and Action Buttons: `1px` border using the review border tokens.
- Radius: `8px` for panel, rows, and empty state; `6px` for thumbnails and compact controls.

Do not stack cards inside cards. Occurrence List, Comparison Strip, Selected Score, and Preview Panel should read as regions within the one extension panel surface, using spacing, borders, and typography rather than additional heavy shadows.

## 8. Standalone Link Workspace

### Brief and boundary

The standalone web surface replaces extension setup with one primary journey: paste a YouTube link, start a score job, follow its progress, and download the completed score. It is a real web page, not an extension popup or a marketing landing page. The browser owns input, progress, recovery, and result presentation. A backend job API owns video retrieval and score generation; the page must never fabricate a completed result when that API is absent or fails.

Primary users are musicians who know the video they want but should not need to understand tab capture, ROI selection, browser permissions, or frame processing. The main Korean task language is direct and calm. Supporting copy explains only what is necessary at the current step.

### Standalone tokens

The page extends the existing neutral, operational system with a warm paper workspace:

- `--web-canvas`: `#f4f3ed`, the full viewport background.
- `--web-surface`: `#fffef9`, the primary paper surface.
- `--web-surface-muted`: `#ebe9e0`, supporting process and note surfaces.
- `--web-ink`: `#172019`, primary text and form labels.
- `--web-on-ink`: `#f7f8f4`, text on the darkest operational surface.
- `--web-muted-ink`: `#596159`, supporting text.
- `--web-border`: `#d7d6ce`, default separators and controls.
- `--web-border-strong`: `#a9afa8`, focused structural borders.
- `--web-primary`: `#1f6f4a`, primary action and completed state.
- `--web-primary-hover`: `#185c3d`, active primary action.
- `--web-primary-soft`: `#e2efe7`, progress and success backing.
- `--web-error`: `#a33a32`, invalid input and failed jobs.
- `--web-error-soft`: `#f8e8e5`, recoverable error backing.
- `--web-shadow`: `0 24px 70px rgba(23, 32, 25, 0.12)`, used once on the main workspace.
- `--web-radius-sm`: `8px`; `--web-radius-md`: `14px`; `--web-radius-lg`: `24px`.
- `--web-space-1` through `--web-space-7`: `4px`, `8px`, `12px`, `16px`, `24px`, `32px`, `48px`.
- Typography tokens: `--web-type-micro`, `--web-type-meta`, `--web-type-note`, `--web-type-control`, `--web-type-body`, `--web-type-lead`, `--web-type-status-title`, and responsive hero/lead tokens define every shipped text size.
- Geometry tokens: named content/form/copy measures, control and header/footer heights, workspace/panel heights, intro padding, notation offsets, and progress dimensions define repeated component structure.

Typography uses `Pretendard`, `Inter`, `system-ui`, `-apple-system`, `BlinkMacSystemFont`, and `"Segoe UI"`, with system fallbacks when local webfonts are unavailable. The display heading is `clamp(36px, 5.5vw, 72px)` at `0.98` line height and `-0.045em` tracking. Body copy is `16px/1.65`; labels and controls are `14px/1.4`; compact status metadata is `12px/1.45`. Korean phrases should wrap by semantic block where possible; never force one-character final lines.

### Layout and components

Standalone job controls produce one PDF using the established 1200 x 1700 score-sheet layout. The page does not expose paper-format choices and the POST body contains only the canonical video identity. The active cancel control follows submit in keyboard order, remains hidden until a queued or running job ID is known, and uses the existing control-height token, which exceeds the 44px touch-target minimum.

The job status region is exactly `role="status"`, `aria-live="polite"`, and `aria-atomic="true"`. It renders ready, submitting, queued, running, succeeded, failed, cancelled, and interrupted-or-expired states through real DOM text-node replacement. A success link is accepted only when its relative path is exactly bound to the returned job ID.

The page has one header and one workspace. The header contains the `yt2sheet` wordmark and the quiet descriptor `Link to score`. The workspace is a two-column grid at `960px` and above: task copy and URL form on the left, live process/result surface on the right. Below `960px`, it becomes a single column; below `560px`, page and surface padding reduce while controls retain at least `44px` height. The content width is capped at `1180px`; the form reading measure is capped at `620px`.

Link Form: A persistent `<label>` names the YouTube URL field. URL input and submit action share a horizontal row above `640px` and stack below it. Input, button, and visible focus ring use the standalone tokens. Placeholder text is an example, never the only label. The primary button text is always an action (`악보 만들기`, `다시 시도`) rather than a vague confirmation.

Process Surface: One `role="status"`, `aria-live="polite"`, `aria-atomic="true"` region renders exactly one state at a time: ready guidance, submitting, queued, processing, cancelled, interrupted-or-expired, completed, or failed. Queued and processing states show a determinate progress bar only when the API supplies progress; otherwise they show direct status text without fake percentages. Completed state exposes the result file name and one exact job-bound relative download link from the API. Failed, cancelled, and interrupted-or-expired states explain the recoverable cause and keep the original URL available for retry.

Notation Motif: The process surface may use five thin horizontal rules as a static structural motif. They must be CSS decoration with `aria-hidden="true"`, never a screenshot or fake score result, and must not animate. The actual result area remains semantic DOM.

Trust Note: A compact note below the form states that processing continues on the server after submission and that only successful jobs produce downloads. Do not claim that AI, automatic detection, or a PDF was used unless the API result explicitly says so.

### Interaction, responsive, and adaptive states

Malformed input sets `aria-invalid="true"` and returns focus to the URL field. While an active known job is being cancelled, the browser sends DELETE before locally aborting polling. Cancellation, terminal, network-error, and known-job-404 paths re-enable submit; cancellation returns focus to that enabled submit action. A known-job 404 is recoverable interrupted-or-expired state. Per-run token identity guards every update, terminal response, error, cancellation response, catch, and finally path so stale work cannot alter a newer run. These are DOM and focus observables only; no actual screen-reader announcement is claimed.

Submission locks only the submit control while preserving selectable input text. Malformed input returns focus to the input, sets `aria-invalid="true"`, and uses a visible inline error with `role="alert"`. Network, cancellation, terminal-job, and known-job-404 paths restore an enabled action and never leave a stale progress bar or download link. A new submission cancels the previous polling request before starting another.

Keyboard order is wordmark, URL input, primary action, active cancel action, then any result download. All interactive elements have a `3px` focus ring with at least `2px` offset. Touch targets are at least `44px`. At 200 percent zoom, the page remains one logical column without horizontal scrolling. `prefers-reduced-motion: reduce` removes transitions; default motion is limited to a short opacity change on real state replacement and a progress fill transform. High-contrast and forced-colors modes retain native borders and focus visibility.

### Accessibility constraints and accepted debt

The page must pass WCAG AA contrast, preserve native form semantics, announce state changes, associate errors through `aria-describedby`, and avoid color-only status. Korean text must remain legible without webfont loading. The success link must have a useful file-oriented label rather than `다운로드` alone.

Accepted integration debt for this frontend-first phase: the production media-processing backend is not yet migrated. The shipped page calls the documented score-job API and reports its real unavailability; only QA uses a local fixture server. This debt does not permit a demo mode, fabricated score preview, hardcoded success timer, or hidden extension dependency.
