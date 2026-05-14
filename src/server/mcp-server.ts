import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { getWorkflowStatus, listRuns, type RunDetail, type RunInfo } from "../installer/status.js";
import { runWorkflow, type RunWorkflowResult } from "../installer/run.js";
import { getRecentEvents, type TamanduaEvent } from "../installer/events.js";
import { resolveSourcePath, resolveSkillPath } from "../installer/paths.js";
import { pauseRunWithDaemon, resumeRunWithDaemon } from "./control-client.js";

export const DEFAULT_MCP_PORT = 3338;
export const MCP_ENDPOINT_PATH = "/mcp";

const MCP_TOOL_RUNS_LIST = "tamandua.runs.list";
const MCP_TOOL_RUN_STATUS = "tamandua.run.status";
const MCP_TOOL_RUN_START = "tamandua.run.start";
const MCP_TOOL_RUN_PAUSE = "tamandua.run.pause";
const MCP_TOOL_RUN_RESUME = "tamandua.run.resume";
const MCP_TOOL_EVENTS_RECENT = "tamandua.events.recent";
const MCP_TOOL_SKILL_PATH = "tamandua.skill.path";
const MCP_TOOL_SOURCE_PATH = "tamandua.source.path";
const MCP_TOOL_UPDATE_COMMAND = "tamandua.update.command";

type McpSession = {
  protocolServer: Server;
  transport: StreamableHTTPServerTransport;
};

export interface TamanduaMcpToolServices {
  listRuns: (limit?: number) => RunInfo[];
  getWorkflowStatus: (query: string) => RunDetail;
  runWorkflow: (params: {
    workflowId: string;
    taskTitle: string;
    workingDirectoryForHarness: string;
  }) => Promise<RunWorkflowResult>;
  getRecentEvents: (limit?: number) => TamanduaEvent[];
  getSourcePath: () => string;
  getSkillPath: () => string;
  pauseRun: (runId: string, drain?: boolean) => Promise<{ runId: string; status: string }>;
  resumeRun: (runId: string) => Promise<{ runId: string; status: string }>;
}

export type TamanduaMcpServerOptions = {
  services?: Partial<TamanduaMcpToolServices>;
};

export type TamanduaMcpServer = {
  readonly server: http.Server;
  readonly port: number;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

const defaultToolServices: TamanduaMcpToolServices = {
  listRuns,
  getWorkflowStatus,
  runWorkflow,
  getRecentEvents,
  getSourcePath: resolveSourcePath,
  getSkillPath: resolveSkillPath,
  async pauseRun(runId, drain = false) {
    const r = await pauseRunWithDaemon(runId, drain);
    if (!r) throw new Error("Daemon control plane unreachable");
    if (r.body.error) throw new Error(String(r.body.error));
    return { runId, status: String(r.body.state ?? r.status) };
  },
  async resumeRun(runId) {
    const r = await resumeRunWithDaemon(runId);
    if (!r) throw new Error("Daemon control plane unreachable");
    if (r.body.error) throw new Error(String(r.body.error));
    return { runId, status: String(r.body.state ?? r.status) };
  },
};

const mcpTools: Array<Record<string, unknown>> = [
  {
    name: MCP_TOOL_RUNS_LIST,
    title: "List Tamandua Runs",
    description: "List recent Tamandua workflow runs.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum number of runs to return (default 50).",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["runs"],
      properties: {
        runs: {
          type: "array",
          description: "Run metadata returned by listRuns().",
          items: { type: "object" },
        },
      },
    },
  },
  {
    name: MCP_TOOL_RUN_STATUS,
    title: "Get Tamandua Run Status",
    description: "Fetch detailed status for a run by id, prefix, or task query.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "Run id, run id prefix, or task substring.",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["run"],
      properties: {
        run: {
          type: "object",
          description: "Detailed run status returned by getWorkflowStatus().",
        },
      },
    },
  },
  {
    name: MCP_TOOL_RUN_START,
    title: "Start Tamandua Run",
    description: "Start a workflow run. For remote safety, workingDirectoryForHarness is required.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workflowId", "taskTitle", "workingDirectoryForHarness"],
      properties: {
        workflowId: {
          type: "string",
          minLength: 1,
          description: "Workflow id to run.",
        },
        taskTitle: {
          type: "string",
          minLength: 1,
          description: "Task description for the workflow run.",
        },
        workingDirectoryForHarness: {
          type: "string",
          minLength: 1,
          description: "Mandatory harness working directory for remote MCP runs.",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["run"],
      properties: {
        run: {
          type: "object",
          description: "Run metadata returned by runWorkflow().",
        },
      },
    },
  },
  {
    name: MCP_TOOL_EVENTS_RECENT,
    title: "Get Recent Tamandua Events",
    description: "List recent global Tamandua events.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum number of events to return (default 50).",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["events"],
      properties: {
        events: {
          type: "array",
          description: "Event records returned by getRecentEvents().",
          items: { type: "object" },
        },
      },
    },
  },
  {
    name: MCP_TOOL_RUN_PAUSE,
    title: "Pause Tamandua Run",
    description: "Pause a running Tamandua workflow run. Optionally drain in-flight work before pausing.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: {
          type: "string",
          minLength: 1,
          description: "Run id to pause.",
        },
        drain: {
          type: "boolean",
          description: "If true, wait for in-flight work to complete before pausing (default false).",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["runId", "status"],
      properties: {
        runId: { type: "string", description: "Run id that was paused." },
        status: { type: "string", description: "New run status after pause." },
      },
    },
  },
  {
    name: MCP_TOOL_RUN_RESUME,
    title: "Resume Tamandua Run",
    description: "Resume a paused Tamandua workflow run.",
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: {
          type: "string",
          minLength: 1,
          description: "Run id to resume.",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["runId", "status"],
      properties: {
        runId: { type: "string", description: "Run id that was resumed." },
        status: { type: "string", description: "New run status after resume." },
      },
    },
  },
  {
    name: MCP_TOOL_SKILL_PATH,
    title: "Get Tamandua Skill Path",
    description: "Return the path to the bundled tamandua-agents skill that teaches agents how to operate Tamandua.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    outputSchema: {
      type: "object",
      required: ["skillPath"],
      properties: {
        skillPath: {
          type: "string",
          description: "Absolute path to the bundled tamandua-agents skill file.",
        },
      },
    },
  },
  {
    name: MCP_TOOL_SOURCE_PATH,
    title: "Get Tamandua Source Path",
    description: "Return the local Tamandua source checkout path.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    outputSchema: {
      type: "object",
      required: ["sourcePath"],
      properties: {
        sourcePath: {
          type: "string",
          description: "Tamandua source checkout path.",
        },
      },
    },
  },
  {
    name: MCP_TOOL_UPDATE_COMMAND,
    title: "Get Tamandua Update Command",
    description: "Return local CLI guidance for updating Tamandua safely.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    outputSchema: {
      type: "object",
      required: ["command", "description", "safety"],
      properties: {
        command: {
          type: "string",
          description: "The local CLI command.",
        },
        description: {
          type: "string",
          description: "What the command does.",
        },
        safety: {
          type: "string",
          description: "Important service lifecycle guidance.",
        },
      },
    },
  },
];

