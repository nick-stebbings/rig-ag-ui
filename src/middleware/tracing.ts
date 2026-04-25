import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { NextFunction, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

/**
 * W3C Trace Context header names
 */
export const TRACEPARENT_HEADER = "traceparent";
export const TRACESTATE_HEADER = "tracestate";
export const CORRELATION_ID_HEADER = "x-correlation-id";
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Distributed tracing context for request correlation
 */
export interface TracingContext {
	/** Trace ID (32 hex chars) - correlates all spans in a distributed trace */
	traceId: string;
	/** Span ID (16 hex chars) - identifies this specific span */
	spanId: string;
	/** Parent span ID from incoming request */
	parentSpanId?: string;
	/** Whether this trace is sampled */
	sampled: boolean;
	/** Request start time for duration calculation */
	startTime: number;
	/** Original traceparent header (if received) */
	traceparent?: string;
	/** Original tracestate header (if received) */
	tracestate?: string;
	// Backwards compatibility
	correlationId: string;
	requestId: string;
}

declare global {
	namespace Express {
		interface Request {
			tracing?: TracingContext;
		}
	}
}

/**
 * Generate a random trace ID (32 hex characters)
 */
function generateTraceId(): string {
	return uuidv4().replace(/-/g, "");
}

/**
 * Generate a random span ID (16 hex characters)
 */
function generateSpanId(): string {
	return uuidv4().replace(/-/g, "").slice(0, 16);
}

/**
 * Parse a W3C traceparent header
 * Format: {version}-{trace_id}-{parent_span_id}-{flags}
 * Example: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
 */
function parseTraceparent(
	header: string,
): { traceId: string; parentSpanId: string; sampled: boolean } | null {
	const parts = header.split("-");
	if (parts.length !== 4 || parts[0] !== "00") {
		return null;
	}

	const [, traceId, parentSpanId, flags] = parts;

	// Validate lengths
	if (traceId.length !== 32 || parentSpanId.length !== 16) {
		return null;
	}

	// Validate hex characters
	if (!/^[0-9a-f]+$/i.test(traceId) || !/^[0-9a-f]+$/i.test(parentSpanId)) {
		return null;
	}

	const sampled = (Number.parseInt(flags, 16) & 1) === 1;

	return { traceId, parentSpanId, sampled };
}

/**
 * Format a traceparent header value
 */
function formatTraceparent(
	traceId: string,
	spanId: string,
	sampled: boolean,
): string {
	const flags = sampled ? "01" : "00";
	return `00-${traceId}-${spanId}-${flags}`;
}

/**
 * Normalize a correlation ID to 32 hex characters
 */
function normalizeTraceId(value: string): string {
	const clean = value.replace(/-/g, "").replace(/[^0-9a-f]/gi, "");
	if (clean.length >= 32) {
		return clean.slice(0, 32).toLowerCase();
	}
	return clean.padStart(32, "0").toLowerCase();
}

/**
 * Extract trace context from request headers or OTEL context
 */
function extractTraceContext(req: Request): TracingContext {
	const startTime = Date.now();

	// First, try to get trace context from OTEL (if auto-instrumented)
	const activeSpan = trace.getActiveSpan();
	const spanContext = activeSpan?.spanContext();

	if (spanContext && trace.isSpanContextValid(spanContext)) {
		// Use OTEL context - this means HTTP instrumentation already captured it
		const traceId = spanContext.traceId;
		const spanId = spanContext.spanId;
		const sampled = (spanContext.traceFlags & 1) === 1;

		return {
			traceId,
			spanId,
			sampled,
			startTime,
			// Backwards compatibility
			correlationId: traceId,
			requestId: spanId,
		};
	}

	// Fall back to manual header extraction
	const traceparentHeader = req.headers[TRACEPARENT_HEADER] as string;

	if (traceparentHeader) {
		const parsed = parseTraceparent(traceparentHeader);
		if (parsed) {
			const spanId = generateSpanId();
			return {
				traceId: parsed.traceId,
				spanId,
				parentSpanId: parsed.parentSpanId,
				sampled: parsed.sampled,
				startTime,
				traceparent: traceparentHeader,
				tracestate: req.headers[TRACESTATE_HEADER] as string,
				// Backwards compatibility
				correlationId: parsed.traceId,
				requestId: spanId,
			};
		}
	}

	// Fall back to x-correlation-id or x-request-id headers
	const correlationId =
		(req.headers[CORRELATION_ID_HEADER] as string) ||
		(req.headers[REQUEST_ID_HEADER] as string) ||
		(req.headers["x-trace-id"] as string);

	if (correlationId) {
		const traceId = normalizeTraceId(correlationId);
		const spanId = generateSpanId();
		return {
			traceId,
			spanId,
			sampled: true,
			startTime,
			// Backwards compatibility
			correlationId: traceId,
			requestId: spanId,
		};
	}

	// Generate new trace context
	const traceId = generateTraceId();
	const spanId = generateSpanId();
	return {
		traceId,
		spanId,
		sampled: true,
		startTime,
		// Backwards compatibility
		correlationId: traceId,
		requestId: spanId,
	};
}

/**
 * Distributed tracing middleware
 *
 * This middleware:
 * 1. Extracts trace context from OTEL (if instrumented) or headers
 * 2. Supports W3C traceparent header format
 * 3. Falls back to x-correlation-id for backwards compatibility
 * 4. Adds trace headers to responses
 * 5. Records request timing and status on active OTEL span
 */
export function tracingMiddleware() {
	return (req: Request, res: Response, next: NextFunction): void => {
		// Extract or generate trace context
		const tracing = extractTraceContext(req);
		req.tracing = tracing;

		const tracePrefix = `[${tracing.traceId.slice(0, 8)}]`;

		// Add trace headers to response
		res.setHeader(CORRELATION_ID_HEADER, tracing.traceId);
		res.setHeader(REQUEST_ID_HEADER, tracing.spanId);
		res.setHeader(
			TRACEPARENT_HEADER,
			formatTraceparent(tracing.traceId, tracing.spanId, tracing.sampled),
		);

		if (tracing.tracestate) {
			res.setHeader(TRACESTATE_HEADER, tracing.tracestate);
		}

		// Log request start
		console.log(`${tracePrefix} ${req.method} ${req.path} started`, {
			traceId: tracing.traceId,
			spanId: tracing.spanId,
			parentSpanId: tracing.parentSpanId,
		});

		// Track response completion
		res.on("finish", () => {
			const duration = Date.now() - tracing.startTime;
			console.log(
				`${tracePrefix} ${req.method} ${req.path} ${res.statusCode} ${duration}ms`,
			);

			// Update active OTEL span with response info
			const activeSpan = trace.getActiveSpan();
			if (activeSpan) {
				activeSpan.setAttribute("http.response_time_ms", duration);
				activeSpan.setAttribute("http.status_code", res.statusCode);

				if (res.statusCode >= 400) {
					activeSpan.setStatus({
						code: SpanStatusCode.ERROR,
						message: `HTTP ${res.statusCode}`,
					});
				} else {
					activeSpan.setStatus({ code: SpanStatusCode.OK });
				}
			}
		});

		next();
	};
}

/**
 * Create trace headers for downstream service calls
 *
 * Generates a new span ID for the outgoing request while preserving the trace ID.
 */
export function createTraceHeaders(req: Request): Record<string, string> {
	const headers: Record<string, string> = {};

	if (req.tracing) {
		const { traceId, sampled, tracestate } = req.tracing;
		const newSpanId = generateSpanId();

		// W3C Trace Context headers
		headers[TRACEPARENT_HEADER] = formatTraceparent(
			traceId,
			newSpanId,
			sampled,
		);

		if (tracestate) {
			headers[TRACESTATE_HEADER] = tracestate;
		}

		// Backwards compatibility headers
		headers[CORRELATION_ID_HEADER] = traceId;
		headers[REQUEST_ID_HEADER] = traceId;
	}

	return headers;
}

/**
 * Create trace headers from trace context directly
 *
 * Useful when you have a TracingContext but not a Request object.
 */
export function createTraceHeadersFromContext(
	tracing: TracingContext,
): Record<string, string> {
	const newSpanId = generateSpanId();

	const headers: Record<string, string> = {
		[TRACEPARENT_HEADER]: formatTraceparent(
			tracing.traceId,
			newSpanId,
			tracing.sampled,
		),
		[CORRELATION_ID_HEADER]: tracing.traceId,
		[REQUEST_ID_HEADER]: tracing.traceId,
	};

	if (tracing.tracestate) {
		headers[TRACESTATE_HEADER] = tracing.tracestate;
	}

	return headers;
}

/**
 * Get trace context from current OTEL context (for use outside Express)
 */
export function getTraceContextFromOtel(): TracingContext | null {
	const activeSpan = trace.getActiveSpan();
	const spanContext = activeSpan?.spanContext();

	if (spanContext && trace.isSpanContextValid(spanContext)) {
		return {
			traceId: spanContext.traceId,
			spanId: spanContext.spanId,
			sampled: (spanContext.traceFlags & 1) === 1,
			startTime: Date.now(),
			correlationId: spanContext.traceId,
			requestId: spanContext.spanId,
		};
	}

	return null;
}

/**
 * Log a trace event with correlation context
 */
export function logTraceEvent(
	req: Request,
	event: string,
	data: Record<string, unknown> = {},
): void {
	if (!req.tracing) return;

	const tracePrefix = `[${req.tracing.traceId.slice(0, 8)}]`;
	console.log(`${tracePrefix} ${event}`, {
		traceId: req.tracing.traceId,
		spanId: req.tracing.spanId,
		event,
		...data,
	});
}

/**
 * Create a child span for a specific operation (manual span creation)
 *
 * For OTEL-instrumented code, prefer using trace.getTracer().startActiveSpan()
 */
export function createChildSpan(req: Request, operation: string): string {
	const spanId = generateSpanId();
	logTraceEvent(req, `Span Start: ${operation}`, {
		spanId,
		operation,
		parentSpan: req.tracing?.spanId,
	});
	return spanId;
}

/**
 * End a child span
 */
export function endChildSpan(
	req: Request,
	spanId: string,
	operation: string,
	success = true,
	error?: string,
): void {
	logTraceEvent(req, `Span End: ${operation}`, {
		spanId,
		operation,
		success,
		error,
		parentSpan: req.tracing?.spanId,
	});
}
