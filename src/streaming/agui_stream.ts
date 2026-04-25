import { EventEmitter } from "node:events";
import type { Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { type BaseEvent, EventType } from "../agents/rig_abstract_agent";

/**
 * Identifies the streaming protocol used by a session.
 *
 * Currently only AG-UI (REST + SSE) is supported.
 */
export enum StreamType {
	AG_UI = "agui",
}

/**
 * Represents an active SSE connection to a client.
 *
 * Each stream session tracks the underlying HTTP response, the associated
 * run/thread identifiers, and connection liveness metadata used by the
 * heartbeat mechanism.
 */
export interface StreamSession {
	/** Unique identifier for this stream session. */
	id: string;
	/** The streaming protocol in use (always AG-UI for now). */
	type: StreamType;
	/** The Express response object used to write SSE data. */
	response: Response;
	/** The AG-UI run identifier associated with this stream. */
	runId?: string;
	/** The conversation thread this stream belongs to. */
	threadId?: string;
	/** An optional client-provided identifier (e.g. agent ID). */
	clientId?: string;
	/** Epoch timestamp (ms) when the session was created. */
	startTime: number;
	/** Epoch timestamp (ms) of the most recent activity on the session. */
	lastActivity: number;
	/** Whether the session is still open and writable. */
	isActive: boolean;
}

/**
 * Manages Server-Sent Event (SSE) streams for the AG-UI protocol.
 *
 * Responsibilities:
 * - Creating new SSE connections and configuring HTTP headers.
 * - Sending AG-UI events to individual sessions or broadcasting to many.
 * - Maintaining connection liveness via periodic heartbeats.
 * - Cleaning up stale sessions that exceed the inactivity threshold.
 *
 * @example
 * ```typescript
 * const handler = new AguiStreamHandler();
 * const sessionId = handler.createAguiStream(res, runId, threadId);
 * handler.sendAguiEvent(sessionId, event);
 * ```
 */
export class AguiStreamHandler extends EventEmitter {
	private activeSessions: Map<string, StreamSession> = new Map();
	private heartbeatInterval: NodeJS.Timeout | null = null;
	private keepaliveInterval: NodeJS.Timeout | null = null;

	constructor() {
		super();
		this.startHeartbeat();
		this.startKeepalive();
	}

	/**
	 * Create a new SSE stream session for the AG-UI protocol.
	 *
	 * Sets the required `text/event-stream` headers on the response, sends an
	 * initial `RUN_STARTED` connection event, and registers the session for
	 * heartbeat monitoring and automatic cleanup on client disconnect.
	 *
	 * @param response - The Express response to write SSE data to.
	 * @param runId - The AG-UI run identifier for this stream.
	 * @param threadId - Optional conversation thread identifier.
	 * @param clientId - Optional client-provided identifier (e.g. agent ID).
	 * @returns The unique session ID for the newly created stream.
	 */
	public createAguiStream(
		response: Response,
		runId: string,
		threadId?: string,
		clientId?: string,
	): string {
		const sessionId = uuidv4();

		// Configure SSE headers
		response.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Headers": "Cache-Control",
		});

		// NOTE: Do NOT send RUN_STARTED here — the Rig agent/SessionBridge
		// forwards its own RUN_STARTED event. Sending it here would cause a
		// duplicate that violates the AG-UI protocol verifier.

		// Create session
		const session: StreamSession = {
			id: sessionId,
			type: StreamType.AG_UI,
			response,
			runId,
			threadId,
			clientId,
			startTime: Date.now(),
			lastActivity: Date.now(),
			isActive: true,
		};

		this.activeSessions.set(sessionId, session);

		// Handle client disconnect
		response.on("close", () => {
			this.closeSession(sessionId);
		});

		return sessionId;
	}

	/**
	 * Send an AG-UI event to a specific stream session.
	 *
	 * The event is written as a bare SSE `data:` frame (no named event type),
	 * matching the V2 protocol expectation. Event fields are flattened so that
	 * type-specific properties appear at the top level alongside `type`.
	 *
	 * @param sessionId - The target stream session ID.
	 * @param event - The AG-UI protocol event to send.
	 * @returns `true` if the event was written successfully, `false` otherwise.
	 */
	public sendAguiEvent(sessionId: string, event: BaseEvent): boolean {
		const session = this.activeSessions.get(sessionId);

		if (!session || !session.isActive || session.type !== StreamType.AG_UI) {
			return false;
		}

		try {
			this.writeV2SSEEvent(session.response, event);
			session.lastActivity = Date.now();
			return true;
		} catch (_error) {
			this.closeSession(sessionId);
			return false;
		}
	}

	/**
	 * Broadcast an AG-UI event to all active AG-UI stream sessions.
	 *
	 * An optional filter function can narrow the set of target sessions
	 * (e.g. to only those belonging to a particular thread).
	 *
	 * @param event - The AG-UI protocol event to broadcast.
	 * @param filter - Optional predicate to select which sessions receive the event.
	 * @returns The number of sessions that successfully received the event.
	 */
	public broadcastAguiEvent(
		event: BaseEvent,
		filter?: (session: StreamSession) => boolean,
	): number {
		let successCount = 0;

		for (const [sessionId, session] of this.activeSessions) {
			if (session.type === StreamType.AG_UI && session.isActive) {
				if (!filter || filter(session)) {
					if (this.sendAguiEvent(sessionId, event)) {
						successCount++;
					}
				}
			}
		}

		return successCount;
	}

	/**
	 * Close a specific stream session.
	 *
	 * Sends a final `RUN_FINISHED` / close event, ends the HTTP response,
	 * removes the session from the active map, and emits a `session_closed`
	 * event on this handler.
	 *
	 * @param sessionId - The stream session ID to close.
	 */
	public closeSession(sessionId: string): void {
		const session = this.activeSessions.get(sessionId);

		if (session) {
			session.isActive = false;

			try {
				// Send close event before ending the stream (V2 bare data: format)
				const closeEvent: BaseEvent = {
					type: EventType.RUN_FINISHED,
					threadId: session.threadId,
					runId: session.runId,
					timestamp: Date.now(),
					data: {
						sessionId,
						reason: "client_disconnect",
					},
				};
				this.writeV2SSEEvent(session.response, closeEvent);

				// End the response
				session.response.end();
			} catch (_error) {
				// Ignore errors when closing
			}

			this.activeSessions.delete(sessionId);
			this.emit("session_closed", { sessionId, session });
		}
	}

	/**
	 * Close every active stream session (e.g. during server shutdown).
	 */
	public closeAllSessions(): void {
		for (const sessionId of this.activeSessions.keys()) {
			this.closeSession(sessionId);
		}
	}

	/**
	 * Retrieve metadata for a single stream session.
	 *
	 * @param sessionId - The stream session ID to look up.
	 * @returns The session object, or `undefined` if not found.
	 */
	public getSessionInfo(sessionId: string): StreamSession | undefined {
		return this.activeSessions.get(sessionId);
	}

	/**
	 * Return all tracked stream sessions (both active and recently closed).
	 */
	public getAllSessions(): StreamSession[] {
		return Array.from(this.activeSessions.values());
	}

	/**
	 * Return all active sessions that match the given stream type.
	 *
	 * @param type - The {@link StreamType} to filter by.
	 */
	public getSessionsByType(type: StreamType): StreamSession[] {
		return Array.from(this.activeSessions.values()).filter(
			(session) => session.type === type && session.isActive,
		);
	}

	/**
	 * Return all active sessions associated with a given thread.
	 *
	 * @param threadId - The conversation thread identifier.
	 */
	public getSessionsByThreadId(threadId: string): StreamSession[] {
		return Array.from(this.activeSessions.values()).filter(
			(session) => session.threadId === threadId && session.isActive,
		);
	}

	/**
	 * Write a V2-compliant SSE event frame to an HTTP response.
	 *
	 * V2 protocol uses bare `data:` lines (no named `event:` field).
	 * Event fields are flattened: `data` properties are spread to the
	 * top level alongside `type`, `threadId`, `runId`, etc.
	 *
	 * @param response - The Express response to write to.
	 * @param event - The AG-UI BaseEvent to flatten and send.
	 */
	private writeV2SSEEvent(response: Response, event: BaseEvent): void {
		// Flatten: spread data fields to top level, remove nested data key
		const { data, ...rest } = event;
		const flat = { ...rest, ...data };
		response.write(`data: ${JSON.stringify(flat)}\n\n`);
	}

	/**
	 * Start the SSE comment keepalive timer.
	 *
	 * Every 2 seconds, write a `: keepalive` comment line to all active sessions.
	 * SSE comments are ignored by EventSource but prevent idle-connection timeouts
	 * from load balancers and WebKit (which drops streams after ~5s of silence).
	 */
	private startKeepalive(): void {
		this.keepaliveInterval = setInterval(() => {
			for (const [sessionId, session] of this.activeSessions) {
				if (session.isActive) {
					try {
						session.response.write(": keepalive\n\n");
					} catch (_error) {
						this.closeSession(sessionId);
					}
				}
			}
		}, 2000);
	}

	/**
	 * Start the periodic heartbeat timer.
	 *
	 * Every 10 seconds, each active session receives an `AGENT_STATUS_UPDATE`
	 * heartbeat event. Sessions that have been inactive for longer than
	 * 5 minutes are automatically closed.
	 */
	private startHeartbeat(): void {
		this.heartbeatInterval = setInterval(() => {
			const now = Date.now();
			const staleThreshold = 5 * 60 * 1000; // 5 minutes

			for (const [sessionId, session] of this.activeSessions) {
				if (session.isActive) {
					if (now - session.lastActivity > staleThreshold) {
						this.closeSession(sessionId);
						continue;
					}

					try {
						const heartbeatEvent: BaseEvent = {
							type: EventType.AGENT_STATUS_UPDATE,
							threadId: session.threadId,
							runId: session.runId,
							timestamp: now,
							data: {
								heartbeat: true,
								sessionId,
							},
						};
						this.writeV2SSEEvent(session.response, heartbeatEvent);
					} catch (_error) {
						this.closeSession(sessionId);
					}
				}
			}
		}, 10000);
	}

	/**
	 * Stop the heartbeat timer, close all sessions, and remove all listeners.
	 *
	 * Call this during graceful shutdown to release resources.
	 */
	public destroy(): void {
		if (this.keepaliveInterval) {
			clearInterval(this.keepaliveInterval);
			this.keepaliveInterval = null;
		}
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}

		this.closeAllSessions();
		this.removeAllListeners();
	}
}
