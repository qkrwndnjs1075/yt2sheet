import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { runProcess, type MediaTools } from "../pipeline/media-tools";
import { validateMxl } from "../pipeline/musicxml-validator";
import type { DoctorCheck } from "./doctor-contract";

export async function runLocalMediaSmoke(tools: MediaTools): Promise<DoctorCheck> {
  const directory = await mkdtemp(join(tmpdir(), "yt2sheet-doctor-"));
  const videoPath = join(directory, "fixture.mp4");
  const framePath = join(directory, "frame.png");
  const mxlPath = join(directory, "fixture.mxl");
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
    const score = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Smoke</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><note><rest/><duration>1</duration><type>quarter</type></note></measure></part>
</score-partwise>`);
    await writeFile(mxlPath, zipSync({
      "META-INF/container.xml": strToU8("<?xml version=\"1.0\"?><container><rootfiles><rootfile full-path=\"score.musicxml\" media-type=\"application/vnd.recordare.musicxml+xml\"/></rootfiles></container>"),
      "score.musicxml": score
    }, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") }));
    await validateMxl(await readFile(mxlPath));
    const pdf = await PDFDocument.create();
    const image = await pdf.embedPng(await readFile(framePath));
    const page = pdf.addPage([64, 64]);
    page.drawImage(image, { x: 0, y: 0, width: 64, height: 64 });
    await writeFile(pdfPath, await pdf.save());
    if (pdf.getPageCount() !== 1) throw new Error("로컬 스모크 PDF가 한 페이지가 아닙니다.");
    const [videoStat, frameStat, mxlStat, pdfStat] = await Promise.all([
      stat(videoPath),
      stat(framePath),
      stat(mxlPath),
      stat(pdfPath)
    ]);
    if (videoStat.size === 0 || frameStat.size === 0 || mxlStat.size === 0 || pdfStat.size === 0) {
      throw new Error("로컬 PNG->MXL->PDF 스모크 산출물이 비어 있습니다.");
    }
    return {
      key: "smoke",
      label: "로컬 미디어/PDF 스모크",
      status: "pass",
      message: "오프라인 PNG->MXL->PDF 한 페이지 스모크를 생성하고 검증했습니다."
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
