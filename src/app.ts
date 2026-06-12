import { type Server, createServer } from "node:http";
import cors from "cors";
import express, {
	type Express,
	type NextFunction,
	type Request,
	type Response,
	Router,
} from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { metricsMiddleware } from "./middleware/metrics";
import {
	createChildSpan,
	endChildSpan,
	logTraceEvent,
	tracingMiddleware,
} from "./middleware/tracing";
import { SessionBridge } from "./session/session_bridge";
import { AguiStreamHandler } from "./streaming/agui_stream";

/**
 * Standard shape for JSON error responses returned by the middleware.
 */
interface ErrorResponse {
	error: string;
	message: string;
	code?: number;
	details?: Record<string, unknown>;
}

type RunContextEntry = {
	type: string;
	value: unknown;
	[key: string]: unknown;
};

const BASE_ALLOWED_HEADERS = [
	"Content-Type",
	"Authorization",
	"X-API-Key",
	"X-Requested-With",
	"traceparent",
	"tracestate",
] as const;

function parseCsvEnv(value: string | undefined): string[] {
	if (!value) return [];

	return value
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
}

function uniqueHeaderNames(headers: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const header of headers) {
		const normalized = header.trim().toLowerCase();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(header);
	}

	return result;
}

function buildAllowedHeaders(): string[] {
	return uniqueHeaderNames([
		...BASE_ALLOWED_HEADERS,
		...parseCsvEnv(process.env.AGUI_EXTRA_ALLOWED_HEADERS),
		...parseCsvEnv(process.env.AGUI_CONTEXT_FORWARD_HEADERS),
	]);
}

function normalizeHeaderValue(
	value: string | string[] | undefined,
): string | null {
	if (Array.isArray(value)) {
		return value.join(",").trim() || null;
	}

	return value?.trim() || null;
}

function collectForwardedHeaderContext(
	headers: Request["headers"],
): RunContextEntry[] {
	const explicitHeaders = new Set(
		parseCsvEnv(process.env.AGUI_CONTEXT_FORWARD_HEADERS),
	);
	const headerPrefixes = parseCsvEnv(
		process.env.AGUI_CONTEXT_FORWARD_HEADER_PREFIXES,
	);

	if (explicitHeaders.size === 0 && headerPrefixes.length === 0) {
		return [];
	}

	const entries: RunContextEntry[] = [];
	for (const [name, rawValue] of Object.entries(headers)) {
		const normalizedName = name.toLowerCase();
		const shouldForward =
			explicitHeaders.has(normalizedName) ||
			headerPrefixes.some((prefix) => normalizedName.startsWith(prefix));
		const value = shouldForward ? normalizeHeaderValue(rawValue) : null;

		if (!value) continue;

		entries.push({
			type: "http_header",
			name: normalizedName,
			value,
			[normalizedName]: value,
		});
	}

	return entries;
}

/**
 * Zod validation schemas for incoming request bodies.
 *
 * These schemas are used by route handlers to validate and parse
 * request payloads before they reach the session bridge.
 */
const MessageSchema = z.object({
	id: z.string(),
	role: z.enum(["user", "assistant", "system"]),
	content: z.string().min(1),
	metadata: z.record(z.any()).optional(),
	timestamp: z.number().optional(),
});

const ToolSchema = z.object({
	name: z.string().min(1),
	description: z.string().min(1),
	parameters: z.object({
		type: z.string().optional(),
		properties: z.record(z.any()).optional(),
		required: z.array(z.string()).optional(),
	}),
});

const AgentRunRequestSchema = z.object({
	runId: z.string(),
	messages: z.array(MessageSchema).optional().default([]),
	tools: z.array(ToolSchema).optional().default([]),
	context: z
		.array(
			z.object({
				type: z.string(),
				value: z.any(),
			}),
		)
		.optional()
		.default([]),
});

const AgentInterruptRequestSchema = z.object({
	runId: z.string(),
	reason: z.enum(["user_stop", "timeout", "error", "redirect"]),
	message: z.string().optional(),
});

/**
 * AG-UI V2 REST request schema (CopilotKit V2 format)
 *
 * Matches the RunAgentInputSchema from @ag-ui/core.
 * The client sends a POST to /copilotkit/agent/:agentId/run with
 * messages/tools and receives an SSE stream of AG-UI protocol events.
 */
const AguiV2MessageSchema = z.object({
	id: z.string(),
	role: z.enum([
		"user",
		"assistant",
		"system",
		"developer",
		"tool",
		"activity",
		"reasoning",
	]),
	content: z.union([z.string(), z.array(z.any())]).optional(),
	toolCalls: z.array(z.any()).optional(),
	toolCallId: z.string().optional(),
	name: z.string().optional(),
	metadata: z.record(z.any()).optional(),
});

