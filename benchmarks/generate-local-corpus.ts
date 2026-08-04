import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runProcess } from "../pipeline/media-tools";
import { VerovioToolkit } from "verovio/esm";
import createVerovioModule from "verovio/wasm";

const REQUIRED_TAGS = ["static", "cursor", "scroll", "hard-turn", "fade", "compression", "no-score"] as const;
const FFmpeg = process.env.FFMPEG_PATH?.trim() || "ffmpeg";

async function main(): Promise<void> {
  const outputRoot = resolve(process.argv[2] ?? "tests/fixtures/score-corpus/generated-v1");
  const mediaRoot = join(outputRoot, "media");
  const musicXmlRoot = join(outputRoot, "musicxml");
  const labelsRoot = join(outputRoot, "labels");
  const eventsRoot = join(outputRoot, "events");
  const rightsRoot = join(outputRoot, "rights");
  const provenanceRoot = join(outputRoot, "provenance");
  await Promise.all([mediaRoot, musicXmlRoot, labelsRoot, eventsRoot, rightsRoot, provenanceRoot].map((path) => mkdir(path, { recursive: true })));
  const rightsBytes = Buffer.from(JSON.stringify({ evidenceVersion: "project-owned/1", holder: "yt2sheet project", statement: "Generated MusicXML benchmark score owned by the project; derivatives permitted." }));
  await writeFile(join(rightsRoot, "project-owned.json"), rightsBytes);
  const provenanceBytes = Buffer.from(JSON.stringify({ generator: "verovio", version: "6.1.0", package: "verovio@6.1.0", renderer: "ffmpeg", compression: { codec: "libx264", preset: "medium", baselineCrf: 23, compressionCrf: 40 }, generatedAt: "2026-08-04T00:00:00.000Z" }));
  await writeFile(join(provenanceRoot, "verovio-6.1.0.json"), provenanceBytes);
  const verovioModule = await createVerovioModule();
  const toolkit = new VerovioToolkit(verovioModule);
  toolkit.setOptions({ pageWidth: 1200, pageHeight: 1700, scale: 40 });
  const assets: Record<string, unknown>[] = [];
  for (let index = 1; index <= 30; index += 1) {
    const assetId = `generated-${String(index).padStart(2, "0")}`;
    const sourceGroupId = `generated-group-${String(index).padStart(2, "0")}`;
    const split = index <= 10 ? "calibration" : "test";
    const variantTags = variantTagsFor(index);
    const noScore = variantTags.includes("no-score");
    const musicXml = musicXmlData(index);
    const musicXmlBytes = Buffer.from(musicXml);
    const musicXmlPath = join(musicXmlRoot, `${assetId}.musicxml`);
    await writeFile(musicXmlPath, musicXmlBytes);
    const loaded = toolkit.loadData(musicXml);
    if (!loaded) throw new Error(`verovio rejected ${assetId}`);
    const engravedSvg = toolkit.renderToSVG(1, {});
    const svg = noScore ? blankSvg() : engravedSvg.replace(/(<svg[^>]*>)/u, "$1<rect width=\"100%\" height=\"100%\" fill=\"white\"/>");
    const svgPath = join(mediaRoot, `${assetId}.svg`);
    await writeFile(svgPath, svg);
    const videoPath = join(mediaRoot, `${assetId}.mp4`);
    const filter = ["scale=640:-2", ...variantTags.flatMap((tag) => filterForTag(tag))].join(",");
    const codecArguments = noScore || !variantTags.includes("compression")
      ? ["-c:v", "libx264", "-preset", "medium", "-crf", "23"]
      : ["-c:v", "libx264", "-preset", "medium", "-crf", "40"];
    await runProcess(FFmpeg, ["-hide_banner", "-loglevel", "error", "-loop", "1", "-i", svgPath, "-t", "2", "-vf", filter, "-r", "2", ...codecArguments, "-pix_fmt", "yuv420p", "-y", videoPath]);
    const videoBytes = await readFile(videoPath);
    const eventTrace = { schemaVersion: "score-events/1", assetId, events: [{ timestampMs: 200, score: 10 }, { timestampMs: 950, score: 92 }, { timestampMs: 1050, score: 88 }] };
    const eventBytes = Buffer.from(JSON.stringify(eventTrace));
    await writeFile(join(eventsRoot, `${assetId}.json`), eventBytes);
    const expectedDisposition = noScore ? "blocked" : index === 16 ? "structured" : "raster-fallback";
    const labels = {
      schemaVersion: "score-labels/1", assetId, durationMs: 2000,
      states: [{ stateId: `${assetId}-a`, startMs: 0, endMs: 1000 }, { stateId: `${assetId}-b`, startMs: 1000, endMs: 2000 }],
      boundaries: [{ timestampMs: 1000, type: "hard-turn" }],
      probes: expectedDisposition === "blocked" ? [{ timestampMs: 500, hasScore: false, source: { width: 640, height: 360 }, scoreRects: [] }] : [
        { timestampMs: 500, hasScore: true, source: { width: 640, height: 360 }, scoreRects: [{ x: 32, y: 90, width: 576, height: 190 }] },
        { timestampMs: 1500, hasScore: true, source: { width: 640, height: 360 }, scoreRects: [{ x: 32, y: 90, width: 576, height: 190 }] }
      ],
      oracle: {
        expectedDisposition, expectedPageCount: expectedDisposition === "blocked" ? 0 : 1,
        expectedPageOrder: expectedDisposition === "blocked" ? [] : [1],
        expectedStaffCounts: expectedDisposition === "blocked" ? [] : [1],
        expectedSystemCounts: expectedDisposition === "blocked" ? [] : [1],
        groundTruthMusicXmlSha256: digest(musicXmlBytes)
      },
      annotators: [{ id: "verovio-generator", role: "annotator" }], confidence: 1
    };
    const labelsBytes = Buffer.from(JSON.stringify(labels));
    await writeFile(join(labelsRoot, `${assetId}.json`), labelsBytes);
    assets.push({
      assetId, sourceGroupId, split, classTags: [...variantTags],
      source: {
        kind: "generated-local", relativePath: `media/${assetId}.mp4`, sha256: digest(videoBytes), contentSha256: digest(musicXmlBytes), byteLength: videoBytes.byteLength, durationMs: 2000,
        eventTrace: { relativePath: `events/${assetId}.json`, sha256: digest(eventBytes) },
        generation: {
          generator: { name: "verovio", version: "6.1.0", command: "verovio@6.1.0 MusicXML -> SVG", provenance: { relativePath: "provenance/verovio-6.1.0.json", sha256: digest(provenanceBytes) } },
          renderer: { name: "ffmpeg", version: "8.1.2", command: `ffmpeg tags=${variantTags.join("+")} filter${variantTags.includes("compression") ? " compression=libx264:crf=40:preset=medium" : ""}`, independent: true },
          musicXml: { relativePath: `musicxml/${assetId}.musicxml`, sha256: digest(musicXmlBytes) }
        }
      },
      rights: { decision: "approved", basis: "owned", holder: "yt2sheet project", licenseExpression: "Project-owned generated benchmark fixture", evidence: { relativePath: "rights/project-owned.json", sha256: digest(rightsBytes) }, allowedUses: { benchmark: true, derivatives: true, redistribution: true, commercial: false } },
      labels: { relativePath: `labels/${assetId}.json`, sha256: digest(labelsBytes) }
    });
  }
  const manifest = { schemaVersion: "score-corpus/1", corpusId: "yt2sheet-generated-disjoint-v1", corpusVersion: "1.0.0", createdAt: "2026-08-04T00:00:00.000Z", assets };
  await writeFile(join(outputRoot, "manifest.json"), JSON.stringify(manifest));
}

