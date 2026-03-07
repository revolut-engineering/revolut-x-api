import type { StreamableHTTPServerTransport as StreamableHTTPServerTransportType } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const MCP_PORT = Number(process.env.MCP_PORT ?? 8000);
const MCP_HOST = process.env.MCP_HOST ?? "0.0.0.0";

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runHttp(): Promise<void> {
  const { randomUUID } = await import("node:crypto");
  const { createMcpExpressApp } =
    await import("@modelcontextprotocol/sdk/server/express.js");
  const { StreamableHTTPServerTransport } =
    await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { isInitializeRequest } =
    await import("@modelcontextprotocol/sdk/types.js");

  const transports: Record<string, StreamableHTTPServerTransportType> = {};
  const app = createMcpExpressApp({
    host: MCP_HOST,
    allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
  });

  const mcpPostHandler = async (
    req: {
      headers: { [key: string]: string | string[] | undefined };
      body: unknown;
    },
    res: {
      status: (n: number) => { json: (o: object) => void };
      headersSent: boolean;
    },
  ): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    try {
      let transport: StreamableHTTPServerTransportType;
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) delete transports[sid];
        };
        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req as never, res as never, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
        return;
      }
      await transport.handleRequest(req as never, res as never, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  const mcpGetHandler = async (
    req: { headers: { [key: string]: string | string[] | undefined } },
    res: { status: (n: number) => { send: (s: string) => void } },
  ): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req as never, res as never);
  };

  const mcpDeleteHandler = async (
    req: { headers: { [key: string]: string | string[] | undefined } },
    res: {
      status: (n: number) => { send: (s: string) => void };
      headersSent: boolean;
    },
  ): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    try {
      await transports[sessionId].handleRequest(req as never, res as never);
    } catch (error) {
      console.error("Error handling session termination:", error);
      if (!res.headersSent)
        res.status(500).send("Error processing session termination");
    }
  };

  app.post("/mcp", mcpPostHandler);
  app.get("/mcp", mcpGetHandler);
  app.delete("/mcp", mcpDeleteHandler);

  app.listen(MCP_PORT, () => {
    console.log(
      `RevolutX MCP HTTP server listening on ${MCP_HOST}:${MCP_PORT}`,
    );
  });

  process.on("SIGINT", async () => {
    for (const sid of Object.keys(transports)) {
      try {
        await transports[sid].close();
      } catch (e) {
        console.error("Error closing transport:", e);
      }
      delete transports[sid];
    }
    process.exit(0);
  });
}

async function main(): Promise<void> {
  const useHttp =
    process.argv.includes("--transport") &&
    process.argv[process.argv.indexOf("--transport") + 1] === "http";
  if (useHttp) {
    await runHttp();
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
