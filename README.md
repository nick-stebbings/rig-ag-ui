# @rig-ag-ui/middleware

AG-UI/CopilotKit ↔ Rig backend protocol bridge. Translates CopilotKit V2 REST+SSE requests into Rig backend API calls, manages agent session lifecycles, streams AG-UI protocol events back to clients, and forwards workflow state updates for `useCoAgent` integration.

## Rig Backend API Contract

The middleware expects the following endpoints on the Rig backend. Configure the backend root with `RIG_API_BASE_URL` and, when needed, a shared prefix with `RIG_API_PATH` (default: `/internal/rig`).

| Method | Path | Description |
|--------|------|-------------|
| POST | `{RIG_API_PATH}/sessions` | Create a new agent session |
| POST | `{RIG_API_PATH}/sessions/:id/messages` | Send a message; returns an SSE stream |
| POST | `{RIG_API_PATH}/sessions/:id/interrupt` | Interrupt a running session |

### SSE stream format from `/messages`

Each line emitted by the backend during a run:

| Line | Description |
|------|-------------|
| `data: {"type":"text","content":"..."}` | Text chunk to stream to the client |
| `data: __STATE_UPDATE__{"key":"value"}` | Workflow state update (forwarded as AG-UI `STATE_SNAPSHOT`) |
| `data: [DONE]` | Stream complete — middleware closes the SSE connection |

## Configuration (`RigAgentAppConfig`)

The built-in configuration is a reference implementation for a Rig backend. To adapt the middleware for a different deployment, supply a custom `RigAgentAppConfig`:

```typescript
import { RigAbstractAgent } from '@rig-ag-ui/middleware'
import type { RigAgentAppConfig } from '@rig-ag-ui/middleware'

const appConfig: RigAgentAppConfig = {
  // Map a workflow/display name to a CopilotKit agent identifier
  workflowNameMapper: (name) => name.toLowerCase().replace(/\s+/g, '-') + '-agent',

  // Categorise a progress message string into a phase label
  progressCategorizer: (message) => {
    if (message.includes('generat')) return 'ai-generation'
    return 'setup'
  },

  // Factory for the initial agent state shape sent to useCoAgent
  createInitialWorkflowState: () => ({
    status: 'idle',
    progress: { currentStep: 0, totalSteps: 1, currentActivity: '' },
  }),

  // Optional: fire-and-forget durable session initializer
  durableSessionInitializer: ({ rigApiBaseUrl, executionId, workflowName }) => {
    // persist session metadata to your own storage
  },
}

const agent = new RigAbstractAgent({
  agentId: 'my-agent',
  rigApiBaseUrl: process.env.RIG_API_BASE_URL,
  appConfig,
})
```

The `EXAMPLE_APP_CONFIG` export from `src/config/example-app-config.ts` is the default reference implementation of `RigAgentAppConfig` used when running the server standalone.

## Environment Variables

All variables are read at startup. Copy `.env.example` as a starting point.

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Node environment (`development` enables request logging) |
| `PORT` | `3001` | Port the middleware listens on |
| `LOG_LEVEL` | `info` | Winston log level (`debug`, `info`, `warn`, `error`) |
| `RIG_API_BASE_URL` | `http://localhost:8080` | Base URL of the Rig backend host |
| `RIG_API_PATH` | `/internal/rig` | Optional shared path prefix prepended before `/sessions` endpoints |
| `AGUI_API_KEY` | `development-key` | API key clients must send in the `x-api-key` header |
| `AGENT_REGISTRY` | *(unset)* | Static JSON object mapping agent IDs to metadata; returned by `/copilotkit/info` |
| `AGENT_DISCOVERY_URL` | *(unset)* | Optional discovery endpoint the middleware queries for agent metadata |
| `AGENT_DISCOVERY_HEADERS` | *(unset)* | Optional JSON object of HTTP headers used for `AGENT_DISCOVERY_URL` requests |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins, or `*` to allow all |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate-limit window in milliseconds (15 minutes) |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Max requests per IP per window |
| `OTEL_SERVICE_NAME` | `ag-ui-middleware` | Service name for OpenTelemetry traces |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(unset)* | OTLP endpoint for trace export (e.g. `http://localhost:4318`); leave empty to disable |
| `OTEL_EXPORTER_OTLP_HEADERS` | *(unset)* | OTLP auth headers (e.g. `Authorization=Basic <base64>`) |
| `OTEL_DEBUG` | `false` | Enable verbose OpenTelemetry debug logging |

## Middleware endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | none | Health check — returns Rig backend connectivity and session stats |
| GET | `/copilotkit/info` | none | Agent registry info (CopilotKit bootstrap) |
| POST | `/copilotkit` | API key | CopilotKit V2 single-endpoint transport |
| POST | `/copilotkit/agent/:agentId/run` | API key | CopilotKit V2 multi-endpoint: start agent run, returns SSE |
| POST | `/copilotkit/agent/:agentId/connect` | API key | Connect to an existing run stream |
| POST | `/copilotkit/agent/:agentId/stop/:threadId` | API key | Stop a run |
| GET | `/copilotkit/agent/:agentId/events/:streamSessionId` | API key | Subscribe to deferred SSE stream |
| POST | `/agents/:agentId/run` | API key | Internal AG-UI agent run endpoint |
| POST | `/agents/:agentId/interrupt` | API key | Interrupt an in-flight agent run |
| GET | `/sessions` | API key | List active sessions |
| GET | `/sessions/:sessionId/state` | API key | Get session state |

Authentication is via the `x-api-key` header, which must match `AGUI_API_KEY`.

## Agent Discovery

The middleware core does not assume any platform-specific agent catalog endpoint. To populate `/copilotkit/info`, configure either `AGENT_REGISTRY` or `AGENT_DISCOVERY_URL`.

Static registry:

```env
AGENT_REGISTRY={"research-assistant-agent":{"description":"Answer research questions using your backend tools"}}
```

Dynamic discovery endpoints are fetched and cached for 60 seconds. They may return either a tool list:

```json
{"tools":[{"name":"search-documents","bundle_id":"research-assistant","description":"Answer research questions using your backend tools"}]}
```

or an agent map:

```json
{"agents":{"research-assistant-agent":{"description":"Answer research questions using your backend tools"}}}
```

If the discovery endpoint needs authentication, set `AGENT_DISCOVERY_HEADERS` to a JSON object of request headers.

## Running standalone

```bash
pnpm install
cp .env.example .env
# Edit .env — at minimum set RIG_API_BASE_URL and AGUI_API_KEY
pnpm dev
```

For production:

```bash
pnpm build
pnpm start
```

The server starts on `http://0.0.0.0:${PORT}` (default `3001`). Check `GET /health` to verify the Rig backend is reachable.

### Common local configurations

For a backend that already includes the Rig path in the base URL:

```env
RIG_API_BASE_URL=http://localhost:8080/internal/rig
RIG_API_PATH=
```

For a backend that exposes the Rig routes under a shared prefix:

```env
RIG_API_BASE_URL=http://localhost:8080
RIG_API_PATH=/internal/rig
```
