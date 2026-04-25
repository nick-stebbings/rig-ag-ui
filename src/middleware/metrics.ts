/**
 * HTTP Metrics Middleware for Express
 *
 * Records OpenTelemetry metrics for HTTP requests:
 * - http_server_request_duration_seconds: histogram of request latency
 * - http_server_active_requests: gauge of concurrent requests
 * - http_server_request_total: counter of total requests with labels
 */

import type { NextFunction, Request, Response } from "express";
import { getHttpServerMetrics } from "../tracing/otel";

/**
 * Normalize route path for metric labels
 *
 * Replaces dynamic path segments with placeholders to avoid
 * high cardinality in metric labels.
 *
 * Examples:
 * - /agents/abc123/run -> /agents/:agentId/run
 * - /sessions/xyz/state -> /sessions/:sessionId/state
 */
function normalizeRoute(req: Request): string {
	// Use the Express route pattern if available (most accurate)
	if (req.route?.path) {
		return `${req.baseUrl}${req.route.path}`;
	}

	// Fall back to path normalization for routes without patterns
	const path = req.path || req.url?.split("?")[0] || "/";

	// Common dynamic segment patterns
	const normalizedPath = path
		// UUID pattern
		.replace(
			/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
			"/:id",
		)
		// Numeric IDs
		.replace(/\/\d+/g, "/:id")
		// Known path segments with dynamic values
		.replace(/\/agents\/[^/]+/g, "/agents/:agentId")
		.replace(/\/sessions\/[^/]+/g, "/sessions/:sessionId");

	return normalizedPath;
}

/**
 * Get HTTP status code class for grouping
 * Returns "2xx", "3xx", "4xx", "5xx", or the specific code
 */
function getStatusClass(statusCode: number): string {
	if (statusCode >= 200 && statusCode < 300) return "2xx";
	if (statusCode >= 300 && statusCode < 400) return "3xx";
	if (statusCode >= 400 && statusCode < 500) return "4xx";
	if (statusCode >= 500) return "5xx";
	return String(statusCode);
}

/**
 * Express middleware to record HTTP server metrics
 *
 * Must be added early in the middleware chain to capture all requests.
 */
export function metricsMiddleware() {
	return (req: Request, res: Response, next: NextFunction): void => {
		const metrics = getHttpServerMetrics();

		// Skip if metrics are not initialized
		if (!metrics) {
			next();
			return;
		}

		const startTime = process.hrtime.bigint();
		const method = req.method;

		// Increment active requests counter
		metrics.activeRequests.add(1, {
			method,
		});

		// Track response completion
		res.on("finish", () => {
			// Calculate duration in seconds (nanoseconds to seconds)
			const endTime = process.hrtime.bigint();
			const durationNs = Number(endTime - startTime);
			const durationSeconds = durationNs / 1e9;

			const statusCode = res.statusCode;
			const statusClass = getStatusClass(statusCode);
			const route = normalizeRoute(req);

			// Record request duration histogram
			metrics.requestDuration.record(durationSeconds, {
				method,
				route,
				status_code: String(statusCode),
			});

			// Increment total requests counter
			metrics.requestTotal.add(1, {
				method,
				route,
				status_code: String(statusCode),
				status_class: statusClass,
			});

			// Decrement active requests counter
			metrics.activeRequests.add(-1, {
				method,
			});
		});

		// Handle connection close/error before response finishes
		res.on("close", () => {
			if (!res.writableEnded) {
				// Response was not completed normally (client disconnect, etc.)
				metrics.activeRequests.add(-1, {
					method,
				});

				// Record as an aborted request
				metrics.requestTotal.add(1, {
					method,
					route: normalizeRoute(req),
					status_code: "0",
					status_class: "aborted",
				});
			}
		});

		next();
	};
}