const AguiV2ToolSchema = z.object({
	name: z.string(),
	description: z.string().optional(),
	parameters: z.any().optional(),
});

const AguiV2ContextSchema = z.object({
	description: z.string(),
	value: z.string(),
});

const AguiV2RequestSchema = z.object({
	threadId: z.string(),
	runId: z.string(),
	messages: z.array(AguiV2MessageSchema).min(1),
	tools: z.array(AguiV2ToolSchema).default([]),
	context: z.array(AguiV2ContextSchema).default([]),
	state: z.any().optional(),
	forwardedProps: z.any().optional(),
	parentRunId: z.string().optional(),
});

/**
 * Main application class for the AG-UI middleware server.
 *
 * Wires together Express middleware (CORS, auth, rate-limiting),
 * the {@link AguiStreamHandler} for SSE streaming, and the
 * {@link SessionBridge} for agent session lifecycle management.
 *
 * @example
 * ```typescript
 * const app = new AguiMiddlewareApp();
 * await app.start(3001);
 * // later...
 * await app.shutdown();
 * ```
 */
export class AguiMiddlewareApp {
	private app: Express;
	private httpServer: Server;
	private streamHandler: AguiStreamHandler;
	private sessionBridge: SessionBridge;
	private rigApiBaseUrl?: string;

	/**
	 * Create the middleware application.
	 *
	 * Configures Express middleware, registers route handlers, and sets up
	 * global error handling. The server is not started until {@link start}
	 * is called.
	 */
	constructor(config: { rigApiBaseUrl?: string } = {}) {
		this.app = express();
		this.httpServer = createServer(this.app);
		this.rigApiBaseUrl = config.rigApiBaseUrl;
		this.streamHandler = new AguiStreamHandler();
		this.sessionBridge = new SessionBridge(this.streamHandler, {
			rigApiBaseUrl: this.rigApiBaseUrl,
		});

		this.setupMiddleware();
		this.setupRoutes();
		this.setupErrorHandling();
	}

	/**
	 * Setup Express middleware
	 */
	private setupMiddleware(): void {
		// Trust proxy - required when running behind a reverse proxy (nginx, load balancer, etc.)
		// This allows express-rate-limit to correctly identify clients via X-Forwarded-For
		this.app.set("trust proxy", 1);

		// CORS configuration - MUST be first to handle preflight OPTIONS requests
		// Note: When credentials: true, origin cannot be '*' - must be explicit origins
		const allowedOrigins = process.env.ALLOWED_ORIGINS;
		const corsOrigin =
			allowedOrigins === "*"
				? true // Allow all origins (for development/staging)
				: allowedOrigins?.split(",").map((o) => o.trim()) || true;

		console.log("[CORS] Configuring with origin:", corsOrigin);

		this.app.use(
			cors({
				origin: corsOrigin,
				credentials: true,
				methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
				allowedHeaders: buildAllowedHeaders(),
				exposedHeaders: ["X-Correlation-Id", "X-Request-Id"],
				preflightContinue: false,
				optionsSuccessStatus: 204,
			}),
		);

		// HTTP metrics middleware (early in chain to capture all requests)
		this.app.use(metricsMiddleware());

		// Security middleware (after CORS so preflight works)
		this.app.use(
			helmet({
				contentSecurityPolicy: false, // Allow SSE
				crossOriginResourcePolicy: { policy: "cross-origin" },
			}),
		);

		// Distributed tracing middleware
		this.app.use(tracingMiddleware());

		// Public endpoint: runtime info (no auth required, used by V2 client bootstrap)
		this.app.get("/copilotkit/info", this.handleAguiV2Info.bind(this));

		// Inter-service authentication middleware
		// Note: CORS handles OPTIONS preflight before this runs
		this.app.use("/agents", this.authenticateRequest.bind(this));
		this.app.use("/copilotkit", this.authenticateRequest.bind(this));

		// Rate limiting
		const limiter = rateLimit({
			windowMs: 15 * 60 * 1000, // 15 minutes
			max: 100, // limit each IP to 100 requests per windowMs
			message: "Too many requests from this IP, please try again later.",
		});
		this.app.use(limiter);

		// Body parsing with error handling
		this.app.use(
			express.json({
				limit: "10mb",
				type: "application/json",
				strict: true,
			}),
		);
		this.app.use(express.urlencoded({ extended: true }));

		// Handle JSON parsing errors
		this.app.use(
			(error: unknown, _req: Request, res: Response, next: NextFunction) => {
				if (error instanceof SyntaxError && "body" in error) {
					res.status(400).json({
						error: "INVALID_JSON",
						message: "Request body must be valid JSON",
					});
					return;
				}
				next(error);
			},
		);

		// Request logging (minimal)
		if (process.env.NODE_ENV === "development") {
			this.app.use((req, _res, next) => {
				console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
				next();
			});
		}
	}

