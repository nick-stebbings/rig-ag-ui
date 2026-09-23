import { z } from "zod";

const ToolCallSchema = z.object({
	id: z.string().min(1),
	type: z.literal("function"),
	function: z.object({ name: z.string().min(1), arguments: z.string() }),
});

export const AguiMessageSchema = z
	.object({
		id: z.string().min(1),
		role: z.enum([
			"user",
			"assistant",
			"system",
			"developer",
			"tool",
			"activity",
			"reasoning",
		]),
		content: z.union([z.string(), z.array(z.unknown())]).optional(),
		toolCalls: z.array(ToolCallSchema).optional(),
		toolCallId: z.string().min(1).optional(),
		name: z.string().optional(),
		metadata: z.record(z.unknown()).optional(),
	})
	.passthrough()
	.superRefine((message, ctx) => {
		if (
			message.role === "tool" &&
			(!message.toolCallId || typeof message.content !== "string")
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "A tool result needs toolCallId and string content",
			});
		}
	});

export const AguiToolSchema = z.object({
	name: z.string().min(1),
	description: z.string().default(""),
	parameters: z.record(z.unknown()).default({}),
});

/** Internal Rig contract. Rig must validate ownership and pending calls. */
export interface AguiRunEnvelope {
	version: 1;
	thread_id: string;
	run_id: string;
	messages: z.infer<typeof AguiMessageSchema>[];
	tools: z.infer<typeof AguiToolSchema>[];
	state?: unknown;
}

const StructuredToolCallSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	arguments: z.record(z.unknown()),
});

export type StructuredToolCall = z.infer<typeof StructuredToolCallSchema>;

/** Neutral marker for any backend that streams a client-owned tool call. */
export const STRUCTURED_TOOL_MARKER = "__AGUI_TOOL_CALL__:";

/** Previous generic frontend-call envelope. Preserve it during rolling upgrades. */
export const COMPATIBLE_TOOL_MARKER = "__FRONTEND_TOOL_CALL__:";

/**
 * Parse a structured client-owned tool call.
 *
 * The producer creates the call ID. Middleware only transports it. The tool
 * must be advertised for the current run before middleware emits it.
 */
export function parseStructuredToolCall(
	content: string,
	tools: AguiRunEnvelope["tools"],
	prefix = STRUCTURED_TOOL_MARKER,
): StructuredToolCall | null {
	const matchedPrefix = [
		prefix,
		STRUCTURED_TOOL_MARKER,
		COMPATIBLE_TOOL_MARKER,
	].find((candidate) => candidate.length > 0 && content.startsWith(candidate));
	if (!matchedPrefix) return null;
	const call = StructuredToolCallSchema.parse(
		JSON.parse(content.slice(matchedPrefix.length)),
	);
	if (!tools.some((tool) => tool.name === call.name)) {
		throw new Error(
			"Backend requested a client tool that this run did not advertise",
		);
	}
	return call;
}
