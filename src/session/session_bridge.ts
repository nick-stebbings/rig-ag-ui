import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";
import {
	type AgentConfig,
	type AgentState,
	type BaseEvent,
	type Message,
	RigAbstractAgent,
	type Tool,
} from "../agents/rig_abstract_agent";
import { EXAMPLE_APP_CONFIG } from "../config/example-app-config";
import type { AguiStreamHandler } from "../streaming/agui_stream";

/**
 * Tracks the lifecycle and conversation state of an agent session.
 *
 * A session transitions through: `active` -> `processing` -> `idle`,
 * and may be `terminated` when the session expires or is explicitly closed.
 */
export interface SessionState {
	/** Unique session identifier (also used as the Rig thread ID). */
	sessionId: string;
	/** The agent instance identifier for this session. */
	agentId: string;
	/** Conversation thread identifier (defaults to sessionId). */
	threadId?: string;
	/** Current lifecycle status. */
	status: "active" | "idle" | "processing" | "terminated";
	/** Epoch timestamp (ms) when the session was created. */
	createdAt: number;
	/** Epoch timestamp (ms) of the last activity. */
	lastActivity: number;
	/** Epoch timestamp (ms) when the session entered "processing" state. */
	processingStartedAt?: number;
	/** Total number of messages exchanged. */
	messageCount: number;
	/** Full ordered message history. */
	messages: Message[];
	/** The ID of the currently executing run, if any. */
	activeRunId?: string;
	/** Arbitrary metadata attached to the session. */
	metadata: Record<string, unknown>;
}

/**
 * Combines a {@link RigAbstractAgent} instance with its session state
 * and the set of SSE stream session IDs that should receive its events.
 */
export interface AgentSession {
	/** Unique session identifier. */
	sessionId: string;
	/** The Rig agent instance handling this session. */
	agent: RigAbstractAgent;
	/** Mutable session state (status, messages, etc.). */
	state: SessionState;
	/** IDs of SSE stream sessions that should receive events from this agent. */
	streamSessions: Set<string>;
	/**
	 * Buffer for events that arrive before any SSE stream session connects.
	 * Used by the deferred stream mode (Tauri WebKit compatibility) where
	 * the agent run starts before the EventSource GET connects.
	 */
	eventBuffer?: BaseEvent[];
}

/**
 * Configuration options for {@link SessionBridge}.
 */
export interface SessionBridgeConfig {
	/** Base URL for the Rig backend API (default: `RIG_API_BASE_URL` env or `http://localhost:8080`). */
	rigApiBaseUrl?: string;
	/** Maximum session age before automatic cleanup, in milliseconds (default: 24 hours). */
	maxSessionAge?: number;
	/** Interval between cleanup sweeps, in milliseconds (default: 5 minutes). */
	cleanupInterval?: number;
	/** Maximum number of concurrent sessions (default: 1000). */
	maxSessions?: number;
}

/**
 * Internal bookkeeping for an in-flight tool call.
 *
 * Stored between `tool_call_start` and `tool_call_end` events so that
 * the original arguments are available when the end event fires.
 */
interface PendingToolCall {
	toolCallId: string;
	toolCallName: string;
	args: Record<string, unknown>;
	startTime: number;
}

/**
 * Orchestrates agent sessions, their lifecycle, and event routing.
 *
 * The SessionBridge is the central coordinator between:
 * - Incoming HTTP requests (via route handlers in {@link AguiMiddlewareApp})
 * - {@link RigAbstractAgent} instances that communicate with the Rig backend
 * - {@link AguiStreamHandler} SSE sessions that deliver events to clients
 *
 * It creates agent sessions on demand, starts/interrupts agent runs,
 * forwards agent events to the correct SSE streams, and periodically
 * cleans up expired sessions.
 *
 * @example
 * ```typescript
 * const bridge = new SessionBridge(streamHandler);
 * const session = await bridge.createSession("session-1", { agentId: "my-agent" });
 * await bridge.startAgentRun("session-1", { runId, messages });
 * ```
 */
