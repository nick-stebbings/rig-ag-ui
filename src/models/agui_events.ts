/**
 * AG-UI Protocol Event Types
 *
 * Based on the Agent User Interaction Protocol specification.
 * These types define the structure of events sent from the middleware
 * to AG-UI compatible clients.
 *
 * @deprecated Prefer the canonical types in `agents/rig_abstract_agent.ts`
 * ({@link EventType}, {@link BaseEvent}). This file is retained for
 * backward compatibility during migration.
 */

/**
 * Core event type identifiers for the AG-UI protocol.
 *
 * @deprecated Use {@link EventType} from `agents/rig_abstract_agent` instead.
 */
export enum AGUIEventType {
	TEXT_MESSAGE_CONTENT = "text_message_content",
	AGENT_STATUS_UPDATE = "agent_status_update",
	THINKING_DISPLAY = "thinking_display",
	TOOL_EXECUTION = "tool_execution",
	ERROR_OCCURRED = "error_occurred",
	STREAM_COMPLETE = "stream_complete",
}

/** Base event structure shared by all legacy AG-UI event interfaces. */
export interface AGUIBaseEvent {
	type: AGUIEventType;
	runId: string;
	messageId: string;
	timestamp: number;
}

/** Incremental text content from the agent. */
export interface AGUITextMessageContentEvent extends AGUIBaseEvent {
	type: AGUIEventType.TEXT_MESSAGE_CONTENT;
	data: {
		delta: string;
		content: string;
		role: "user" | "agent";
	};
}

/** Agent processing status change (idle, processing, tool_execution, etc.). */
export interface AGUIAgentStatusUpdateEvent extends AGUIBaseEvent {
	type: AGUIEventType.AGENT_STATUS_UPDATE;
	data: {
		status: AgentStatus;
		currentTask?: string;
		progress?: number;
	};
}

/** Agent reasoning / chain-of-thought display event. */
export interface AGUIThinkingDisplayEvent extends AGUIBaseEvent {
	type: AGUIEventType.THINKING_DISPLAY;
	data: {
		reasoning: string;
		visible: boolean;
		stepId?: string;
	};
}

/** Tool invocation lifecycle event (started, in_progress, completed, failed). */
export interface AGUIToolExecutionEvent extends AGUIBaseEvent {
	type: AGUIEventType.TOOL_EXECUTION;
	data: {
		toolName: string;
		toolInput: Record<string, unknown>;
		toolOutput?: unknown;
		status: "started" | "in_progress" | "completed" | "failed";
		callId: string;
	};
}

/** Error event with optional recovery information. */
export interface AGUIErrorOccurredEvent extends AGUIBaseEvent {
	type: AGUIEventType.ERROR_OCCURRED;
	data: {
		error: string;
		message: string;
		code?: string;
		recoverable: boolean;
		details?: Record<string, unknown>;
	};
}

/** Terminal event indicating the stream has finished. */
export interface AGUIStreamCompleteEvent extends AGUIBaseEvent {
	type: AGUIEventType.STREAM_COMPLETE;
	data: {
		finalContent: string;
		totalTokens?: number;
		processingTime?: number;
		metadata?: Record<string, unknown>;
	};
}

/** Discriminated union of all AG-UI event types. */
export type AGUIEvent =
	| AGUITextMessageContentEvent
	| AGUIAgentStatusUpdateEvent
	| AGUIThinkingDisplayEvent
	| AGUIToolExecutionEvent
	| AGUIErrorOccurredEvent
	| AGUIStreamCompleteEvent;

/** Agent processing status values (mirrors the Rust `AgentStatus` enum). */
export enum AgentStatus {
	Idle = "idle",
	Processing = "processing",
	ToolExecution = "tool_execution",
	WaitingForInput = "waiting_for_input",
	Errored = "errored",
}

