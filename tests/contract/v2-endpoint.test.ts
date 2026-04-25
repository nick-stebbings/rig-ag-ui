import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

/**
 * Mock the SessionBridge and AguiStreamHandler before importing the app.
 * This avoids real HTTP calls to the Rig backend and real SSE stream setup.
 */

// Mock the session bridge module
vi.mock("../../src/session/session_bridge", () => {
	const mockSessionBridge = {
		createSession: vi.fn().mockResolvedValue({ sessionId: "mock-session" }),
		associateStreamSession: vi.fn(),
		startAgentRun: vi.fn().mockResolvedValue(undefined),
		getSession: vi.fn().mockReturnValue(null),
		getSessionState: vi.fn().mockReturnValue(null),
		getAgentState: vi.fn().mockReturnValue(null),
		listSessions: vi.fn().mockReturnValue([]),
		getSessionStats: vi
			.fn()
			.mockReturnValue({ totalSessions: 0, activeSessions: 0 }),
		interruptAgentRun: vi.fn().mockResolvedValue(false),
		healthCheck: vi
			.fn()
			.mockResolvedValue({ rigApiConnected: true, uptime: 100 }),
		destroy: vi.fn(),
	};

	return {
		SessionBridge: vi.fn(() => mockSessionBridge),
	};
});

// Mock the stream handler — createAguiStream sets SSE headers on the response
vi.mock("../../src/streaming/agui_stream", () => {
	const mockStreamHandler = {
		createAguiStream: vi.fn(
			(
				res: {
					writeHead: (
						status: number,
						headers: Record<string, string>,
					) => void;
					write: (chunk: string) => void;
					end: () => void;
				},
				_runId: string,
				_threadId?: string,
				_clientId?: string,
			) => {
				// Simulate what the real handler does: set SSE headers, write bare data lines, then end
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});
				// Write a bare data: line (V2 format — no event: prefix)
				res.write(
					`data: ${JSON.stringify({ type: "RUN_STARTED", threadId: "mock-thread", runId: _runId })}\n\n`,
				);
				// End the response so supertest does not hang
				res.end();
				return "mock-stream-session-id";
			},
		),
		destroy: vi.fn(),
	};

	return {
		AguiStreamHandler: vi.fn(() => mockStreamHandler),
	};
});

// Mock tracing/metrics middleware to no-ops
vi.mock("../../src/middleware/tracing", () => ({
	tracingMiddleware: () =>
		(_req: unknown, _res: unknown, next: () => void) => next(),
	createChildSpan: () => "mock-span",
	endChildSpan: vi.fn(),
	logTraceEvent: vi.fn(),
}));

