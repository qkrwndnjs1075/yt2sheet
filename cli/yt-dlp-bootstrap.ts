import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { type IncomingMessage } from "node:http";
import { get } from "node:https";
import { ScorePipelineError } from "../server/score-job-service";

export const YT_DLP_RELEASE_VERSION = "2026.07.04";

type YtDlpAsset = {
  readonly name: string;
  readonly fileName: string;
};

export type YtDlpBootstrapProgress = {
  readonly phase: "checking" | "checksum" | "download" | "verify" | "ready";
  readonly percent: number;
  readonly downloadedBytes?: number;
  readonly totalBytes?: number;
};

export type YtDlpBootstrapProgressHandler = (progress: YtDlpBootstrapProgress) => void;

const YT_DLP_PROGRESS_LABELS = {
  checking: "확인 중",
  checksum: "무결성 정보 확인 중",
  download: "다운로드 중",
  verify: "무결성 검증 중",
  ready: "준비 완료"
} as const;

export function formatYtDlpProgress(progress: YtDlpBootstrapProgress): string {
  const label = YT_DLP_PROGRESS_LABELS[progress.phase];
  if (progress.phase === "ready") {
    return `### yt-dlp ${label}`;
  }
  if (progress.phase === "download" && progress.totalBytes === undefined && progress.downloadedBytes !== undefined) {
    return `### yt-dlp ${label} ${formatByteCount(progress.downloadedBytes)} 다운로드됨`;
  }
  return `### yt-dlp ${label} ${progress.percent}%`;
}

export async function ensureYtDlpExecutable(onProgress?: YtDlpBootstrapProgressHandler): Promise<string> {
  reportProgress(onProgress, { phase: "checking", percent: 0 });
  const asset = selectYtDlpAsset(platform(), arch());
  const directory = getToolCacheDirectory();
  const targetPath = join(directory, asset.fileName);
  const checksumPath = `${targetPath}.sha256`;
  const cachedChecksum = (await readFile(checksumPath, "utf8").catch(() => "")).trim();
  if (cachedChecksum && await isVerifiedBinary(targetPath, checksumPath, cachedChecksum)) {
    reportProgress(onProgress, { phase: "ready", percent: 100 });
    return targetPath;
  }
  reportProgress(onProgress, { phase: "checksum", percent: 0 });
  const expectedChecksum = await downloadChecksum(asset.name);
  reportProgress(onProgress, { phase: "checksum", percent: 100 });

  if (await isVerifiedBinary(targetPath, checksumPath, expectedChecksum)) {
    reportProgress(onProgress, { phase: "ready", percent: 100 });
    return targetPath;
  }

  await mkdir(directory, { recursive: true });
  const temporaryPath = `${targetPath}.${randomUUID()}.part`;
  try {
    reportProgress(onProgress, { phase: "download", percent: 0 });
    await downloadFile(buildReleaseUrl(asset.name), temporaryPath, ({ downloadedBytes, totalBytes }) => {
      const percent = totalBytes === undefined
        ? 0
        : Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
      reportProgress(onProgress, {
        phase: "download",
        percent,
        downloadedBytes,
        ...(totalBytes === undefined ? {} : { totalBytes })
      });
    });
    reportProgress(onProgress, { phase: "download", percent: 100 });
    reportProgress(onProgress, { phase: "verify", percent: 0 });
    const actualChecksum = await hashFile(temporaryPath);
    if (actualChecksum !== expectedChecksum) {
      throw new ScorePipelineError(
        "TOOL_MISSING",
        "yt-dlp 다운로드 무결성 검증에 실패했습니다. 잠시 후 다시 시도해 주세요.",
        { cause: new Error(`Expected ${expectedChecksum}, received ${actualChecksum}`) }
      );
    }
    if (platform() !== "win32") {
      await chmod(temporaryPath, 0o755);
    }
    await rm(targetPath, { force: true });
    await rename(temporaryPath, targetPath);
    await writeFile(checksumPath, `${expectedChecksum}\n`, "utf8");
    reportProgress(onProgress, { phase: "verify", percent: 100 });
    reportProgress(onProgress, { phase: "ready", percent: 100 });
    return targetPath;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function selectYtDlpAsset(currentPlatform: string, currentArch: string): YtDlpAsset {
  if (currentPlatform === "win32") {
    if (currentArch === "arm64") return { name: "yt-dlp_arm64.exe", fileName: "yt-dlp.exe" };
    if (currentArch === "x64") return { name: "yt-dlp.exe", fileName: "yt-dlp.exe" };
    if (currentArch === "ia32") return { name: "yt-dlp_x86.exe", fileName: "yt-dlp.exe" };
  }
  if (currentPlatform === "darwin" && (currentArch === "arm64" || currentArch === "x64")) {
    return { name: "yt-dlp_macos", fileName: "yt-dlp" };
  }
  if (currentPlatform === "linux" && currentArch === "x64") {
    return { name: "yt-dlp_linux", fileName: "yt-dlp" };
  }
  if (currentPlatform === "linux" && currentArch === "arm64") {
    return { name: "yt-dlp_linux_aarch64", fileName: "yt-dlp" };
  }
  throw new ScorePipelineError(
    "TOOL_MISSING",
    `현재 OS/CPU(${currentPlatform}/${currentArch})용 yt-dlp를 지원하지 않습니다.`
  );
}

function getToolCacheDirectory(): string {
  const homeDirectory = homedir();
  const cacheVersion = `${YT_DLP_RELEASE_VERSION}-${platform()}-${arch()}`;
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA?.trim() || join(homeDirectory, "AppData", "Local"), "yt2sheet", "tools", cacheVersion);
  }
  if (platform() === "darwin") {
    return join(homeDirectory, "Library", "Caches", "yt2sheet", "tools", cacheVersion);
  }
  return join(process.env.XDG_CACHE_HOME?.trim() || join(homeDirectory, ".cache"), "yt2sheet", "tools", cacheVersion);
}

