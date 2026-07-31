import { DEBUG_CAPTURE_STATE_KEY, type DebugCaptureState } from "../shared/debug-state";
import type { FrameLayoutSummary, Rect } from "../shared/layout-types";
import type { RuntimeMessage } from "../shared/messages";
import type { RoiIdentityDebugInfo } from "../shared/roi-types";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("Debug app root not found.");
}

const root = app;

document.body.style.margin = "0";
document.body.style.fontFamily = "Inter, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif";
document.body.style.background = "#f7f8fa";
document.body.style.color = "#111827";

root.style.maxWidth = "960px";
root.style.margin = "0 auto";
root.style.padding = "24px";

void render();
setInterval(() => {
  void render();
}, 1000);

async function render(): Promise<void> {
  const state = await readDebugState();
  const session = state.currentSession ?? state.lastCompletedSession;
  const frames = [...state.recentFrames].reverse();
  const uniqueScores = state.uniqueScores ?? [];

  root.innerHTML = `
    <header class="header">
      <div>
        <h1>Score Frame Collector Debug</h1>
        <p>Temporary ROI previews only. Raw full frames are not stored here.</p>
      </div>
      <button id="refresh" type="button">Refresh</button>
    </header>

    <section class="grid">
      <div class="panel">
        <h2>Session</h2>
        ${session ? sessionHtml(session, state.currentSession !== null) : "<p>No session has been captured in this extension session.</p>"}
      </div>
      <div class="panel">
        <h2>Last Frame</h2>
        ${frames[0] ? frameHtml(frames[0]) : "<p>No sampled frame metadata yet.</p>"}
      </div>
    </section>

    <section class="panel">
      <h2>Unique Scores</h2>
      ${uniqueScores.length > 0 ? uniqueScoresHtml(uniqueScores) : "<p>No accepted unique score images yet.</p>"}
    </section>

    <section class="panel">
      <h2>Recent Frame Metadata</h2>
      ${frames.length > 0 ? framesTableHtml(frames) : "<p>Start capture on a YouTube watch page to populate this table.</p>"}
    </section>

    <section class="panel">
      <h2>Last Error</h2>
      ${state.lastError ? `<pre>${escapeHtml(JSON.stringify(state.lastError, null, 2))}</pre>` : "<p>No error recorded.</p>"}
    </section>

    <footer>Updated at ${escapeHtml(state.updatedAt)}</footer>
  `;

  installStyles();
  document.querySelector("#refresh")?.addEventListener("click", () => {
    void render();
  });
}

async function readDebugState(): Promise<DebugCaptureState> {
  try {
    return await chrome.runtime.sendMessage<RuntimeMessage, DebugCaptureState>({ type: "GET_DEBUG_CAPTURE_STATE" });
  } catch {
  }

  const stored = await chrome.storage.session.get(DEBUG_CAPTURE_STATE_KEY);
  const state = stored[DEBUG_CAPTURE_STATE_KEY] as Partial<DebugCaptureState> | undefined;

  return {
    currentSession: state?.currentSession ?? null,
    lastCompletedSession: state?.lastCompletedSession ?? null,
    recentFrames: state?.recentFrames ?? [],
    uniqueScores: state?.uniqueScores ?? [],
    exportCandidates: state?.exportCandidates ?? state?.uniqueScores ?? [],
    lastError: state?.lastError ?? null,
    updatedAt: state?.updatedAt ?? new Date().toISOString()
  };
}

function sessionHtml(session: DebugCaptureState["currentSession"], active: boolean): string {
  if (!session) {
    return "";
  }

  return `
    <dl>
      <dt>Status</dt><dd>${active ? "active" : "last completed"} / ${escapeHtml(session.state)}</dd>
      <dt>Video</dt><dd>${escapeHtml(session.source.title)} (${escapeHtml(session.source.videoId)})</dd>
      <dt>Frames</dt><dd>${session.stats.framesSampled} sampled, ${session.stats.framesDropped} dropped</dd>
      <dt>Last Timestamp</dt><dd>${formatNumber(session.stats.lastTimestampSec)}s</dd>
      <dt>Last Size</dt><dd>${session.stats.lastFrameWidth ?? "-"} x ${session.stats.lastFrameHeight ?? "-"}</dd>
      <dt>Started</dt><dd>${escapeHtml(session.stats.startedAt)}</dd>
      <dt>Ended</dt><dd>${escapeHtml(session.stats.endedAt ?? "-")}</dd>
    </dl>
  `;
}

