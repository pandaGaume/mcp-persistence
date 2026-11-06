# mcp-persistence

Never use the U+2014 character in files or replies.

Read README.md and docs/brief_persistence_slot.md first. The README describes current behavior; the brief records the initial design. This is an initial implementation. Keep guarantees tied to tests and mark planned behavior clearly.

Development explicitly uses --dev and openGuard on loopback. Normal startup uses BrokerAccessGuard and must never fall back to openGuard. The broker HOWTO.md describes the transition through auth.dev to production OAuth.

Follow mcp-vault, mcp-cache and mcp-history for the store, behavior, slot client and reusable conformance pattern. Use mcp-core, mcp-broker-provider and mcp-uns; reuse broker authorization and UNS conventions. Do not introduce a transport or policy engine.

Keep application schemas, migrations and scene restoration in the consuming applications. Never turn client identifiers into physical paths. Test durability, concurrency, idempotence, crash recovery and authorization with a real broker before claiming these guarantees.