	/**
	 * Setup application routes
	 */
	private setupRoutes(): void {
		// Health check endpoint
		this.app.get("/health", this.handleHealthCheck.bind(this));

		// AG-UI Agent endpoints (internal API)
		this.app.post("/agents/:agentId/run", this.handleAgentRun.bind(this));
		this.app.post(
			"/agents/:agentId/interrupt",
			this.handleAgentInterrupt.bind(this),
		);

		// CopilotKit V2 single-endpoint transport (useSingleEndpoint=true, the default)
		// All requests go to POST /copilotkit with { method, params, body }
		this.app.post("/copilotkit", this.handleSingleEndpoint.bind(this));

		// CopilotKit V2 multi-endpoint REST+SSE transport routes (useSingleEndpoint=false)
		const copilotRouter = Router();
		copilotRouter.post("/agent/:agentId/run", this.handleAguiV2.bind(this));
		copilotRouter.post(
			"/agent/:agentId/connect",
			this.handleAguiV2Connect.bind(this),
		);
		copilotRouter.post(
			"/agent/:agentId/stop/:threadId",
			this.handleAguiV2Stop.bind(this),
		);
		copilotRouter.get("/info", this.handleAguiV2Info.bind(this));
		copilotRouter.get(
			"/agent/:agentId/events/:streamSessionId",
			this.handleAguiV2EventStream.bind(this),
		);
		this.app.use("/copilotkit", copilotRouter);

		// Session management endpoints
		this.app.get(
			"/sessions/:sessionId/state",
			this.handleGetSessionState.bind(this),
		);
		this.app.get("/sessions", this.handleListSessions.bind(this));
	}

	/**
	 * Setup error handling
	 */
	private setupErrorHandling(): void {
		this.app.use(
			(error: Error, _req: Request, res: Response, _next: NextFunction) => {
				console.error("Application error:", error);

				const errorResponse: ErrorResponse = {
					error: error.name || "INTERNAL_ERROR",
					message: error.message || "An internal error occurred",
					code: 500,
				};

				res.status(500).json(errorResponse);
			},
		);
	}

	/**
	 * Handle health check
	 */
	private async handleHealthCheck(req: Request, res: Response): Promise<void> {
		const spanId = createChildSpan(req, "health_check");
		logTraceEvent(req, "Health Check Start");

		try {
			const sessionBridgeHealth = await this.sessionBridge.healthCheck();
			const stats = this.sessionBridge.getSessionStats();

			logTraceEvent(req, "Health Check Data Collected", {
				rigConnected: sessionBridgeHealth.rigApiConnected,
				totalSessions: stats.totalSessions,
			});

			res.json({
				status: sessionBridgeHealth.rigApiConnected ? "healthy" : "degraded",
				rig_backend: sessionBridgeHealth.rigApiConnected
					? "connected"
					: "disconnected",
				uptime: Math.floor(process.uptime()),
				version: "0.1.0",
				timestamp: Date.now(),
				service: "ag-ui-middleware",
				sessions: stats,
			});

			endChildSpan(req, spanId, "health_check", true);
			logTraceEvent(req, "Health Check Success");
		} catch (error) {
			endChildSpan(
				req,
				spanId,
				"health_check",
				false,
				error instanceof Error ? error.message : "Unknown error",
			);
			logTraceEvent(req, "Health Check Error", {
				error: error instanceof Error ? error.message : error,
			});
			res.status(503).json({
				error: "SERVICE_UNAVAILABLE",
				message: "Health check failed",
				details: error instanceof Error ? error.message : error,
			});
		}
	}