async function isVerifiedBinary(targetPath: string, checksumPath: string, expectedChecksum: string): Promise<boolean> {
  try {
    await access(targetPath);
    const storedChecksum = await readFile(checksumPath, "utf8").catch(() => "");
    return storedChecksum.trim() === expectedChecksum || (await hashFile(targetPath)) === expectedChecksum;
  } catch {
    return false;
  }
}

async function downloadChecksum(assetName: string): Promise<string> {
  const contents = await downloadText(buildReleaseUrl("SHA2-256SUMS"));
  const line = contents.split(/\r?\n/).find((candidate) => candidate.trim().endsWith(assetName));
  const match = line?.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
  if (!match || match[2].trim() !== assetName) {
    throw new ScorePipelineError("TOOL_MISSING", "yt-dlp 릴리스의 무결성 정보를 찾지 못했습니다.");
  }
  return match[1].toLowerCase();
}

function buildReleaseUrl(assetName: string): string {
  return `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_RELEASE_VERSION}/${assetName}`;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function downloadText(url: string): Promise<string> {
  return request(url, async (response) => {
    const chunks: string[] = [];
    let size = 0;
    for await (const chunk of response) {
      const text = chunk.toString();
      size += text.length;
      if (size > 2_000_000) {
        throw new Error("Downloaded checksum data is too large.");
      }
      chunks.push(text);
    }
    return chunks.join("");
  });
}

async function downloadFile(
  url: string,
  destination: string,
  onProgress?: (progress: { readonly downloadedBytes: number; readonly totalBytes?: number }) => void
): Promise<void> {
  await request(url, async (response) => {
    const totalBytes = parseContentLength(response);
    let downloadedBytes = 0;
    let lastPercent = -1;
    let lastReportedBytes = 0;
    response.on("data", (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      if (totalBytes !== undefined) {
        const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
        if (percent === lastPercent) {
          return;
        }
        lastPercent = percent;
      } else if (downloadedBytes - lastReportedBytes < 256 * 1024) {
        return;
      }
      lastReportedBytes = downloadedBytes;
      onProgress?.({
        downloadedBytes,
        ...(totalBytes === undefined ? {} : { totalBytes })
      });
    });
    await pipeline(response, createWriteStream(destination, { flags: "wx" }));
    onProgress?.({
      downloadedBytes,
      ...(totalBytes === undefined ? {} : { totalBytes })
    });
  });
}

function reportProgress(
  onProgress: YtDlpBootstrapProgressHandler | undefined,
  progress: YtDlpBootstrapProgress
): void {
  onProgress?.(progress);
}

function parseContentLength(response: IncomingMessage): number | undefined {
  const header = response.headers["content-length"];
  const rawValue = Array.isArray(header) ? header[0] : header;
  if (!rawValue) {
    return undefined;
  }
  const value = Number(rawValue);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function request<T>(url: string, handle: (response: IncomingMessage) => Promise<T>, redirects = 0): Promise<T> {
  if (redirects > 5) {
    throw new Error("Too many download redirects.");
  }
  return new Promise<T>((resolve, reject) => {
    const requestHandle = get(url, {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": `yt2sheet/${YT_DLP_RELEASE_VERSION}`
      }
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        request(new URL(location, url).toString(), handle, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${String(status)}.`));
        return;
      }
      handle(response).then(resolve, reject);
    });
    requestHandle.once("error", reject);
  });
}
