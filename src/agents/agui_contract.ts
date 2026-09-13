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

const FrontendCallSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	arguments: z.record(z.unknown()),
});

export const FRONTEND_TOOL_MARKER = "__FRONTEND_TOOL_CALL__:";

/** Preserve the server call ID. Never make a tool result in middleware. */
export function parseFrontendToolCall(
	content: string,
	tools: AguiRunEnvelope["tools"],
) {
	const call = FrontendCallSchema.parse(
		JSON.parse(content.slice(FRONTEND_TOOL_MARKER.length)),
	);
	if (!tools.some((tool) => tool.name === call.name)) {
		throw new Error(
			"Rig requested a frontend tool that this run did not advertise",
		);
	}
	return call;
}
