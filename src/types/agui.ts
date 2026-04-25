/**
 * AG-UI Protocol Types Module
 *
 * All types related to AG-UI (Agent User Interaction) protocol.
 * Import as: import { agui } from 'shared/types'
 */

export type UUID = string;

// Core AG-UI Event Types
export enum EventType {
	TEXT_MESSAGE_CONTENT = "text_message_content",
	AGENT_STATUS_UPDATE = "agent_status_update",
	THINKING_DISPLAY = "thinking_display",
	TOOL_EXECUTION = "tool_execution",
	ERROR_OCCURRED = "error_occurred",
	STREAM_COMPLETE = "stream_complete",
}

// Base event structure
export interface BaseEvent {
	type: EventType;
	runId: string;
	messageId: string;
	timestamp: number;
}

// Specific event types
export interface TextMessageContentEvent extends BaseEvent {
	type: EventType.TEXT_MESSAGE_CONTENT;
	data: {
		delta: string;
		content: string;
		role: "user" | "agent";
	};
}

export interface AgentStatusUpdateEvent extends BaseEvent {
	type: EventType.AGENT_STATUS_UPDATE;
	data: {
		status: AgentStatus;
		currentTask?: string;
		progress?: number;
	};
}

export interface ThinkingDisplayEvent extends BaseEvent {
	type: EventType.THINKING_DISPLAY;
	data: {
		reasoning: string;
		visible: boolean;
		stepId?: string;
	};
}

export interface ToolExecutionEvent extends BaseEvent {
	type: EventType.TOOL_EXECUTION;
	data: {
		toolName: string;
		toolInput: unknown;
		toolOutput?: unknown;
		status: "started" | "in_progress" | "completed" | "failed";
		callId: string;
	};
}

export interface ErrorOccurredEvent extends BaseEvent {
	type: EventType.ERROR_OCCURRED;
	data: {
		error: string;
		message: string;
		code?: string;
		recoverable: boolean;
		details?: unknown;
	};
}

export interface StreamCompleteEvent extends BaseEvent {
	type: EventType.STREAM_COMPLETE;
	data: {
		finalContent: string;
		totalTokens?: number;
		processingTime?: number;
		metadata?: Record<string, unknown>;
	};
}

export type Event =
	| TextMessageContentEvent
	| AgentStatusUpdateEvent
	| ThinkingDisplayEvent
	| ToolExecutionEvent
	| ErrorOccurredEvent
	| StreamCompleteEvent;

// Agent status enum
export enum AgentStatus {
	Idle = "idle",
	Processing = "processing",
	ToolExecution = "tool_execution",
	WaitingForInput = "waiting_for_input",
	Errored = "errored",
}

// Input types for AG-UI agent run request
export interface RunAgentInput {
	runId: string;
	messages: Message[];
	tools?: Tool[];
	context?: Context[];
}

export interface Message {
	id: string;
	role: "user" | "agent";
	content: string;
	metadata?: Record<string, unknown>;
}

export interface Tool {
	name: string;
	description: string;
	parameters: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
}

export interface Context {
	type: string;
	value: unknown;
}

// Rig stream chunk interface (input from Rig backend)
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

// Event builder utility class
export class EventBuilder {
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
	): TextMessageContentEvent {
		return {
			type: EventType.TEXT_MESSAGE_CONTENT,
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
	): AgentStatusUpdateEvent {
		return {
			type: EventType.AGENT_STATUS_UPDATE,
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
	): ThinkingDisplayEvent {
		return {
			type: EventType.THINKING_DISPLAY,
			runId: this.runId,
			messageId: this.messageId,
			timestamp: Date.now(),
			data: { reasoning, visible, stepId },
		};
	}

	toolExecution(
		toolName: string,
		toolInput: unknown,
		status: "started" | "in_progress" | "completed" | "failed",
		callId: string,
		toolOutput?: unknown,
	): ToolExecutionEvent {
		return {
			type: EventType.TOOL_EXECUTION,
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
		details?: unknown,
	): ErrorOccurredEvent {
		return {
			type: EventType.ERROR_OCCURRED,
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
	): StreamCompleteEvent {
		return {
			type: EventType.STREAM_COMPLETE,
			runId: this.runId,
			messageId: this.messageId,
			timestamp: Date.now(),
			data: { finalContent, totalTokens, processingTime, metadata },
		};
	}
}

// Protocol utilities
// biome-ignore lint/complexity/noStaticOnlyClass: Preserve the public namespace-style helper API.
export class ProtocolUtils {
	static toSSE(event: Event): string {
		const data = JSON.stringify(event);
		return `data: ${data}\n\n`;
	}

	static fromRigChunk(
		chunk: RigStreamChunk,
		runId: string,
		messageId: string,
	): Event[] {
		const builder = new EventBuilder(runId, messageId);
		const events: Event[] = [];

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
					events.push(
						builder.textMessageContent(chunk.content, chunk.content, "agent"),
					);
				}
				break;

			case "error":
				events.push(
					builder.errorOccurred("StreamingError", chunk.content, true),
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
				events.push(
					builder.textMessageContent(chunk.content, chunk.content, "agent"),
				);
		}

		if (chunk.metadata?.agentStatus) {
			const status = chunk.metadata.agentStatus as AgentStatus;
			events.push(builder.agentStatusUpdate(status));
		}

		return events;
	}

	static validateEvent(event: unknown): event is Event {
		if (!event || typeof event !== "object") {
			return false;
		}
		const candidate = event as Partial<BaseEvent> & { data?: unknown };

		if (
			!candidate.type ||
			!candidate.runId ||
			!candidate.messageId ||
			!candidate.timestamp ||
			!candidate.data
		) {
			return false;
		}

		if (!Object.values(EventType).includes(candidate.type)) {
			return false;
		}

		return true;
	}

	static getStreamHeaders(): Record<string, string> {
		return {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Headers": "Cache-Control",
		};
	}
}
