import { EventEmitter } from "node:events";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import axios, {
	type AxiosInstance,
	type InternalAxiosRequestConfig,
} from "axios";
import { Observable } from "rxjs";
import { v4 as uuidv4 } from "uuid";
import {
	CORRELATION_ID_HEADER,
	REQUEST_ID_HEADER,
	TRACEPARENT_HEADER,
} from "../middleware/tracing";

/**
 * Application-specific configuration hooks for customizing agent behavior.
 *
 * The generic {@link RigAbstractAgent} delegates domain-specific logic
 * (workflow naming, progress categorization, durable sessions, state shape)
 * to these hooks. Provide an implementation to wire in your own platform
 * semantics without modifying the core agent.
 */
export interface RigAgentAppConfig {
	/** Map a workflow name to a CopilotKit agent name for dynamic routing. */
	workflowNameMapper?: (name: string) => string | undefined;
	/** Categorize a progress message into a progress phase. */
	progressCategorizer?: (message: string) => string | undefined;
	/** Factory for the initial workflow agent state object. */
	createInitialWorkflowState?: () => Record<string, unknown>;
	/**
	 * Optional transformer applied to the accumulated workflow state whenever a
	 * `__STATE_UPDATE__` marker arrives from the Rig backend. The function
	 * receives a copy of the current state augmented with a `__latestEvent`
	 * helper key (`{ sseEventType, workflowEvent }`). Return the new state
	 * object; the `__latestEvent` key is stripped before it is emitted.
	 *
	 * Use this hook to build platform-specific state shapes (e.g. `proposedPosts`,
	 * `opportunities`) without modifying the core agent.
	 *
	 * Defaults to identity (pass-through) when not provided.
	 */
	stateTransformer?: (
		rawState: Record<string, unknown>,
	) => Record<string, unknown>;
	/**
	 * Optional async initializer called when creating a new Rig session.
	 * Return metadata to forward to the backend (e.g. `{ userId }` derived
	 * from the auth token).
	 *
	 * To pass user identity, decode the authToken here:
	 * @example
	 * ```typescript
	 * durableSessionInitializer: async (authToken) => ({
	 *   userId: parseJwt(authToken).sub,
	 * })
	 * ```
	 */
	durableSessionInitializer?: (
		authToken: string | undefined,
	) => Promise<Record<string, unknown>>;
}

/**
 * Event type identifiers for the AG-UI protocol.
 *
 * Each value corresponds to a specific lifecycle or content event that
 * the middleware emits over SSE during an agent run.
 */
export enum EventType {
	RUN_STARTED = "RUN_STARTED",
	RUN_FINISHED = "RUN_FINISHED",
	RUN_ERROR = "RUN_ERROR",
	TEXT_MESSAGE_START = "TEXT_MESSAGE_START",
	TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT",
	TEXT_MESSAGE_END = "TEXT_MESSAGE_END",
	TOOL_CALL_START = "TOOL_CALL_START",
	TOOL_CALL_ARGS = "TOOL_CALL_ARGS",
	TOOL_CALL_END = "TOOL_CALL_END",
	TOOL_CALL_RESULT = "TOOL_CALL_RESULT",
	STATE_SNAPSHOT = "STATE_SNAPSHOT",
	STATE_DELTA = "STATE_DELTA",
	MESSAGES_SNAPSHOT = "MESSAGES_SNAPSHOT",
	STEP_STARTED = "STEP_STARTED",
	STEP_FINISHED = "STEP_FINISHED",
	// Internal / non-standard events (used by our middleware, not part of V2 spec)
	AGENT_STATUS_UPDATE = "AGENT_STATUS_UPDATE",
	AGENT_STATE_UPDATE = "AGENT_STATE_UPDATE",
	THINKING_DISPLAY = "THINKING_DISPLAY",
	// Legacy - kept for backwards compatibility
	TOOL_EXECUTION = "TOOL_EXECUTION",
	ERROR = "RUN_ERROR",
}

/**
 * Base event structure shared by all AG-UI protocol events.
 *
 * Every event emitted during an agent run conforms to this shape.
 * The `type` discriminant identifies the event kind, while `data`
 * carries the type-specific payload.
 */
export interface BaseEvent {
	/** The AG-UI event type discriminant. */
	type: EventType;
	/** Conversation thread this event belongs to. */
	threadId?: string;
	/** Run identifier this event belongs to. */
	runId?: string;
	/** Message identifier (for content-related events). */
	messageId?: string;
	/** Epoch timestamp in milliseconds. */
	timestamp?: number;
	/** Event-specific payload. */
	data?: Record<string, unknown>;
}

/**
 * Configuration options for creating a {@link RigAbstractAgent}.
 */
export interface AgentConfig {
	agentId?: string;
	description?: string;
	threadId?: string;
	initialMessages?: Message[];
	initialState?: AgentState;
	rigApiBaseUrl?: string;
	/** Application-specific hooks for domain logic (workflow naming, progress, etc.). */
	appConfig?: RigAgentAppConfig;
}