	/**
	 * Handle AG-UI agent run request
	 */
	private async handleAgentRun(req: Request, res: Response): Promise<void> {
		try {
			const { agentId } = req.params;

			// Validate agentId parameter
			if (!agentId || typeof agentId !== "string") {
				res.status(400).json({
					error: "VALIDATION_ERROR",
					message: "Invalid agentId parameter",
				});
				return;
			}

			// Validate request body
			const validationResult = AgentRunRequestSchema.safeParse(req.body);
			if (!validationResult.success) {
				res.status(400).json({
					error: "VALIDATION_ERROR",
					message: "Invalid request body",
					details: validationResult.error.issues,
				});
				return;
			}

			const { runId, messages, tools, context } = validationResult.data;

			// Create or get session
			const _session = await this.sessionBridge.createSession(agentId, {
				agentId,
			});

			// Create AG-UI stream session
			const streamSessionId = this.streamHandler.createAguiStream(
				res,
				runId,
				agentId,
				agentId,
			);

			// Associate stream with agent session
			this.sessionBridge.associateStreamSession(agentId, streamSessionId);

			const runContext: RunContextEntry[] = [
				...(context?.map((ctx) => ({
					type: ctx.type,
					value: ctx.value as unknown,
				})) ?? []),
				...collectForwardedHeaderContext(req.headers),
			];

			// Start agent run - convert tools to the expected format
			await this.sessionBridge.startAgentRun(agentId, {
				runId,
				messages,
				tools: tools?.map((tool) => ({ type: "tool", value: tool })),
				context: runContext,
			});
		} catch (error) {
			console.error("Agent run error:", error);

			if (!res.headersSent) {
				res.status(500).json({
					error: "AGENT_RUN_ERROR",
					message:
						error instanceof Error
							? error.message
							: "Failed to start agent run",
				});
			}
		}
	}

	/**
	 * Handle AG-UI agent interrupt request
	 */
	private async handleAgentInterrupt(
		req: Request,
		res: Response,
	): Promise<void> {
		try {
			const { agentId } = req.params;

			// Validate agentId parameter
			if (!agentId || typeof agentId !== "string") {
				res.status(400).json({
					error: "VALIDATION_ERROR",
					message: "Invalid agentId parameter",
				});
				return;
			}

			// Validate request body
			const validationResult = AgentInterruptRequestSchema.safeParse(req.body);
			if (!validationResult.success) {
				res.status(400).json({
					error: "VALIDATION_ERROR",
					message: "Invalid request body",
					details: validationResult.error.issues,
				});
				return;
			}

			const { runId, reason } = validationResult.data;

			// Get session
			const session = this.sessionBridge.getSession(agentId);
			if (!session) {
				res.status(404).json({
					error: "SESSION_NOT_FOUND",
					message: `Agent session ${agentId} not found`,
				});
				return;
			}

			// Check if there's an active run to interrupt
			if (!session.state.activeRunId) {
				res.status(409).json({
					error: "NO_ACTIVE_RUN",
					message: "No active run to interrupt",
				});
				return;
			}

			// Interrupt the run
			const success = await this.sessionBridge.interruptAgentRun(
				agentId,
				runId,
				reason,
			);

			if (success) {
				res.json({
					interrupted: true,
					runId,
					reason,
					timestamp: Date.now(),
				});
			} else {
				res.status(500).json({
					error: "INTERRUPT_FAILED",
					message: "Failed to interrupt agent run",
				});
			}
		} catch (error) {
			console.error("Agent interrupt error:", error);
			res.status(500).json({
				error: "INTERRUPT_ERROR",
				message:
					error instanceof Error ? error.message : "Failed to interrupt agent",
			});
		}
	}

	/**
	 * Handle AG-UI V2 REST+SSE run request
	 *
	 * CopilotKit V2 transport: POST /copilotkit/agent/:agentId/run
	 * The agentId comes from the URL path param, not the request body.
	 *
	 * Request body: RunAgentInput { threadId, runId, messages, tools?, context?, state?, forwardedProps? }
	 * Response: text/event-stream with AG-UI events (RUN_STARTED, TEXT_MESSAGE_CONTENT, etc.)
	 */

	/**
	 * Single-endpoint dispatcher for CopilotKit's useSingleEndpoint=true mode.
	 * All requests arrive as POST /copilotkit with { method, params, body }.
	 */
	private async handleSingleEndpoint(
		req: Request,
		res: Response,
	): Promise<void> {
		const { method, params, body: innerBody } = req.body || {};

		if (!method) {
			res
				.status(400)
				.json({ error: "VALIDATION_ERROR", message: "Missing method field" });
			return;
		}

		// Dispatch based on method
		switch (method) {
			case "info": {
				this.handleAguiV2Info(req, res);
				return;
			}
			case "agent/run": {
				// Rewrite req.body to the inner body and set params
				req.body = innerBody || {};
				req.params = { agentId: params?.agentId || "default" };
				await this.handleAguiV2(req, res);
				return;
			}
			case "agent/connect": {
				req.body = innerBody || {};
				req.params = { agentId: params?.agentId || "default" };
				await this.handleAguiV2Connect(req, res);
				return;
			}
			case "agent/stop": {
				req.body = innerBody || {};
				req.params = {
					agentId: params?.agentId || "default",
					threadId: params?.threadId || "",
				};
				await this.handleAguiV2Stop(req, res);
				return;
			}
			default: {
				res.status(404).json({
					error: "NOT_FOUND",
					message: `Unknown method: ${method}`,
				});
			}
		}
	}

