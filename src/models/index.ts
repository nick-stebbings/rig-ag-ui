/**
 * AG-UI Middleware Models
 *
 * Re-exports shared types with proper module structure.
 * Usage: import { agui, copilotkit, ProtocolTranslator } from './models';
 */

// Import from shared types
import {
	ProtocolTranslator,
	TypeUtils,
	TypeValidator,
	agui,
	common,
	copilotkit,
	rig,
} from "../types";

// Re-export with proper namespacing
export { agui, copilotkit, rig, common };

// Re-export utilities
export { ProtocolTranslator, TypeValidator, TypeUtils };

// Convenience type aliases for this service
export type AGUIEvent = agui.Event;
export type AGUIRunAgentInput = agui.RunAgentInput;
export type CopilotKitRuntimeRequest = copilotkit.RuntimeRequest;
export type CopilotKitStreamChunk = copilotkit.StreamChunk;
export type RigStreamingResponse = rig.StreamingResponse;

// Service-specific types
export interface MiddlewareConfig {
	rig_api_url: string;
	port: number;
	cors_enabled: boolean;
	max_connections: number;
	request_timeout_ms: number;
}

export interface TranslationContext {
	runId: string;
	sessionId: string;
	sourceProtocol: "agui" | "copilotkit";
	targetProtocol: "agui" | "copilotkit";
	metadata?: Record<string, unknown>;
}

export interface StreamingSession {
	id: string;
	runId: string;
	protocol: "agui" | "copilotkit";
	startTime: number;
	lastActivity: number;
	messageCount: number;
	isActive: boolean;
}
