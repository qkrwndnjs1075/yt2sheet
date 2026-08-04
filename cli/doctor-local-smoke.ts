import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { runProcess, type MediaTools } from "../pipeline/media-tools";
import type { DoctorCheck } from "./doctor-contract";

export async function runLocalMediaSmoke(tools: MediaTools): Promise<DoctorCheck> {
  const directory = await mkdtemp(join(tmpdir(), "yt2sheet-doctor-"));
  const videoPath = join(directory, "fixture.mp4");
  const framePath = join(directory, "frame.png");
  const pdfPath = join(directory, "fixture.pdf");
  try {
    await runProcess(tools.ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=64x64:r=1:d=1",
      "-pix_fmt",
      "yuv420p",
      videoPath
    ], { timeoutMs: 15_000 });
    const duration = (await runProcess(tools.ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      videoPath
    ], { timeoutMs: 15_000 })).trim();
    if (!Number.isFinite(Number(duration)) || Number(duration) <= 0) {
      throw new Error(`ffprobe returned an invalid duration: ${duration || "empty"}`);
    }
    await runProcess(tools.ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      videoPath,
      "-frames:v",
      "1",
      framePath
    ], { timeoutMs: 15_000 });
    const pdf = await PDFDocument.create();
    pdf.addPage([64, 64]);
    await writeFile(pdfPath, await pdf.save());
    const [videoStat, frameStat, pdfStat] = await Promise.all([
      stat(videoPath),
      stat(framePath),
      stat(pdfPath)
    ]);
    if (videoStat.size === 0 || frameStat.size === 0 || pdfStat.size === 0) {
      throw new Error("로컬 스모크 산출물이 비어 있습니다.");
    }
    return {
      key: "smoke",
      label: "로컬 미디어/PDF 스모크",
      status: "pass",
      message: "임시 영상, 프레임, PDF를 생성하고 정리했습니다."
    };
  } catch (error: unknown) {
    return {
      key: "smoke",
      label: "로컬 미디어/PDF 스모크",
      status: "fail",
      message: "임시 영상/프레임/PDF 검증에 실패했습니다.",
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