/**
 * A conversation message in the AG-UI protocol format.
 */
export interface Message {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	metadata?: Record<string, unknown>;
	timestamp?: number;
}

/**
 * A tool definition in the AG-UI protocol, with JSON Schema parameters.
 */
export interface Tool {
	name: string;
	description: string;
	parameters: {
		type?: string;
		properties?: Record<string, unknown>;
		required?: string[];
	};
}

/**
 * Runtime state of a {@link RigAbstractAgent}, including processing status,
 * available tools, reasoning step history, and error context.
 */
export interface AgentState {
	status:
		| "idle"
		| "processing"
		| "tool_execution"
		| "waiting_for_input"
		| "errored";
	currentTask?: string;
	availableTools: string[];
	reasoningSteps: Array<{
		id: string;
		description: string;
		timestamp: number;
		status: "active" | "completed";
	}>;
	errorContext?: {
		error: string;
		message: string;
		timestamp: number;
	};
}

/**
 * Input parameters for starting an agent run via {@link RigAbstractAgent.runAgent}.
 */
export interface RunAgentInput {
	runId: string;
	threadId?: string;
	messages?: Message[];
	tools?: Tool[];
	context?: Array<{ type: string; value: unknown }>;
	/** JWT auth token to forward to backend for workflow execution */
	authToken?: string;
}

/**
 * Callback interface for subscribing to agent run events outside the
 * RxJS Observable pipeline (e.g. for logging or side-effects).
 */
export interface AgentSubscriber {
	next?: (event: BaseEvent) => void;
	error?: (error: Error) => void;
	complete?: () => void;
}

/**
 * AG-UI agent implementation that communicates with a Rig backend.
 *
 * Follows the AG-UI AbstractAgent pattern: the caller invokes
 * {@link runAgent} which returns an RxJS Observable of {@link BaseEvent}
 * objects. Internally, this agent creates a Rig backend session,
 * streams the response via SSE, and translates Rig-specific markers
 * (tool calls, state updates) into AG-UI protocol events.
 *
 * Supports:
 * - Chat memory via persistent Rig sessions
 * - Tool call detection and AG-UI tool call lifecycle events
 * - Workflow state updates for CopilotKit `useCoAgent`
 * - Durable session initialization for event persistence
 * - OpenTelemetry trace propagation to the Rig backend
 *
 * @example
 * ```typescript
 * const agent = new RigAbstractAgent({ agentId: "my-agent", rigApiBaseUrl: "http://localhost:8080" });
 * agent.runAgent({ runId: "run-1", messages: [{ id: "1", role: "user", content: "Hello" }] })
 *   .subscribe({ next: (event) => console.log(event.type) });
 * ```
 */
export class RigAbstractAgent extends EventEmitter {
	public agentId: string;
	public description: string;
	public threadId?: string;
	public messages: Message[] = [];
	public state: AgentState;

	private rigApiClient: AxiosInstance;
	private rigApiBaseUrl: string;
	/** Cached Rig backend session ID - reused for all messages in this thread */
	private rigSessionId?: string;

	/** Flag to track if durable session has been initialized for current execution */
	private durableSessionInitialized = false;

	/** Current auth token for backend requests */
	private currentAuthToken?: string;

	/** Metadata derived from the current request auth token. */
	private currentSessionMetadata: Record<string, unknown> = {};

	/** Application-specific configuration hooks */
	private appConfig: RigAgentAppConfig;

	/**
	 * Cumulative workflow agent state for CopilotKit.
	 * Shape is determined by the appConfig.createInitialWorkflowState factory.
	 */
	private workflowAgentState: Record<string, unknown>;

	constructor(config: AgentConfig = {}) {
		super();

		this.appConfig = config.appConfig || {};
		this.workflowAgentState = this.createInitialWorkflowState();

		this.agentId = config.agentId || uuidv4();
		this.description = config.description || "Rig AI Agent";
		this.threadId = config.threadId;
		this.messages = config.initialMessages || [];

		// Initialize agent state
		this.state = config.initialState || {
			status: "idle",
			availableTools: [],
			reasoningSteps: [],
		};

		// Configure Rig API client
		this.rigApiBaseUrl =
			config.rigApiBaseUrl ||
			process.env.RIG_API_BASE_URL ||
			"http://localhost:8080";

		const timeout = process.env.NODE_ENV === "test" ? 5000 : 300000;

		this.rigApiClient = axios.create({
			baseURL: this.rigApiBaseUrl,
			timeout,
			headers: {
				"Content-Type": "application/json",
			},
		});

		// Add request interceptor for trace context propagation
		this.rigApiClient.interceptors.request.use(
			(config: InternalAxiosRequestConfig) => {
				// Get current trace context from OTEL
				const activeSpan = trace.getActiveSpan();
				const spanContext = activeSpan?.spanContext();

				if (spanContext && trace.isSpanContextValid(spanContext)) {
					const traceId = spanContext.traceId;
					const spanId = spanContext.spanId;
					const sampled = (spanContext.traceFlags & 1) === 1;
					const flags = sampled ? "01" : "00";

					// Inject W3C Trace Context headers
					config.headers.set(
						TRACEPARENT_HEADER,
						`00-${traceId}-${spanId}-${flags}`,
					);
					config.headers.set(CORRELATION_ID_HEADER, traceId);
					config.headers.set(REQUEST_ID_HEADER, traceId);

					console.log(
						`[RigAgent] Propagating trace context: ${traceId.slice(0, 8)}`,
					);
				}

				return config;
			},
		);
	}

