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
import { registerEngineApiRoutes, startCurationReaper } from "../engineApi";
import { ensureCurationWorker } from "../domain/curationWorker";
import { registerDevAuthRoutes } from "./devAuth";
import { ENV } from "./env";

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
  registerEngineApiRoutes(app);
  if (ENV.engineWorkerToken.length >= 32) {
    startCurationReaper();
  } else {
    console.log("[CurationReaper] disabled — ENGINE_WORKER_TOKEN is not configured");
  }
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

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    // Mount ClinVar and HGMD now, so the first analysis does not sit in Loading.
    // The process stays up and later variants reuse that mount.
    if (ENV.engineWorkerToken.length >= 32) {
      try {
        const worker = ensureCurationWorker();
        console.log(
          worker.alreadyRunning
            ? "[curation] classifier already warm"
            : "[curation] classifier starting; reference data will mount in the background"
        );
      } catch (error) {
        console.error("[curation] classifier did not start:", error instanceof Error ? error.message : error);
      }
    }
  });
}

startServer().catch(console.error);
