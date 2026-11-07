import type { IPersistenceStore } from "../contract/persistence.store.js";
import type { IArtifact, IBeginArtifact, IDeleteDocument, IDocument, IDocumentKey, IFinishArtifact, IListDocuments, IPage, IPageRequest, IPersistenceCapabilities, IPurge, IPutDocument, IStoreContext, IUpload } from "../contract/persistence.types.js";
import { PersistenceError, type PersistenceErrorCode } from "../contract/errors.js";
import { fail, segment } from "../contract/validation.js";
import type { ICheckCredentials, ICredentialsCheck, IListDatabases, IPersistenceRegistry, IRegisteredDatabase, IRegisteredServer, IRegisterDatabase, IRegisterServer } from "../contract/configuration.types.js";

export interface ISlotClient {
    callTool(name: string, args: Record<string, unknown>): Promise<{ content?: readonly unknown[]; structuredContent?: unknown; isError?: boolean }>;
}
export function slotPayload(result: Awaited<ReturnType<ISlotClient["callTool"]>>): unknown {
    let payload = result.structuredContent;
    if (payload === undefined) {
        const block = result.content?.find(b => typeof b === "object" && b !== null && (b as { type?: string }).type === "text") as { text?: string } | undefined;
        try { payload = JSON.parse(block?.text ?? "null"); } catch { fail("integrity_error", "Malformed persistence response"); }
    }
    if (result.isError) {
        const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
        throw new PersistenceError((error?.code ?? "store_unavailable") as PersistenceErrorCode, error?.message ?? "Persistence operation failed");
    }
    return payload;
}
export interface ITransferClientOptions {
    baseUrl: string;
    /** The same bearer credentials used by the MCP client. Never sent to an arbitrary redirected URL. */
    headers?: () => Record<string, string>;
}
export class PersistenceSlotStore implements IPersistenceStore, IPersistenceRegistry {
    constructor(readonly id: string, private readonly client: ISlotClient, private readonly transfer?: ITransferClientOptions) {
        if (transfer) {
            const url = new URL(transfer.baseUrl);
            if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) fail("invalid_request", "Transfer endpoint requires HTTPS or loopback HTTP");
        }
    }
    private async call<T>(method: string, request: object, context?: IStoreContext): Promise<T> {
        context?.signal?.throwIfAborted();
        return slotPayload(await this.client.callTool(`persistence.${method}`, { ...request })) as T;
    }
    getCapabilitiesAsync(): Promise<IPersistenceCapabilities> { return this.call("capabilities", {}); }
    getAsync(r: IDocumentKey & { revision?: number }, c: IStoreContext): Promise<IDocument> { return this.call("get", { namespace: r.namespace, id: r.id, ...(r.databaseId === undefined ? {} : { databaseId: r.databaseId }), ...(r.revision === undefined ? {} : { revision: r.revision }) }, c); }
    putAsync(r: IPutDocument, c: IStoreContext): Promise<IDocument> { return this.call("put", r, c); }
    listAsync(r: IListDocuments, c: IStoreContext): Promise<IPage<IDocument>> { return this.call("list", r, c); }
    listRevisionsAsync(r: IDocumentKey & IPageRequest, c: IStoreContext): Promise<IPage<IDocument>> { return this.call("listRevisions", { namespace: r.namespace, id: r.id, ...(r.databaseId === undefined ? {} : { databaseId: r.databaseId }), ...(r.limit === undefined ? {} : { limit: r.limit }), ...(r.cursor === undefined ? {} : { cursor: r.cursor }) }, c); }
    deleteAsync(r: IDeleteDocument, c: IStoreContext): Promise<IDocument> { return this.call("delete", r, c); }
    purgeAsync(r: IPurge, c: IStoreContext): Promise<void> { return this.call("purge", r, c); }
    beginArtifactAsync(r: IBeginArtifact, c: IStoreContext): Promise<IUpload> { return this.call("beginArtifact", r, c); }
    inspectUploadAsync(namespace: string, uploadId: string, c: IStoreContext): Promise<IUpload> { return this.call("uploadAccess", { namespace, uploadId }, c); }
    commitArtifactAsync(r: IFinishArtifact, c: IStoreContext): Promise<IArtifact> { return this.call("commitArtifact", r, c); }
    abortArtifactAsync(r: IFinishArtifact, c: IStoreContext): Promise<void> { return this.call("abortArtifact", r, c); }
    getArtifactAsync(r: IDocumentKey, c: IStoreContext): Promise<IArtifact> { if (r.databaseId && r.databaseId !== "default") fail("unsupported_format", "Artifacts use the default local backend"); return this.call("getArtifact", { namespace: r.namespace, id: r.id }, c); }
    registerServerAsync(r: IRegisterServer, c: IStoreContext): Promise<IRegisteredServer> { return this.call("server.register", r, c); }
    getServerAsync(id: string, c: IStoreContext): Promise<IRegisteredServer> { return this.call("server.get", { id }, c); }
    listServersAsync(r: IPageRequest, c: IStoreContext): Promise<IPage<IRegisteredServer>> { return this.call("server.list", r, c); }
    registerDatabaseAsync(r: IRegisterDatabase, c: IStoreContext): Promise<IRegisteredDatabase> { return this.call("database.register", r, c); }
    getDatabaseAsync(id: string, c: IStoreContext): Promise<IRegisteredDatabase> { return this.call("database.get", { id }, c); }
    listDatabasesAsync(r: IListDatabases, c: IStoreContext): Promise<IPage<IRegisteredDatabase>> { return this.call("database.list", r, c); }
    checkCredentialsAsync(r: ICheckCredentials, c: IStoreContext): Promise<ICredentialsCheck> { return this.call("credentials.check", r, c); }
    private async response(path: string, init: RequestInit): Promise<Response> {
        if (!this.transfer) fail("unsupported_format", "Configure the HTTP transfer endpoint");
        const response = await fetch(`${this.transfer.baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers: { ...this.transfer.headers?.(), ...init.headers }, redirect: "error" });
        if (!response.ok) {
            let body: { error?: { code?: PersistenceErrorCode } } = {};
            try { body = await response.json() as typeof body; } catch { /* A proxy may return a non-JSON failure. */ }
            throw new PersistenceError(body.error?.code ?? (response.status === 403 || response.status === 401 ? "policy_denied" : "store_unavailable"), "Artifact transfer failed");
        }
        return response;
    }
    async writeArtifactAsync(r: { namespace: string; uploadId: string; bytes: AsyncIterable<Uint8Array> }, c: IStoreContext): Promise<void> {
        c.signal?.throwIfAborted();
        const iterator = r.bytes[Symbol.asyncIterator]();
        const stream = new ReadableStream<Uint8Array>({ async pull(controller) { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); }, async cancel() { await iterator.return?.(); } });
        await this.response(`/uploads/${segment(r.namespace)}/${segment(r.uploadId)}`, { method: "PUT", body: stream, signal: c.signal, duplex: "half" } as RequestInit);
    }
    async readArtifactAsync(r: IDocumentKey, c: IStoreContext): Promise<AsyncIterable<Uint8Array>> {
        if (r.databaseId && r.databaseId !== "default") fail("unsupported_format", "Artifacts use the default local backend");
        const response = await this.response(`/artifacts/${segment(r.namespace)}/${segment(r.id)}`, { signal: c.signal });
        if (!response.body) fail("transfer_incomplete", "Missing artifact response body");
        const body = response.body;
        return (async function* () { const reader = body.getReader(); try { while (true) { const chunk = await reader.read(); if (chunk.done) break; yield chunk.value; } } finally { await reader.cancel(); reader.releaseLock(); } })();
    }
    /** Caller owns the connected MCP client. Context.subject is never sent over the wire. */
    async closeAsync(): Promise<void> {}
}