	/**
	 * Create initial workflow state.
	 * Delegates to appConfig.createInitialWorkflowState if provided,
	 * otherwise returns a minimal default state.
	 */
	private createInitialWorkflowState(): Record<string, unknown> {
		if (this.appConfig.createInitialWorkflowState) {
			return this.appConfig.createInitialWorkflowState();
		}
		return {
			executionId: "",
			workflowName: "",
			status: "idle",
			progress: {
				currentStep: 0,
				totalSteps: 1,
				currentActivity: "",
				category: "setup",
			},
			duration: { startedAt: "" },
		};
	}

	/**
	 * Determine progress category from a progress message.
	 * Delegates to appConfig.progressCategorizer if provided,
	 * otherwise returns "setup" as a generic fallback.
	 */
	private getProgressCategory(message: string): string {
		if (this.appConfig.progressCategorizer) {
			const category = this.appConfig.progressCategorizer(message);
			if (category !== undefined) {
				return category;
			}
		}
		return "setup";
	}

	/**
	 * Reset workflow state for a new execution
	 */
	private resetWorkflowState(): void {
		this.workflowAgentState = this.createInitialWorkflowState();
		this.durableSessionInitialized = false;
	}

	/**
	 * Access a nested sub-object of workflowAgentState as a mutable record.
	 * Returns the value at the given key, cast to Record<string, unknown>.
	 */
	private stateObj(key: string): Record<string, unknown> {
		return this.workflowAgentState[key] as Record<string, unknown>;
	}

	/**
	 * Initialize a durable session in the backend for event storage.
	 * Delegates to appConfig.durableSessionInitializer if provided.
	 * This is fire-and-forget — errors are logged but don't block the workflow.
	 */
	private initializeDurableSession(): void {
		// Only initialize once per execution
		if (this.durableSessionInitialized) {
			return;
		}

		// Mark as initialized immediately to prevent duplicate calls
		this.durableSessionInitialized = true;

		if (this.appConfig.durableSessionInitializer) {
			// Fire-and-forget: intentionally not awaited
			void this.appConfig
				.durableSessionInitializer(this.currentAuthToken)
				.then((metadata) => {
					console.log(
						"[RigAgent] Durable session initialized:",
						JSON.stringify(metadata),
					);
				})
				.catch((error) => {
					console.error(
						"[RigAgent] Failed to initialize durable session:",
						error instanceof Error ? error.message : error,
					);
				});
		} else {
			console.log(
				"[RigAgent] No durable session initializer configured, skipping.",
			);
		}
	}

	private async getSessionMetadata(
		authToken: string | undefined,
	): Promise<Record<string, unknown>> {
		if (!this.appConfig.durableSessionInitializer) {
			return {};
		}

		try {
			return await this.appConfig.durableSessionInitializer(authToken);
		} catch (error) {
			console.error(
				"[RigAgent] Failed to derive session metadata:",
				error instanceof Error ? error.message : error,
			);
			return {};
		}
	}

	private getUserIdFromMetadata(): string | undefined {
		const userId =
			this.currentSessionMetadata.user_id ?? this.currentSessionMetadata.userId;
		return typeof userId === "string" && userId.length > 0
			? userId
			: undefined;
	}

	/**
	 * Start an agent run and return an Observable of AG-UI protocol events.
	 *
	 * The Observable emits `RUN_STARTED`, content/tool/state events, and
	 * finally `RUN_FINISHED`. On error, an `ERROR` event is emitted before
	 * the Observable errors out.
	 *
	 * @param input - Run parameters including messages, tools, and context.
	 * @param subscriber - Optional callback subscriber for side-effect handling.
	 * @returns An RxJS Observable of {@link BaseEvent} objects.
	 */
	public runAgent(
		input: RunAgentInput,
		subscriber?: AgentSubscriber,
	): Observable<BaseEvent> {
		return new Observable<BaseEvent>((observer) => {
			this.executeRun(input, observer, subscriber).catch((error) => {
				observer.error(error);
			});
		});
	}

