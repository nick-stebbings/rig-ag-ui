import { describe, expect, it } from "vitest";
import { parseToolResultMarker } from "./rig_abstract_agent";

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
