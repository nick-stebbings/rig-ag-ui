/**
 * Shared Types Main Module
 *
 * Organized type exports with proper namespacing.
 * Usage:
 *   import { copilotkit, agui, rig, common } from 'shared/types';
 *
 *   const request: copilotkit.ActionRequest = { ... };
 *   const event: agui.Event = { ... };
 *   const session: rig.Session = { ... };
 */

import * as agui from "./agui";
import * as common from "./common";
import * as copilotkit from "./copilotkit";
import * as rig from "./rig";

export { copilotkit, agui, rig, common };

// Re-export commonly used types at top level for convenience
export type UUID = common.UUID;
export type Timestamp = common.Timestamp;
export type ErrorResponse = common.ErrorResponse;
export type ApiResponse<T = unknown> = common.ApiResponse<T>;

// Protocol translation utilities
// biome-ignore lint/complexity/noStaticOnlyClass: Preserve the public namespace-style helper API.
export class ProtocolTranslator {
	/**
	 * Convert CopilotKit request to AG-UI format
	 */
	static copilotKitToAGUI(
		request: copilotkit.RuntimeRequest,
	): agui.RunAgentInput {
		return {
			runId: request.config?.sessionId || `run-${Date.now()}`,
			messages: request.messages.map((msg) => ({
				id: msg.id,
				role: common.ROLE_TRANSLATION.copilot_to_agui[msg.role],
				content: msg.content,
				metadata: msg.metadata,
			})),
			tools: request.tools?.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
			context: request.config
				? [
						{
							type: "copilotkit_config",
							value: request.config,
						},
					]
				: [],
		};
	}

	/**
	 * Convert AG-UI event to CopilotKit streaming format
	 */
	static aguiToCopilotKit(event: agui.Event): copilotkit.StreamChunk | null {
		const timestamp = Date.now();

		switch (event.type) {
			case agui.EventType.TEXT_MESSAGE_CONTENT:
				return {
					type: copilotkit.StreamEventType.CONTENT,
					data: {
						messageId: event.messageId,
						delta: event.data.delta,
						content: event.data.content,
						role: "assistant",
					},
					timestamp,
				};

			case agui.EventType.THINKING_DISPLAY:
				return {
					type: copilotkit.StreamEventType.THINKING,
					data: {
						messageId: event.messageId,
						reasoning: event.data.reasoning,
						visible: event.data.visible,
					},
					timestamp,
				};

			case agui.EventType.AGENT_STATUS_UPDATE:
				return {
					type: copilotkit.StreamEventType.STATUS,
					data: {
						status: event.data.status,
						progress: event.data.progress,
						message: event.data.currentTask,
					},
					timestamp,
				};

			case agui.EventType.TOOL_EXECUTION: {
				// Map AG-UI tool status to CopilotKit compatible status
				const copilotStatus =
					event.data.status === "in_progress" ? "started" : event.data.status;
				return {
					type: copilotkit.StreamEventType.TOOL_CALL,
					data: {
						toolName: event.data.toolName,
						toolInput: event.data.toolInput,
						toolOutput: event.data.toolOutput,
						callId: event.data.callId,
						status: copilotStatus as "started" | "completed" | "failed",
					},
					timestamp,
				};
			}

			case agui.EventType.STREAM_COMPLETE: {
				const metadata =
					event.data.metadata && typeof event.data.metadata === "object"
						? event.data.metadata
						: {};
				return {
					type: copilotkit.StreamEventType.COMPLETE,
					data: {
						messageId: event.messageId,
						finalContent: event.data.finalContent,
						metadata: {
							totalTokens: event.data.totalTokens,
							processingTime: event.data.processingTime,
							...metadata,
						},
					},
					timestamp,
				};
			}

			case agui.EventType.ERROR_OCCURRED:
				return {
					type: copilotkit.StreamEventType.ERROR,
					data: {
						error: event.data.error,
						message: event.data.message,
						code: event.data.code,
						details: event.data.details,
					},
					timestamp,
				};

			default:
				return null;
		}
	}

