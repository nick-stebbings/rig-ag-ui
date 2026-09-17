import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpAgent } from "@ag-ui/client";
import { CopilotKitCore } from "@copilotkit/core";
import express, { type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AguiRunEnvelope } from "../../src/agents/agui_contract";
import { AguiMiddlewareApp } from "../../src/app";

type RigRequest = {
	content: string;
	auth_token?: string;
	metadata: {
		ag_ui: AguiRunEnvelope;
		context: { type: string; value: unknown }[];
	};
};

function listen(
	app: express.Express,
): Promise<{ server: Server; url: string }> {
	return new Promise((resolve, reject) => {
		const server = app.listen(0, "127.0.0.1", () => {
			resolve({
				server,
				url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			});
		});
		server.on("error", reject);
	});
}

function frame(content: string, nested = false) {
	return `data: ${JSON.stringify(nested ? { data: { chunk: { content } } } : { content })}\n\n`;
}

describe("CopilotKit frontend tool continuation through HTTP middleware", () => {
	let middleware: AguiMiddlewareApp;
	let servers: Server[];
	let url: string;
	let requests: RigRequest[];
	let reply: (request: RigRequest, response: Response) => void;

	beforeEach(async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		servers = [];
		requests = [];
		const rig = express();
		rig.use(express.json());
		rig.post("/sessions", (req, res) =>
			res.json({ session_id: req.body.session_id }),
		);
		rig.post("/sessions/:id/messages", (req, res) => {
			requests.push(req.body);
			reply(req.body, res);
		});
		const backend = await listen(rig);
		servers.push(backend.server);
		vi.stubEnv("RIG_API_BASE_URL", backend.url);
		middleware = new AguiMiddlewareApp();
		const bridge = await listen(middleware.getApp());
		servers.push(bridge.server);
		url = `${bridge.url}/copilotkit/agent/general/run`;
	});

	afterEach(async () => {
		await middleware?.shutdown();
		await Promise.all(
			servers.map(
				(server) =>
					new Promise<void>((resolve) => {
						server.closeAllConnections();
						server.close(() => resolve());
					}),
			),
		);
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("preserves structured messages and separate conversations", async () => {
		reply = (_request, res) =>
			res.type("text/event-stream").end(frame("Ready."));
		const messages = [
			{ id: "policy", role: "developer", content: "Use supplied facts" },
			{
				id: "input",
				role: "user",
				content: [{ type: "text", text: "A product" }],
			},
			{
				id: "call-message",
				role: "assistant",
				toolCalls: [
					{
						id: "call-1",
						type: "function",
						function: { name: "collect_generation_inputs", arguments: "{}" },
					},
				],
			},
			{
				id: "result",
				role: "tool",
				toolCallId: "call-1",
				content: "cancelled",
			},
		];
		const threads = [randomUUID(), randomUUID()];
		await Promise.all(
			threads.map(async (threadId) => {
				const response = await fetch(url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-API-Key": "development-key",
					},
					body: JSON.stringify({
						threadId,
						runId: randomUUID(),
						messages,
						tools: [
							{
								name: "collect_generation_inputs",
								parameters: {
									type: "object",
									additionalProperties: false,
									$defs: { action: { enum: ["pick"] } },
								},
							},
						],
					}),
				});
				expect(await response.text()).toContain('"type":"RUN_FINISHED"');
			}),
		);
		expect(
			requests.map((item) => item.metadata.ag_ui.thread_id).sort(),
		).toEqual(threads.sort());
		for (const item of requests) {
			expect(item.metadata.ag_ui.messages).toEqual(messages);
			expect(item.metadata.ag_ui.tools[0].parameters.$defs).toEqual({
				action: { enum: ["pick"] },
			});
			expect(item.content).toBe("");
		}
	});

	it.each([false, true])(
		"shows a safe recovery action (deferred: %s)",
		async (deferred) => {
			reply = (_request, res) =>
				res.status(409).json({
					code: "FRONTEND_TOOL_PENDING",
					tool_call_id: "pending-call",
					next_action: "complete_or_cancel_pending_action",
					error: "private upstream details must not be forwarded",
				});
			const headers = {
				"Content-Type": "application/json",
				"X-API-Key": "development-key",
				...(deferred ? { "X-Stream-Mode": "deferred" } : {}),
			};
			let response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify({
					threadId: randomUUID(),
					runId: randomUUID(),
					messages: [{ id: "user", role: "user", content: "Continue" }],
				}),
			});
			if (deferred) {
				const { streamSessionId } = await response.json();
				response = await fetch(
					url.replace(/\/run$/, `/events/${streamSessionId}`),
					{ headers },
				);
			}
			const body = await response.text();
			expect(body).toContain('"type":"RUN_ERROR"');
			expect(body).toContain('"code":"FRONTEND_TOOL_PENDING"');
			expect(body).toContain('"tool_call_id":"pending-call"');
			expect(body).toContain(
				'"next_action":"complete_or_cancel_pending_action"',
			);
			expect(body).toContain(
				"Finish or cancel the pending setup action before sending another message.",
			);
			expect(body).not.toContain("private upstream details");
			expect(body).not.toContain('"type":"RUN_FINISHED"');
		},
	);

	it("keeps normal chat and server tool results", async () => {
		reply = (_request, res) =>
			res
				.type("text/event-stream")
				.end(
					frame('__TOOL_CALL__:lookup:{"query":"product"}') +
						frame('__TOOL_RESULT__:server-call:{"found":true}') +
						frame("Found the product."),
				);
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-Key": "development-key",
			},
			body: JSON.stringify({
				threadId: randomUUID(),
				runId: randomUUID(),
				messages: [{ id: "user", role: "user", content: "Find the product" }],
			}),
		});
		const body = await response.text();
		expect(requests[0].content).toBe("Find the product");
		expect(body).toContain('"type":"TOOL_CALL_RESULT"');
		expect(body).toContain("Found the product.");
		expect(body).toContain('"type":"RUN_FINISHED"');
	});

	it("rejects a tool result without its call ID before contacting Rig", async () => {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-Key": "development-key",
			},
			body: JSON.stringify({
				threadId: randomUUID(),
				runId: randomUUID(),
				messages: [{ id: "result", role: "tool", content: "accepted" }],
			}),
		});
		expect(response.status).toBe(400);
		expect(requests).toHaveLength(0);
	});

	it.each([
		{ outcome: "accepted", deferred: false },
		{ outcome: "cancelled", deferred: false },
		{ outcome: "stale_state", deferred: false },
		{ outcome: "accepted", deferred: true },
		{ outcome: "cancelled", deferred: true },
		{ outcome: "stale_state", deferred: true },
	])(
		"continues after $outcome (deferred: $deferred)",
		async ({ outcome, deferred }) => {
			const callId = randomUUID();
			const threadId = randomUUID();
			const toolName = deferred
				? "choose_meta_ad_copy"
				: "collect_generation_inputs";
			const args = {
				draftId: "draft-café",
				draftRevision: 1,
				...(deferred
					? {
							headlines: ["One", "Two", "Three"],
							primaryTexts: ["First", "Second", "Third"],
						}
					: { action: "select_product" }),
			};
			const marker = `__FRONTEND_TOOL_CALL__:${JSON.stringify({ id: callId, name: toolName, arguments: args })}`;
			reply = (_request, res) => {
				res.type("text/event-stream");
				if (requests.length === 1) {
					const bytes = Buffer.from(frame(marker, true) + frame(marker, true));
					const split = bytes.indexOf(Buffer.from("é")) + 1;
					res.write(bytes.subarray(0, split));
					setImmediate(() => res.end(bytes.subarray(split)));
				} else
					res.end(
						`${frame("Native returned its result.")}data: {"content":"","is_final":true}\n\n`,
					);
			};
			const agent = new HttpAgent({
				url,
				fetch: async (requestUrl, init) => {
					if (!deferred) return fetch(requestUrl, init);
					const headers = new Headers(init.headers);
					headers.set("X-Stream-Mode", "deferred");
					const response = await fetch(requestUrl, { ...init, headers });
					if (!response.ok) return response;
					const { streamSessionId } = await response.json();
					return fetch(url.replace(/\/run$/, `/events/${streamSessionId}`), {
						headers,
						signal: init.signal,
					});
				},
				agentId: "general",
				threadId,
				initialMessages: [
					{ id: randomUUID(), role: "user", content: "Update my setup" },
				],
				initialState: { transport: "preserved" },
			});
			const core = new CopilotKitCore({
				agents__unsafe_dev_only: { general: agent },
				headers: {
					Authorization: "Bearer fixture-token",
					"X-API-Key": "development-key",
				},
			});
			let contextId = core.addContext({
				description: "native_setup",
				value: JSON.stringify(args),
			});
			let respond!: (value: unknown) => void;
			const handler = vi.fn(
				async () =>
					new Promise((resolve) => {
						respond = resolve;
					}),
			);
			core.addTool({
				name: toolName,
				parameters: z.object({
					draftId: z.string(),
					draftRevision: z.number().int().min(1),
					...(deferred
						? {
								headlines: z.array(z.string().min(1)).length(3),
								primaryTexts: z.array(z.string().min(1)).length(3),
							}
						: { action: z.string() }),
				}),
				handler,
			});
			const run = core.runAgent({ agent });
			await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
			expect(requests).toHaveLength(1);
			expect(agent.messages.some((message) => message.role === "tool")).toBe(
				false,
			);
			core.removeContext(contextId);
			contextId = core.addContext({
				description: "native_setup",
				value: JSON.stringify({ ...args, draftRevision: 2 }),
			});
			respond({ outcome, draftId: args.draftId, draftRevision: 2 });
			await run;
			expect(requests).toHaveLength(2);
			const [first, second] = requests;
			expect(second.content).toBe("");
			expect(second.auth_token).toBe("fixture-token");
			expect(second.metadata.ag_ui.thread_id).toBe(threadId);
			expect(second.metadata.ag_ui.run_id).not.toBe(
				first.metadata.ag_ui.run_id,
			);
			expect(second.metadata.ag_ui.state).toEqual({ transport: "preserved" });
			expect(second.metadata.context).toContainEqual({
				type: "native_setup",
				value: JSON.stringify({ ...args, draftRevision: 2 }),
			});
			expect(second.metadata.ag_ui.tools[0].name).toBe(toolName);
			expect(second.metadata.ag_ui.messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						role: "assistant",
						toolCalls: [
							{
								id: callId,
								type: "function",
								function: {
									name: toolName,
									arguments: JSON.stringify(args),
								},
							},
						],
					}),
					expect.objectContaining({
						role: "tool",
						toolCallId: callId,
						content: JSON.stringify({
							outcome,
							draftId: args.draftId,
							draftRevision: 2,
						}),
					}),
				]),
			);
			expect(handler).toHaveBeenCalledTimes(1);
			core.removeContext(contextId);
		},
	);

	it.each([
		"http",
		"malformed",
		"unadvertised",
		"truncated",
		"disconnect",
		"conflicting_id",
	])(
		"returns an error without simulated success for %s failure",
		async (failure) => {
			reply = (_request, res) => {
				if (failure === "http") {
					res.status(409).json({ error: "Pending call expired" });
					return;
				}
				res.type("text/event-stream");
				if (failure === "malformed") res.end(frame("__FRONTEND_TOOL_CALL__:{"));
				if (failure === "unadvertised")
					res.end(
						frame(
							`__FRONTEND_TOOL_CALL__:${JSON.stringify({ id: "call", name: "unknown_tool", arguments: {} })}`,
						),
					);
				if (failure === "truncated") res.end('data: {"content":');
				if (failure === "disconnect") {
					res.write(": keepalive\n\n");
					setImmediate(() => res.destroy());
				}
				if (failure === "conflicting_id")
					res.end(
						frame(
							`__FRONTEND_TOOL_CALL__:${JSON.stringify({ id: "call", name: "collect_generation_inputs", arguments: { revision: 1 } })}`,
						) +
							frame(
								`__FRONTEND_TOOL_CALL__:${JSON.stringify({ id: "call", name: "collect_generation_inputs", arguments: { revision: 2 } })}`,
							),
					);
			};
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-API-Key": "development-key",
				},
				body: JSON.stringify({
					threadId: randomUUID(),
					runId: randomUUID(),
					tools: [{ name: "collect_generation_inputs" }],
					messages: [
						{
							id: "result",
							role: "tool",
							toolCallId: "expired-call",
							content: "cancelled",
						},
					],
				}),
			});
			const body = await response.text();
			expect(body).toContain('"type":"RUN_ERROR"');
			expect(body).not.toContain('"type":"RUN_FINISHED"');
			expect(body).not.toContain('"type":"TOOL_CALL_RESULT"');
			expect(body).not.toContain('"type":"TEXT_MESSAGE_CONTENT"');
		},
	);
});