function frameHtml(frame: DebugCaptureState["recentFrames"][number]): string {
  return `
    ${previewHtml(frame)}
    ${identityHtml(frame.identity)}
    ${layoutHtml(frame.layout)}
    <dl>
      <dt>Frame</dt><dd>#${frame.frameIndex}</dd>
      <dt>Timestamp</dt><dd>${formatNumber(frame.timestampSec)}s</dd>
      <dt>Size</dt><dd>${frame.width} x ${frame.height}</dd>
      <dt>Sampled At</dt><dd>${escapeHtml(frame.sampledAt)}</dd>
    </dl>
  `;
}

function framesTableHtml(frames: DebugCaptureState["recentFrames"]): string {
  return `
    <table>
      <thead>
        <tr>
          <th>Preview</th>
          <th>Frame</th>
          <th>Timestamp</th>
          <th>Size</th>
          <th>Layout</th>
          <th>Identity</th>
          <th>Sampled At</th>
        </tr>
      </thead>
      <tbody>
        ${frames.map((frame) => `
          <tr>
            <td>${previewHtml(frame, true)}</td>
            <td>#${frame.frameIndex}</td>
            <td>${formatNumber(frame.timestampSec)}s</td>
            <td>${frame.width} x ${frame.height}</td>
            <td>${compactLayoutHtml(frame.layout)}</td>
            <td>${compactIdentityHtml(frame.identity)}</td>
            <td>${escapeHtml(frame.sampledAt)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function uniqueScoresHtml(scores: DebugCaptureState["uniqueScores"]): string {
  return `
    <div class="unique-grid">
      ${scores.map(uniqueScoreHtml).join("")}
    </div>
  `;
}

function uniqueScoreHtml(score: DebugCaptureState["uniqueScores"][number]): string {
  return `
    <article class="unique-card">
      ${score.image.dataUrl
        ? `<img src="${escapeHtml(score.image.dataUrl)}" width="${score.image.width}" height="${score.image.height}" alt="Unique score ${score.order}" />`
        : "<div class=\"unique-card__placeholder\">No image preview</div>"}
      <dl>
        <dt>Order</dt><dd>#${score.order}</dd>
        <dt>Cluster</dt><dd>${escapeHtml(score.clusterId)}</dd>
        <dt>Seen</dt><dd>${formatNumber(score.source.firstSeenSec)}s - ${formatNumber(score.source.lastSeenSec)}s</dd>
        <dt>Quality</dt><dd>${formatNumber(score.qualityScore)}</dd>
      </dl>
    </article>
  `;
}

function identityHtml(identity: RoiIdentityDebugInfo | undefined): string {
  if (!identity) {
    return "<p class=\"muted layout-summary\">No ROI identity metadata for this frame.</p>";
  }

  return `
    <dl class="layout-summary">
      <dt>ROI Decision</dt><dd>${escapeHtml(identity.decision ?? identity.skippedReason ?? "-")}</dd>
      <dt>Cluster</dt><dd>matched ${escapeHtml(identity.matchedClusterId ?? "-")} / new ${escapeHtml(identity.newClusterId ?? "-")}</dd>
      <dt>Distances</dt><dd>pHash ${formatNumber(identity.contentPHashDistance)}, dHash ${formatNumber(identity.contentDHashDistance)}</dd>
      <dt>Projection</dt><dd>v ${formatNumber(identity.verticalProjectionSimilarity)}, h ${formatNumber(identity.horizontalProjectionSimilarity)}</dd>
      <dt>Counts</dt><dd>clusters ${identity.clusterCount}, accepted ${identity.acceptedClusterCount}, pending ${identity.pendingCount}</dd>
      <dt>Quality</dt><dd>${formatNumber(identity.representativeQualityScore)}</dd>
    </dl>
  `;
}

function previewHtml(frame: DebugCaptureState["recentFrames"][number], compact = false): string {
  if (!frame.previewDataUrl) {
    return compact ? "<span class=\"muted\">metadata only</span>" : "<p>No preview retained for this frame.</p>";
  }

  return `
    <figure class="${compact ? "preview preview--compact" : "preview"}">
      <div class="preview-frame">
        <img src="${escapeHtml(frame.previewDataUrl)}" width="${frame.previewWidth ?? ""}" height="${frame.previewHeight ?? ""}" alt="Sampled score ROI preview #${frame.frameIndex}" />
        ${compact ? "" : overlayHtml(frame)}
      </div>
      ${compact ? "" : `<figcaption>#${frame.frameIndex} thumbnail, ${frame.previewWidth ?? "-"} x ${frame.previewHeight ?? "-"}</figcaption>`}
    </figure>
  `;
}

function layoutHtml(layout: FrameLayoutSummary | undefined): string {
  if (!layout) {
    return "<p class=\"muted layout-summary\">No layout metadata for this frame.</p>";
  }

  return `
    <dl class="layout-summary">
      <dt>Score</dt><dd>${layout.scoreDetected ? "detected" : "not detected"} / confidence ${formatNumber(layout.confidence)}</dd>
      <dt>Regions</dt><dd>${layout.scoreRegions.length}</dd>
      <dt>Proposals</dt><dd>${layout.regionProposals.length} total, ${layout.weakCandidates.length} weak</dd>
      <dt>Staffs</dt><dd>${layout.debug?.staffCandidates.length ?? 0}</dd>
      <dt>Systems</dt><dd>${layout.systems.map((system) => `${escapeHtml(system.kind)} ${rectLabel(system.rect)}`).join("<br>") || "-"}</dd>
      <dt>ROI</dt><dd>${layout.debug?.videoRoiRect ? rectLabel(layout.debug.videoRoiRect) : "-"}</dd>
      <dt>Failure</dt><dd>${escapeHtml(layout.debug?.failureReason ?? "-")}</dd>
      <dt>Scale</dt><dd>line gap ${formatNumber(layout.scale.estimatedStaffLineGap)}px, staff ${formatNumber(layout.scale.estimatedStaffHeight)}px</dd>
      <dt>Processing</dt><dd>${formatNumber(layout.debug?.processingTimeMs)}ms</dd>
    </dl>
  `;
}

function compactLayoutHtml(layout: FrameLayoutSummary | undefined): string {
  if (!layout) {
    return "<span class=\"muted\">-</span>";
  }

  return `${layout.scoreDetected ? "yes" : "no"} / systems ${layout.systems.length} / conf ${formatNumber(layout.confidence)}`;
}

function compactIdentityHtml(identity: RoiIdentityDebugInfo | undefined): string {
  if (!identity) {
    return "<span class=\"muted\">-</span>";
  }

  return `${escapeHtml(identity.decision ?? identity.skippedReason ?? "-")} / clusters ${identity.clusterCount} / pending ${identity.pendingCount}`;
}

function overlayHtml(frame: DebugCaptureState["recentFrames"][number]): string {
  const layout = frame.layout;

  if (!layout) {
    return "";
  }

  const proposalBoxes = layout.regionProposals.map((proposal) => boxHtml(proposal.status === "weak" ? "weak" : "proposal", proposal.rect, frame.width, frame.height, proposal.source));
  const regionBoxes = layout.scoreRegions.map((region) => boxHtml("region", region.rect, frame.width, frame.height, "promoted"));
  const staffBoxes = (layout.debug?.staffCandidates ?? []).map((staff) => boxHtml("staff", staff.rect, frame.width, frame.height, staff.kind));
  const systemBoxes = layout.systems.map((system) => boxHtml("system", system.rect, frame.width, frame.height, system.kind));

  return `<div class="overlay">${[...proposalBoxes, ...regionBoxes, ...staffBoxes, ...systemBoxes].join("")}</div>`;
}

function boxHtml(kind: "proposal" | "weak" | "region" | "staff" | "system", rect: Rect, width: number, height: number, label: string): string {
  const left = percent(rect.x, width);
  const top = percent(rect.y, height);
  const boxWidth = percent(rect.width, width);
  const boxHeight = percent(rect.height, height);

  return `
    <span class="box box--${kind}" style="left:${left}%;top:${top}%;width:${boxWidth}%;height:${boxHeight}%;">
      <span>${escapeHtml(label)}</span>
    </span>
  `;
}

function rectLabel(rect: Rect): string {
  return `x=${Math.round(rect.x)} y=${Math.round(rect.y)} w=${Math.round(rect.width)} h=${Math.round(rect.height)}`;
}

function percent(value: number, base: number): string {
  return base <= 0 ? "0" : Math.max(0, Math.min(100, (value / base) * 100)).toFixed(3);
}

function installStyles(): void {
  if (document.querySelector("#debug-style")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "debug-style";
  style.textContent = `
    .header {
      align-items: center;
      display: flex;
      gap: 16px;
      justify-content: space-between;
      margin-bottom: 20px;
    }

    h1 {
      font-size: 24px;
      margin: 0 0 6px;
    }

    h2 {
      font-size: 16px;
      margin: 0 0 14px;
    }

    p, footer {
      color: #4b5563;
      margin: 0;
    }

    .muted {
      color: #6b7280;
      font-size: 13px;
    }

    button {
      background: #111827;
      border: 0;
      border-radius: 6px;
      color: #fff;
      cursor: pointer;
      font-size: 14px;
      padding: 9px 12px;
    }

    button.secondary {
      background: #e5e7eb;
      color: #111827;
    }

    .button-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .ai-settings {
      display: grid;
      gap: 12px;
      max-width: 560px;
    }

    .ai-settings label {
      color: #374151;
      display: grid;
      gap: 6px;
      font-size: 13px;
    }

    .ai-settings label:first-child {
      align-items: center;
      display: flex;
      gap: 8px;
    }

    .ai-settings input[type="text"],
    .ai-settings input[type="password"],
    .ai-settings input[type="url"] {
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font: inherit;
      padding: 8px 10px;
    }

    .grid {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      margin-bottom: 16px;
    }

    .panel {
      background: #fff;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      margin-bottom: 16px;
      padding: 16px;
    }

    dl {
      display: grid;
      gap: 8px 14px;
      grid-template-columns: 130px minmax(0, 1fr);
      margin: 0;
    }

    dt {
      color: #6b7280;
      font-size: 13px;
    }

    dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    table {
      border-collapse: collapse;
      width: 100%;
    }

    th, td {
      border-bottom: 1px solid #e5e7eb;
      padding: 10px 8px;
      text-align: left;
    }

    th {
      color: #6b7280;
      font-size: 13px;
      font-weight: 600;
    }

    pre {
      background: #111827;
      border-radius: 6px;
      color: #f9fafb;
      margin: 0;
      overflow: auto;
      padding: 12px;
    }

    .preview {
      margin: 0 0 14px;
    }

    .unique-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    }

    .unique-card {
      border: 1px solid #d1d5db;
      border-radius: 8px;
      display: grid;
      gap: 10px;
      padding: 10px;
    }

    .unique-card img,
    .unique-card__placeholder {
      align-items: center;
      background: #111827;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      color: #f9fafb;
      display: flex;
      height: auto;
      justify-content: center;
      max-height: 180px;
      max-width: 100%;
      min-height: 90px;
      object-fit: contain;
    }

    .unique-card dl {
      gap: 4px 10px;
      grid-template-columns: 64px minmax(0, 1fr);
    }

    .preview img {
      background: #111827;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      display: block;
      height: auto;
      max-width: 100%;
    }

    .preview-frame {
      display: inline-block;
      max-width: 100%;
      position: relative;
    }

    .overlay {
      inset: 0;
      pointer-events: none;
      position: absolute;
    }

    .box {
      border: 2px solid;
      box-sizing: border-box;
      position: absolute;
    }

    .box span {
      background: rgba(17, 24, 39, 0.82);
      color: #fff;
      font-size: 11px;
      left: 0;
      line-height: 1;
      padding: 3px 4px;
      position: absolute;
      top: 0;
      white-space: nowrap;
    }

    .box--region {
      border-color: #f59e0b;
    }

    .box--proposal {
      border-color: #fb923c;
    }

    .box--weak {
      border-color: #facc15;
    }

    .box--staff {
      border-color: #22c55e;
    }

    .box--system {
      border-color: #2563eb;
    }

    .layout-summary {
      margin: 0 0 14px;
    }

    .preview figcaption {
      color: #6b7280;
      font-size: 13px;
      margin-top: 6px;
    }

    .preview--compact {
      margin: 0;
    }

    .preview--compact img {
      max-height: 72px;
      max-width: 128px;
      object-fit: contain;
    }

    @media (max-width: 720px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
  `;
  document.head.append(style);
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "-" : value.toFixed(2);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