	/**
	 * Convert AG-UI request to Rig API format
	 */
	static aguiToRig(request: agui.RunAgentInput): {
		createSession: rig.CreateSessionRequest;
		sendMessage: rig.SendMessageRequest;
	} {
		const userMessage = request.messages.find((m) => m.role === "user");

		return {
			createSession: {
				user_context: {
					user_id: request.runId,
					metadata: { runId: request.runId },
				},
				agent_config: {
					model: "gpt-4",
					tools: request.tools?.map((t) => t.name) || [],
				},
			},
			sendMessage: {
				content: userMessage?.content || "",
				role: rig.MessageRole.User,
				metadata:
					userMessage?.metadata && typeof userMessage.metadata === "object"
						? userMessage.metadata
						: undefined,
			},
		};
	}

	/**
	 * Convert Rig streaming response to AG-UI event
	 */
	static rigToAGUI(response: rig.StreamingResponse, runId: string): agui.Event {
		const builder = new agui.EventBuilder(runId, response.message_id);

		switch (response.chunk.chunk_type) {
			case rig.ChunkType.Text:
				return builder.textMessageContent(
					response.chunk.delta || response.chunk.content,
					response.chunk.content,
					"agent",
				);

			case rig.ChunkType.Thinking:
				return builder.thinkingDisplay(response.chunk.content, true);

			case rig.ChunkType.ToolCall:
				try {
					const toolData = JSON.parse(response.chunk.content);
					return builder.toolExecution(
						toolData.name || "unknown",
						toolData.input || {},
						"started",
						toolData.callId || Math.random().toString(36),
						toolData.output,
					);
				} catch {
					return builder.textMessageContent(
						response.chunk.content,
						response.chunk.content,
						"agent",
					);
				}

			case rig.ChunkType.Error:
				return builder.errorOccurred(
					"StreamingError",
					response.chunk.content,
					true,
				);

			case rig.ChunkType.Complete:
				return builder.streamComplete(
					response.chunk.content,
					response.metadata.total_tokens,
					response.metadata.processing_time,
				);

			default:
				return builder.textMessageContent(
					response.chunk.content,
					response.chunk.content,
					"agent",
				);
		}
	}
}

// Validation utilities
// biome-ignore lint/complexity/noStaticOnlyClass: Preserve the public namespace-style helper API.
export class TypeValidator {
	static isCopilotKitRequest(obj: unknown): obj is copilotkit.RuntimeRequest {
		return copilotkit.ProtocolUtils.validateRuntimeRequest(obj);
	}

	static isAGUIEvent(obj: unknown): obj is agui.Event {
		return agui.ProtocolUtils.validateEvent(obj);
	}

	static isRigCreateSessionRequest(
		obj: unknown,
	): obj is rig.CreateSessionRequest {
		return rig.ProtocolUtils.validateCreateSessionRequest(obj);
	}

	static isRigSendMessageRequest(obj: unknown): obj is rig.SendMessageRequest {
		return rig.ProtocolUtils.validateSendMessageRequest(obj);
	}
}

// Utility functions for common operations
// biome-ignore lint/complexity/noStaticOnlyClass: Preserve the public namespace-style helper API.
export class TypeUtils {
	static createCopilotKitConfig(sessionId?: string): copilotkit.Config {
		return copilotkit.ProtocolUtils.createDefaultConfig(sessionId);
	}

	static createRigAgentConfig(): rig.AgentConfig {
		return rig.ProtocolUtils.createDefaultAgentConfig();
	}

	static createErrorResponse(
		error: string,
		message: string,
		details?: unknown,
	): common.ErrorResponse {
		return {
			error,
			message,
			details:
				details && typeof details === "object"
					? (details as Record<string, unknown>)
					: undefined,
			timestamp: common.createTimestamp(),
		};
	}

	static createApiResponse<T>(data: T, success = true): common.ApiResponse<T> {
		return {
			success,
			data,
			metadata: {
				timestamp: common.createTimestamp(),
			},
		};
	}
}