	private async handleAguiV2(req: Request, res: Response): Promise<void> {
		try {
			const { agentId } = req.params;

			// Validate agentId from URL
			if (!agentId || typeof agentId !== "string") {
				res.status(400).json({
					error: "VALIDATION_ERROR",
					message: "Invalid agentId parameter",
				});
				return;
			}

			// Validate V2 request body (RunAgentInput schema)
			const validationResult = AguiV2RequestSchema.safeParse(req.body);
			if (!validationResult.success) {
				res.status(400).json({
					error: "VALIDATION_ERROR",
					message: "Invalid AG-UI V2 request body",
					details: validationResult.error.issues,
				});
				return;
			}

			const { threadId, runId, messages, tools, context } =
				validationResult.data;

			// Use threadId as the session key (V2 threads map to sessions)
			const sessionId = threadId;

			// Convert V2 messages to internal Message format
			// V2 content can be string or InputContent[]; extract string content
			const agentMessages = messages.map((msg) => ({
				id: msg.id,
				role: msg.role as "user" | "assistant" | "system",
				content:
					typeof msg.content === "string"
						? msg.content
						: JSON.stringify(msg.content ?? ""),
				metadata: msg.metadata as Record<string, unknown> | undefined,
			}));

			// Convert V2 tools to the wrapped format expected by SessionBridge
			const wrappedTools = tools.map((tool) => ({
				type: "tool" as const,
				value: {
					name: tool.name,
					description: tool.description ?? "",
					parameters: tool.parameters ?? {},
				},
			}));

			// Check for deferred stream mode (Tauri WebKit compatibility).
			// When X-Stream-Mode: deferred, the POST returns a JSON response with
			// a streamSessionId. The client then opens an EventSource on the GET
			// endpoint to receive SSE events. This works around Tauri WebKit's
			// lack of support for fetch+ReadableStream SSE.
			const streamMode = req.headers["x-stream-mode"] as string | undefined;
			const isDeferred = streamMode === "deferred";
			const runContext: RunContextEntry[] = [
				{ type: "agent_id", value: agentId },
				{ type: "thread_id", value: threadId },
				...context.map((ctx) => ({
					type: ctx.description,
					value: ctx.value as unknown,
				})),
				...collectForwardedHeaderContext(req.headers),
			];

			// Create or get session
			await this.sessionBridge.createSession(sessionId, {
				agentId,
			});

			// Extract auth token from request headers if present
			const authHeader = req.headers.authorization;
			const authToken = authHeader?.startsWith("Bearer ")
				? authHeader.slice(7)
				: undefined;

			if (isDeferred) {
				// Deferred mode: return streamSessionId immediately as JSON.
				// Events will buffer in the session until the EventSource GET connects.
				const deferredStreamId = uuidv4();

				// Store the deferred stream metadata on the session so the GET
				// endpoint can create the real SSE stream with the correct IDs.
				const session = this.sessionBridge.getSession(sessionId);
				if (session) {
					session.state.metadata.deferredStreamId = deferredStreamId;
					session.state.metadata.deferredRunId = runId;
					session.state.metadata.deferredThreadId = threadId;
					session.state.metadata.deferredAgentId = agentId;
				}

				// Start agent run — events will buffer in sessionBridge since
				// no stream sessions are connected yet.
				await this.sessionBridge.startAgentRun(sessionId, {
					runId,
					messages: agentMessages,
					tools: wrappedTools,
					context: runContext,
					authToken,
				});

				// Return the stream session ID for the client to connect via EventSource
				res.status(200).json({
					streamSessionId: deferredStreamId,
					sessionId,
					runId,
					threadId,
				});
				return;
			}

			// Standard mode: stream SSE directly on this response.
			// Create AG-UI SSE stream — this sets headers
			const streamSessionId = this.streamHandler.createAguiStream(
				res,
				runId,
				threadId,
				agentId,
			);

			// Associate stream with agent session
			this.sessionBridge.associateStreamSession(sessionId, streamSessionId);

			// Start agent run — events will flow through the SSE stream
			await this.sessionBridge.startAgentRun(sessionId, {
				runId,
				messages: agentMessages,
				tools: wrappedTools,
				context: runContext,
				authToken,
			});

			// NOTE: Do NOT close the response here. startAgentRun() initiates the
			// run but returns before streaming completes. The SessionBridge forwards
			// events (including RUN_FINISHED) to the SSE stream as they arrive.
			// The stream will be closed when the session bridge emits RUN_FINISHED.
		} catch (error) {
			console.error("AG-UI V2 handler error:", error);

			if (!res.headersSent) {
				res.status(500).json({
					error: "AGUI_V2_ERROR",
					message:
						error instanceof Error
							? error.message
							: "Failed to process AG-UI V2 request",
				});
			}
		}
	}

