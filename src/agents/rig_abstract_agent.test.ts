import { describe, expect, it } from "vitest";
import { isUuid, parseToolResultMarker } from "./rig_abstract_agent";

describe("parseToolResultMarker", () => {
	it("parses a well-formed __TOOL_RESULT__ marker into its parts", () => {
		const json = JSON.stringify({
			accepted: true,
			execution_id: "exec-123",
			status: "running",
		});
		const marker = `__TOOL_RESULT__:call-abc:${json}`;

		expect(parseToolResultMarker(marker)).toEqual({
			internalCallId: "call-abc",
			resultJson: json,
		});
	});

	it("preserves colons inside the JSON payload", () => {
		const json = JSON.stringify({ message: "ratio 3:2 reached" });
		const marker = `__TOOL_RESULT__:call-abc:${json}`;

		expect(parseToolResultMarker(marker)?.resultJson).toBe(json);
	});

	it("returns null when the JSON payload is malformed", () => {
		const marker = "__TOOL_RESULT__:call-abc:{not valid json";

		expect(parseToolResultMarker(marker)).toBeNull();
	});

	it("returns null when there is no internal_call_id separator", () => {
		const marker = "__TOOL_RESULT__:no-second-colon-here";

		expect(parseToolResultMarker(marker)).toBeNull();
	});
});

describe("isUuid", () => {
	it("accepts a canonical lowercase UUID (client crypto.randomUUID form)", () => {
		expect(isUuid("083f404e-41bb-54a1-a464-a226df4ce807")).toBe(true);
	});

	it("accepts uppercase hex", () => {
		expect(isUuid("083F404E-41BB-54A1-A464-A226DF4CE807")).toBe(true);
	});

	it("rejects the client's non-UUID thread fallback and junk", () => {
		expect(isUuid("thread-1752522000-abcdef12")).toBe(false);
		expect(isUuid("")).toBe(false);
		expect(isUuid(undefined)).toBe(false);
		expect(isUuid("083f404e41bb54a1a464a226df4ce807")).toBe(false);
	});
});
