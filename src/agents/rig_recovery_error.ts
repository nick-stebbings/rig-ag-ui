import { Readable } from "node:stream";
import axios from "axios";
import { z } from "zod";

const pendingCall = z.object({
	code: z.literal("FRONTEND_TOOL_PENDING"),
	tool_call_id: z.string().trim().min(1).max(256),
	next_action: z.literal("complete_or_cancel_pending_action"),
});

/** A known recovery state. Never forward arbitrary upstream error text. */
export class RigRecoveryError extends Error {
	constructor(readonly recovery: z.infer<typeof pendingCall>) {
		super(
			"Finish or cancel the pending setup action before sending another message.",
		);
		this.name = "RigRecoveryError";
	}
}

/** Read only a small, bounded error body from Rig's streaming HTTP response. */
export async function readRigRecoveryError(
	error: unknown,
): Promise<RigRecoveryError | undefined> {
	if (!axios.isAxiosError(error) || error.response?.status !== 409) return;
	const stream: unknown = error.response.data;
	if (!(stream instanceof Readable)) return;
	const timeout = setTimeout(
		() => stream.destroy(new Error("Recovery response timed out")),
		2000,
	);
	try {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of stream) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += bytes.length;
			if (size > 8192) return;
			chunks.push(bytes);
		}
		const parsed = pendingCall.safeParse(
			JSON.parse(Buffer.concat(chunks).toString("utf8")),
		);
		if (parsed.success) return new RigRecoveryError(parsed.data);
	} catch {
		// Unknown or malformed errors use the existing generic failure path.
	} finally {
		clearTimeout(timeout);
		stream.destroy();
	}
	return undefined;
}