function variantTagsFor(index: number): readonly (typeof REQUIRED_TAGS)[number][] {
  if (index >= 11 && index <= 15) return ["no-score"];
  if (index >= 16 && index <= 20) return ["static", "cursor"];
  if (index >= 21 && index <= 25) return ["static", "hard-turn", "fade"];
  if (index >= 26 && index <= 30) return ["scroll", "compression"];
  return [REQUIRED_TAGS[(index - 1) % REQUIRED_TAGS.length] ?? "static"];
}

function filterForTag(tag: (typeof REQUIRED_TAGS)[number]): readonly string[] {
  switch (tag) {
    case "static":
    case "no-score":
      return [];
    case "cursor":
      return ["drawbox=x=300:y=10:w=5:h=640:color=red@0.8:t=fill"];
    case "scroll":
      return ["crop=640:906:x=0:y=0"];
    case "hard-turn":
      return ["drawbox=x=0:y=0:w=640:h=8:color=black:t=fill"];
    case "fade":
      return ["fade=t=out:st=1:d=1"];
    case "compression":
      return ["scale=iw:ih:flags=lanczos"];
    default:
      return assertNever(tag);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled variant tag: ${String(value)}`);
}

function musicXmlData(index: number): string {
  const pitch = ["C", "D", "E", "F", "G", "A", "B"][index % 7];
  const alter = index % 2 === 0 ? "<alter>0</alter>" : "";
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Benchmark ${index}</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><pitch><step>${pitch}</step>${alter}<octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`;
}

function blankSvg(): string {
  return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1200\" height=\"1700\"><rect width=\"1200\" height=\"1700\" fill=\"white\"/></svg>";
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