/** Raw stream chunk received from the Rig backend SSE endpoint. */
export interface RigStreamChunk {
	content: string;
	finished: boolean;
	metadata?: {
		totalTokens?: number;
		processingTime?: number;
		agentStatus?: string;
		chunkType?: "text" | "thinking" | "tool_call" | "error" | "complete";
	};
}

/**
 * Convenience builder for constructing typed AG-UI events.
 *
 * Binds a `runId` and `messageId` at construction time so that each
 * factory method only needs the event-specific data.
 *
 * @example
 * ```typescript
 * const builder = new AGUIEventBuilder(runId, messageId);
 * const event = builder.textMessageContent("hello ", "hello ", "agent");
 * ```
 */
export class AGUIEventBuilder {
	private runId: string;
	private messageId: string;

	constructor(runId: string, messageId: string) {
		this.runId = runId;
		this.messageId = messageId;
	}

	textMessageContent(
		delta: string,
		content: string,
		role: "user" | "agent",
	): AGUITextMessageContentEvent {
		return {
			type: AGUIEventType.TEXT_MESSAGE_CONTENT,
			runId: this.runId,
			messageId: this.messageId,
			timestamp: Date.now(),
			data: { delta, content, role },
		};
	}

	agentStatusUpdate(
		status: AgentStatus,
		currentTask?: string,
		progress?: number,
	): AGUIAgentStatusUpdateEvent {
		return {
			type: AGUIEventType.AGENT_STATUS_UPDATE,
			runId: this.runId,
			messageId: this.messageId,
			timestamp: Date.now(),
			data: { status, currentTask, progress },
		};
	}

	thinkingDisplay(
		reasoning: string,
		visible: boolean,
		stepId?: string,
	): AGUIThinkingDisplayEvent {
		return {
			type: AGUIEventType.THINKING_DISPLAY,
			runId: this.runId,
			messageId: this.messageId,
			timestamp: Date.now(),
			data: { reasoning, visible, stepId },
		};
	}

	toolExecution(
		toolName: string,
		toolInput: Record<string, unknown>,
		status: "started" | "in_progress" | "completed" | "failed",
		callId: string,
		toolOutput?: unknown,
	): AGUIToolExecutionEvent {
		return {
			type: AGUIEventType.TOOL_EXECUTION,
			runId: this.runId,
			messageId: this.messageId,
			timestamp: Date.now(),
			data: { toolName, toolInput, toolOutput, status, callId },
		};
	}

	errorOccurred(
		error: string,
		message: string,
		recoverable: boolean,
		code?: string,
		details?: Record<string, unknown>,
	): AGUIErrorOccurredEvent {
		return {
			type: AGUIEventType.ERROR_OCCURRED,
			runId: this.runId,
			messageId: this.messageId,
			timestamp: Date.now(),
			data: { error, message, code, recoverable, details },
		};
	}

	streamComplete(
		finalContent: string,
		totalTokens?: number,
		processingTime?: number,
		metadata?: Record<string, unknown>,
	): AGUIStreamCompleteEvent {
		return {
			type: AGUIEventType.STREAM_COMPLETE,
			runId: this.runId,
			messageId: this.messageId,
			timestamp: Date.now(),
			data: { finalContent, totalTokens, processingTime, metadata },
		};
	}
}

// ---------------------------------------------------------------------------
// Utility functions for AG-UI protocol
// ---------------------------------------------------------------------------

/**
 * Serialize an {@link AGUIEvent} as an SSE `data:` frame.
 *
 * @param event - The event to serialize.
 * @returns A string ready to be written to an SSE response.
 */
export function toSSE(event: AGUIEvent): string {
	// Flatten: spread data fields to top level for V2 compliance
	const { data, ...rest } = event;
	const flat = { ...rest, ...data };
	return `data: ${JSON.stringify(flat)}\n\n`;
}

