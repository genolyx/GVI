import "./loadEnv";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerGoogleOAuthRoutes } from "./googleOAuth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { registerGatewayAuthRoutes } from "../gatewayAuth";
import { registerPartnerRoutes } from "../partnerApi";
import { registerEngineApiRoutes, startCurationReaper } from "../engineApi";
import { ensureCurationWorker } from "../domain/curationWorker";
import { registerUploadRoute } from "../uploads";
import { registerDevAuthRoutes } from "./devAuth";
import { ENV } from "./env";
import { startSomaticWorker } from "../domain/somatic/runWorker";
import { startCivicImportWorker } from "../domain/somatic/civic/importWorker";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

if (!ENV.isProduction && ENV.engineWorkerToken.length < 32) {
  ENV.engineWorkerToken = "local-dev-engine-worker-token-change-me!!";
  process.env.ENGINE_WORKER_TOKEN = ENV.engineWorkerToken;
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerGoogleOAuthRoutes(app);
  registerDevAuthRoutes(app);
  registerGatewayAuthRoutes(app);
  registerPartnerRoutes(app);
  registerEngineApiRoutes(app);
  if (ENV.engineWorkerToken.length >= 32) {
    startCurationReaper();
  } else {
    console.log(
      "[CurationReaper] disabled — ENGINE_WORKER_TOKEN is not configured"
    );
  }
  startSomaticWorker();
  startCivicImportWorker();
  registerUploadRoute(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  // VCF uploads stream through this process, so a large file can take longer than the default request limit.
  server.requestTimeout = 60 * 60 * 1000;
  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    // Mount ClinVar and HGMD now, so the first analysis does not sit in Loading.
    // The process stays up and later variants reuse that mount.
    if (ENV.engineWorkerToken.length >= 32) {
      try {
        const worker = ensureCurationWorker();
        console.log(
          worker.alreadyRunning
            ? `[curation] ${worker.desired} classifier workers already warm`
            : `[curation] starting ${worker.started} classifier worker(s); ${worker.desired} configured`
        );
      } catch (error) {
        console.error(
          "[curation] classifier did not start:",
          error instanceof Error ? error.message : error
        );
      }
    }
  });
}

startServer().catch(console.error);
