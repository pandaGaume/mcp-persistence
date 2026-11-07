/** Backend-independent wire contract. Generate contracts/persistence.v1.json from these definitions. */
type Schema = Record<string, unknown>;
const string: Schema = { type: "string", minLength: 1, maxLength: 256 };
const segment: Schema = { type: "string", pattern: "^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$", maxLength: 128 };
const revision: Schema = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const expectedRevision: Schema = { ...revision, minimum: 0 };
const date: Schema = { type: "string", format: "date-time" };
const key: Schema = { ...string, maxLength: 128 };
const mimeType: Schema = { type: "string", maxLength: 128, pattern: "^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$" };
const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });
function object(properties: Record<string, Schema>, required = Object.keys(properties)) { return { type: "object", properties, required, additionalProperties: false }; }
const location = { namespace: segment, id: segment };
const page = { limit: { type: "integer", minimum: 1, maximum: 200 }, cursor: { type: "string", minLength: 1, maxLength: 4096 } };
const finish = { namespace: segment, uploadId: segment, idempotencyKey: key };
const metadata = { revision, managed: { type: "boolean" }, createdAt: date, updatedAt: date };
const server = { id: segment, driver: segment, host: { type: "string", minLength: 1, maxLength: 253 }, port: { type: "integer", minimum: 1, maximum: 65535 }, credentialsRef: ref("VaultSecretReference") };
const database = { id: segment, serverId: segment, name: segment, credentialsRef: ref("VaultSecretReference") };
const errorCodes = ["not_found", "revision_conflict", "idempotency_conflict", "policy_denied", "quota_exceeded", "transfer_incomplete", "integrity_error", "invalid_request", "unsupported_format", "retention_blocked", "busy", "store_unavailable"];
export const PERSISTENCE_DEFINITIONS: Record<string, Schema> = {
    Json: { anyOf: [{ type: "null" }, { type: "boolean" }, { type: "number" }, { type: "string" }, { type: "array", items: ref("Json") }, { type: "object", additionalProperties: ref("Json") }] },
    Reference: { oneOf: [object({ type: { const: "document" }, ...location, revision }), object({ type: { const: "artifact" }, ...location })] },
    Hash: object({ algorithm: { const: "sha256" }, value: { type: "string", pattern: "^[a-f0-9]{64}$" } }),
    Document: object({ ...location, kind: string, schemaVersion: string, revision, createdAt: date, updatedAt: date, deleted: { type: "boolean" }, payload: ref("Json"), references: { type: "array", maxItems: 256, items: ref("Reference") } }),
    Artifact: object({ ...location, mimeType, size: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, hash: ref("Hash"), createdAt: date, provenance: ref("Json") }),
    Upload: object({ namespace: segment, artifactId: segment, uploadId: segment, expiresAt: date }),
    DocumentPage: object({ items: { type: "array", maxItems: 200, items: ref("Document") }, nextCursor: page.cursor }, ["items"]),
    Capabilities: object({ contract: { const: "persistence.v1" }, durability: { enum: ["file-sync", "file-and-directory-sync"] }, limits: object(Object.fromEntries(["maxDocumentBytes", "maxArtifactBytes", "maxReferences", "maxPageSize", "maxNamespaceBytes", "idempotencyRetentionSeconds"].map(k => [k, { type: "integer", minimum: 1 }]))) }),
    Acknowledgement: object({ ok: { const: true } }),
    Error: object({ error: object({ code: { enum: errorCodes }, message: { type: "string" } }) }),
    VaultSecretReference: object({ slot: segment, path: { type: "string", minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}(/[A-Za-z0-9_][A-Za-z0-9._-]{0,127})*$" }, version: revision }, ["slot", "path"]),
    Server: object({ ...server, ...metadata }, ["id", "driver", ...Object.keys(metadata)]),
    Database: object({ ...database, ...metadata }, ["id", "serverId", "name", ...Object.keys(metadata)]),
    ServerPage: object({ items: { type: "array", maxItems: 200, items: ref("Server") }, nextCursor: page.cursor }, ["items"]),
    DatabasePage: object({ items: { type: "array", maxItems: 200, items: ref("Database") }, nextCursor: page.cursor }, ["items"]),
    CredentialsCheck: { oneOf: [
        object({ target: { enum: ["server", "database"] }, id: segment, available: { const: false } }),
        object({ target: { enum: ["server", "database"] }, id: segment, available: { const: true }, source: { enum: ["server", "database"] }, credentialsRef: ref("VaultSecretReference"), version: revision, kind: { enum: ["keys", "file"] } }),
    ] },
};
export const PERSISTENCE_TOOL_DESCRIPTIONS: Record<string, string> = {
    capabilities: "Read protocol limits and durability guarantees.",
    get: "Read a document head or an immutable revision.", put: "Create or update with expectedRevision and an idempotency key.",
    list: "List documents you may read, with bounded pagination.", listRevisions: "List immutable revisions of a document you may read.",
    delete: "Add a tombstone; keep history and referenced files.", purge: "Permanently purge an unreferenced revision or artifact after retention.",
    beginArtifact: "Reserve an upload. Transfer bytes over the authenticated HTTP endpoint.",
    commitArtifact: "Verify and publish a completed upload atomically.", abortArtifact: "Abort an inactive upload.",
    getArtifact: "Read artifact metadata; bytes use the authenticated HTTP endpoint.",
    uploadAccess: "Authorize an upload stream and read its target metadata. Used by the transfer endpoint.",
    "server.register": "Declare or update a server with vault references only. PostgreSQL and MySQL document backends are selected using databaseId on document calls.",
    "server.get": "Read a server declaration, never secret values or physical paths.",
    "server.list": "List readable server declarations, including the startup-managed local server.",
    "database.register": "Declare or update a database attached to an existing server. Store a vault reference, never credentials.",
    "database.get": "Read a database declaration, never secret values.",
    "database.list": "List readable database declarations, optionally filtered by server.",
    "credentials.check": "Resolve a configured vault reference with the persistence service identity. Return availability and version, never secret content. This does not connect to a database.",
};
const inputs: Record<string, { input: ReturnType<typeof object>; result: string }> = {
    capabilities: { input: object({}), result: "Capabilities" },
    get: { input: object({ ...location, revision }, ["namespace", "id"]), result: "Document" },
    put: { input: object({ ...location, expectedRevision, kind: string, schemaVersion: string, payload: ref("Json"), references: { type: "array", maxItems: 256, items: ref("Reference") }, idempotencyKey: key }), result: "Document" },
    list: { input: object({ namespace: segment, kind: string, includeDeleted: { type: "boolean" }, ...page }, ["namespace"]), result: "DocumentPage" },
    listRevisions: { input: object({ ...location, ...page }, ["namespace", "id"]), result: "DocumentPage" },
    delete: { input: object({ ...location, expectedRevision: revision, idempotencyKey: key }), result: "Document" },
    purge: { input: object({ namespace: segment, target: { oneOf: [object({ type: { const: "document" }, id: segment, revision }), object({ type: { const: "artifact" }, id: segment })] }, idempotencyKey: key }), result: "Acknowledgement" },
    beginArtifact: { input: object({ namespace: segment, mimeType, size: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, hash: ref("Hash"), provenance: ref("Json"), idempotencyKey: key }), result: "Upload" },
    commitArtifact: { input: object(finish), result: "Artifact" },
    abortArtifact: { input: object(finish), result: "Acknowledgement" },
    uploadAccess: { input: object({ namespace: segment, uploadId: segment }), result: "Upload" },
    getArtifact: { input: object(location), result: "Artifact" },
    "server.register": { input: object({ ...server, expectedRevision, idempotencyKey: key }, ["id", "driver", "expectedRevision", "idempotencyKey"]), result: "Server" },
    "server.get": { input: object({ id: segment }), result: "Server" },
    "server.list": { input: object(page, []), result: "ServerPage" },
    "database.register": { input: object({ ...database, expectedRevision, idempotencyKey: key }, ["id", "serverId", "name", "expectedRevision", "idempotencyKey"]), result: "Database" },
    "database.get": { input: object({ id: segment }), result: "Database" },
    "database.list": { input: object({ serverId: segment, ...page }, []), result: "DatabasePage" },
    "credentials.check": { input: object({ target: { enum: ["server", "database"] }, id: segment }), result: "CredentialsCheck" },
};
/** Plain MCP tools/list descriptors, including inputSchema and outputSchema. */
function withDefinitions<T extends Schema>(schema: T): T & { $defs: Record<string, Schema> } {
    const definitions: Record<string, Schema> = {};
    const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        const node = value as Record<string, unknown>;
        if (typeof node.$ref === "string" && node.$ref.startsWith("#/$defs/")) {
            const name = node.$ref.slice(8);
            if (!Object.hasOwn(definitions, name)) { definitions[name] = PERSISTENCE_DEFINITIONS[name]!; visit(definitions[name]); }
        }
        for (const child of Object.values(node)) visit(child);
    };
    visit(schema);
    return { ...schema, $defs: definitions };
}
export const PERSISTENCE_TOOLS = Object.entries(inputs).map(([name, definition]) => ({
    name: `persistence.${name}`, description: PERSISTENCE_TOOL_DESCRIPTIONS[name]!,
    inputSchema: withDefinitions(["get", "put", "list", "listRevisions", "delete", "purge"].includes(name) ? { ...definition.input, properties: { ...definition.input.properties, databaseId: segment } } : definition.input),
    outputSchema: withDefinitions({ type: "object", anyOf: [ref(definition.result), ref("Error")] }),
}));
export const PERSISTENCE_RESOURCE_TEMPLATES = [
    { uriTemplate: "persistence://documents/{namespace}/{id}", name: "Document head", mimeType: "application/json" },
    { uriTemplate: "persistence://documents/{namespace}/{id}/revisions/{revision}", name: "Pinned document revision", mimeType: "application/json" },
    { uriTemplate: "persistence://artifacts/{namespace}/{id}", name: "Artifact metadata", mimeType: "application/json" },
    { uriTemplate: "persistence://servers/{id}", name: "Server declaration", mimeType: "application/json" },
    { uriTemplate: "persistence://databases/{id}", name: "Database declaration", mimeType: "application/json" },
    { uriTemplate: "persistence://databases/{databaseId}/documents/{namespace}/{id}", name: "Selected database document", mimeType: "application/json" },
    { uriTemplate: "persistence://databases/{databaseId}/documents/{namespace}/{id}/revisions/{revision}", name: "Selected database revision", mimeType: "application/json" },
];
export const PERSISTENCE_PROTOCOL = {
    contract: "persistence.v1", revision: 2,
    tools: PERSISTENCE_TOOLS,
    resources: [{ uri: "persistence://capabilities", name: "Persistence capabilities", mimeType: "application/json", description: PERSISTENCE_TOOL_DESCRIPTIONS.capabilities! }],
    resourceTemplates: PERSISTENCE_RESOURCE_TEMPLATES,
    transfer: {
        authentication: "The same bearer as the MCP client; every request is reauthorized through the broker. No reusable bearer URLs.",
        routes: [
            { method: "PUT", path: "/uploads/{namespace}/{uploadId}", request: "application/octet-stream raw bytes", success: 204, precondition: "beginArtifact; uploadAccess authorization" },
            { method: "GET", path: "/artifacts/{namespace}/{id}", response: "raw bytes with stored MIME type and Content-Length", success: 200, precondition: "committed artifact; getArtifact authorization" },
        ],
        errors: { 400: ["invalid_request", "transfer_incomplete", "integrity_error"], 403: ["policy_denied"], 404: ["not_found"], 413: ["quota_exceeded"], 500: ["store_unavailable", "busy"] },
    },
};
