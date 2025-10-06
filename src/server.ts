import Server from "@musistudio/llms";
import { readConfigFile, writeConfigFile } from "./utils";
import { CONFIG_FILE } from "./constants";
import { join } from "path";
import { readFileSync } from "fs";
import fastifyStatic from "@fastify/static";
import { setupTracingHooks, maintainTraceContext } from "./middleware/tracing";
import { initializeTracer } from "./utils/tracer";
import { wrapFetch } from "./tracing/interceptor";

export const createServer = (config: any): Server => {
  // Initialize tracer with config FIRST
  const actualConfig = config.initialConfig || config;
  initializeTracer(actualConfig);

  // Add tracing hooks if enabled
  const tracingEnabled = actualConfig.Tracing?.enabled !== false;
  if (tracingEnabled) {
    // Wrap fetch for outbound tracing
    wrapFetch();
  }

  // Create server
  const server = new Server(config);
  // Auto-register providers from initialConfig/env when Fastify is ready
  try {
    server.app.addHook("onReady", async () => {
      try {
        const envMap: Record<string,string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY', groq: 'GROQ_API_KEY', deepseek: 'DEEPSEEK_API_KEY' };
        const list: any[] = Array.isArray(actualConfig.providers) ? actualConfig.providers : (Array.isArray(actualConfig.Providers) ? actualConfig.Providers : []);
        const svc = (server as any).app._server && (server as any).app._server.providerService;
        if (!svc) {
          console.error('Provider auto-registration failed: providerService not available onReady');
          return;
        }
        for (const p of (list || [])) {
          if (!p) continue;
          const name = String(p.name || '');
          if (!name) continue;
          const lname = name.toLowerCase();
          const baseUrl = p.api_base_url || p.baseUrl || p.apiBaseUrl || '';
          const apiKey = p.api_key || (process as any).env[envMap[lname]] || (process as any).env[(name.toUpperCase()) + '_API_KEY'] || '';
          const models = Array.isArray(p.models) ? p.models : [];
          const transformer = p.transformer || {};
          if (!svc.getProvider(name)) {
            svc.registerProvider({ name, baseUrl, apiKey, models, transformer });
          }
        }
      } catch (e: any) {
        console.error('Provider auto-registration failed:', e?.stack || e?.message || e);
      }
    });
  } catch (e: any) {
    console.error('Provider auto-registration hook error:', e?.stack || e?.message || e);
  }
if (tracingEnabled) {
    // Setup all tracing hooks properly at the server level
    setupTracingHooks(server.app);
  }
  
  // Add auth and router middleware for standalone usage (e.g., tests)
  const { apiKeyAuth } = require('./middleware/auth');
  const { router } = require('./utils/router');
  
  server.app.addHook("preHandler", async (req, reply) => {
    return new Promise((resolve, reject) => {
      const done = (err?: Error) => {
        if (err) reject(err);
        else resolve();
      };
      apiKeyAuth(actualConfig)(req, reply, done).catch(reject);
    });
  });
  
  server.app.addHook("preHandler", async (req, reply) => {
    if(req.url.startsWith("/v1/messages")) {
      const context = (req as any).traceContext;
      if (context) {
        const { runWithTraceContext } = require('./tracing/context');
        await runWithTraceContext(context, async () => {
          await router(req, reply, actualConfig);
        });
      } else {
        await router(req, reply, actualConfig);
      }
    }
  });

  // Add endpoint to read config.json with access control
  server.app.get("/api/config", async (req, reply) => {
    // Get access level from request (set by auth middleware)
    const accessLevel = (req as any).accessLevel || "restricted";
    
    // If restricted access, return 401
    if (accessLevel === "restricted") {
      reply.status(401).send("API key required to access configuration");
      return;
    }
    
    // For full access (including temp API key), return complete config
    return await readConfigFile();
  });

  server.app.get("/api/transformers", async () => {
    const transformers =
      server.app._server!.transformerService.getAllTransformers();
    const transformerList = Array.from(transformers.entries()).map(
      ([name, transformer]: any) => ({
        name,
        endpoint: transformer.endPoint || null,
      })
    );
    return { transformers: transformerList };
  });

  // Add endpoint to save config.json with access control
  server.app.post("/api/config", async (req, reply) => {
    // Only allow full access users to save config
    const accessLevel = (req as any).accessLevel || "restricted";
    if (accessLevel !== "full") {
      reply.status(403).send("Full access required to modify configuration");
      return;
    }
    
    const newConfig = req.body;
    
    // Backup existing config file if it exists
    const { backupConfigFile } = await import("./utils");
    const backupPath = await backupConfigFile();
    if (backupPath) {
      console.log(`Backed up existing configuration file to ${backupPath}`);
    }
    
    await writeConfigFile(newConfig);
    return { success: true, message: "Config saved successfully" };
  });
  
  // Add endpoint for testing full access without modifying config
  server.app.post("/api/config/test", async (req, reply) => {
    // Only allow full access users to test config access
    const accessLevel = (req as any).accessLevel || "restricted";
    if (accessLevel !== "full") {
      reply.status(403).send("Full access required to test configuration access");
      return;
    }
    
    // Return success without modifying anything
    return { success: true, message: "Access granted" };
  });

  // Add endpoint to restart the service with access control
  server.app.post("/api/restart", async (req, reply) => {
    // Only allow full access users to restart service
    const accessLevel = (req as any).accessLevel || "restricted";
    if (accessLevel !== "full") {
      reply.status(403).send("Full access required to restart service");
      return;
    }
    
    reply.send({ success: true, message: "Service restart initiated" });

    // Restart the service after a short delay to allow response to be sent
    setTimeout(() => {
      const { spawn } = require("child_process");
      spawn(process.execPath, [process.argv[1], "restart"], { detached: true, stdio: "ignore" });
    }, 1000);
  });

  // Register static file serving with caching
  server.app.register(fastifyStatic, {
    root: join(__dirname, "..", "dist"),
    prefix: "/ui/",
    maxAge: "1h",
  });

  // Redirect /ui to /ui/ for proper static file serving
  server.app.get("/ui", async (_, reply) => {
    return reply.redirect("/ui/");
  });

  return server;
};
