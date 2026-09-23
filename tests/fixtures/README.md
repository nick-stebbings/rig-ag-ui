# Frontend tool transport

`frontend-tool-transport.json` is a conformance fixture from
`@agentiffai/workflow-contracts/wire/frontend-tool-transport.json`.
It contains generic transport fields. The middleware has no runtime dependency
on that package or any Agentiff workflow.

The HTTP tests use its prefixes and advertised tool name. They prove that a
call reaches CopilotKit once and returns a result with the original call ID.
They cover direct and deferred streams and a split UTF-8 event.

Keep the fixture byte-identical when updating the shared contract.
