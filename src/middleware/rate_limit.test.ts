import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_RATE_LIMIT_SETTINGS,
	createRateLimiters,
	isExemptFromRateLimit,
	rateLimitSettings,
	userRateLimitKey,
} from "./rate_limit";

function requestWith(authorization?: string) {
	return { headers: authorization ? { authorization } : {} };
}

describe("rate limit settings", () => {
	it("uses the defaults when nothing is set", () => {
		expect(rateLimitSettings({})).toEqual(DEFAULT_RATE_LIMIT_SETTINGS);
	});

	it("reads positive integers and ignores bad values", () => {
		expect(
			rateLimitSettings({
				AGUI_RATE_LIMIT_WINDOW_MS: "60000",
				AGUI_RATE_LIMIT_USER_MAX: "50",
				AGUI_RATE_LIMIT_IP_MAX: "0",
			}),
		).toEqual({
			windowMs: 60000,
			userMax: 50,
			ipMax: DEFAULT_RATE_LIMIT_SETTINGS.ipMax,
		});
		expect(
			rateLimitSettings({ AGUI_RATE_LIMIT_USER_MAX: "many" }).userMax,
		).toBe(DEFAULT_RATE_LIMIT_SETTINGS.userMax);
	});
});

describe("user rate limit key", () => {
	it("is the same for one token and different for another", () => {
		const first = userRateLimitKey(requestWith("Bearer token-a"));
		expect(first).toBe(userRateLimitKey(requestWith("Bearer token-a")));
		expect(first).not.toBe(userRateLimitKey(requestWith("Bearer token-b")));
	});

	it("does not contain the token", () => {
		expect(userRateLimitKey(requestWith("Bearer token-a"))).not.toContain(
			"token-a",
		);
	});

	it("is undefined with no bearer token", () => {
		expect(userRateLimitKey(requestWith())).toBeUndefined();
		expect(userRateLimitKey(requestWith("Basic abc"))).toBeUndefined();
		expect(userRateLimitKey(requestWith("Bearer "))).toBeUndefined();
	});
});

describe("health check", () => {
	it("is exempt and other paths are not", () => {
		expect(isExemptFromRateLimit({ path: "/health" })).toBe(true);
		expect(isExemptFromRateLimit({ path: "/copilotkit/info" })).toBe(false);
	});
});

describe("limiters on a server", () => {
	let close: (() => void) | undefined;
	afterEach(() => close?.());

	async function serve(userMax: number, ipMax: number): Promise<string> {
		const app = express();
		for (const limiter of createRateLimiters({
			windowMs: 60_000,
			userMax,
			ipMax,
		})) {
			app.use(limiter);
		}
		app.get("/health", (_req, res) => res.json({ ok: true }));
		app.post("/agents/run", (_req, res) => res.json({ ok: true }));
		app.get("/agents/events", (_req, res) => res.json({ ok: true }));
		const server = app.listen(0);
		close = () => server.close();
		const { port } = server.address() as AddressInfo;
		return `http://127.0.0.1:${port}`;
	}

	async function post(base: string, token: string): Promise<number> {
		const response = await fetch(`${base}/agents/run`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
		});
		return response.status;
	}

	it("gives each user on one address a separate allowance", async () => {
		const base = await serve(3, 100);
		// The first user uses the whole allowance.
		expect(await post(base, "alice")).toBe(200);
		expect(await post(base, "alice")).toBe(200);
		expect(await post(base, "alice")).toBe(200);
		expect(await post(base, "alice")).toBe(429);
		// A colleague on the same address is not affected.
		expect(await post(base, "bob")).toBe(200);
	});

	it("keeps the address limit as the upper bound", async () => {
		const base = await serve(100, 2);
		expect(await post(base, "t1")).toBe(200);
		expect(await post(base, "t2")).toBe(200);
		// A third request from the address is refused, with any token.
		expect(await post(base, "t3")).toBe(429);
	});

	it("counts a request with no token against the address only", async () => {
		const base = await serve(1, 3);
		for (let i = 0; i < 3; i++) {
			expect((await fetch(`${base}/agents/events`)).status).toBe(200);
		}
		expect((await fetch(`${base}/agents/events`)).status).toBe(429);
	});

	it("never limits the health check", async () => {
		const base = await serve(1, 1);
		for (let i = 0; i < 5; i++) {
			expect((await fetch(`${base}/health`)).status).toBe(200);
		}
	});
});
