/**
 * CopilotKit Protocol Types Module
 *
 * All types related to CopilotKit protocol and integration.
 * Import as: import { copilotkit } from 'shared/types'
 */

export type UUID = string;

export interface RuntimeRequest {
	messages: Message[];
	tools?: Tool[];
	config?: Config;
}

export interface Message {
	id: UUID;
	role: "user" | "assistant" | "system";
	content: string;
	metadata?: Record<string, unknown>;
	timestamp: number;
}

export interface Tool {
	name: string;
	description: string;
	parameters: {
		type: "object";
		properties: Record<string, ToolParameter>;
		required?: string[];
	};
}

export interface ToolParameter {
	type: string;
	description?: string;
	enum?: string[];
	default?: unknown;
}

export interface Config {
	agentId?: string;
	sessionId?: string;
	model?: string;
	stream?: boolean;
	temperature?: number;
	maxTokens?: number;
	[key: string]: unknown;
}

// Streaming response types
export enum StreamEventType {
	CONTENT = "content",
	THINKING = "thinking",
	STATUS = "status",
	TOOL_CALL = "tool_call",
	COMPLETE = "complete",
	ERROR = "error",
}

export interface StreamEvent {
	type: StreamEventType;
	data: unknown;
	timestamp: number;
}

export interface ContentChunk extends StreamEvent {
	type: StreamEventType.CONTENT;
	data: {
		messageId: string;
		delta: string;
		content: string;
		role: "assistant";
	};
}

export interface ThinkingChunk extends StreamEvent {
	type: StreamEventType.THINKING;
	data: {
		messageId: string;
		reasoning: string;
		visible: boolean;
	};
}

export interface StatusChunk extends StreamEvent {
	type: StreamEventType.STATUS;
	data: {
		status: string;
		progress?: number;
		message?: string;
	};
}

export interface ToolCallChunk extends StreamEvent {
	type: StreamEventType.TOOL_CALL;
	data: {
		toolName: string;
		toolInput: unknown;
		toolOutput?: unknown;
		callId: string;
		status: "started" | "completed" | "failed";
	};
}

export interface CompleteChunk extends StreamEvent {
	type: StreamEventType.COMPLETE;
	data: {
		messageId: string;
		finalContent: string;
		metadata?: {
			totalTokens?: number;
			processingTime?: number;
			[key: string]: unknown;
		};
	};
}

export interface ErrorChunk extends StreamEvent {
	type: StreamEventType.ERROR;
	data: {
		error: string;
		message: string;
		code?: string;
		details?: unknown;
	};
}

export type StreamChunk =
	| ContentChunk
	| ThinkingChunk
	| StatusChunk
	| ToolCallChunk
	| CompleteChunk
	| ErrorChunk;

// Actions API
export interface ActionRequest {
	action: string;
	input: unknown;
	context?: unknown;
}

export interface ActionResponse {
	success: boolean;
	output?: unknown;
	error?: string;
}

export interface Action {
	name: string;
	description: string;
	parameters: Record<string, ToolParameter>;
	handler: (input: unknown) => Promise<unknown>;
}

// Type guards
export function isContentChunk(event: StreamChunk): event is ContentChunk {
	return event.type === StreamEventType.CONTENT;
}

export function isThinkingChunk(event: StreamChunk): event is ThinkingChunk {
	return event.type === StreamEventType.THINKING;
}

export function isToolCallChunk(event: StreamChunk): event is ToolCallChunk {
	return event.type === StreamEventType.TOOL_CALL;
}

export function isCompleteChunk(event: StreamChunk): event is CompleteChunk {
	return event.type === StreamEventType.COMPLETE;
}

export function isErrorChunk(event: StreamChunk): event is ErrorChunk {
	return event.type === StreamEventType.ERROR;
}

// Protocol utilities
// biome-ignore lint/complexity/noStaticOnlyClass: Preserve the public namespace-style helper API.
export class ProtocolUtils {
	static toSSE(event: StreamChunk): string {
		const data = JSON.stringify(event);
		return `data: ${data}\n\n`;
	}

	static getStreamHeaders(): Record<string, string> {
		return {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		};
	}

	static validateRuntimeRequest(request: unknown): request is RuntimeRequest {
		if (!request || typeof request !== "object") {
			return false;
		}
		const candidate = request as Partial<RuntimeRequest>;

		if (!Array.isArray(candidate.messages)) {
			return false;
		}

		for (const message of candidate.messages) {
			if (
				!message.id ||
				!message.role ||
				!message.content ||
				typeof message.timestamp !== "number"
			) {
				return false;
			}

			if (!["user", "assistant", "system"].includes(message.role)) {
				return false;
			}
		}

		if (candidate.tools && !Array.isArray(candidate.tools)) {
			return false;
		}

		if (candidate.tools) {
			for (const tool of candidate.tools) {
				if (!tool.name || !tool.description || !tool.parameters) {
					return false;
				}
			}
		}

		return true;
	}

	static createDefaultConfig(sessionId?: string): Config {
		return {
			agentId: `agent-${Date.now()}`,
			sessionId: sessionId || `session-${Date.now()}`,
			model: "gpt-4",
			stream: true,
			temperature: 0.7,
			maxTokens: 2048,
		};
	}

	static mergeConfigs(base: Config, override: Partial<Config>): Config {
		return {
			...base,
			...override,
		};
	}
}