function invalidParams(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, message);
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    invalidParams("Tool arguments must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

function readLimitArgument(args: Record<string, unknown>, defaultValue: number, max: number): number {
  const rawLimit = args.limit;
  if (rawLimit === undefined) return defaultValue;
  if (!Number.isInteger(rawLimit)) {
    invalidParams('Argument "limit" must be an integer');
  }

  const limit = Number(rawLimit);
  if (limit < 1 || limit > max) {
    invalidParams(`Argument "limit" must be between 1 and ${max}`);
  }

  return limit;
}

function readRequiredStringArgument(args: Record<string, unknown>, key: string): string {
  const rawValue = args[key];
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    invalidParams(`Argument "${key}" must be a non-empty string`);
  }
  return rawValue.trim();
}

function readRequiredQuery(args: Record<string, unknown>): string {
  return readRequiredStringArgument(args, "query");
}

function createToolResult(payload: Record<string, unknown>): { content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function createProtocolServer(services: TamanduaMcpToolServices): Server {
  const server = new Server(
    {
      name: "tamandua-remote-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = parseToolArguments(request.params.arguments);

    if (name === MCP_TOOL_RUNS_LIST) {
      const limit = readLimitArgument(args, 50, 200);
      return createToolResult({ runs: services.listRuns(limit) });
    }

    if (name === MCP_TOOL_RUN_STATUS) {
      const query = readRequiredQuery(args);
      try {
        return createToolResult({ run: services.getWorkflowStatus(query) });
      } catch (err) {
        throw new McpError(ErrorCode.InvalidParams, (err as Error).message);
      }
    }

    if (name === MCP_TOOL_RUN_START) {
      const workflowId = readRequiredStringArgument(args, "workflowId");
      const taskTitle = readRequiredStringArgument(args, "taskTitle");
      const workingDirectoryForHarness = readRequiredStringArgument(args, "workingDirectoryForHarness");
      try {
        const run = await services.runWorkflow({
          workflowId,
          taskTitle,
          workingDirectoryForHarness,
        });
        return createToolResult({ run });
      } catch (err) {
        throw new McpError(ErrorCode.InvalidParams, (err as Error).message);
      }
    }

    if (name === MCP_TOOL_EVENTS_RECENT) {
      const limit = readLimitArgument(args, 50, 500);
      return createToolResult({ events: services.getRecentEvents(limit) });
    }

    if (name === MCP_TOOL_RUN_PAUSE) {
      const runId = readRequiredStringArgument(args, "runId");
      const drain = args.drain === true;
      try {
        const result = await services.pauseRun(runId, drain);
        return createToolResult({ runId: result.runId, status: result.status });
      } catch (err) {
        throw new McpError(ErrorCode.InvalidParams, (err as Error).message);
      }
    }

    if (name === MCP_TOOL_RUN_RESUME) {
      const runId = readRequiredStringArgument(args, "runId");
      try {
        const result = await services.resumeRun(runId);
        return createToolResult({ runId: result.runId, status: result.status });
      } catch (err) {
        throw new McpError(ErrorCode.InvalidParams, (err as Error).message);
      }
    }

    if (name === MCP_TOOL_SKILL_PATH) {
      return createToolResult({ skillPath: services.getSkillPath() });
    }

    if (name === MCP_TOOL_SOURCE_PATH) {
      return createToolResult({ sourcePath: services.getSourcePath() });
    }

    if (name === MCP_TOOL_UPDATE_COMMAND) {
      return createToolResult({
        command: "tamandua update [--force]",
        description:
          "Runs git pull in the Tamandua source checkout, rebuilds when the pulled HEAD changes, reinstalls bundled workflows, and restarts previously running Tamandua services when safe.",
        safety:
          "Run this command through the local CLI. The update process manages dashboard, MCP, and control-plane lifecycle; without --force it refuses the service reinstall/restart step while Tamandua runs are active.",
      });
    }

    throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
  });

  return server;
}

function getSessionId(req: http.IncomingMessage): string | undefined {
  const raw = req.headers["mcp-session-id"];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function respondJsonRpcError(
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
  id: string | number | null = null,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id,
    }),
  );
}

