import { Readable } from "node:stream";
import { AxiosError } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRigRecoveryError } from "./rig_recovery_error";

function responseError(data: Readable, status = 409) {
	return Object.assign(new AxiosError("HTTP failure"), {
		response: { status, data },
	});
}

describe("Rig recovery error", () => {
	afterEach(() => vi.useRealTimers());

	it.each([
		"not-json",
		JSON.stringify({ code: "UNKNOWN", secret: "private" }),
		"x".repeat(8193),
	])("ignores malformed, unknown, or oversized responses", async (body) => {
		const stream = Readable.from([body]);
		expect(await readRigRecoveryError(responseError(stream))).toBeUndefined();
		expect(stream.destroyed).toBe(true);
	});

	it("stops reading a stalled response", async () => {
		vi.useFakeTimers();
		const stream = new Readable({ read() {} });
		const result = readRigRecoveryError(responseError(stream));
		await vi.advanceTimersByTimeAsync(2000);
		expect(await result).toBeUndefined();
		expect(stream.destroyed).toBe(true);
	});

	it("does not interpret other failures as a pending call", async () => {
		expect(await readRigRecoveryError(new Error("private"))).toBeUndefined();
	});

	it("returns a stable code for a known continuation rejection", async () => {
		const result = await readRigRecoveryError(
			responseError(
				Readable.from([
					JSON.stringify({
						error:
							"Failed to continue tool result: tool result does not match current Native setup",
					}),
				]),
				400,
			),
		);
		expect(result).toMatchObject({
			name: "RigContinuationRejectedError",
			code: "RIG_CONTINUATION_TOOL_RESULT_DOES_NOT_MATCH_CURRENT_NATIVE_SETUP",
		});
	});

	it("does not expose an unknown 400 body", async () => {
		const result = await readRigRecoveryError(
			responseError(
				Readable.from([JSON.stringify({ error: "private upstream detail" })]),
				400,
			),
		);
		expect(result).toBeUndefined();
	});
});
