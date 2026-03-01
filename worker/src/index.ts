import { loadSettings } from "./config.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  // Parse --config-dir first (must set env before loadSettings resolves paths)
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config-dir" && args[i + 1]) {
      process.env["REVOLUTX_CONFIG_DIR"] = args[++i];
    }
  }

  const settings = loadSettings();

  // Parse remaining CLI args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--host" && args[i + 1]) {
      settings.host = args[++i];
    } else if (args[i] === "--port" && args[i + 1]) {
      settings.port = Number(args[++i]);
    }
  }

  const app = await buildApp(settings);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down...`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    const address = await app.listen({ host: settings.host, port: settings.port });
    console.log(`RevolutX Worker listening on ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
