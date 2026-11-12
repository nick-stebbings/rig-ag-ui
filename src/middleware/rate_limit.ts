/**
 * Rate limits for the middleware.
 *
 * Two limits apply to every request except the health check:
 *
 * - a limit for each signed-in user, keyed by a hash of the bearer token;
 * - a higher limit for each IP address, as a backstop.
 *
 * One limit for each IP address alone is wrong for an office: people there
 * share one address, and one chat turn costs two or more requests, so a few
 * busy users used the whole allowance of everyone on that network.
 *
 * The token is not verified here; the API does that. A caller who sends many
 * different tokens gets a new user allowance for each, so the IP limit stays
 * as the upper bound. Requests with no bearer token (the event stream is
 * opened with EventSource, which cannot set headers) count against the IP
 * limit only.
 */
import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import rateLimit from "express-rate-limit";

export interface RateLimitSettings {
	windowMs: number;
	userMax: number;
	ipMax: number;
}

export const DEFAULT_RATE_LIMIT_SETTINGS: RateLimitSettings = {
	windowMs: 15 * 60 * 1000,
	// About 150 chat turns in 15 minutes for one user.
	userMax: 300,
	// About 10 busy users, or 750 event streams, behind one address.
	ipMax: 1500,
};

/** A positive integer from the environment, or the default. */
function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read the three settings; a missing or bad value keeps its default. */
export function rateLimitSettings(
	env: Record<string, string | undefined> = process.env,
): RateLimitSettings {
	return {
		windowMs: positiveInt(
			env.AGUI_RATE_LIMIT_WINDOW_MS,
			DEFAULT_RATE_LIMIT_SETTINGS.windowMs,
		),
		userMax: positiveInt(
			env.AGUI_RATE_LIMIT_USER_MAX,
			DEFAULT_RATE_LIMIT_SETTINGS.userMax,
		),
		ipMax: positiveInt(
			env.AGUI_RATE_LIMIT_IP_MAX,
			DEFAULT_RATE_LIMIT_SETTINGS.ipMax,
		),
	};
}

/** The bearer token of a request, when it has one. */
function bearerToken(req: Pick<Request, "headers">): string | undefined {
	const header = req.headers.authorization;
	if (typeof header !== "string" || !header.startsWith("Bearer ")) {
		return undefined;
	}
	const token = header.slice(7).trim();
	return token.length > 0 ? token : undefined;
}

/**
 * The key for the user limit: a hash of the bearer token, so the token is
 * never kept. `undefined` when the request has no token.
 */
export function userRateLimitKey(
	req: Pick<Request, "headers">,
): string | undefined {
	const token = bearerToken(req);
	return token === undefined
		? undefined
		: `user:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
}

/** The health check is not counted: a monitor must never be limited. */
export function isExemptFromRateLimit(req: Pick<Request, "path">): boolean {
	return req.path === "/health";
}

/** The two limiters, in the order they must be mounted. */
export function createRateLimiters(
	settings: RateLimitSettings = rateLimitSettings(),
): RequestHandler[] {
	const ipLimiter = rateLimit({
		windowMs: settings.windowMs,
		max: settings.ipMax,
		standardHeaders: true,
		legacyHeaders: false,
		skip: (req) => isExemptFromRateLimit(req),
		message: "Too many requests from this network, please try again later.",
	});
	const userLimiter = rateLimit({
		windowMs: settings.windowMs,
		max: settings.userMax,
		standardHeaders: true,
		legacyHeaders: false,
		// No token: only the IP limit applies.
		skip: (req) =>
			isExemptFromRateLimit(req) || userRateLimitKey(req) === undefined,
		keyGenerator: (req) => userRateLimitKey(req) ?? "anonymous",
		message: "Too many requests, please try again later.",
	});
	return [ipLimiter, userLimiter];
}
