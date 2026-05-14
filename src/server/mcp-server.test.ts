import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_MCP_PORT,
  createTamanduaMcpServer,
  startTamanduaMcpServer,
  stopTamanduaMcpServer,
  type TamanduaMcpServer,
} from "../../dist/server/mcp-server.js";

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

function initializeRequest(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "tamandua-test-client",
        version: "0.0.0",
      },
    },
  };
}

function parseJsonRpcBody(text: string): JsonRpcResponse | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as JsonRpcResponse;
  } catch {
    const sseDataLine = trimmed
      .split(/\r?\n/)
      .find((line) => line.startsWith("data:"));

    if (!sseDataLine) {
      throw new Error(`Unexpected response payload: ${trimmed}`);
    }

    return JSON.parse(sseDataLine.slice("data:".length).trim()) as JsonRpcResponse;
  }
}

async function postJsonRpc(
  port: number,
  payload: Record<string, unknown>,
  sessionId?: string,
): Promise<{ status: number; headers: Headers; body: JsonRpcResponse | undefined }> {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });

  if (sessionId) {
    headers.set("mcp-session-id", sessionId);
  }

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  const body = parseJsonRpcBody(text);

  return { status: response.status, headers: response.headers, body };
}

async function initializeSession(port: number): Promise<string> {
  const initialize = await postJsonRpc(port, initializeRequest(1));
  assert.equal(initialize.status, 200);
  assert.ok(initialize.body?.result, "initialize should return a result");
  assert.equal(initialize.body?.error, undefined);

  const sessionId = initialize.headers.get("mcp-session-id");
  assert.ok(sessionId, "initialize response should include mcp-session-id");

  const initialized = await postJsonRpc(
    port,
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
    sessionId ?? undefined,
  );

  assert.ok(
    [200, 202, 204].includes(initialized.status),
    `unexpected initialized status ${initialized.status}`,
  );

  return sessionId as string;
}

async function callTool(
  port: number,
  sessionId: string,
  id: number,
  toolName: string,
  toolArguments?: unknown,
): Promise<{ status: number; headers: Headers; body: JsonRpcResponse | undefined }> {
  const params: Record<string, unknown> = { name: toolName };
  if (toolArguments !== undefined) {
    params.arguments = toolArguments;
  }

  return postJsonRpc(
    port,
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params,
    },
    sessionId,
  );
}

