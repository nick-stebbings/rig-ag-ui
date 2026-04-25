/**
 * OpenTelemetry initialization for AG-UI Middleware
 *
 * This module MUST be imported and initialized BEFORE any other imports
 * to ensure proper instrumentation of HTTP and Express.
 *
 * Provides both TRACING (spans) and METRICS for observability.
 */

import {
	type Counter,
	DiagConsoleLogger,
	DiagLogLevel,
	type Histogram,
	type UpDownCounter,
	diag,
	metrics,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { Resource } from "@opentelemetry/resources";
import {
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

let sdk: NodeSDK | null = null;
let meterProvider: MeterProvider | null = null;

/**
 * HTTP server metrics following OpenTelemetry semantic conventions
 */
export interface HttpServerMetrics {
	/** Histogram for request duration in seconds */
	requestDuration: Histogram;
	/** Gauge (UpDownCounter) for concurrent active requests */
	activeRequests: UpDownCounter;
	/** Counter for total requests with status, method, route labels */
	requestTotal: Counter;
}

let httpServerMetrics: HttpServerMetrics | null = null;

/**
 * Get the HTTP server metrics instance
 * Returns null if OTEL is not initialized
 */
export function getHttpServerMetrics(): HttpServerMetrics | null {
	return httpServerMetrics;
}

/**
 * Parse OTLP headers from environment variable
 * Format: "key1=value1,key2=value2" or "key1=value1"
 */
function parseOtlpHeaders(): Record<string, string> {
	const headersEnv = process.env.OTEL_EXPORTER_OTLP_HEADERS;
	const headers: Record<string, string> = {};
	if (headersEnv) {
		for (const pair of headersEnv.split(",")) {
			const eqIdx = pair.indexOf("=");
			if (eqIdx > 0) {
				const key = pair.substring(0, eqIdx).trim();
				const value = pair.substring(eqIdx + 1).trim();
				headers[key] = value;
			}
		}
	}
	return headers;
}

/**
 * Initialize the MeterProvider for metrics
 */
function initMeterProvider(
	resource: Resource,
	genericEndpoint: string | undefined,
	headers: Record<string, string>,
): void {
	// Metrics endpoint - use METRICS-specific or fall back to generic + /v1/metrics
	const metricsEndpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
	const exportUrl =
		metricsEndpoint ||
		(genericEndpoint ? `${genericEndpoint}/v1/metrics` : undefined);

	if (!exportUrl) {
		console.warn(
			"[OTEL] No metrics endpoint configured, skipping metrics export",
		);
		return;
	}

	const metricExporter = new OTLPMetricExporter({
		url: exportUrl,
		headers: Object.keys(headers).length > 0 ? headers : undefined,
	});

	meterProvider = new MeterProvider({
		resource,
		readers: [
			new PeriodicExportingMetricReader({
				exporter: metricExporter,
				// Export metrics every 60 seconds (Grafana Cloud recommended interval)
				exportIntervalMillis: 60000,
			}),
		],
	});

	// Register this MeterProvider globally
	metrics.setGlobalMeterProvider(meterProvider);

	console.log(`[OTEL] Metrics exporting to: ${exportUrl}`);
}

/**
 * Initialize HTTP server metrics instruments
 */
function initHttpMetrics(serviceName: string): void {
	const meter = metrics.getMeter(serviceName);

	httpServerMetrics = {
		// Histogram for request duration following OTEL semantic conventions
		// Using seconds as the unit (recommended by OTEL)
		requestDuration: meter.createHistogram(
			"http_server_request_duration_seconds",
			{
				description: "Duration of HTTP server requests in seconds",
				unit: "s",
			},
		),

		// UpDownCounter for active requests (acts as a gauge)
		activeRequests: meter.createUpDownCounter("http_server_active_requests", {
			description: "Number of concurrent HTTP requests being processed",
			unit: "{request}",
		}),

		// Counter for total requests with labels for status, method, route
		requestTotal: meter.createCounter("http_server_request_total", {
			description: "Total number of HTTP requests",
			unit: "{request}",
		}),
	};

	console.log("[OTEL] HTTP server metrics initialized");
}

/**
 * Initialize OpenTelemetry SDK
 *
 * Must be called BEFORE creating the Express app or importing other modules.
 * The SDK will automatically instrument HTTP and Express requests.
 * Also initializes the MeterProvider for metrics export.
 */
export function initOtel(): void {
	// For Grafana Cloud, prefer TRACES-specific endpoint (includes /v1/traces)
	// Fall back to generic endpoint (we'll append /v1/traces)
	const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
	const genericEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	const serviceName = process.env.OTEL_SERVICE_NAME || "ag-ui-middleware";
	const serviceVersion = process.env.npm_package_version || "0.1.0";
	const debugEnabled = process.env.OTEL_DEBUG === "true";

	// Enable debug logging if requested
	if (debugEnabled) {
		diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
	}

	const resource = new Resource({
		[ATTR_SERVICE_NAME]: serviceName,
		[ATTR_SERVICE_VERSION]: serviceVersion,
		"deployment.environment": process.env.NODE_ENV || "development",
	});

	if (!tracesEndpoint && !genericEndpoint) {
		console.log(
			"[OTEL] No OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT set, telemetry export disabled",
		);
		console.log("[OTEL] Trace context propagation still active");

		// Still initialize SDK for context propagation, just without exporter
		sdk = new NodeSDK({
			resource,
			instrumentations: [
				new HttpInstrumentation({
					// Propagate trace context to outgoing requests
					requestHook: (span, request) => {
						// Add custom attributes - check for ClientRequest which has path
						if ("path" in request && typeof request.path === "string") {
							span.setAttribute("http.path", request.path);
						}
					},
				}),
				new ExpressInstrumentation({
					// Capture route info
					requestHook: (span, info) => {
						if (info.route) {
							span.setAttribute("express.route", info.route);
						}
					},
				}),
			],
		});

		sdk.start();

		// Initialize metrics with a no-op meter provider (for local dev without export)
		initHttpMetrics(serviceName);

		console.log(`[OTEL] SDK initialized (${serviceName} v${serviceVersion})`);
		return;
	}

	// Parse OTLP headers
	const headers = parseOtlpHeaders();

	// Determine the final URL for traces
	// If TRACES_ENDPOINT is set, use it directly (it should include /v1/traces)
	// Otherwise, append /v1/traces to the generic endpoint
	const traceExportUrl = tracesEndpoint || `${genericEndpoint}/v1/traces`;

	// Full initialization with OTLP exporter
	const traceExporter = new OTLPTraceExporter({
		url: traceExportUrl,
		headers: Object.keys(headers).length > 0 ? headers : undefined,
	});

	sdk = new NodeSDK({
		resource,
		traceExporter,
		instrumentations: [
			new HttpInstrumentation({
				requestHook: (span, request) => {
					if ("path" in request && typeof request.path === "string") {
						span.setAttribute("http.path", request.path);
					}
				},
			}),
			new ExpressInstrumentation({
				requestHook: (span, info) => {
					if (info.route) {
						span.setAttribute("express.route", info.route);
					}
				},
			}),
		],
	});

	sdk.start();
	console.log(`[OTEL] Tracing initialized (${serviceName} v${serviceVersion})`);
	console.log(`[OTEL] Exporting traces to: ${traceExportUrl}`);

	// Initialize metrics with OTLP exporter
	initMeterProvider(resource, genericEndpoint, headers);
	initHttpMetrics(serviceName);

	// Setup graceful shutdown
	const shutdown = async (): Promise<void> => {
		console.log("[OTEL] Shutting down...");
		try {
			// Shutdown MeterProvider first to flush metrics
			if (meterProvider) {
				await meterProvider.shutdown();
				console.log("[OTEL] MeterProvider shut down successfully");
			}
			await sdk?.shutdown();
			console.log("[OTEL] SDK shut down successfully");
		} catch (error) {
			console.error("[OTEL] Shutdown error:", error);
		}
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

/**
 * Shutdown the OpenTelemetry SDK and MeterProvider
 *
 * Call this before process exit to ensure all spans and metrics are flushed.
 */
export async function shutdownOtel(): Promise<void> {
	// Shutdown MeterProvider first to flush metrics
	if (meterProvider) {
		await meterProvider.shutdown();
		meterProvider = null;
		httpServerMetrics = null;
	}

	if (sdk) {
		await sdk.shutdown();
		sdk = null;
	}
}

/**
 * Check if OTEL is initialized
 */
export function isOtelInitialized(): boolean {
	return sdk !== null;
}