vi.mock("../../src/middleware/metrics", () => ({
	metricsMiddleware: () =>
		(_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Now import the app after mocks are registered
import { AguiMiddlewareApp } from "../../src/app";

// ── Helpers ──────────────────────────────────────────────────────────────────

function validV2Body(overrides: Record<string, unknown> = {}) {
	return {
		threadId: "thread-001",
		runId: "run-001",
		messages: [
			{
				id: "msg-1",
				role: "user",
				content: "Hello, agent",
			},
		],
		...overrides,
	};
}

const V2_RUN_ENDPOINT = "/copilotkit/agent/general/run";

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("AG-UI V2 REST+SSE endpoint contract tests", () => {
	let app: Express;

	beforeAll(() => {
		// Ensure dev mode so auth middleware skips API-key check for localhost
		process.env.NODE_ENV = "development";

		const middleware = new AguiMiddlewareApp();
		app = middleware.getApp();
	});

	afterAll(() => {
		delete process.env.NODE_ENV;
	});

	// ── Health check ───────────────────────────────────────────────────────

	describe("GET /health", () => {
		it("should return 200 with health status", async () => {
			const res = await request(app).get("/health");

			expect(res.status).toBe(200);
			expect(res.body).toHaveProperty("status");
			expect(res.body).toHaveProperty("service", "ag-ui-middleware");
			expect(res.body).toHaveProperty("version", "0.1.0");
		});
	});

	// ── GET /copilotkit/info ──────────────────────────────────────────────

	describe("GET /copilotkit/info", () => {
		it("should return 200 with agents list", async () => {
			const res = await request(app).get("/copilotkit/info");

			expect(res.status).toBe(200);
			expect(res.body).toHaveProperty("agents");
			expect(Array.isArray(res.body.agents)).toBe(true);
			expect(res.body.agents.length).toBeGreaterThan(0);
			expect(res.body.agents[0]).toHaveProperty("name");
			expect(res.body.agents[0]).toHaveProperty("description");
		});

		it("should include runtime metadata", async () => {
			const res = await request(app).get("/copilotkit/info");

			expect(res.status).toBe(200);
			expect(res.body).toHaveProperty("runtime");
			expect(res.body.runtime).toHaveProperty("version", "0.1.0");
			expect(res.body.runtime).toHaveProperty("service", "ag-ui-middleware");
		});
	});

	// ── POST /copilotkit/agent/:agentId/run — valid requests ─────────────

	describe("POST /copilotkit/agent/:agentId/run — valid requests", () => {
		it("should return 200 with SSE Content-Type for a valid body", async () => {
			const res = await request(app)
				.post(V2_RUN_ENDPOINT)
				.send(validV2Body())
				.set("Content-Type", "application/json");

			expect(res.status).toBe(200);
			expect(res.headers["content-type"]).toContain("text/event-stream");
		});

		it("should accept optional tools array", async () => {
			const res = await request(app)
				.post(V2_RUN_ENDPOINT)
				.send(
					validV2Body({
						tools: [
							{
								name: "get_weather",
								description: "Get weather for a city",
								parameters: {
									type: "object",
									properties: { city: { type: "string" } },
								},
							},
						],
					}),
				)
				.set("Content-Type", "application/json");

			expect(res.status).toBe(200);
		});

		it("should accept context, state, and forwardedProps fields", async () => {
			const res = await request(app)
				.post(V2_RUN_ENDPOINT)
				.send(
					validV2Body({
						context: [
							{ description: "User timezone", value: "America/New_York" },
						],
						state: { counter: 0 },
						forwardedProps: { theme: "dark" },
					}),
				)
				.set("Content-Type", "application/json");

			expect(res.status).toBe(200);
		});

		it("should accept expanded message roles (developer, tool, activity, reasoning)", async () => {
			const res = await request(app)
				.post(V2_RUN_ENDPOINT)
				.send(
					validV2Body({
						messages: [
							{ id: "msg-1", role: "user", content: "Hello" },
							{ id: "msg-2", role: "developer", content: "System prompt" },
							{
								id: "msg-3",
								role: "tool",
								content: "result",
								toolCallId: "tc-1",
							},
						],
					}),
				)
				.set("Content-Type", "application/json");

			expect(res.status).toBe(200);
		});
	});

	// ── POST /copilotkit/agent/:agentId/run — request validation ─────────

	describe("POST /copilotkit/agent/:agentId/run — request validation", () => {
		it("should return 400 when messages field is missing", async () => {
			const res = await request(app)
				.post(V2_RUN_ENDPOINT)
				.send({ threadId: "t-1", runId: "r-1", tools: [] })
				.set("Content-Type", "application/json");

			expect(res.status).toBe(400);
			expect(res.body).toHaveProperty("error", "VALIDATION_ERROR");
		});

		it("should return 400 when messages array is empty", async () => {
			const res = await request(app)
				.post(V2_RUN_ENDPOINT)
				.send({ threadId: "t-1", runId: "r-1", messages: [] })
				.set("Content-Type", "application/json");

			expect(res.status).toBe(400);
			expect(res.body).toHaveProperty("error", "VALIDATION_ERROR");
		});

		it("should return 400 when threadId is missing", async () => {
			const res = await request(app)
				.post(V2_RUN_ENDPOINT)
				.send({
					runId: "run-001",
					messages: [{ id: "msg-1", role: "user", content: "Hello" }],
				})
				.set("Content-Type", "application/json");

			expect(res.status).toBe(400);
			expect(res.body).toHaveProperty("error", "VALIDATION_ERROR");
		});

		it("should return 400 when runId is missing", async () => {
			const res = await request(app)
				.post(V2_RUN_ENDPOINT)
				.send({
					threadId: "thread-001",
					messages: [{ id: "msg-1", role: "user", content: "Hello" }],
				})
				.set("Content-Type", "application/json");

			expect(res.status).toBe(400);
			expect(res.body).toHaveProperty("error", "VALIDATION_ERROR");
		});

		it("should return 400 when message has invalid role", async () => {
			const res = await request(app)
				.post(V2_RUN_ENDPOINT)
				.send(
					validV2Body({
						messages: [
							{ id: "msg-1", role: "moderator", content: "Hello" },
						],
					}),
				)
				.set("Content-Type", "application/json");

			expect(res.status).toBe(400);
			expect(res.body).toHaveProperty("error", "VALIDATION_ERROR");
		});

		it("should return 400 when message is missing id field", async () => {
			const res = await request(app)
				.post(V2_RUN_ENDPOINT)
				.send(
					validV2Body({
						messages: [{ role: "user", content: "Hello" }],
					}),
				)
				.set("Content-Type", "application/json");

			expect(res.status).toBe(400);
			expect(res.body).toHaveProperty("error", "VALIDATION_ERROR");
		});

		it("should return 400 when body is not valid JSON", async () => {
			const res = await request(app)
				.post(V2_RUN_ENDPOINT)
				.set("Content-Type", "application/json")
				.send("this is not json{{{");

			expect(res.status).toBe(400);
		});
	});

	// ── SSE response format ────────────────────────────────────────────────

	describe("POST /copilotkit/agent/:agentId/run — SSE response format", () => {
		it("should set Cache-Control: no-cache header", async () => {
			const res = await request(app)
				.post(V2_RUN_ENDPOINT)
				.send(validV2Body())
				.set("Content-Type", "application/json");

			expect(res.headers["cache-control"]).toContain("no-cache");
		});

		it("should set Connection: keep-alive header", async () => {
			const res = await request(app)
				.post(V2_RUN_ENDPOINT)
				.send(validV2Body())
				.set("Content-Type", "application/json");

			expect(res.headers.connection).toContain("keep-alive");
		});

		it("should use bare data: lines without event: prefix", async () => {
			const res = await request(app)
				.post(V2_RUN_ENDPOINT)
				.send(validV2Body())
				.set("Content-Type", "application/json")
				.buffer(true)
				.parse((res, callback) => {
					let data = "";
					res.on("data", (chunk: Buffer) => {
						data += chunk.toString();
					});
					res.on("end", () => callback(null, data));
				});

			const body = res.body as string;

			// Body should contain bare "data:" lines
			expect(body).toContain("data:");

			// Body should NOT contain "event:" prefix lines
			expect(body).not.toMatch(/^event:/m);

			// Parse the data line and verify UPPER_SNAKE_CASE event type
			const dataLine = body
				.split("\n")
				.find((line: string) => line.startsWith("data:"));
			expect(dataLine).toBeDefined();
			const parsed = JSON.parse(dataLine!.replace("data: ", ""));
			expect(parsed.type).toBe("RUN_STARTED");
		});

		it("should use UPPER_SNAKE_CASE event types with flat fields", async () => {
			const res = await request(app)
				.post(V2_RUN_ENDPOINT)
				.send(validV2Body())
				.set("Content-Type", "application/json")
				.buffer(true)
				.parse((res, callback) => {
					let data = "";
					res.on("data", (chunk: Buffer) => {
						data += chunk.toString();
					});
					res.on("end", () => callback(null, data));
				});

			const body = res.body as string;
			const dataLine = body
				.split("\n")
				.find((line: string) => line.startsWith("data:"));
			const parsed = JSON.parse(dataLine!.replace("data: ", ""));

			// Verify flat field structure (threadId, runId at top level)
			expect(parsed).toHaveProperty("type");
			expect(parsed).toHaveProperty("threadId");
			expect(parsed).toHaveProperty("runId");
		});
	});

	// ── POST /copilotkit/agent/:agentId/stop/:threadId ────────────────────

	describe("POST /copilotkit/agent/:agentId/stop/:threadId", () => {
		it("should return 404 when no session exists for threadId", async () => {
			const res = await request(app)
				.post("/copilotkit/agent/general/stop/nonexistent-thread")
				.send({})
				.set("Content-Type", "application/json");

			expect(res.status).toBe(404);
			expect(res.body).toHaveProperty("error", "SESSION_NOT_FOUND");
		});
	});

	// ── POST /copilotkit/agent/:agentId/connect ───────────────────────────

	describe("POST /copilotkit/agent/:agentId/connect", () => {
		it("should return 501 Not Implemented", async () => {
			const res = await request(app)
				.post("/copilotkit/agent/general/connect")
				.send({})
				.set("Content-Type", "application/json");

			expect(res.status).toBe(501);
			expect(res.body).toHaveProperty("error", "NOT_IMPLEMENTED");
		});
	});

	// ── V1 endpoints removed ───────────────────────────────────────────────

	describe("V1 endpoints removed", () => {
		it("POST /copilotkit/runtime should return 404", async () => {
			const res = await request(app)
				.post("/copilotkit/runtime")
				.send({})
				.set("Content-Type", "application/json");

			expect(res.status).toBe(404);
		});

		it("POST /copilotkit/actions should return 404", async () => {
			const res = await request(app)
				.post("/copilotkit/actions")
				.send({})
				.set("Content-Type", "application/json");

			expect(res.status).toBe(404);
		});

		it("GET /copilotkit/status should return 404", async () => {
			const res = await request(app).get("/copilotkit/status");

			expect(res.status).toBe(404);
		});

		it("POST /copilotkit (old V2 flat endpoint) should return 404", async () => {
			const res = await request(app)
				.post("/copilotkit")
				.send(validV2Body())
				.set("Content-Type", "application/json");

			expect(res.status).toBe(404);
		});
	});
});