	/**
	 * Execute the agent run by communicating with Rig API
	 */
	private async executeRun(
		input: RunAgentInput,
		// biome-ignore lint/suspicious/noExplicitAny: RxJS Observer type from Observable pattern
		observer: any,
		subscriber?: AgentSubscriber,
	): Promise<void> {
		const { runId, threadId, messages = [], context = [], authToken } = input;

		try {
			this.currentAuthToken = authToken;
			this.currentSessionMetadata = await this.getSessionMetadata(authToken);

			// Update thread ID if provided
			if (threadId) {
				this.threadId = threadId;
			}

			// Emit run started event
			const runStartedEvent: BaseEvent = {
				type: EventType.RUN_STARTED,
				threadId: this.threadId,
				runId,
				timestamp: Date.now(),
			};
			observer.next(runStartedEvent);
			subscriber?.next?.(runStartedEvent);

			// Update agent state
			this.state.status = "processing";
			this.emitStatusUpdate(observer, subscriber, runId);

			// NOTE: We do NOT emit initial "running" state here for UI loading skeleton.
			// This was causing ALL chat messages to show loading skeletons in PostCanvas.
			// Instead, the "running" state is only emitted when we actually receive
			// __STATE_UPDATE__ markers from the workflow SSE stream, which indicates
			// a backend workflow is actually being triggered.
			// Reset workflow state for this run (will be populated if a workflow triggers)
			this.resetWorkflowState();

			// Create or REUSE Rig API session
			// CRITICAL: Reusing the same session preserves chat history in the backend
			let rigSessionId: string;

			try {
				// Reuse existing session if we have one (enables chat memory)
				if (this.rigSessionId) {
					rigSessionId = this.rigSessionId;
					console.log(
						`♻️ Reusing existing Rig session: ${rigSessionId} (enables chat history)`,
					);
				} else {
					// Map CopilotKit agent ID to the Rig agent type expected by the backend.
					// The default bridge uses the general workflow-assistance agent.
					const agentType = "general";

					// Create session with OTEL span
					const tracer = trace.getTracer("ag-ui-middleware");
					const sessionResponse = await tracer.startActiveSpan(
						"rig.create_session",
						{
							kind: SpanKind.CLIENT,
							attributes: {
								"rig.agent_type": agentType,
								"rig.run_id": runId,
							},
						},
						async (span) => {
							try {
								const response = await this.rigApiClient.post("/sessions", {
									user_context: {
										agent_id: agentType,
										user_id: this.getUserIdFromMetadata(),
										context: context,
									},
								});
								span.setAttribute("rig.session_id", response.data.session_id);
								span.setStatus({ code: SpanStatusCode.OK });
								return response;
							} catch (error) {
								span.recordException(error as Error);
								span.setStatus({
									code: SpanStatusCode.ERROR,
									message: (error as Error).message,
								});
								throw error;
							} finally {
								span.end();
							}
						},
					);

					rigSessionId = sessionResponse.data.session_id;
					// Cache the session ID for subsequent messages
					this.rigSessionId = rigSessionId;
					console.log(
						`🆕 Created new Rig session: ${rigSessionId} (cached for chat history)`,
					);
				}

				// Process messages if provided
				if (messages.length > 0) {
					const latestMessage = messages[messages.length - 1];
					await this.processMessageWithRig(
						rigSessionId,
						latestMessage,
						runId,
						observer,
						subscriber,
						authToken,
					);
				} else {
					// No messages to process, complete immediately
					this.completeRun(runId, observer, subscriber);
				}
			} catch (rigError) {
				// Handle Rig API connection failures gracefully
				console.error(
					`❌ Rig API connection failed: ${rigError instanceof Error ? rigError.message : rigError}`,
				);
				if (rigError instanceof Error && rigError.stack) {
					console.error("Stack:", rigError.stack);
				}

				// Simulate response for testing/demo purposes
				if (messages.length > 0) {
					await this.simulateResponse(
						messages[messages.length - 1],
						runId,
						observer,
						subscriber,
					);
				}

				// Complete the run after simulation
				this.completeRun(runId, observer, subscriber);
			}
		} catch (error) {
			this.state.status = "errored";
			this.state.errorContext = {
				error: error instanceof Error ? error.name : "UnknownError",
				message:
					error instanceof Error ? error.message : "An unknown error occurred",
				timestamp: Date.now(),
			};

			const errorEvent: BaseEvent = {
				type: EventType.ERROR,
				threadId: this.threadId,
				runId,
				timestamp: Date.now(),
				data: this.state.errorContext,
			};
			observer.next(errorEvent);
			subscriber?.error?.(
				error instanceof Error ? error : new Error(String(error)),
			);
			observer.error(error);
		}
	}

