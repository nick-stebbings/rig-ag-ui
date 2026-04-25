import { v4 as uuidv4 } from "uuid";
import {
	type BaseEvent,
	EventType,
	type Message,
	type Tool,
} from "../agents/rig_abstract_agent";

/**
 * Represents a single streaming response chunk from the Rig backend.
 *
 * The `type` discriminant determines which optional fields are populated.
 */
export interface RigStreamingResponse {
	/** Discriminant indicating the kind of streaming chunk. */
	type: "content" | "thinking" | "tool_call" | "complete" | "error";
	/** Incremental text delta for content/thinking chunks. */
	delta?: string;
	/** Full or accumulated content payload. */
	content?: string;
	/** Name of the tool being called (for `tool_call` type). */
	tool_name?: string;
	/** Tool invocation arguments (for `tool_call` type). */
	tool_input?: Record<string, unknown>;
	/** Error identifier (for `error` type). */
	error?: string;
	/** Human-readable error or status message. */
	message?: string;
	/** Backend session identifier. */
	session_id?: string;
	/** Message identifier assigned by the backend. */
	message_id?: string;
	/** Epoch timestamp in milliseconds. */
	timestamp?: number;
	/** Current agent processing status string. */
	agent_status?: string;
}

/**
 * Represents a shared-state mutation event destined for CopilotKit
 * `useCoAgent` consumers.
 */
export interface SharedStateEvent {
	type: "state_update";
	/** The CopilotKit agent name this state belongs to. */
	agentName: string;
	/** The state payload (e.g. recipe data, workflow status). */
	state: Record<string, unknown>;
	/** Epoch timestamp in milliseconds. */
	timestamp: number;
}

/**
 * A single message in the CopilotKit conversation format.
 */
export interface CopilotMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	metadata?: Record<string, unknown>;
	timestamp: number;
}

/**
 * A tool definition in CopilotKit format, with JSON Schema parameters.
 */
export interface CopilotTool {
	name: string;
	description: string;
	parameters: {
		type: "object";
		properties: Record<string, unknown>;
		required: string[];
	};
}

/**
 * The request body sent by a CopilotKit V2 runtime client.
 */
export interface CopilotRuntimeRequest {
	messages: CopilotMessage[];
	tools?: CopilotTool[];
	config?: {
		agentId?: string;
		sessionId?: string;
		model?: string;
		stream?: boolean;
	};
}

/**
 * A streaming chunk in CopilotKit format.
 *
 * The `type` discriminant identifies the chunk kind (content delta,
 * tool call, status update, etc.). The `data` object carries the
 * type-specific payload.
 */
export interface CopilotStreamChunk {
	type: "content" | "thinking" | "status" | "tool_call" | "complete" | "error";
	data: {
		delta?: string;
		content?: string;
		status?: string;
		toolName?: string;
		toolInput?: Record<string, unknown>;
		messageId?: string;
		timestamp: number;
		[key: string]: unknown;
	};
}

/**
 * The canonical AG-UI agent run request structure.
 *
 * Used as the internal representation after validating and normalising
 * incoming requests from any transport (REST, etc.).
 */
export interface AgentRunRequest {
	/** Unique identifier for this run. */
	runId: string;
	/** Ordered conversation messages. */
	messages: Message[];
	/** Available tools, each wrapped with a type discriminant. */
	tools?: Array<{ type: string; value: unknown }>;
	/** Contextual metadata entries (agent ID, thread ID, model, etc.). */
	context?: Array<{ type: string; value: unknown }>;
}