export class SessionBridge extends EventEmitter {
	private sessions: Map<string, AgentSession> = new Map();
	private streamHandler: AguiStreamHandler;
	private config: Required<SessionBridgeConfig>;
	private cleanupTimer: NodeJS.Timeout | null = null;
	/** Track pending tool calls to preserve args between start and end events */
	private pendingToolCalls: Map<string, PendingToolCall> = new Map();

	/**
	 * @param streamHandler - The SSE stream handler used to deliver events to clients.
	 * @param config - Optional configuration overrides.
	 */
	constructor(
		streamHandler: AguiStreamHandler,
		config: SessionBridgeConfig = {},
	) {
		super();

		this.streamHandler = streamHandler;
		this.config = {
			rigApiBaseUrl:
				config.rigApiBaseUrl ||
				process.env.RIG_API_BASE_URL ||
				"http://localhost:8080",
			maxSessionAge: config.maxSessionAge || 24 * 60 * 60 * 1000, // 24 hours
			cleanupInterval: config.cleanupInterval || 5 * 60 * 1000, // 5 minutes
			maxSessions: config.maxSessions || 1000,
		};

		this.startCleanupTimer();
	}

	/**
	 * Create a new agent session, or return the existing one if it already exists.
	 *
	 * When a new session is created, a {@link RigAbstractAgent} is instantiated
	 * and wired to emit events through this bridge.
	 *
	 * @param sessionId - Optional session ID (auto-generated if omitted).
	 * @param agentConfig - Partial agent configuration (agentId, description, etc.).
	 * @returns The new or existing {@link AgentSession}.
	 * @throws {Error} If the maximum session limit has been reached.
	 */
	public async createSession(
		sessionId?: string,
		agentConfig?: Partial<AgentConfig>,
	): Promise<AgentSession> {
		const resolvedSessionId = sessionId || uuidv4();

		// Check if session already exists
		const existingSession = this.sessions.get(resolvedSessionId);
		if (existingSession) {
			this.updateSessionActivity(resolvedSessionId);
			return existingSession;
		}

		// Check session limits
		if (this.sessions.size >= this.config.maxSessions) {
			throw new Error(
				`Maximum session limit (${this.config.maxSessions}) reached`,
			);
		}

		// Create new agent with configuration
		const agentId = agentConfig?.agentId || uuidv4();
		const agent = new RigAbstractAgent({
			agentId,
			description: agentConfig?.description || "AG-UI Middleware Agent",
			threadId: resolvedSessionId,
			rigApiBaseUrl: this.config.rigApiBaseUrl,
			...agentConfig,
			appConfig: agentConfig?.appConfig || EXAMPLE_APP_CONFIG,
		});

		// Create session state
		const sessionState: SessionState = {
			sessionId: resolvedSessionId,
			agentId,
			threadId: resolvedSessionId,
			status: "active",
			createdAt: Date.now(),
			lastActivity: Date.now(),
			messageCount: 0,
			messages: [],
			metadata: {},
		};

		// Create agent session
		const agentSession: AgentSession = {
			sessionId: resolvedSessionId,
			agent,
			state: sessionState,
			streamSessions: new Set(),
		};

		this.sessions.set(resolvedSessionId, agentSession);

		// Set up agent event handlers
		this.setupAgentEventHandlers(agentSession);

		this.emit("session_created", {
			sessionId: resolvedSessionId,
			agentSession,
		});

		return agentSession;
	}

	/**
	 * Retrieve an existing session by ID, updating its last-activity timestamp.
	 *
	 * @param sessionId - The session identifier to look up.
	 * @returns The session, or `undefined` if not found.
	 */
	public getSession(sessionId: string): AgentSession | undefined {
		const session = this.sessions.get(sessionId);
		if (session) {
			this.updateSessionActivity(sessionId);
		}
		return session;
	}