	/**
	 * Process a message through Rig API and stream the response
	 */
	private async processMessageWithRig(
		sessionId: string,
		message: Message,
		runId: string,
		// biome-ignore lint/suspicious/noExplicitAny: RxJS Observer type from Observable pattern
		observer: any,
		subscriber?: AgentSubscriber,
		authToken?: string,
	): Promise<void> {
		// Always generate a NEW messageId for the assistant response.
		// Using the input message's ID would cause defaultApplyEvents to
		// append assistant content to the user message instead of creating
		// a separate one.
		const messageId = uuidv4();

		// Emit message start event
		const messageStartEvent: BaseEvent = {
			type: EventType.TEXT_MESSAGE_START,
			threadId: this.threadId,
			runId,
			messageId,
			timestamp: Date.now(),
			data: {
				role: "assistant",
				messageId,
			},
		};
		observer.next(messageStartEvent);
		subscriber?.next?.(messageStartEvent);

		try {
			// Send message to Rig API for streaming response
			const messageUrl = `/sessions/${sessionId}/messages`;

			// To pass user identity to your Rig backend, implement durableSessionInitializer
			// in your RigAgentAppConfig. The authToken is available in the request context.
			// Example: durableSessionInitializer: async (authToken) => ({ userId: parseJwt(authToken).sub })

			const response = await this.rigApiClient.post(
				messageUrl,
				{
					content: message.content,
					// Forward auth token for workflow execution (JWT from original request)
					auth_token: authToken,
					user_id: this.getUserIdFromMetadata(),
				},
				{
					responseType: "stream",
					headers: {
						Accept: "text/event-stream",
					},
				},
			);
			console.log(
				"[RigAgent] Got streaming response, setting up event listeners",
			);

			// Process the streaming response
			let accumulatedContent = "";
			let streamCompleted = false;
			let chunksReceived = 0;

			response.data.on("data", (chunk: Buffer) => {
				chunksReceived++;
				console.log(
					`[RigAgent] Received chunk #${chunksReceived}:`,
					chunk.toString().substring(0, 200),
				);
				const lines = chunk.toString().split("\n");

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						try {
							const eventData = JSON.parse(line.slice(6));

							// Handle actual Rig API format: {"content": "...", "sequence": N, "is_final": bool}
							if (eventData.content !== undefined) {
								const content = eventData.content;

								// Log content type for debugging
								const contentPrefix = content.substring(0, 30);
								if (
									content.startsWith("__TOOL_CALL__") ||
									content.startsWith("__STATE_UPDATE__")
								) {
									console.log(
										`[RigAgent] Detected special marker: ${contentPrefix}...`,
									);
								}

								// Feature 031: Check for tool call marker
								if (content.startsWith("__TOOL_CALL__:")) {
									console.log(
										`[RigAgent] Processing tool call: ${content.substring(0, 100)}`,
									);
									// Parse tool call: __TOOL_CALL__:name:args
									const toolCallData = content.substring(
										"__TOOL_CALL__:".length,
									);
									const firstColonIndex = toolCallData.indexOf(":");
									if (firstColonIndex > 0) {
										const toolName = toolCallData.substring(0, firstColonIndex);
										const toolArgsJson = toolCallData.substring(
											firstColonIndex + 1,
										);
										const toolCallId = `${toolName}-${runId}`;

										try {
											// Parse to validate JSON format (throws if invalid)
											const parsedArgs = JSON.parse(toolArgsJson);

											// Emit AG-UI standard TOOL_CALL_START event
											// Include parsed args so GraphQL server can create ActionExecutionMessage immediately
											const toolStartEvent: BaseEvent = {
												type: EventType.TOOL_CALL_START,
												threadId: this.threadId,
												runId,
												messageId,
												timestamp: Date.now(),
												data: {
													toolCallId,
													toolCallName: toolName,
													parentMessageId: messageId,
													args: parsedArgs, // Include args for immediate rendering
												},
											};
											observer.next(toolStartEvent);
											subscriber?.next?.(toolStartEvent);

											// Emit TOOL_CALL_ARGS with the full args (single delta)
											const toolArgsEvent: BaseEvent = {
												type: EventType.TOOL_CALL_ARGS,
												threadId: this.threadId,
												runId,
												timestamp: Date.now(),
												data: {
													toolCallId,
													delta: toolArgsJson,
												},
											};
											observer.next(toolArgsEvent);
											subscriber?.next?.(toolArgsEvent);

											// Emit TOOL_CALL_END to complete the sequence
											const toolEndEvent: BaseEvent = {
												type: EventType.TOOL_CALL_END,
												threadId: this.threadId,
												runId,
												timestamp: Date.now(),
												data: {
													toolCallId,
													toolCallName: toolName, // Include name for ResultMessageOutput
												},
											};
											observer.next(toolEndEvent);
											subscriber?.next?.(toolEndEvent);

											// Also emit as text marker for frontend detection.
											// CopilotKit's multipart format replaces data on each chunk,
											// so ActionExecutionMessageOutput gets overwritten by the next
											// text chunk. The hook useCopilotToolCallSync detects these
											// markers in TextMessage content as the reliable execution path.
											const textMarker = `<!--TOOL_CALL:${toolName}:${toolArgsJson}-->`;
											accumulatedContent += textMarker;

											const markerEvent: BaseEvent = {
												type: EventType.TEXT_MESSAGE_CONTENT,
												threadId: this.threadId,
												runId,
												messageId,
												timestamp: Date.now(),
												data: {
													delta: textMarker,
													accumulated: accumulatedContent,
												},
											};
											observer.next(markerEvent);
											subscriber?.next?.(markerEvent);

											console.log(
												`[RigAgent] Tool call processed: ${toolName} (TOOL_CALL events + text marker emitted)`,
											);
										} catch (parseError) {
											console.error(
												"Failed to parse tool call args:",
												parseError,
												toolArgsJson,
											);
										}
									}
								}
								// Feature 031: Check for state update marker from workflow SSE events
								else if (content.startsWith("__STATE_UPDATE__:")) {
									// Parse state update: __STATE_UPDATE__:event_type:data
									const stateData = content.substring(
										"__STATE_UPDATE__:".length,
									);
									const firstColonIndex = stateData.indexOf(":");
									if (firstColonIndex > 0) {
										const sseEventType = stateData.substring(
											0,
											firstColonIndex,
										);
										const eventDataJson = stateData.substring(
											firstColonIndex + 1,
										);

										try {
											const workflowEvent = JSON.parse(eventDataJson);
											console.log(
												"[RigAgent] Processing workflow SSE event:",
												sseEventType,
												JSON.stringify(workflowEvent, null, 2),
											);

											// Handle "status" events - initialize or update execution state
											if (sseEventType === "status") {
												const workflowStatus =
													workflowEvent.data?.status || workflowEvent.status;
												const executionId =
													workflowEvent.data?.execution_id ||
													workflowEvent.execution_id ||
													runId;
												const workflowName =
													workflowEvent.data?.workflow_name ||
													workflowEvent.workflow_name ||
													"";

												// Initialize state if this is a new execution
												if (
													this.workflowAgentState.executionId !== executionId
												) {
													this.resetWorkflowState();
													this.workflowAgentState.executionId = executionId;
													this.workflowAgentState.workflowName = workflowName;
													this.stateObj("duration").startedAt =
														new Date().toISOString();

													// Initialize durable session in backend for event storage.
													// This is fire-and-forget — won't block the workflow.
													this.initializeDurableSession();
												}

												// Map workflow status to expected format
												if (workflowStatus === "running") {
													this.workflowAgentState.status = "running";
												} else if (workflowStatus === "completed") {
													this.workflowAgentState.status = "completed";
													this.stateObj("duration").completedAt =
														new Date().toISOString();
												} else if (workflowStatus === "failed") {
													this.workflowAgentState.status = "failed";
												}

												console.log(
													"[RigAgent] Setting agent status:",
													this.workflowAgentState.status,
												);
											}

											// Handle "progress" events - update progress state
											if (sseEventType === "progress") {
												const progressMessage =
													workflowEvent.data?.message ||
													workflowEvent.message ||
													"";
												const prevProgress = this.stateObj("progress");
												const prevStep =
													(prevProgress.currentStep as number) || 0;
												const prevTotal =
													(prevProgress.totalSteps as number) || 1;
												this.workflowAgentState.progress = {
													currentStep: prevStep + 1,
													totalSteps: Math.max(prevTotal, prevStep + 2),
													currentActivity: progressMessage,
													category: this.getProgressCategory(progressMessage),
												};
											}

											// Apply stateTransformer hook for custom event handling.
											// The transformer receives the current accumulated
											// workflowAgentState and may return a new state object.
											// Platform-specific logic (e.g. building proposedPosts,
											// opportunities) belongs in the stateTransformer provided
											// via appConfig — not in this generic agent.
											//
											// Example stateTransformer (social media platform):
											// stateTransformer: (rawState) => {
											//   const event = rawState.__latestEvent as { sseEventType: string; workflowEvent: unknown }
											//   if (event?.sseEventType === 'custom') {
											//     const payload = (event.workflowEvent as { data?: { payload?: { posts?: unknown[] } } })?.data?.payload ?? {}
											//     const posts = (payload as { posts?: unknown[] }).posts ?? []
											//     if (posts.length > 0) {
											//       return { ...rawState, status: 'awaiting_approval', proposedPosts: posts.map(mapPost) }
											//     }
											//   }
											//   return rawState
											// }
											if (this.appConfig.stateTransformer) {
												const transformed = this.appConfig.stateTransformer({
													...this.workflowAgentState,
													__latestEvent: { sseEventType, workflowEvent },
												});
												// Remove the internal __latestEvent helper key before storing
												const { __latestEvent: _dropped, ...rest } =
													transformed;
												this.workflowAgentState = rest;
											}

											// Handle error events
											if (sseEventType === "error") {
												this.workflowAgentState.status = "failed";
												this.workflowAgentState.error = {
													code:
														workflowEvent.data?.errorCode ||
														workflowEvent.errorCode ||
														"UNKNOWN",
													message:
														workflowEvent.data?.error ||
														workflowEvent.error ||
														"Unknown error",
												};
											}

											// Emit the complete state for CopilotKit
											// Use dynamic agent name based on workflow
											const workflowName =
												(this.workflowAgentState.workflowName as string) ||
												"workflow";
											const mapper = this.appConfig.workflowNameMapper;
											const mappedName = mapper
												? mapper(workflowName)
												: undefined;
											const dynamicAgentName =
												mappedName ??
												`${workflowName.toLowerCase().replace(/\s+/g, "-")}-agent`;
											const stateUpdateEvent: BaseEvent = {
												type: EventType.AGENT_STATE_UPDATE,
												threadId: this.threadId,
												runId,
												timestamp: Date.now(),
												data: {
													agentName: dynamicAgentName,
													state: { ...this.workflowAgentState },
												},
											};
											console.log(
												`[RigAgent] Emitting state update to agent: ${dynamicAgentName}`,
											);
											observer.next(stateUpdateEvent);
											subscriber?.next?.(stateUpdateEvent);
										} catch (parseError) {
											console.error(
												"Failed to parse state update data:",
												parseError,
												eventDataJson,
											);
										}
									}
								}
								// Only process non-empty content or when is_final is true
								else if (content || eventData.is_final) {
									accumulatedContent += content;

									// Emit content chunk event
									const contentEvent: BaseEvent = {
										type: EventType.TEXT_MESSAGE_CONTENT,
										threadId: this.threadId,
										runId,
										messageId,
										timestamp: Date.now(),
										data: {
											delta: content,
											accumulated: accumulatedContent,
										},
									};
									observer.next(contentEvent);
									subscriber?.next?.(contentEvent);
								}
							}
							// Fallback: Handle old format if needed (chunk.chunk_type)
							else if (eventData.chunk) {
								const chunkType = eventData.chunk.chunk_type;

								if (chunkType === "Text" && eventData.chunk.content) {
									const content = eventData.chunk.content;
									accumulatedContent += content;

									// Emit content chunk event
									const contentEvent: BaseEvent = {
										type: EventType.TEXT_MESSAGE_CONTENT,
										threadId: this.threadId,
										runId,
										messageId,
										timestamp: Date.now(),
										data: {
											delta: content,
											accumulated: accumulatedContent,
										},
									};
									observer.next(contentEvent);
									subscriber?.next?.(contentEvent);
								} else if (
									chunkType === "StateUpdate" &&
									eventData.chunk.content
								) {
									// Parse the state update content
									try {
										const stateData = JSON.parse(eventData.chunk.content);

										// Emit state update event for AG-UI protocol
										const stateUpdateEvent: BaseEvent = {
											type: EventType.AGENT_STATE_UPDATE,
											threadId: this.threadId,
											runId,
											timestamp: Date.now(),
											data: {
												agentName: stateData.agentName,
												state: stateData.state,
											},
										};
										observer.next(stateUpdateEvent);
										subscriber?.next?.(stateUpdateEvent);
									} catch (parseError) {
										console.error("Failed to parse state update:", parseError);
									}
								}
							}
						} catch (parseError) {
							console.error("Failed to parse Rig API event:", line, parseError);
						}
					}
				}
			});

