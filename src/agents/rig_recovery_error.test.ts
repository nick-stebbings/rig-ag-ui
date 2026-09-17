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
});