	/**
	 * Handle AG-UI V2 connect request (placeholder)
	 *
	 * POST /copilotkit/agent/:agentId/connect
	 * Used for establishing persistent connections. Returns 501 for now.
	 */
	private async handleAguiV2Connect(
		req: Request,
		res: Response,
	): Promise<void> {
		// Stateless middleware — no prior run state to resume.
		// Must return a valid complete run lifecycle (RUN_STARTED → RUN_FINISHED)
		// so the client's verifyEvents pipeline and lastValueFrom() complete cleanly.
		// An empty stream causes EmptyError which breaks subsequent runAgent() calls.
		const threadId = req.body?.threadId || crypto.randomUUID();
		const runId = req.body?.runId || crypto.randomUUID();

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write(
			`data: ${JSON.stringify({ type: "RUN_STARTED", threadId, runId })}\n\n`,
		);
		res.write(
			`data: ${JSON.stringify({ type: "RUN_FINISHED", threadId, runId })}\n\n`,
		);
		res.end();
	}

	/**
	 * Handle deferred SSE event stream for Tauri WebKit compatibility.
	 *
	 * GET /copilotkit/agent/:agentId/events/:streamSessionId
	 *
	 * This endpoint is used with the deferred stream mode. The client first
	 * POSTs to `/agent/:agentId/run` with `X-Stream-Mode: deferred` to start
	 * the agent run, receiving a `streamSessionId` in the JSON response.
	 * Then the client opens an EventSource on this GET endpoint to receive
	 * the AG-UI events via standard SSE (compatible with Tauri's WebKit).
	 *
	 * Any events that arrived between the POST and this GET are buffered
	 * in the SessionBridge and flushed when this endpoint connects.
	 */
	private handleAguiV2EventStream(req: Request, res: Response): void {
		const { agentId, streamSessionId: deferredStreamId } = req.params;

		if (!deferredStreamId) {
			res.status(400).json({
				error: "VALIDATION_ERROR",
				message: "Missing streamSessionId parameter",
			});
			return;
		}

		// Find the agent session that has this deferred stream ID
		let targetSessionId: string | undefined;
		let targetRunId: string | undefined;
		let targetThreadId: string | undefined;

		for (const sessionState of this.sessionBridge.listSessions()) {
			if (sessionState.metadata.deferredStreamId === deferredStreamId) {
				targetSessionId = sessionState.sessionId;
				targetRunId = sessionState.metadata.deferredRunId as string;
				targetThreadId = sessionState.metadata.deferredThreadId as string;
				break;
			}
		}

		if (!targetSessionId) {
			res.status(404).json({
				error: "NOT_FOUND",
				message: `Stream session ${deferredStreamId} not found or already connected`,
			});
			return;
		}

		// Create the real SSE stream on this GET response
		const realStreamSessionId = this.streamHandler.createAguiStream(
			res,
			targetRunId ?? "",
			targetThreadId,
			agentId,
		);

		// Associate the real stream session with the agent session
		this.sessionBridge.associateStreamSession(
			targetSessionId,
			realStreamSessionId,
		);

		// Flush any buffered events that arrived before this GET connected
		const flushed = this.sessionBridge.flushEventBuffer(
			targetSessionId,
			realStreamSessionId,
		);

		console.log(
			`[AG-UI EventStream] Connected deferred stream for session=${targetSessionId}, ` +
				`flushed=${flushed} buffered events, streamSessionId=${realStreamSessionId}`,
		);

		// Clear the deferred metadata so the same ID cannot be reused
		const session = this.sessionBridge.getSession(targetSessionId);
		if (session) {
			session.state.metadata.deferredStreamId = undefined;
			session.state.metadata.deferredRunId = undefined;
			session.state.metadata.deferredThreadId = undefined;
			session.state.metadata.deferredAgentId = undefined;
		}

		// NOTE: Do NOT close the response here. Events will continue flowing
		// from the SessionBridge through the stream handler. The stream closes
		// when RUN_FINISHED is forwarded.
	}