/**
 * Convert a raw {@link RigStreamChunk} into one or more {@link AGUIEvent} objects.
 *
 * The chunk's `metadata.chunkType` determines the resulting event type(s).
 * An additional `AGENT_STATUS_UPDATE` event is appended when the chunk
 * carries an `agentStatus` metadata field.
 *
 * @param chunk - The raw chunk from the Rig backend.
 * @param runId - The AG-UI run identifier.
 * @param messageId - The message identifier to attach to events.
 * @returns An array of AG-UI events (usually one, sometimes two).
 */
export function fromRigChunk(
	chunk: RigStreamChunk,
	runId: string,
	messageId: string,
): AGUIEvent[] {
	const builder = new AGUIEventBuilder(runId, messageId);
	const events: AGUIEvent[] = [];

	// Determine event type based on chunk metadata
	const chunkType = chunk.metadata?.chunkType || "text";

	switch (chunkType) {
		case "text":
			events.push(
				builder.textMessageContent(chunk.content, chunk.content, "agent"),
			);
			break;

		case "thinking":
			events.push(builder.thinkingDisplay(chunk.content, true));
			break;

		case "tool_call":
			// Parse tool call content (assumed to be JSON)
			try {
				const toolData = JSON.parse(chunk.content);
				events.push(
					builder.toolExecution(
						toolData.name || "unknown",
						toolData.input || {},
						"started",
						toolData.callId || Math.random().toString(36),
						toolData.output,
					),
				);
			} catch {
				// Fallback to text content if parsing fails
				events.push(
					builder.textMessageContent(chunk.content, chunk.content, "agent"),
				);
			}
			break;

		case "error":
			events.push(
				builder.errorOccurred(
					"StreamingError",
					chunk.content,
					true, // Assume recoverable by default
				),
			);
			break;

		case "complete":
			events.push(
				builder.streamComplete(
					chunk.content,
					chunk.metadata?.totalTokens,
					chunk.metadata?.processingTime,
				),
			);
			break;

		default:
			// Default to text content
			events.push(
				builder.textMessageContent(chunk.content, chunk.content, "agent"),
			);
	}

	// Add agent status update if provided
	if (chunk.metadata?.agentStatus) {
		const status = chunk.metadata.agentStatus as AgentStatus;
		events.push(builder.agentStatusUpdate(status));
	}

	return events;
}

/**
 * Type guard that validates an unknown value as a well-formed {@link AGUIEvent}.
 *
 * Checks for required base fields (`type`, `runId`, `messageId`, `timestamp`,
 * `data`) and ensures `type` is a recognised {@link AGUIEventType} value.
 *
 * @param event - The value to validate.
 * @returns `true` if the value is a valid AG-UI event.
 */
export function validateEvent(event: unknown): event is AGUIEvent {
	if (!event || typeof event !== "object") {
		return false;
	}

	const evt = event as Record<string, unknown>;

	// Check required base fields
	if (
		!evt.type ||
		!evt.runId ||
		!evt.messageId ||
		!evt.timestamp ||
		!evt.data
	) {
		return false;
	}

	// Check event type is valid
	if (!Object.values(AGUIEventType).includes(evt.type as AGUIEventType)) {
		return false;
	}

	// Type-specific validation could be added here
	return true;
}

/**
 * Return the HTTP headers required for an SSE response.
 *
 * @returns A record of header name/value pairs.
 */
export function getStreamHeaders(): Record<string, string> {
	return {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Headers": "Cache-Control",
	};
}

/** Input payload for starting an agent run (legacy format). */
export interface AGUIRunAgentInput {
	runId: string;
	messages: AGUIMessage[];
	tools?: AGUITool[];
	context?: AGUIContext[];
}

/** A conversation message (legacy format). */
export interface AGUIMessage {
	id: string;
	role: "user" | "agent";
	content: string;
	metadata?: Record<string, unknown>;
}

/** A tool definition (legacy format). */
export interface AGUITool {
	name: string;
	description: string;
	parameters: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
}

/** Contextual metadata entry (legacy format). */
export interface AGUIContext {
	type: string;
	value: unknown;
}