async function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalLength = 0;

  for await (const chunk of req) {
    const piece = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    chunks.push(piece);
    totalLength += piece.length;
    if (totalLength > 1024 * 1024) {
      throw new Error("Request body too large");
    }
  }

  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    throw new Error("Missing JSON-RPC request body");
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON payload");
  }
}

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export function createTamanduaMcpServer(port = DEFAULT_MCP_PORT, options: TamanduaMcpServerOptions = {}): TamanduaMcpServer {
  const sessions = new Map<string, McpSession>();
  const services: TamanduaMcpToolServices = {
    ...defaultToolServices,
    ...options.services,
  };

  const httpServer = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const pathname = (req.url ?? "/").split("?")[0];

    if (pathname !== MCP_ENDPOINT_PATH) {
      respondJsonRpcError(res, 404, -32601, `Not found: ${method} ${pathname}`);
      return;
    }

    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      respondJsonRpcError(res, 405, -32600, `Unsupported method: ${method}`);
      return;
    }

    try {
      if (method === "POST") {
        const body = await parseJsonBody(req);
        const sessionId = getSessionId(req);

        if (sessionId) {
          const session = sessions.get(sessionId);
          if (!session) {
            respondJsonRpcError(res, 404, -32001, "Unknown MCP session", null);
            return;
          }

          await session.transport.handleRequest(req, res, body);
          return;
        }

        if (!isInitializeRequest(body)) {
          respondJsonRpcError(res, 400, -32600, "Expected initialize request for new MCP session", null);
          return;
        }

        const protocolServer = createProtocolServer(services);
        let transport: StreamableHTTPServerTransport;

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { protocolServer, transport });
          },
        });

        transport.onclose = () => {
          const activeSessionId = transport.sessionId;
          if (activeSessionId) {
            sessions.delete(activeSessionId);
          }
        };

        await protocolServer.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      const sessionId = getSessionId(req);
      if (!sessionId) {
        respondJsonRpcError(res, 400, -32600, "Missing mcp-session-id header", null);
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        respondJsonRpcError(res, 404, -32001, "Unknown MCP session", null);
        return;
      }

      await session.transport.handleRequest(req, res);
    } catch (err) {
      respondJsonRpcError(res, 500, -32603, (err as Error).message, null);
    }
  });

  let activePort = port;

  async function start(): Promise<void> {
    if (httpServer.listening) return;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };

      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port);
    });

    const address = httpServer.address();
    if (address && typeof address !== "string") {
      activePort = address.port;
    }
  }

  async function stop(): Promise<void> {
    const snapshot = Array.from(sessions.values());
    sessions.clear();

    await Promise.allSettled(
      snapshot.map(async (session) => {
        await session.transport.close();
        await session.protocolServer.close();
      }),
    );

    if (httpServer.listening) {
      await closeHttpServer(httpServer);
    }
  }

  return {
    server: httpServer,
    get port() {
      return activePort;
    },
    start,
    stop,
  };
}

export async function startTamanduaMcpServer(
  port = DEFAULT_MCP_PORT,
  options: TamanduaMcpServerOptions = {},
): Promise<TamanduaMcpServer> {
  const server = createTamanduaMcpServer(port, options);
  await server.start();
  return server;
}

export async function stopTamanduaMcpServer(server: TamanduaMcpServer): Promise<void> {
  await server.stop();
}