	/**
	 * Handle AG-UI V2 stop request
	 *
	 * POST /copilotkit/agent/:agentId/stop/:threadId
	 * Stops an active run for the given thread.
	 */
	private async handleAguiV2Stop(req: Request, res: Response): Promise<void> {
		try {
			const { agentId, threadId } = req.params;

			if (!agentId || !threadId) {
				res.status(400).json({
					error: "VALIDATION_ERROR",
					message: "agentId and threadId are required",
				});
				return;
			}

			// Use threadId as session key (matches handleAguiV2)
			const session = this.sessionBridge.getSession(threadId);
			if (!session) {
				res.status(404).json({
					error: "SESSION_NOT_FOUND",
					message: `No session found for thread ${threadId}`,
				});
				return;
			}

			if (!session.state.activeRunId) {
				res.status(409).json({
					error: "NO_ACTIVE_RUN",
					message: "No active run to stop",
				});
				return;
			}

			const success = await this.sessionBridge.interruptAgentRun(
				threadId,
				session.state.activeRunId,
				"user_stop",
			);

			if (success) {
				res.json({
					stopped: true,
					threadId,
					timestamp: Date.now(),
				});
			} else {
				res.status(500).json({
					error: "STOP_FAILED",
					message: "Failed to stop agent run",
				});
			}
		} catch (error) {
			console.error("AG-UI V2 stop error:", error);
			res.status(500).json({
				error: "STOP_ERROR",
				message:
					error instanceof Error ? error.message : "Failed to stop agent",
			});
		}
	}

	/**
	 * Handle AG-UI V2 info request
	 *
	 * GET /copilotkit/info
	 * Returns available agents and runtime metadata.
	 */
	private async handleAguiV2Info(_req: Request, res: Response): Promise<void> {
		const stats = this.sessionBridge.getSessionStats();

		// NOTE: "default" is NOT listed here because the client registers it
		// via selfManagedAgents (EventSourceAgent). Listing it here would
		// create a competing ProxiedCopilotRuntimeAgent that overwrites it.
		//
		// Agent registry: explicit middleware config, optionally backed by a custom discovery endpoint.
		const agents = await AguiMiddlewareApp.discoverAgents();

		res.json({
			agents,
			runtime: {
				version: "0.1.0",
				service: "ag-ui-middleware",
				sessions: stats,
			},
		});
	}

	/** Cached agent registry + timestamp */
	private static agentCache: {
		agents: Record<string, { description: string }>;
		ts: number;
	} | null = null;

	private static parseDiscoveryHeaders(): Record<string, string> {
		const raw = process.env.AGENT_DISCOVERY_HEADERS;
		if (!raw) {
			return {};
		}

		try {
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			const headers: Record<string, string> = {};
			for (const [key, value] of Object.entries(parsed)) {
				if (typeof value === "string") {
					headers[key] = value;
				}
			}
			return headers;
		} catch {
			return {};
		}
	}

	/**
	 * Discover agents from explicit middleware configuration.
	 *
	 * Order of precedence:
	 * 1. AGENT_DISCOVERY_URL + optional AGENT_DISCOVERY_HEADERS
	 * 2. AGENT_REGISTRY static JSON
	 *
	 * The middleware core intentionally does not assume a platform-specific
	 * backend catalog endpoint. Consumers can provide either a static registry
	 * or a custom discovery endpoint returning { tools: [...] } or { agents: {...} }.
	 */
	private static async discoverAgents(): Promise<
		Record<string, { description: string }>
	> {
		const now = Date.now();
		if (
			AguiMiddlewareApp.agentCache &&
			now - AguiMiddlewareApp.agentCache.ts < 60_000
		) {
			return AguiMiddlewareApp.agentCache.agents;
		}

		const discoveryUrl = process.env.AGENT_DISCOVERY_URL;
		if (discoveryUrl) {
			try {
				const resp = await fetch(discoveryUrl, {
					headers: AguiMiddlewareApp.parseDiscoveryHeaders(),
					signal: AbortSignal.timeout(5000),
				});
				if (resp.ok) {
					const data = (await resp.json()) as {
						tools?: Array<{
							name: string;
							description?: string;
							bundle_id?: string;
						}>;
						agents?: Record<string, { description?: string }>;
					};
					const agents: Record<string, { description: string }> = {};
					for (const tool of data.tools || []) {
						const sourceId = tool.bundle_id || tool.name;
						const agentId = sourceId.endsWith("-agent")
							? sourceId
							: `${sourceId}-agent`;
						agents[agentId] = { description: tool.description || tool.name };
					}
					for (const [agentId, agent] of Object.entries(data.agents || {})) {
						agents[agentId] = { description: agent.description || agentId };
					}
					AguiMiddlewareApp.agentCache = { agents, ts: now };
					return agents;
				}
			} catch {
				// Discovery unavailable; fall through to the static registry.
			}
		}

		const raw = process.env.AGENT_REGISTRY;
		if (raw) {
			try {
				const parsed = JSON.parse(raw) as Record<
					string,
					{ description: string }
				>;
				AguiMiddlewareApp.agentCache = { agents: parsed, ts: now };
				return parsed;
			} catch {
				/* ignore parse errors */
			}
		}

		return {};
	}

