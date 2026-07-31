import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import pino from "pino";
import { assertMediaTools, defaultMediaTools } from "./media-tools";
import { ScoreJobService } from "./score-job-service";
import { cleanupOwnedResultFiles, cleanupOwnedWorkDirectories, shutdownScoreJobServer } from "./workspace-cleanup";
import { createProductionApp } from "./web-app";
import { YouTubeScoreProcessor } from "./youtube-score-processor";

const logger = pino({ name: "yt2sheet-server" });
const host = process.env.HOST?.trim() || "127.0.0.1";
const port = parsePort(process.env.PORT);
const dataRoot = resolve(process.env.YT2SHEET_DATA_ROOT?.trim() || ".yt2sheet-data");
const webRoot = resolve(process.env.YT2SHEET_WEB_ROOT?.trim() || "dist-web");

void start().catch((error: unknown) => {
  logger.fatal({ err: error }, "server startup failed");
  process.exitCode = 1;
});

async function start(): Promise<void> {
  await assertMediaTools(defaultMediaTools);
  await cleanupOwnedResultFiles(dataRoot);
  await cleanupOwnedWorkDirectories(dataRoot);
  const processor = new YouTubeScoreProcessor({ dataRoot, tools: defaultMediaTools });
  const service = new ScoreJobService(processor, { dataRoot });
  const app = createProductionApp(service, webRoot);
  const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    logger.info({ host: info.address, port: info.port, dataRoot, webRoot }, "server listening");
  });

  let shutdownStarted = false;
  const shutdown = async (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    try {
      await shutdownScoreJobServer(service, server);
      logger.info({ signal }, "server stopped");
      process.exit(0);
    } catch (error) {
      const failure = error instanceof Error ? error : new TypeError(String(error));
      logger.error({ err: failure, signal }, "server shutdown failed");
      process.exit(1);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void shutdown(signal); });
  }
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? "4174");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new RangeError(`Invalid PORT: ${value ?? ""}`);
  }
  return parsed;
}