describe("mcp-server bootstrap", () => {
  it("exports the fixed default MCP port", () => {
    assert.equal(DEFAULT_MCP_PORT, 3338);
  });

  it("supports initialize, tools/list, and tools/call over HTTP", async () => {
    const runListCalls: number[] = [];
    const runStatusCalls: string[] = [];
    const runStartCalls: Array<{ workflowId: string; taskTitle: string; workingDirectoryForHarness: string }> = [];
    const eventCalls: number[] = [];
    const sourcePathCalls: string[] = [];

    const expectedRuns = [
      {
        id: "run-abc",
        workflowId: "feature-dev",
        task: "Implement MCP tools",
        status: "running",
        createdAt: "2026-05-02T15:00:00.000Z",
        updatedAt: "2026-05-02T15:05:00.000Z",
        stepSummary: "running:1",
        tokensSpent: 0,
      },
    ];

    const expectedRunDetail = {
      ...expectedRuns[0],
      steps: [
        {
          stepId: "story",
          agentId: "feature-dev_developer",
          status: "running",
          type: "single",
          retryCount: 0,
        },
      ],
    };

    const expectedEvents = [
      {
        ts: "2026-05-02T15:05:01.000Z",
        event: "step.started",
        runId: "run-abc",
      },
    ];

    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: (limit = 50) => {
          runListCalls.push(limit);
          return expectedRuns;
        },
        getWorkflowStatus: (query) => {
          runStatusCalls.push(query);
          return expectedRunDetail;
        },
        runWorkflow: async ({ workflowId, taskTitle, workingDirectoryForHarness }) => {
          runStartCalls.push({ workflowId, taskTitle, workingDirectoryForHarness });
          return {
            runId: "run-new",
            runNumber: 9,
            workflowId,
            taskTitle,
            status: "running",
            stepCount: 1,
            workingDirectoryForHarness,
          };
        },
        getRecentEvents: (limit = 50) => {
          eventCalls.push(limit);
          return expectedEvents;
        },
        getSourcePath: () => {
          sourcePathCalls.push("called");
          return "/tmp/tamandua-source";
        },
        pauseRun: async (runId, _drain) => {
          return { runId, status: "paused" };
        },
        resumeRun: async (runId) => {
          return { runId, status: "running" };
        },
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      const toolsList = await postJsonRpc(
        server.port,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        },
        sessionId,
      );

      assert.equal(toolsList.status, 200);
      assert.equal(toolsList.body?.error, undefined);

      const tools = (toolsList.body?.result?.tools ?? []) as Array<Record<string, unknown>>;
      assert.deepEqual(
        tools.map((tool) => tool.name),
        [
          "tamandua.runs.list",
          "tamandua.run.status",
          "tamandua.run.start",
          "tamandua.events.recent",
          "tamandua.run.pause",
          "tamandua.run.resume",
          "tamandua.skill.path",
          "tamandua.source.path",
          "tamandua.update.command",
        ],
      );
      assert.deepEqual((tools[0]?.inputSchema as { properties?: Record<string, unknown> }).properties?.limit, {
        type: "integer",
        minimum: 1,
        maximum: 200,
        description: "Maximum number of runs to return (default 50).",
      });
      assert.deepEqual((tools[1]?.inputSchema as { required?: string[] }).required, ["query"]);
      assert.deepEqual((tools[2]?.inputSchema as { required?: string[] }).required, ["workflowId", "taskTitle", "workingDirectoryForHarness"]);

      const runsList = await callTool(server.port, sessionId, 3, "tamandua.runs.list", { limit: 10 });
      assert.equal(runsList.status, 200);
      assert.equal(runsList.body?.error, undefined);
      assert.deepEqual(runsList.body?.result?.structuredContent, { runs: expectedRuns });
      assert.deepEqual(runListCalls, [10]);

      const runStatus = await callTool(server.port, sessionId, 4, "tamandua.run.status", { query: "run-ab" });
      assert.equal(runStatus.status, 200);
      assert.equal(runStatus.body?.error, undefined);
      assert.deepEqual(runStatus.body?.result?.structuredContent, { run: expectedRunDetail });
      assert.deepEqual(runStatusCalls, ["run-ab"]);

      const runStart = await callTool(server.port, sessionId, 5, "tamandua.run.start", {
        workflowId: "feature-dev",
        taskTitle: "Implement MCP start",
        workingDirectoryForHarness: "/tmp/remote-harness",
      });
      assert.equal(runStart.status, 200);
      assert.equal(runStart.body?.error, undefined);
      assert.deepEqual(runStart.body?.result?.structuredContent, {
        run: {
          runId: "run-new",
          runNumber: 9,
          workflowId: "feature-dev",
          taskTitle: "Implement MCP start",
          status: "running",
          stepCount: 1,
          workingDirectoryForHarness: "/tmp/remote-harness",
        },
      });
      assert.deepEqual(runStartCalls, [{
        workflowId: "feature-dev",
        taskTitle: "Implement MCP start",
        workingDirectoryForHarness: "/tmp/remote-harness",
      }]);

      const eventsRecent = await callTool(server.port, sessionId, 6, "tamandua.events.recent", { limit: 7 });
      assert.equal(eventsRecent.status, 200);
      assert.equal(eventsRecent.body?.error, undefined);
      assert.deepEqual(eventsRecent.body?.result?.structuredContent, { events: expectedEvents });
      assert.deepEqual(eventCalls, [7]);

      const sourcePath = await callTool(server.port, sessionId, 7, "tamandua.source.path", {});
      assert.equal(sourcePath.status, 200);
      assert.equal(sourcePath.body?.error, undefined);
      assert.deepEqual(sourcePath.body?.result?.structuredContent, { sourcePath: "/tmp/tamandua-source" });
      assert.deepEqual(sourcePathCalls, ["called"]);

      const updateCommand = await callTool(server.port, sessionId, 8, "tamandua.update.command", {});
      assert.equal(updateCommand.status, 200);
      assert.equal(updateCommand.body?.error, undefined);
      assert.match(updateCommand.body?.result?.structuredContent?.command, /tamandua update/);
      assert.match(updateCommand.body?.result?.structuredContent?.safety, /local CLI/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("returns MCP invalid-params errors for bad tool arguments without crashing the session", async () => {
    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => {
          throw new Error("should not be called for invalid args");
        },
        runWorkflow: async () => {
          throw new Error("should not be called for invalid args");
        },
        getRecentEvents: () => [],
        pauseRun: async () => {
          throw new Error("should not be called for invalid args");
        },
        resumeRun: async () => {
          throw new Error("should not be called for invalid args");
        },
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      const missingQuery = await callTool(server.port, sessionId, 10, "tamandua.run.status", {});
      assert.equal(missingQuery.status, 200);
      assert.equal(missingQuery.body?.result, undefined);
      assert.equal(missingQuery.body?.error?.code, -32602);
      assert.match(missingQuery.body?.error?.message ?? "", /query/);

      const badLimitType = await callTool(server.port, sessionId, 11, "tamandua.runs.list", { limit: "25" });
      assert.equal(badLimitType.status, 200);
      assert.equal(badLimitType.body?.result, undefined);
      assert.equal(badLimitType.body?.error?.code, -32602);
      assert.match(badLimitType.body?.error?.message ?? "", /limit/);

      const missingHarnessDir = await callTool(server.port, sessionId, 12, "tamandua.run.start", {
        workflowId: "feature-dev",
        taskTitle: "remote run",
      });
      assert.equal(missingHarnessDir.status, 200);
      assert.equal(missingHarnessDir.body?.result, undefined);
      assert.equal(missingHarnessDir.body?.error?.code, -32602);
      assert.match(missingHarnessDir.body?.error?.message ?? "", /workingDirectoryForHarness/);

      const validAfterErrors = await callTool(server.port, sessionId, 13, "tamandua.events.recent", { limit: 3 });
      assert.equal(validAfterErrors.status, 200);
      assert.equal(validAfterErrors.body?.error, undefined);
      assert.deepEqual(validAfterErrors.body?.result?.structuredContent, { events: [] });
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("supports tamandua.run.pause and tamandua.run.resume tools", async () => {
    const pauseCalls: Array<{ runId: string; drain: boolean }> = [];
    const resumeCalls: string[] = [];

    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({} as any),
        runWorkflow: async () => ({ runId: "x", runNumber: 1, workflowId: "x", taskTitle: "x", status: "running", stepCount: 0, workingDirectoryForHarness: "/x" }),
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        pauseRun: async (runId, drain = false) => {
          pauseCalls.push({ runId, drain });
          return { runId, status: drain ? "draining_pause" : "paused" };
        },
        resumeRun: async (runId) => {
          resumeCalls.push(runId);
          return { runId, status: "running" };
        },
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      // Test pause (immediate)
      const pauseResult = await callTool(server.port, sessionId, 20, "tamandua.run.pause", { runId: "run-abc" });
      assert.equal(pauseResult.status, 200);
      assert.equal(pauseResult.body?.error, undefined);
      assert.deepEqual(pauseResult.body?.result?.structuredContent, { runId: "run-abc", status: "paused" });
      assert.deepEqual(pauseCalls, [{ runId: "run-abc", drain: false }]);

      // Test pause with drain
      const pauseDrainResult = await callTool(server.port, sessionId, 21, "tamandua.run.pause", { runId: "run-def", drain: true });
      assert.equal(pauseDrainResult.status, 200);
      assert.equal(pauseDrainResult.body?.error, undefined);
      assert.deepEqual(pauseDrainResult.body?.result?.structuredContent, { runId: "run-def", status: "draining_pause" });
      assert.deepEqual(pauseCalls, [{ runId: "run-abc", drain: false }, { runId: "run-def", drain: true }]);

      // Test resume
      const resumeResult = await callTool(server.port, sessionId, 22, "tamandua.run.resume", { runId: "run-abc" });
      assert.equal(resumeResult.status, 200);
      assert.equal(resumeResult.body?.error, undefined);
      assert.deepEqual(resumeResult.body?.result?.structuredContent, { runId: "run-abc", status: "running" });
      assert.deepEqual(resumeCalls, ["run-abc"]);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("pause run rejects terminal runs with MCP error", async () => {
    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({} as any),
        runWorkflow: async () => ({ runId: "x", runNumber: 1, workflowId: "x", taskTitle: "x", status: "running", stepCount: 0, workingDirectoryForHarness: "/x" }),
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        pauseRun: async () => {
          throw new Error("Run is terminal: completed");
        },
        resumeRun: async () => {
          throw new Error("should not be called");
        },
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      const result = await callTool(server.port, sessionId, 30, "tamandua.run.pause", { runId: "run-terminal" });
      assert.equal(result.status, 200);
      assert.equal(result.body?.result, undefined);
      assert.equal(result.body?.error?.code, -32602);
      assert.match(result.body?.error?.message ?? "", /terminal/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("pause and resume tools require runId argument", async () => {
    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => ({} as any),
        runWorkflow: async () => ({ runId: "x", runNumber: 1, workflowId: "x", taskTitle: "x", status: "running", stepCount: 0, workingDirectoryForHarness: "/x" }),
        getRecentEvents: () => [],
        getSourcePath: () => "/x",
        pauseRun: async () => {
          throw new Error("should not be called");
        },
        resumeRun: async () => {
          throw new Error("should not be called");
        },
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      const missingRunIdPause = await callTool(server.port, sessionId, 40, "tamandua.run.pause", {});
      assert.equal(missingRunIdPause.status, 200);
      assert.equal(missingRunIdPause.body?.result, undefined);
      assert.equal(missingRunIdPause.body?.error?.code, -32602);
      assert.match(missingRunIdPause.body?.error?.message ?? "", /runId/);

      const missingRunIdResume = await callTool(server.port, sessionId, 41, "tamandua.run.resume", {});
      assert.equal(missingRunIdResume.status, 200);
      assert.equal(missingRunIdResume.body?.result, undefined);
      assert.equal(missingRunIdResume.body?.error?.code, -32602);
      assert.match(missingRunIdResume.body?.error?.message ?? "", /runId/);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("factory creates start/stop capable server handles", async () => {
    const server: TamanduaMcpServer = createTamanduaMcpServer(0);
    await server.start();
    assert.equal(server.server.listening, true);

    await server.stop();
    assert.equal(server.server.listening, false);
  });
});