	/**
	 * Handle get session state request
	 */
	private handleGetSessionState(req: Request, res: Response): void {
		try {
			const { sessionId } = req.params;

			if (!sessionId) {
				res.status(400).json({
					error: "VALIDATION_ERROR",
					message: "Session ID is required",
				});
				return;
			}

			const sessionState = this.sessionBridge.getSessionState(sessionId);
			const agentState = this.sessionBridge.getAgentState(sessionId);

			if (!sessionState) {
				res.status(404).json({
					error: "SESSION_NOT_FOUND",
					message: `Session ${sessionId} not found`,
				});
				return;
			}

			res.json({
				session: sessionState,
				agent: agentState,
				timestamp: Date.now(),
			});
		} catch (error) {
			console.error("Get session state error:", error);
			res.status(500).json({
				error: "SESSION_STATE_ERROR",
				message: "Failed to get session state",
			});
		}
	}

	/**
	 * Handle list sessions request
	 */
	private handleListSessions(_req: Request, res: Response): void {
		try {
			const sessions = this.sessionBridge.listSessions();
			const stats = this.sessionBridge.getSessionStats();

			res.json({
				sessions,
				stats,
				timestamp: Date.now(),
			});
		} catch (error) {
			console.error("List sessions error:", error);
			res.status(500).json({
				error: "LIST_SESSIONS_ERROR",
				message: "Failed to list sessions",
			});
		}
	}

	/**
	 * Inter-service authentication middleware
	 */
	private authenticateRequest(
		req: Request,
		res: Response,
		next: NextFunction,
	): void {
		// For self-hosted deployment, use simple API key authentication
		// Also accept API key from query param (for EventSource/SSE which can't set headers)
		const apiKey =
			(req.headers["x-api-key"] as string) || (req.query.api_key as string);
		const expectedApiKey = process.env.AGUI_API_KEY || "development-key";

		// Allow requests from localhost in development
		const isDevelopment = process.env.NODE_ENV === "development";
		const cleanIp = req.ip?.replace("::ffff:", "") || "";
		const isLocalhost =
			req.ip === "127.0.0.1" ||
			req.ip === "::1" ||
			req.ip === "::ffff:127.0.0.1" ||
			cleanIp === "127.0.0.1" ||
			req.hostname === "localhost" ||
			req.hostname === "127.0.0.1";

		// In development, also allow requests from local network clients.
		const isLocalNetwork =
			isDevelopment &&
			(cleanIp.startsWith("192.168.") ||
				cleanIp.startsWith("10.") ||
				cleanIp.startsWith("172.") ||
				req.ip?.includes("192.168.") ||
				req.ip?.includes("10.") ||
				req.ip?.includes("172."));

		if (isDevelopment && (isLocalhost || isLocalNetwork)) {
			// Skip authentication for local development and local network
			next();
			return;
		}

		if (!apiKey || apiKey !== expectedApiKey) {
			console.log("Authentication failed:", {
				hasApiKey: !!apiKey,
				apiKeyMatches: apiKey === expectedApiKey,
				clientIp: req.ip,
				cleanIp: cleanIp,
				hostname: req.hostname,
				isDevelopment,
				isLocalhost,
				isLocalNetwork,
			});
			res.status(401).json({
				error: "UNAUTHORIZED",
				message: "Valid API key required",
			});
			return;
		}

		next();
	}

	/**
	 * Get Express app instance
	 */
	public getApp(): Express {
		return this.app;
	}

	/**
	 * Start the server on the specified port
	 *
	 * @param port - Port number to listen on (default: 3001)
	 */
	public async start(port = 3001): Promise<void> {
		return new Promise((resolve) => {
			this.httpServer.listen(port, "0.0.0.0", () => {
				if (process.env.NODE_ENV !== "test") {
					console.log(`AG-UI Middleware server running on port ${port}`);
				}
				resolve();
			});
		});
	}

	/**
	 * Shutdown the application gracefully
	 */
	public async shutdown(): Promise<void> {
		// Close all stream sessions
		this.streamHandler.destroy();

		// Terminate all agent sessions
		this.sessionBridge.destroy();
	}
}

/**
 * Create and configure the Express app
 */
export async function createApp(): Promise<Express> {
	const middleware = new AguiMiddlewareApp();
	return middleware.getApp();
}
