import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import pino from "pino";
import { createScoreJobApp } from "./app";
import { assertMediaTools, defaultMediaTools } from "./media-tools";
import { ScoreJobService } from "./score-job-service";
import { YouTubeScoreProcessor } from "./youtube-score-processor";

const logger = pino({ name: "yt2sheet-server" });
const host = "127.0.0.1";
const port = parsePort(process.env.PORT);
const dataRoot = resolve(process.env.YT2SHEET_DATA_ROOT?.trim() || ".yt2sheet-data");

void start().catch((error: unknown) => {
  logger.fatal({ err: error }, "server startup failed");
  process.exitCode = 1;
});

async function start(): Promise<void> {
  await assertMediaTools(defaultMediaTools);
  const processor = new YouTubeScoreProcessor({ dataRoot, tools: defaultMediaTools });
  const service = new ScoreJobService(processor);
  const app = createScoreJobApp(service);
  const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    logger.info({ host: info.address, port: info.port, dataRoot }, "server listening");
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? "4174");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new RangeError(`Invalid PORT: ${value ?? ""}`);
  }
  return parsed;
}
