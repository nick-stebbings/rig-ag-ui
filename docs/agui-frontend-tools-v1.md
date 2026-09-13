# Frontend tool transport, version 1

Goal: let CopilotKit execute a Native tool and continue the conversation.
Native owns the accepted draft. Rig owns pending calls and durable results.
The middleware carries messages and events. It does not accept draft changes.

Start condition: Rig implements the contract in [WFL-219](https://linear.app/agentiff/issue/WFL-219).
The Native app advertises its tools for the active conversation.
This middleware work is [WFL-220](https://linear.app/agentiff/issue/WFL-220).

## Request

CopilotKit sends its Agent User Interaction Protocol (AG-UI) run request to
`POST /copilotkit/agent/:agentId/run`.
The single endpoint and deferred stream routes use the same request handler.

The middleware sends the existing Rig message request with these fields:

```ts
{
  content: "", // Empty for a final tool result. User turns keep their text.
  auth_token: "<token from the incoming Authorization header>",
  user_id: "<existing identity hook output>",
  metadata: {
    context: [
      { type: "native_setup", value: "<JSON string for the current safe draft>" }
    ],
    ag_ui: {
      version: 1,
      thread_id: "<CopilotKit threadId>",
      run_id: "<CopilotKit runId>",
      messages: [/* Full structured AG-UI messages */],
      tools: [/* Advertised name, description, and JSON Schema */],
      state: {} // Transport state. This does not create a draft store.
    }
  }
}
```

Rig must read the named `native_setup` context entry.
Rig must decode its JSON string before it validates the safe draft.
The draft view includes `draftId` and positive integer `draftRevision`.
The middleware does not extract domain fields or copy them into agent state.

Preserve assistant `toolCalls`, tool `toolCallId`, optional assistant content,
developer messages, and structured user content.
Preserve the full parameter schema, including nested definitions.
The next run can have a different `run_id`. Keep the same `thread_id`.

## Response and continuation

Rig emits this marker in a stream content field:

```text
__FRONTEND_TOOL_CALL__:{"id":"server-call-id","name":"collect_generation_inputs","arguments":{"draftId":"draft-id","draftRevision":1,"action":"select_product"}}
```

The middleware accepts `content`, `chunk.content`, or `data.chunk.content`.
The action is an example. Native defines the accepted action schema.
The other approved product tool is `choose_meta_ad_copy`.
Its arguments include three `headlines` and three `primaryTexts`.
The middleware uses the advertised tool list. Rig enforces its approved names.

1. Emit `TOOL_CALL_START` with the original call ID and tool name.
2. Emit `TOOL_CALL_ARGS` with the argument object encoded as JSON.
3. Emit `TOOL_CALL_END` with the original call ID.
4. End the current run when the Rig stream ends.
5. Let CopilotKit execute the frontend handler.
6. Let the handler return its result after Native accepts or rejects the action.
7. Forward the automatic follow-up run with its structured tool result.

Do not emit `TOOL_CALL_RESULT` for a frontend request.
Do not put a frontend call in a hidden text marker.
Repeated identical markers in one stream emit one call.
A reused ID with changed arguments causes `RUN_ERROR`.
Rig must validate pending calls and reject repeated results across requests.
Rig must bind calls to authenticated conversation ownership.
Client history is not proof of a pending call.

## Failure behavior

| State | Action |
| --- | --- |
| A tool result lacks its call ID or string content. | Return HTTP 400 before calling Rig. |
| Rig rejects a request. | Emit `RUN_ERROR`. Do not simulate a reply. |
| A frontend marker is malformed or names an unadvertised tool. | Emit `RUN_ERROR`. |
| A stream ends with an incomplete event or disconnects early. | Emit `RUN_ERROR`. |
| A server ignores the new envelope. | Empty legacy content prevents a tool result from becoming user text. |

Close direct and deferred streams after `RUN_ERROR` or `RUN_FINISHED`.
Carry internal status events as standard `CUSTOM` events.
Keep existing server tool markers and results.

## Proof

Run `pnpm exec vitest run --pool=forks --maxWorkers=1 --minWorkers=1`.
The contract test opens local HTTP servers.
It uses CopilotKit Core 1.63.1 and AG-UI client 0.0.57.
It exercises both direct and deferred streams through the real middleware.
It checks the handler wait, automatic follow-up, fresh context, call identity,
accepted results, cancellation, stale results, split UTF-8 chunks, repeated
markers, failed streams, separate conversations, and legacy server tools.

The Rig server in this test is a fixture.
Rust persistence, authenticated ownership, restart behavior, and Native device
behavior still need joint verification after WFL-219 is ready.
Nick owns shared deployment. Andrew records the Native device proof.