			response.data.on("end", () => {
				if (streamCompleted) return;
				streamCompleted = true;

				// Emit message end event
				const messageEndEvent: BaseEvent = {
					type: EventType.TEXT_MESSAGE_END,
					threadId: this.threadId,
					runId,
					messageId,
					timestamp: Date.now(),
					data: {
						finalContent: accumulatedContent,
						messageId,
					},
				};
				observer.next(messageEndEvent);
				subscriber?.next?.(messageEndEvent);

				// Add assistant message to history
				this.messages.push({
					id: messageId,
					role: "assistant",
					content: accumulatedContent,
					timestamp: Date.now(),
				});

				// Complete the run
				this.completeRun(runId, observer, subscriber);

				// Clean up the stream
				response.data.destroy();
			});

			// biome-ignore lint/suspicious/noExplicitAny: Node.js stream error event
			response.data.on("error", (error: any) => {
				if (streamCompleted) return;
				streamCompleted = true;

				console.error("❌ Rig API stream error:", error);

				// Clean up the stream
				response.data.destroy();

				// Emit error event
				const errorEvent: BaseEvent = {
					type: EventType.ERROR,
					threadId: this.threadId,
					runId,
					messageId,
					timestamp: Date.now(),
					data: {
						error: error.code || "STREAM_ERROR",
						message: error.message || "Stream connection error",
					},
				};
				observer.next(errorEvent);

				// Complete the run even on error
				this.completeRun(runId, observer, subscriber);
			});
		} catch (error) {
			throw new Error(
				`Failed to process message with Rig API: ${error instanceof Error ? error.message : error}`,
			);
		}
	}

	/**
	 * Interrupt an ongoing agent execution by notifying the Rig backend.
	 *
	 * @param runId - The run to interrupt.
	 * @param reason - A human-readable reason for the interruption.
	 * @throws {Error} If no active session exists or the Rig API call fails.
	 */
	public async interruptAgent(runId: string, reason: string): Promise<void> {
		if (!this.threadId) {
			throw new Error("No active session to interrupt");
		}

		try {
			await this.rigApiClient.post(`/sessions/${this.threadId}/interrupt`, {
				reason,
			});

			this.state.status = "idle";
			this.emit("interrupted", { runId, reason, timestamp: Date.now() });
		} catch (error) {
			throw new Error(
				`Failed to interrupt agent: ${error instanceof Error ? error.message : error}`,
			);
		}
	}

	/**
	 * Return a snapshot of the current agent state.
	 */
	public getState(): AgentState {
		return { ...this.state };
	}

	/**
	 * Emit agent status update event
	 */
	private emitStatusUpdate(
		// biome-ignore lint/suspicious/noExplicitAny: RxJS Observer type from Observable pattern
		observer: any,
		subscriber?: AgentSubscriber,
		runId?: string,
	): void {
		const statusEvent: BaseEvent = {
			type: EventType.AGENT_STATUS_UPDATE,
			threadId: this.threadId,
			runId,
			timestamp: Date.now(),
			data: {
				status: this.state.status,
				availableTools: this.state.availableTools,
				reasoningSteps: this.state.reasoningSteps,
			},
		};
		observer.next(statusEvent);
		subscriber?.next?.(statusEvent);
	}

	/**
	 * Simulate a response when Rig API is not available (for testing/demo)
	 */
	private async simulateResponse(
		message: Message,
		runId: string,
		// biome-ignore lint/suspicious/noExplicitAny: RxJS Observer type from Observable pattern
		observer: any,
		subscriber?: AgentSubscriber,
	): Promise<void> {
		const messageId = uuidv4();

		// Emit message start event
		const messageStartEvent: BaseEvent = {
			type: EventType.TEXT_MESSAGE_START,
			threadId: this.threadId,
			runId,
			messageId,
			timestamp: Date.now(),
			data: {
				role: "assistant",
				messageId,
			},
		};
		observer.next(messageStartEvent);
		subscriber?.next?.(messageStartEvent);

		// Simulate typing delay
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Simulate streaming response
		const simulatedResponse = `Thank you for your message: "${message.content}". This is a simulated response from the AG-UI middleware (Rig API not available).`;
		const chunks = simulatedResponse.split(" ");

		let accumulatedContent = "";

		for (const chunk of chunks) {
			accumulatedContent += `${chunk} `;

			const contentEvent: BaseEvent = {
				type: EventType.TEXT_MESSAGE_CONTENT,
				threadId: this.threadId,
				runId,
				messageId,
				timestamp: Date.now(),
				data: {
					delta: `${chunk} `,
					accumulated: accumulatedContent.trim(),
				},
			};
			observer.next(contentEvent);
			subscriber?.next?.(contentEvent);

			// Simulate typing delay between chunks
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		// Emit message end event
		const messageEndEvent: BaseEvent = {
			type: EventType.TEXT_MESSAGE_END,
			threadId: this.threadId,
			runId,
			messageId,
			timestamp: Date.now(),
			data: {
				finalContent: accumulatedContent.trim(),
				messageId,
			},
		};
		observer.next(messageEndEvent);
		subscriber?.next?.(messageEndEvent);

		// Add assistant message to history
		this.messages.push({
			id: messageId,
			role: "assistant",
			content: accumulatedContent.trim(),
			timestamp: Date.now(),
		});
	}

	/**
	 * Check connectivity to the Rig backend API.
	 *
	 * @returns An object indicating whether the Rig API is reachable.
	 */
	public async healthCheck(): Promise<{
		status: string;
		rigApiConnected: boolean;
	}> {
		try {
			await this.rigApiClient.get("/health");
			return {
				status: "healthy",
				rigApiConnected: true,
			};
		} catch (_error) {
			return {
				status: "unhealthy",
				rigApiConnected: false,
			};
		}
	}

	/**
	 * Complete the agent run and close the observable
	 *
	 * @param runId - Run identifier
	 * @param observer - RxJS observer
	 * @param subscriber - Optional agent subscriber
	 */
	private completeRun(
		runId: string,
		// biome-ignore lint/suspicious/noExplicitAny: RxJS Observer type from Observable pattern
		observer: any,
		subscriber?: AgentSubscriber,
	): void {
		// Emit run finished event
		this.state.status = "idle";
		const runFinishedEvent: BaseEvent = {
			type: EventType.RUN_FINISHED,
			threadId: this.threadId,
			runId,
			timestamp: Date.now(),
		};

		observer.next(runFinishedEvent);
		subscriber?.next?.(runFinishedEvent);

		// Complete the observable
		observer.complete();
	}
}
