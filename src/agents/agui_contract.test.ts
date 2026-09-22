import { describe, expect, it } from "vitest";
import {
	STRUCTURED_TOOL_MARKER,
	parseStructuredToolCall,
} from "./agui_contract";

const tools = [
	{
		name: "collect_input",
		description: "Collect one input.",
		parameters: {},
	},
];

describe("parseStructuredToolCall", () => {
	it("preserves the producer call ID from the neutral marker", () => {
		const marker = `${STRUCTURED_TOOL_MARKER}${JSON.stringify({
			id: "provider-call-456",
			name: "collect_input",
			arguments: { field: "website" },
		})}`;

		expect(parseStructuredToolCall(marker, tools)).toEqual({
			id: "provider-call-456",
			name: "collect_input",
			arguments: { field: "website" },
		});
	});

	it("uses an explicitly configured producer prefix", () => {
		const marker = `__PRODUCT_TOOL_CALL__:${JSON.stringify({
			id: "provider-call-789",
			name: "collect_input",
			arguments: {},
		})}`;

		expect(
			parseStructuredToolCall(marker, tools, "__PRODUCT_TOOL_CALL__:"),
		).toMatchObject({ id: "provider-call-789" });
	});

	it("rejects an unadvertised tool", () => {
		const marker = `${STRUCTURED_TOOL_MARKER}${JSON.stringify({
			id: "provider-call-456",
			name: "not_advertised",
			arguments: {},
		})}`;

		expect(() => parseStructuredToolCall(marker, tools)).toThrow(
			"did not advertise",
		);
	});
});