	/**
	 * Terminate a session, interrupting any active run and closing all
	 * associated SSE streams.
	 *
	 * @param sessionId - The session to terminate.
	 * @returns `true` if the session existed and was terminated.
	 */
	public async terminateSession(sessionId: string): Promise<boolean> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return false;
		}

		try {
			// Interrupt any active runs
			if (session.state.activeRunId) {
				await session.agent.interruptAgent(
					session.state.activeRunId,
					"session_termination",
				);
			}

			// Close all associated stream sessions
			for (const streamSessionId of session.streamSessions) {
				this.streamHandler.closeSession(streamSessionId);
			}

			// Update session state
			session.state.status = "terminated";
			session.state.lastActivity = Date.now();

			// Remove from active sessions
			this.sessions.delete(sessionId);

			this.emit("session_terminated", { sessionId, session });

			return true;
		} catch (error) {
			this.emit("error", { error, sessionId, action: "terminate_session" });
			return false;
		}
	}

	/**
	 * Start an agent run for the given session.
	 *
	 * Creates an RxJS Observable via {@link RigAbstractAgent.runAgent} and
	 * subscribes to it, forwarding each emitted event to the session's
	 * associated SSE streams.
	 *
	 * @param sessionId - The session to run the agent in.
	 * @param runInput - Messages, tools, context, and optional auth token.
	 * @returns The run ID.
	 * @throws {Error} If the session is not found or is already processing.
	 */
	public async startAgentRun(
		sessionId: string,
		runInput: {
			runId?: string;
			messages?: Message[];
			tools?: Array<{ type: string; value: unknown }>;
			context?: Array<{ type: string; value: unknown }>;
			/** JWT auth token for workflow execution */
			authToken?: string;
		},
	): Promise<string> {
		const session = this.getSession(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found`);
		}

		if (session.state.status === "processing") {
			// Auto-reset sessions stuck in processing for more than 60 seconds.
			// This handles cases where the Rig backend stream closed without emitting
			// RUN_FINISHED (e.g., network drop, timeout) leaving the session permanently
			// blocked. Without this, users can never retry after a failed/dismissed run.
			const STUCK_THRESHOLD_MS = 60_000;
			const processingDuration = session.state.processingStartedAt
				? Date.now() - session.state.processingStartedAt
				: STUCK_THRESHOLD_MS + 1; // treat missing timestamp as stuck

			if (processingDuration > STUCK_THRESHOLD_MS) {
				console.warn(
					`[SessionBridge] Session ${sessionId} was stuck in "processing" for ${processingDuration}ms — force-resetting to allow new run`,
				);
				session.state.status = "idle";
				session.state.activeRunId = undefined;
				session.state.processingStartedAt = undefined;
			} else {
				throw new Error(`Session ${sessionId} is already processing`);
			}
		}

		const runId = runInput.runId || uuidv4();

		// Update session state
		session.state.status = "processing";
		session.state.processingStartedAt = Date.now();
		session.state.activeRunId = runId;
		session.state.lastActivity = Date.now();

		// Add new messages to session history
		if (runInput.messages) {
			session.state.messages.push(...runInput.messages);
			session.state.messageCount = session.state.messages.length;
		}

		try {
			// Start agent run - unwrap tools from wrapper format
			const tools = runInput.tools?.map((t) => t.value as Tool) || [];

			const runObservable = session.agent.runAgent({
				runId,
				threadId: sessionId,
				messages: runInput.messages || [],
				tools,
				context: runInput.context || [],
				authToken: runInput.authToken,
			});

			// Subscribe to agent events and forward to stream sessions
			runObservable.subscribe({
				next: (event) => {
					this.forwardEventToStreamSessions(sessionId, event);
				},
				error: (error) => {
					session.state.status = "idle";
					session.state.activeRunId = undefined;
					session.state.processingStartedAt = undefined;
					this.emit("run_error", { sessionId, runId, error });
				},
				complete: () => {
					session.state.status = "idle";
					session.state.activeRunId = undefined;
					session.state.processingStartedAt = undefined;
					this.emit("run_complete", { sessionId, runId });
				},
			});

			this.emit("run_started", { sessionId, runId });

			return runId;
		} catch (error) {
			session.state.status = "idle";
			session.state.activeRunId = undefined;
			session.state.processingStartedAt = undefined;
			throw error;
		}
	}

	/**
	 * Interrupt the active agent run for a session.
	 *
	 * @param sessionId - The session whose run should be interrupted.
	 * @param runId - The specific run ID to interrupt.
	 * @param reason - Human-readable reason for the interruption.
	 * @returns `true` if the run was successfully interrupted.
	 * @throws {Error} If the session is not found.
	 */
	public async interruptAgentRun(
		sessionId: string,
		runId: string,
		reason = "user_request",
	): Promise<boolean> {
		const session = this.getSession(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found`);
		}

		// Check if the runId matches the active run
		// If there's no active run or it doesn't match, we can't interrupt
		if (!session.state.activeRunId) {
			// No active run - this is handled by the endpoint, so just return false
			return false;
		}

		if (session.state.activeRunId !== runId) {
			// RunId mismatch - log but don't throw, just return false
			this.emit("error", {
				error: new Error(`Run ${runId} is not active for session ${sessionId}`),
				sessionId,
				runId,
				action: "interrupt_run_mismatch",
			});
			return false;
		}

		try {
			await session.agent.interruptAgent(runId, reason);

			session.state.status = "idle";
			session.state.activeRunId = undefined;
			session.state.lastActivity = Date.now();

			this.emit("run_interrupted", { sessionId, runId, reason });

			return true;
		} catch (error) {
			this.emit("error", { error, sessionId, runId, action: "interrupt_run" });
			return false;
		}
	}

	/**
	 * Link an SSE stream session to an agent session so that the agent's
	 * events are forwarded to that stream.
	 *
	 * @param sessionId - The agent session ID.
	 * @param streamSessionId - The SSE stream session ID.
	 * @returns `true` if the association was created.
	 */
	public associateStreamSession(
		sessionId: string,
		streamSessionId: string,
	): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return false;
		}

		session.streamSessions.add(streamSessionId);

		// Listen for stream session closure
		this.streamHandler.once("session_closed", (data) => {
			if (data.sessionId === streamSessionId) {
				session.streamSessions.delete(streamSessionId);
			}
		});

		return true;
	}

	/**
	 * Flush any buffered events for a session to a specific stream session.
	 *
	 * Used by the deferred stream mode: when the EventSource GET connects
	 * after the agent run has already started, this method replays any
	 * events that arrived before the SSE connection was established.
	 *
	 * @param sessionId - The agent session ID.
	 * @param streamSessionId - The target SSE stream session ID to flush events to.
	 * @returns The number of buffered events that were flushed.
	 */
	public flushEventBuffer(sessionId: string, streamSessionId: string): number {
		const session = this.sessions.get(sessionId);
		if (!session?.eventBuffer || session.eventBuffer.length === 0) {
			return 0;
		}

		const bufferedEvents = session.eventBuffer;
		session.eventBuffer = [];

		console.log(
			`[SessionBridge] Flushing ${bufferedEvents.length} buffered events for ${sessionId} to stream ${streamSessionId}`,
		);

		let flushed = 0;
		for (const event of bufferedEvents) {
			if (this.streamHandler.sendAguiEvent(streamSessionId, event)) {
				flushed++;
			}

			// Stop flushing after RUN_FINISHED — remaining buffered events
			// may belong to a subsequent run and must not go on this stream.
			if (event.type === "RUN_FINISHED") {
				const streamSession =
					this.streamHandler.getSessionInfo(streamSessionId);
				if (streamSession?.response && !streamSession.response.writableEnded) {
					streamSession.response.end();
				}
				break; // Don't flush events from subsequent runs
			}
		}

		return flushed;
	}

	/**
	 * Get the current {@link SessionState} for a session.
	 *
	 * @param sessionId - The session to query.
	 * @returns The session state, or `undefined` if not found.
	 */
	public getSessionState(sessionId: string): SessionState | undefined {
		const session = this.sessions.get(sessionId);
		return session?.state;
	}

	/**
	 * Get the current {@link AgentState} for a session's agent.
	 *
	 * @param sessionId - The session to query.
	 * @returns The agent state snapshot, or `undefined` if the session is not found.
	 */
	public getAgentState(sessionId: string): AgentState | undefined {
		const session = this.sessions.get(sessionId);
		return session?.agent.getState();
	}

	/**
	 * Return the state of every active session.
	 */
	public listSessions(): SessionState[] {
		return Array.from(this.sessions.values()).map((session) => ({
			...session.state,
		}));
	}

	/**
	 * Return aggregate statistics across all sessions and streams.
	 */
	public getSessionStats(): {
		totalSessions: number;
		activeSessions: number;
		processingSessions: number;
		idleSessions: number;
		streamSessions: number;
	} {
		const sessions = Array.from(this.sessions.values());

		return {
			totalSessions: sessions.length,
			activeSessions: sessions.filter((s) => s.state.status === "active")
				.length,
			processingSessions: sessions.filter(
				(s) => s.state.status === "processing",
			).length,
			idleSessions: sessions.filter((s) => s.state.status === "idle").length,
			streamSessions: this.streamHandler.getAllSessions().length,
		};
	}

	/**
	 * Check connectivity to the Rig backend and return overall health status.
	 *
	 * @returns Health status including Rig API connectivity and active session count.
	 */
	public async healthCheck(): Promise<{
		status: string;
		sessions: number;
		rigApiConnected: boolean;
	}> {
		try {
			// Test Rig API connectivity with a sample agent
			const testAgent = new RigAbstractAgent({
				rigApiBaseUrl: this.config.rigApiBaseUrl,
				appConfig: EXAMPLE_APP_CONFIG,
			});

			const healthResult = await testAgent.healthCheck();

			return {
				status: healthResult.rigApiConnected ? "healthy" : "degraded",
				sessions: this.sessions.size,
				rigApiConnected: healthResult.rigApiConnected,
			};
		} catch (_error) {
			return {
				status: "unhealthy",
				sessions: this.sessions.size,
				rigApiConnected: false,
			};
		}
	}

	/**
	 * Setup event handlers for an agent
	 */
	private setupAgentEventHandlers(agentSession: AgentSession): void {
		const { agent, sessionId } = agentSession;

		// Listen for agent events and update session state
		agent.on("status_update", (data) => {
			agentSession.state.lastActivity = Date.now();
			this.emit("agent_status_update", { sessionId, ...data });
		});

		agent.on("error", (error) => {
			agentSession.state.status = "idle";
			agentSession.state.activeRunId = undefined;
			this.emit("agent_error", { sessionId, error });
		});

		agent.on("interrupted", (data) => {
			agentSession.state.status = "idle";
			agentSession.state.activeRunId = undefined;
			this.emit("agent_interrupted", { sessionId, ...data });
		});
	}

	/**
	 * Forward agent event to all associated stream sessions
	 *
	 * @param sessionId - Session identifier
	 * @param event - Agent event to forward
	 */
	private forwardEventToStreamSessions(
		sessionId: string,
		event: BaseEvent,
	): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			console.log(
				`[SessionBridge] No session found for ${sessionId}, cannot forward event ${event.type}`,
			);
			return;
		}

		// Buffer events when no stream sessions are connected yet (deferred mode)
		if (session.streamSessions.size === 0) {
			if (!session.eventBuffer) {
				session.eventBuffer = [];
			}
			// Clear stale events from previous runs when a new run starts.
			// Without this, old run #1 events accumulate and are replayed before
			// run #2's RUN_STARTED, causing "First event must be 'RUN_STARTED'" errors.
			if (event.type === "RUN_STARTED") {
				if (session.eventBuffer.length > 0) {
					console.log(
						`[SessionBridge] RUN_STARTED received — clearing ${session.eventBuffer.length} stale buffered events for ${sessionId}`,
					);
				}
				session.eventBuffer = [];
			}
			session.eventBuffer.push(event);
			console.log(
				`[SessionBridge] Buffering event type=${event.type} for ${sessionId} (no stream sessions connected, buffer size: ${session.eventBuffer.length})`,
			);
			return;
		}

		// Debug: Log all events being forwarded
		console.log(
			`[SessionBridge] Forwarding event type=${event.type} to ${session.streamSessions.size} stream sessions`,
		);

		// Forward to all AG-UI SSE stream sessions associated with this agent session
		this.streamHandler.broadcastAguiEvent(event, (streamSession) => {
			return session.streamSessions.has(streamSession.id);
		});

		// Close SSE stream after RUN_FINISHED — the run lifecycle is complete
		if (event.type === "RUN_FINISHED") {
			for (const streamSessionId of session.streamSessions) {
				const streamSession =
					this.streamHandler.getSessionInfo(streamSessionId);
				if (streamSession?.response && !streamSession.response.writableEnded) {
					streamSession.response.end();
				}
			}
		}

		// Track pending tool calls so args are available when the end event fires
		if (event.type === "TOOL_CALL_START" && event.data?.toolCallName) {
			const toolCallId = event.data.toolCallId as string;
			const toolCallName = event.data.toolCallName as string;
			const args = (event.data.args as Record<string, unknown>) || {};

			this.pendingToolCalls.set(toolCallId, {
				toolCallId,
				toolCallName,
				args,
				startTime: Date.now(),
			});

			console.log(
				`[SessionBridge] Tool call started: ${toolCallName}`,
				"args:",
				JSON.stringify(args).substring(0, 200),
			);
		}

		if (event.type === "TOOL_CALL_END" && event.data?.toolCallId) {
			const toolCallId = event.data.toolCallId as string;

			// Clean up pending tool call tracking
			this.pendingToolCalls.delete(toolCallId);

			console.log(`[SessionBridge] Tool call ended: ${toolCallId}`);
		}
	}

	/**
	 * Update session activity timestamp
	 */
	private updateSessionActivity(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.state.lastActivity = Date.now();
		}
	}

	/**
	 * Start cleanup timer for expired sessions
	 */
	private startCleanupTimer(): void {
		this.cleanupTimer = setInterval(() => {
			this.cleanupExpiredSessions();
		}, this.config.cleanupInterval);
	}

	/**
	 * Clean up expired sessions
	 */
	private cleanupExpiredSessions(): void {
		const now = Date.now();
		const expiredSessions: string[] = [];

		for (const [sessionId, session] of this.sessions) {
			if (
				session.state.status !== "processing" &&
				now - session.state.lastActivity > this.config.maxSessionAge
			) {
				expiredSessions.push(sessionId);
			}
		}

		for (const sessionId of expiredSessions) {
			this.terminateSession(sessionId);
		}

		if (expiredSessions.length > 0) {
			this.emit("sessions_cleanup", { cleaned: expiredSessions.length });
		}
	}

	/**
	 * Shut down the session bridge: stop cleanup timers, terminate all
	 * sessions, and remove all event listeners.
	 */
	public destroy(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}

		// Terminate all sessions
		const sessionIds = Array.from(this.sessions.keys());
		for (const sessionId of sessionIds) {
			this.terminateSession(sessionId);
		}

		this.removeAllListeners();
	}
}
