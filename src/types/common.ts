/**
 * Common Types Module
 *
 * Shared types used across all protocols and services.
 * Import as: import { common } from 'shared/types'
 */

export type UUID = string;
export type Timestamp = string; // ISO 8601 format

// HTTP status codes
export const HTTP_STATUS = {
	OK: 200,
	CREATED: 201,
	NO_CONTENT: 204,
	BAD_REQUEST: 400,
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	METHOD_NOT_ALLOWED: 405,
	CONFLICT: 409,
	UNPROCESSABLE_ENTITY: 422,
	INTERNAL_SERVER_ERROR: 500,
	BAD_GATEWAY: 502,
	SERVICE_UNAVAILABLE: 503,
	GATEWAY_TIMEOUT: 504,
} as const;

// Content types
export const CONTENT_TYPES = {
	JSON: "application/json",
	TEXT: "text/plain",
	HTML: "text/html",
	EVENT_STREAM: "text/event-stream",
	FORM_DATA: "multipart/form-data",
	URL_ENCODED: "application/x-www-form-urlencoded",
} as const;

// Error response types
export interface ErrorResponse {
	error: string;
	message: string;
	code?: string;
	details?: Record<string, unknown>;
	timestamp: Timestamp;
}

export interface ValidationError {
	field: string;
	message: string;
	value?: unknown;
}

export interface ValidationErrorResponse extends ErrorResponse {
	errors: ValidationError[];
}

// Protocol translation types
export interface ProtocolTranslationRequest {
	source_protocol: "agui" | "copilotkit";
	target_protocol: "agui" | "copilotkit";
	data: unknown;
}

export interface ProtocolTranslationResponse {
	success: boolean;
	translated_data?: unknown;
	error?: string;
}

// Service discovery and configuration
export interface ServiceConfig {
	rig_api: {
		base_url: string;
		timeout_ms: number;
		retry_attempts: number;
	};
	ag_ui_middleware: {
		base_url: string;
		timeout_ms: number;
		max_connections: number;
	};
	features: {
		protocol_translation: boolean;
		streaming: boolean;
		session_persistence: boolean;
	};
}

// WebSocket types
export interface WebSocketMessage {
	type: "ping" | "pong" | "data" | "error" | "close";
	payload?: unknown;
	timestamp: number;
}

export interface WebSocketConfig {
	heartbeat_interval_ms: number;
	max_message_size_bytes: number;
	compression: boolean;
}

// Utility functions
export function isUUID(value: string): boolean {
	const uuidRegex =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(value);
}

export function isValidTimestamp(value: string): boolean {
	const date = new Date(value);
	return !Number.isNaN(date.getTime());
}

export function createTimestamp(): Timestamp {
	return new Date().toISOString();
}

export function parseTimestamp(timestamp: Timestamp): Date {
	return new Date(timestamp);
}

// Role translation mapping between protocols
export const ROLE_TRANSLATION = {
	// AG-UI -> CopilotKit
	agui_to_copilot: {
		user: "user" as const,
		agent: "assistant" as const,
	},
	// CopilotKit -> AG-UI
	copilot_to_agui: {
		user: "user" as const,
		assistant: "agent" as const,
		system: "user" as const, // Map system messages to user for AG-UI compatibility
	},
} as const;

// Generic response wrapper
export interface ApiResponse<T = unknown> {
	success: boolean;
	data?: T;
	error?: ErrorResponse;
	metadata?: {
		timestamp: Timestamp;
		requestId?: string;
		version?: string;
	};
}

// Pagination helpers
export interface PaginationRequest {
	page?: number;
	limit?: number;
	sort?: string;
	order?: "asc" | "desc";
}

export interface PaginationResponse<T> {
	items: T[];
	pagination: {
		page: number;
		limit: number;
		total: number;
		totalPages: number;
		hasNext: boolean;
		hasPrev: boolean;
	};
}

// Logging levels
export enum LogLevel {
	TRACE = "trace",
	DEBUG = "debug",
	INFO = "info",
	WARN = "warn",
	ERROR = "error",
	FATAL = "fatal",
}

export interface LogEntry {
	level: LogLevel;
	message: string;
	timestamp: Timestamp;
	service: string;
	metadata?: Record<string, unknown>;
}
