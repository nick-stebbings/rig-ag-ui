/**
 * @module index
 *
 * Entry point for the AG-UI middleware server.
 *
 * Initialises environment variables and OpenTelemetry instrumentation
 * **before** any other imports so that HTTP and Express are properly
 * patched for distributed tracing. Then starts the Express server and
 * registers graceful shutdown handlers for SIGTERM/SIGINT.
 */

// IMPORTANT: Load env vars and initialize OTEL BEFORE any other imports
// This ensures HTTP and Express are properly instrumented
import dotenv from "dotenv";

dotenv.config();

import { initOtel, shutdownOtel } from "./tracing/otel";

initOtel();

// Now import other modules (after OTEL is initialized)
import winston from "winston";
import { AguiMiddlewareApp } from "./app";

// Configure logger
const logger = winston.createLogger({
	level: process.env.LOG_LEVEL || "info",
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.errors({ stack: true }),
		winston.format.json(),
	),
	transports: [
		new winston.transports.Console({
			format: winston.format.combine(
				winston.format.colorize(),
				winston.format.simple(),
			),
		}),
	],
});

const PORT = Number.parseInt(process.env.PORT || "3001", 10);
const RIG_API_BASE_URL =
	process.env.RIG_API_BASE_URL || "http://localhost:8080";
const RIG_API_PATH = process.env.RIG_API_PATH || "/internal/rig";
const RIG_API_URL = `${RIG_API_BASE_URL}${RIG_API_PATH}`;

/**
 * Initialize and start the AG-UI Middleware application.
 *
 * Creates the {@link AguiMiddlewareApp}, registers shutdown handlers,
 * and begins listening on the configured port.
 */
async function startServer(): Promise<void> {
	try {
		logger.info("=== AG-UI Middleware Startup Beginning ===");
		logger.info(`Environment: NODE_ENV=${process.env.NODE_ENV}`);
		logger.info(`Port: ${PORT}`);
		logger.info(`Rig API URL: ${RIG_API_URL}`);
		logger.info(`Log Level: ${process.env.LOG_LEVEL || "info"}`);
		logger.info(`Allowed Origins: ${process.env.ALLOWED_ORIGINS || "*"}`);

		logger.info("Step 1: Creating AguiMiddlewareApp instance...");
		const middlewareApp = new AguiMiddlewareApp({ rigApiBaseUrl: RIG_API_URL });
		logger.info("Step 1: ✓ AguiMiddlewareApp instance created");

		logger.info("Step 2: Setting up graceful shutdown handlers...");
		// Setup graceful shutdown
		const shutdown = async (): Promise<void> => {
			logger.info("Received shutdown signal, starting graceful shutdown...");
			await middlewareApp.shutdown();
			logger.info("Flushing OpenTelemetry traces...");
			await shutdownOtel();
			process.exit(0);
		};

		// Handle shutdown signals
		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);
		logger.info("Step 2: ✓ Shutdown handlers registered");

		logger.info(`Step 3: Starting server on port ${PORT}...`);
		await middlewareApp.start(PORT);
		logger.info("Step 3: ✓ Server started successfully");

		logger.info("=== AG-UI Middleware Ready ===");
		logger.info(`Listening on: http://0.0.0.0:${PORT}`);
		logger.info(`Rig API endpoint: ${RIG_API_URL}`);
		logger.info(`Health check: http://0.0.0.0:${PORT}/health`);
	} catch (error) {
		logger.error("!!! FATAL ERROR during startup !!!");
		logger.error("Error details:", error);
		if (error instanceof Error) {
			logger.error("Error message:", error.message);
			logger.error("Error stack:", error.stack);
		}
		process.exit(1);
	}
}

// Start the server
startServer();
