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
};
/** Plain MCP tools/list descriptors, including inputSchema and outputSchema. */
export const PERSISTENCE_TOOLS = Object.entries(inputs).map(([name, definition]) => ({
    name: `persistence.${name}`, description: PERSISTENCE_TOOL_DESCRIPTIONS[name]!,
    inputSchema: { ...definition.input, $defs: PERSISTENCE_DEFINITIONS },
    outputSchema: { type: "object", anyOf: [ref(definition.result), ref("Error")], $defs: PERSISTENCE_DEFINITIONS },
}));
export const PERSISTENCE_RESOURCE_TEMPLATES = [
    { uriTemplate: "persistence://documents/{namespace}/{id}", name: "Document head", mimeType: "application/json" },
    { uriTemplate: "persistence://documents/{namespace}/{id}/revisions/{revision}", name: "Pinned document revision", mimeType: "application/json" },
    { uriTemplate: "persistence://artifacts/{namespace}/{id}", name: "Artifact metadata", mimeType: "application/json" },
];
export const PERSISTENCE_PROTOCOL = {
    contract: "persistence.v1", revision: 1,
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
