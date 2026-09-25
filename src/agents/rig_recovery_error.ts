import { Readable } from "node:stream";
import axios from "axios";
import { z } from "zod";

const pendingCall = z.object({
	code: z.literal("FRONTEND_TOOL_PENDING"),
	tool_call_id: z.string().trim().min(1).max(256),
	next_action: z.literal("complete_or_cancel_pending_action"),
});

const continuationRejection = z.object({
	error: z.string().trim().min(1).max(512),
});

const continuationReasons = [
	"tool result does not match a pending call in this conversation",
	"tool result was already accepted",
	"tool result belongs to a superseded call",
	"tool result has no outcome",
	"tool result draft does not match the pending call",
	"tool result has no draft revision",
	"tool result draft revision is stale",
	"tool result does not match current Native setup",
	"Native setup context is required for a tool result",
] as const;

type ContinuationReason = (typeof continuationReasons)[number];

function knownContinuationReason(
	value: string,
): ContinuationReason | undefined {
	return continuationReasons.find((reason) =>
		value.endsWith(`Failed to continue tool result: ${reason}`),
	);
}

/** A known recovery state. Never forward arbitrary upstream error text. */
export class RigRecoveryError extends Error {
	constructor(readonly recovery: z.infer<typeof pendingCall>) {
		super(
			"Finish or cancel the pending setup action before sending another message.",
		);
		this.name = "RigRecoveryError";
	}
}

/** A known continuation rejection. Its code is safe to send to the client. */
export class RigContinuationRejectedError extends Error {
	constructor(readonly code: `RIG_CONTINUATION_${string}`) {
		super(
			"The setup result could not be applied. Return to the current setup action.",
		);
		this.name = "RigContinuationRejectedError";
	}
}

/** Read only a small, bounded error body from Rig's streaming HTTP response. */
export async function readRigRecoveryError(
	error: unknown,
): Promise<RigRecoveryError | RigContinuationRejectedError | undefined> {
	if (!axios.isAxiosError(error)) return;
	const response = error.response;
	if (!response || ![400, 409].includes(response.status)) return;
	const stream: unknown = response.data;
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
		const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		const pending = pendingCall.safeParse(body);
		if (pending.success) return new RigRecoveryError(pending.data);
		const rejection = continuationRejection.safeParse(body);
		const reason = rejection.success
			? knownContinuationReason(rejection.data.error)
			: undefined;
		if (reason) {
			const code = `RIG_CONTINUATION_${reason
				.toUpperCase()
				.replaceAll(/[^A-Z0-9]+/g, "_")
				.replace(/^_|_$/g, "")}` as const;
			return new RigContinuationRejectedError(code);
		}
	} catch {
		// Unknown or malformed errors use the existing generic failure path.
	} finally {
		clearTimeout(timeout);
		stream.destroy();
	}
	return undefined;
}