/**
 * Stateless utility class for translating between Rig backend responses,
 * AG-UI protocol events, and CopilotKit streaming chunks.
 *
 * All methods are static -- no instance state is required.
 *
 * @example
 * ```typescript
 * const aguiEvent = RigToAguiTranslator.rigResponseToAgentEvent(rigChunk, threadId, runId);
 * const copilotChunk = RigToAguiTranslator.agentEventToCopilotChunk(aguiEvent);
 * ```
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Utility class pattern for protocol translation methods
export class RigToAguiTranslator {
	/**
	 * Convert an AG-UI {@link BaseEvent} to a {@link CopilotStreamChunk}.
	 *
	 * Maps each AG-UI event type to the corresponding CopilotKit chunk type
	 * so that events can be forwarded to CopilotKit-compatible consumers.
	 *
	 * @param event - The AG-UI protocol event to translate.
	 * @returns The equivalent CopilotKit stream chunk.
	 */
	public static agentEventToCopilotChunk(event: BaseEvent): CopilotStreamChunk {
		switch (event.type) {
			case EventType.TEXT_MESSAGE_CONTENT:
				return {
					type: "content",
					data: {
						delta: (event.data?.delta as string) || "",
						content: (event.data?.accumulated as string) || "",
						messageId: event.messageId,
						timestamp: event.timestamp || Date.now(),
					},
				};

			case EventType.THINKING_DISPLAY:
				return {
					type: "thinking",
					data: {
						content: (event.data?.thinking as string) || "",
						messageId: event.messageId,
						timestamp: event.timestamp || Date.now(),
					},
				};

			case EventType.AGENT_STATUS_UPDATE:
				return {
					type: "status",
					data: {
						status: (event.data?.status as string) || "processing",
						availableTools: (event.data?.availableTools as string[]) || [],
						reasoningSteps: (event.data?.reasoningSteps as string[]) || [],
						timestamp: event.timestamp || Date.now(),
					},
				};

			case EventType.TOOL_EXECUTION:
				return {
					type: "tool_call",
					data: {
						toolName: (event.data?.toolName as string) || "",
						toolInput: (event.data?.toolInput as Record<string, unknown>) || {},
						callId: (event.data?.callId as string) || uuidv4(),
						timestamp: event.timestamp || Date.now(),
					},
				};

			// AG-UI standard tool call events (Feature 031)
			// Note: GraphQL server expects 'event' not 'status' for tool call lifecycle
			case EventType.TOOL_CALL_START:
				return {
					type: "tool_call",
					data: {
						event: "start",
						toolCallId: (event.data?.toolCallId as string) || "",
						toolCallName: (event.data?.toolCallName as string) || "",
						parentMessageId:
							(event.data?.parentMessageId as string) || event.messageId || "",
						// Include args if present (for immediate ActionExecutionMessage creation)
						args: (event.data?.args as Record<string, unknown>) || {},
						timestamp: event.timestamp || Date.now(),
					},
				};

			case EventType.TOOL_CALL_ARGS:
				return {
					type: "tool_call",
					data: {
						event: "args",
						toolCallId: (event.data?.toolCallId as string) || "",
						delta: (event.data?.delta as string) || "",
						// Parse the delta as args if it's valid JSON
						args: (() => {
							try {
								return JSON.parse((event.data?.delta as string) || "{}");
							} catch {
								return {};
							}
						})(),
						timestamp: event.timestamp || Date.now(),
					},
				};

			case EventType.TOOL_CALL_END:
				return {
					type: "tool_call",
					data: {
						event: "end",
						toolCallId: (event.data?.toolCallId as string) || "",
						toolCallName: (event.data?.toolCallName as string) || "",
						timestamp: event.timestamp || Date.now(),
					},
				};

			case EventType.RUN_FINISHED:
			case EventType.TEXT_MESSAGE_END:
				return {
					type: "complete",
					data: {
						messageId: event.messageId,
						finalContent: event.data?.finalContent || "",
						runId: event.runId,
						timestamp: event.timestamp || Date.now(),
					},
				};

			case EventType.ERROR:
				return {
					type: "error",
					data: {
						error: event.data?.error || "UnknownError",
						message: event.data?.message || "An error occurred",
						code: event.data?.code || 500,
						details: event.data?.details || {},
						timestamp: event.timestamp || Date.now(),
					},
				};

			// Agent state updates for CopilotKit useCoAgent
			case EventType.AGENT_STATE_UPDATE:
				return {
					type: "status",
					data: {
						status: "agent_state_update",
						agentName: (event.data?.agentName as string) || "default",
						state: (event.data?.state as Record<string, unknown>) || {},
						timestamp: event.timestamp || Date.now(),
					},
				};

			default:
				// For unknown event types, return a generic status update
				return {
					type: "status",
					data: {
						status: "processing",
						eventType: event.type,
						timestamp: event.timestamp || Date.now(),
					},
				};
		}
	}

	/**
	 * Convert a Rig backend streaming response chunk into an AG-UI {@link BaseEvent}.
	 *
	 * This is the primary translation path: Rig SSE -> AG-UI protocol events.
	 *
	 * @param rigResponse - The raw streaming chunk from the Rig API.
	 * @param threadId - Optional conversation thread identifier.
	 * @param runId - Optional AG-UI run identifier.
	 * @returns The equivalent AG-UI protocol event.
	 */
	public static rigResponseToAgentEvent(
		rigResponse: RigStreamingResponse,
		threadId?: string,
		runId?: string,
	): BaseEvent {
		const timestamp = rigResponse.timestamp || Date.now();
		const messageId = rigResponse.message_id || uuidv4();

		switch (rigResponse.type) {
			case "content":
				return {
					type: EventType.TEXT_MESSAGE_CONTENT,
					threadId,
					runId,
					messageId,
					timestamp,
					data: {
						delta: rigResponse.delta || "",
						content: rigResponse.content || "",
					},
				};

			case "thinking":
				return {
					type: EventType.THINKING_DISPLAY,
					threadId,
					runId,
					messageId,
					timestamp,
					data: {
						thinking: rigResponse.content || "",
					},
				};

			case "tool_call":
				return {
					type: EventType.TOOL_EXECUTION,
					threadId,
					runId,
					messageId,
					timestamp,
					data: {
						toolName: rigResponse.tool_name || "",
						toolInput: rigResponse.tool_input || {},
						callId: uuidv4(),
					},
				};

			case "complete":
				return {
					type: EventType.TEXT_MESSAGE_END,
					threadId,
					runId,
					messageId,
					timestamp,
					data: {
						finalContent: rigResponse.content || "",
						messageId,
					},
				};

			case "error":
				return {
					type: EventType.ERROR,
					threadId,
					runId,
					messageId,
					timestamp,
					data: {
						error: rigResponse.error || "UnknownError",
						message: rigResponse.message || "An error occurred",
					},
				};

			default:
				return {
					type: EventType.AGENT_STATUS_UPDATE,
					threadId,
					runId,
					messageId,
					timestamp,
					data: {
						status: rigResponse.agent_status || "processing",
					},
				};
		}
	}

	/**
	 * Convert a {@link CopilotMessage} to the internal AG-UI {@link Message} format.
	 *
	 * @param copilotMessage - The CopilotKit message to convert.
	 * @returns The equivalent AG-UI message.
	 */
	public static copilotMessageToAgentMessage(
		copilotMessage: CopilotMessage,
	): Message {
		return {
			id: copilotMessage.id,
			role: copilotMessage.role,
			content: copilotMessage.content,
			metadata: copilotMessage.metadata,
			timestamp: copilotMessage.timestamp,
		};
	}

	/**
	 * Convert an AG-UI {@link Message} to {@link CopilotMessage} format.
	 *
	 * @param agentMessage - The AG-UI message to convert.
	 * @returns The equivalent CopilotKit message.
	 */
	public static agentMessageToCopilotMessage(
		agentMessage: Message,
	): CopilotMessage {
		return {
			id: agentMessage.id,
			role: agentMessage.role,
			content: agentMessage.content,
			metadata: agentMessage.metadata,
			timestamp: agentMessage.timestamp || Date.now(),
		};
	}

	/**
	 * Convert a {@link CopilotTool} to the internal AG-UI {@link Tool} format.
	 *
	 * @param copilotTool - The CopilotKit tool definition to convert.
	 * @returns The equivalent AG-UI tool definition.
	 */
	public static copilotToolToAgentTool(copilotTool: CopilotTool): Tool {
		return {
			name: copilotTool.name,
			description: copilotTool.description,
			parameters: {
				type: copilotTool.parameters.type,
				properties: copilotTool.parameters.properties,
				required: copilotTool.parameters.required,
			},
		};
	}

	/**
	 * Convert an AG-UI {@link Tool} to {@link CopilotTool} format.
	 *
	 * @param agentTool - The AG-UI tool definition to convert.
	 * @returns The equivalent CopilotKit tool definition.
	 */
	public static agentToolToCopilotTool(agentTool: Tool): CopilotTool {
		return {
			name: agentTool.name,
			description: agentTool.description,
			parameters: {
				type: "object",
				properties: agentTool.parameters.properties || {},
				required: agentTool.parameters.required || [],
			},
		};
	}

	/**
	 * Serialize an AG-UI event as a V2-compliant SSE-formatted string.
	 *
	 * V2 uses bare `data:` lines with flattened event fields (no named event type).
	 *
	 * @param event - The AG-UI event to serialize.
	 * @returns A string ready to be written to an SSE response.
	 */
	public static formatAsSSE(event: BaseEvent): string {
		const { data, ...rest } = event;
		const flat = { ...rest, ...data };
		return `data: ${JSON.stringify(flat)}\n\n`;
	}

	/**
	 * Serialize a CopilotKit chunk as a V2-compliant SSE-formatted string.
	 *
	 * @param chunk - The CopilotKit chunk to serialize.
	 * @returns A string ready to be written to an SSE response.
	 */
	public static formatCopilotChunkAsSSE(chunk: CopilotStreamChunk): string {
		return `data: ${JSON.stringify(chunk)}\n\n`;
	}

	/**
	 * Validate that an unknown input conforms to {@link CopilotRuntimeRequest}.
	 *
	 * @param request - The raw request body to validate.
	 * @returns The validated request, typed as {@link CopilotRuntimeRequest}.
	 * @throws {Error} If required fields are missing or invalid.
	 */
	public static validateCopilotRuntimeRequest(
		// biome-ignore lint/suspicious/noExplicitAny: Validation function accepts unknown input
		request: any,
	): CopilotRuntimeRequest {
		if (!request.messages || !Array.isArray(request.messages)) {
			throw new Error(
				"Invalid request: messages field is required and must be an array",
			);
		}

		if (request.messages.length === 0) {
			throw new Error("Invalid request: messages array cannot be empty");
		}

		// Validate each message
		for (const msg of request.messages) {
			if (!msg.id || !msg.role || !msg.content) {
				throw new Error(
					"Invalid message: id, role, and content are required fields",
				);
			}

			if (!["user", "assistant", "system"].includes(msg.role)) {
				throw new Error(
					`Invalid message role: ${msg.role}. Must be one of: user, assistant, system`,
				);
			}
		}

		// Validate tools if provided
		if (request.tools && Array.isArray(request.tools)) {
			for (const tool of request.tools) {
				if (!tool.name || !tool.description) {
					throw new Error(
						"Invalid tool: name and description are required fields",
					);
				}
			}
		}

		return request as CopilotRuntimeRequest;
	}

	/**
	 * Validate that an unknown input conforms to {@link AgentRunRequest}.
	 *
	 * @param request - The raw request body to validate.
	 * @returns The validated request, typed as {@link AgentRunRequest}.
	 * @throws {Error} If `runId` or `messages` are missing/invalid.
	 */
	public static validateAgentRunRequest(
		// biome-ignore lint/suspicious/noExplicitAny: Validation function accepts unknown input
		request: any,
	): AgentRunRequest {
		if (!request.runId) {
			throw new Error("Invalid request: runId field is required");
		}

		if (!request.messages || !Array.isArray(request.messages)) {
			throw new Error(
				"Invalid request: messages field is required and must be an array",
			);
		}

		// Messages can be empty for some use cases, but if provided should be valid
		for (const msg of request.messages) {
			if (!msg.id || !msg.role || !msg.content) {
				throw new Error(
					"Invalid message: id, role, and content are required fields",
				);
			}

			if (!["user", "assistant", "system"].includes(msg.role)) {
				throw new Error(
					`Invalid message role: ${msg.role}. Must be one of: user, assistant, system`,
				);
			}
		}

		return request as AgentRunRequest;
	}

	/**
	 * Detect whether a tool call carries shared agent state and, if so,
	 * extract it as a {@link SharedStateEvent}.
	 *
	 * Uses a generic convention: if the tool input contains a `state` key
	 * whose value is an object, it is forwarded as shared state under
	 * `agentName: "shared_state"`. Alternatively, a tool input with a
	 * `shared_state` key is treated identically. This removes the need for
	 * hardcoded tool-name checks -- any tool can carry shared state by
	 * following the convention.
	 *
	 * @param _toolName - The name of the tool that was called (unused, kept for API compat).
	 * @param toolInput - The arguments passed to the tool.
	 * @returns A state event if the tool carries shared state, or `null`.
	 */
	public static extractSharedStateFromToolCall(
		_toolName: string,
		toolInput: Record<string, unknown>,
	): SharedStateEvent | null {
		// Generic convention: tools can carry shared state via a `state` or
		// `shared_state` key in their input arguments.
		const statePayload =
			(toolInput.shared_state as Record<string, unknown> | undefined) ??
			(toolInput.state as Record<string, unknown> | undefined);

		if (statePayload && typeof statePayload === "object") {
			return {
				type: "state_update",
				agentName: "shared_state",
				state: statePayload,
				timestamp: Date.now(),
			};
		}

		return null;
	}

	/**
	 * Convert a {@link SharedStateEvent} into a CopilotKit status chunk
	 * that triggers `useCoAgent` state updates on the client.
	 *
	 * @param stateEvent - The shared state event to convert.
	 * @returns A CopilotKit status chunk carrying the state payload.
	 */
	public static sharedStateToCopiloitChunk(
		stateEvent: SharedStateEvent,
	): CopilotStreamChunk {
		return {
			type: "status",
			data: {
				status: "state_update",
				agentName: stateEvent.agentName,
				state: stateEvent.state,
				timestamp: stateEvent.timestamp,
			},
		};
	}
}
