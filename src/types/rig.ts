/**
 * Rig API Types Module
 *
 * All types related to Rig backend API and service communication.
 * Import as: import { rig } from 'shared/types'
 */

export type UUID = string;
export type Timestamp = string; // ISO 8601 format

// Session management
export interface CreateSessionRequest {
	user_context?: UserContext;
	agent_config?: AgentConfig;
}

export interface UserContext {
	user_id?: string;
	preferences?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

export interface AgentConfig {
	model?: string;
	tools?: string[];
	temperature?: number;
	max_tokens?: number;
}

export interface Session {
	id: UUID;
	created_at: Timestamp;
	updated_at: Timestamp;
	status: SessionStatus;
	user_context?: UserContext;
	agent_state: AgentState;
}

export enum SessionStatus {
	Created = "created",
	Active = "active",
	Paused = "paused",
	Completed = "completed",
	Errored = "errored",
	Recovered = "recovered",
}

export interface AgentState {
	status: AgentStatus;
	current_task?: string;
	available_tools: ToolDefinition[];
	reasoning_steps: ReasoningStep[];
	error_context?: ErrorContext;
}

export enum AgentStatus {
	Idle = "idle",
	Processing = "processing",
	ToolExecution = "tool_execution",
	WaitingForInput = "waiting_for_input",
	Errored = "errored",
}

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface ReasoningStep {
	step_id: UUID;
	description: string;
	status: StepStatus;
	output?: string;
}

export enum StepStatus {
	Pending = "pending",
	InProgress = "in_progress",
	Completed = "completed",
	Failed = "failed",
}

export interface ErrorContext {
	error_type: string;
	message: string;
	details?: Record<string, unknown>;
	recoverable: boolean;
}

// Message handling
export interface SendMessageRequest {
	content: string;
	role: MessageRole;
	metadata?: Record<string, unknown>;
}

export enum MessageRole {
	User = "user",
	Agent = "agent",
	System = "system",
}

// Streaming response
export interface StreamingResponse {
	session_id: UUID;
	message_id: UUID;
	chunk: ResponseChunk;
	metadata: StreamingMetadata;
}

export interface ResponseChunk {
	chunk_type: ChunkType;
	content: string;
	delta?: string;
	timestamp: number;
}

export enum ChunkType {
	Text = "text",
	Thinking = "thinking",
	ToolCall = "tool_call",
	Error = "error",
	Complete = "complete",
}

export interface StreamingMetadata {
	total_tokens?: number;
	processing_time?: number;
	agent_status: AgentStatus;
	sequence_number: number;
}

// Interruption handling
export interface InterruptSessionRequest {
	reason: InterruptReason;
	new_direction?: string;
}

export enum InterruptReason {
	Stop = "stop",
	Redirect = "redirect",
	Clarify = "clarify",
}

// Health check
export interface HealthCheckResponse {
	status: "healthy" | "unhealthy";
	service: string;
	version: string;
	timestamp: Timestamp;
	dependencies?: {
		[serviceName: string]: {
			status: "healthy" | "unhealthy";
			latency?: number;
		};
	};
}

// Type guards
export function isSessionStatus(value: string): value is SessionStatus {
	return Object.values(SessionStatus).includes(value as SessionStatus);
}

export function isAgentStatus(value: string): value is AgentStatus {
	return Object.values(AgentStatus).includes(value as AgentStatus);
}

export function isMessageRole(value: string): value is MessageRole {
	return Object.values(MessageRole).includes(value as MessageRole);
}

export function isChunkType(value: string): value is ChunkType {
	return Object.values(ChunkType).includes(value as ChunkType);
}

// Protocol utilities
// biome-ignore lint/complexity/noStaticOnlyClass: Preserve the public namespace-style helper API.
export class ProtocolUtils {
	static validateCreateSessionRequest(
		request: unknown,
	): request is CreateSessionRequest {
		if (!request || typeof request !== "object") {
			return true; // Empty request is valid
		}
		const candidate = request as Partial<CreateSessionRequest>;

		if (candidate.user_context) {
			if (typeof candidate.user_context !== "object") {
				return false;
			}
		}

		if (candidate.agent_config) {
			if (typeof candidate.agent_config !== "object") {
				return false;
			}
		}

		return true;
	}

	static validateSendMessageRequest(
		request: unknown,
	): request is SendMessageRequest {
		if (!request || typeof request !== "object") {
			return false;
		}
		const candidate = request as Partial<SendMessageRequest>;

		if (!candidate.content || typeof candidate.content !== "string") {
			return false;
		}

		if (
			!candidate.role ||
			!Object.values(MessageRole).includes(candidate.role)
		) {
			return false;
		}

		return true;
	}

	static validateInterruptSessionRequest(
		request: unknown,
	): request is InterruptSessionRequest {
		if (!request || typeof request !== "object") {
			return false;
		}
		const candidate = request as Partial<InterruptSessionRequest>;

		if (
			!candidate.reason ||
			!Object.values(InterruptReason).includes(candidate.reason)
		) {
			return false;
		}

		if (
			candidate.new_direction &&
			typeof candidate.new_direction !== "string"
		) {
			return false;
		}

		return true;
	}

	static createDefaultAgentConfig(): AgentConfig {
		return {
			model: "gpt-4",
			tools: [],
			temperature: 0.7,
			max_tokens: 2048,
		};
	}

	static createDefaultUserContext(userId?: string): UserContext {
		return {
			user_id: userId,
			preferences: {},
			metadata: {},
		};
	}
}

// Service configuration
export interface ServiceConfig {
	base_url: string;
	timeout_ms: number;
	retry_attempts: number;
	max_concurrent_requests: number;
}

// Metrics and monitoring
export interface ServiceMetrics {
	requests_total: number;
	requests_per_second: number;
	average_response_time_ms: number;
	error_rate: number;
	active_sessions: number;
	memory_usage_mb: number;
	cpu_usage_percent: number;
}

export interface SessionMetrics {
	session_id: UUID;
	created_at: Timestamp;
	duration_ms: number;
	message_count: number;
	token_count: number;
	error_count: number;
	last_activity: Timestamp;
}
