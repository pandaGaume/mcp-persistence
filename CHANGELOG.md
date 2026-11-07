# Changelog

## 0.3.0 - 2026-11-06

- Declare servers and databases through MCP, preserving the managed local/default SQLite startup registration.
- Resolve credential references through a separate authenticated vault client on the broker; no secrets in registration metadata.
- Store documents, revisions, references and idempotency in PostgreSQL or MySQL selected with databaseId; no automatic local fallback.
- Add per-database authorization, operator SQL endpoint allowlisting, verified TLS and persistence.v1 contract revision 2.
- Add real broker/vault and SQL integration scenarios with a reusable validation workflow.

## 0.2.0 - 2026-11-06

- Add the GitHub Actions release workflow with npm OIDC trusted publishing.
- Validate the release tag against package.json before running checks and publishing.
- Publish the initial source tree, contract documentation and examples in the dedicated repository.
- Keep the MCP wire contract at persistence.v1, revision 1.

## 0.1.0 - 2026-11-06

- Initial manual npm publication: versioned documents, SQLite and file artifacts, broker-authorized MCP tools and streaming transfers.
- Include backend-independent protocol schemas and the persistence.v1 JSON manifest.
