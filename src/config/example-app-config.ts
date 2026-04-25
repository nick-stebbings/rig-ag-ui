/**
 * Example RigAgentAppConfig — copy and customize for your Rig deployment.
 * Pass to RigAbstractAgent (or your subclass) as `appConfig`.
 *
 * This is the generic starting point. Replace the stub implementations
 * with your own domain logic as needed.
 */
import type { RigAgentAppConfig } from "../agents/rig_abstract_agent";

/**
 * Generic example configuration. All hooks return `undefined` / no-ops,
 * which causes RigAbstractAgent to fall back to its built-in defaults.
 *
 * @example Domain-specific agent mapping (see commented-out patterns below)
 * ```typescript
 * export const MY_APP_CONFIG: RigAgentAppConfig = {
 *   workflowNameMapper: (workflowName) => {
 *     if (workflowName.toLowerCase().includes('research')) return 'research-assistant-agent'
 *     return workflowName.toLowerCase().replace(/\s+/g, '-') + '-agent'
 *   },
 *   progressCategorizer: (message) => {
 *     if (message.toLowerCase().includes('generat')) return 'ai-generation'
 *     return 'setup'
 *   },
 *   createInitialWorkflowState: () => ({
 *     executionId: '',
 *     status: 'idle',
 *     proposedPosts: [],
 *   }),
 *   stateTransformer: (rawState) => {
 *     // Map platform-specific `rawState` fields into the shape your
 *     // frontend expects. rawState is the parsed object from
 *     // __STATE_UPDATE__ markers emitted by the Rig backend.
 *     //
 *     // Example: build `proposedPosts` from a `review_required` payload
 *     // const posts = (rawState.posts as unknown[]) ?? []
 *     // return { ...rawState, proposedPosts: posts.map(mapPost) }
 *     return rawState
 *   },
 *   durableSessionInitializer: async (authToken) => ({
 *     // Return metadata your Rig backend expects on session creation.
 *     // The authToken is the raw JWT (or API key) from the request.
 *     // To pass user identity, decode the token here:
 *     // Example: { userId: parseJwt(authToken).sub }
 *   }),
 * }
 * ```
 */
export const EXAMPLE_APP_CONFIG: RigAgentAppConfig = {
	workflowNameMapper: (_workflowName: string): string | undefined => {
		// Return undefined to use the default slug-based mapping:
		// `${workflowName.toLowerCase().replace(/\s+/g, '-')}-agent`
		return undefined;
	},

	progressCategorizer: (_message: string): string | undefined => {
		// Return undefined to fall back to the default category: "setup"
		return undefined;
	},

	createInitialWorkflowState: () => ({
		// Add your workflow-specific state fields here.
		// Must match what your Rig backend emits in __STATE_UPDATE__ markers.
	}),

	stateTransformer: (rawState: Record<string, unknown>) => {
		// Transform the raw state from __STATE_UPDATE__ markers into the
		// shape your frontend expects. Return rawState unchanged to pass
		// it through as-is.
		return rawState;
	},

	durableSessionInitializer: async (
		_authToken: string | undefined,
	): Promise<Record<string, unknown>> => ({
		// Return metadata your Rig backend expects on session creation.
		// To pass user identity to your Rig backend, implement this hook.
		// The authToken is available in the request context.
		// Example: { userId: parseJwt(authToken).sub }
	}),
};
