import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createScoreJobApp } from "./app";
import type { ScoreJobService } from "./score-job-service";

export function createProductionApp(service: ScoreJobService, webRoot: string): Hono {
  const app = createScoreJobApp(service);
  const resolvedWebRoot = resolve(webRoot);

  if (existsSync(resolvedWebRoot)) {
    app.use("*", serveStatic({ root: resolvedWebRoot }));
  }

  return app;
}
