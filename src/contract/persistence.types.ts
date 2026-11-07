/** persistence.v1 documents and immutable artifacts. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface IDocumentKey { namespace: string; id: string; databaseId?: string }
export interface IDocumentReference { type: "document"; namespace: string; id: string; revision: number }
export interface IArtifactReference { type: "artifact"; namespace: string; id: string }
export interface IDocument extends IDocumentKey {
    kind: string;
    schemaVersion: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
    deleted: boolean;
    payload: Json;
    references: readonly (IDocumentReference | IArtifactReference)[];
}
export interface IMutation { idempotencyKey: string }
export interface IPutDocument extends IDocumentKey, IMutation {
    /** Zero creates only; otherwise must equal the current revision, including a tombstone. */
    expectedRevision: number;
    kind: string;
    schemaVersion: string;
    payload: Json;
    references: readonly (IDocumentReference | IArtifactReference)[];
}
export interface IPageRequest { limit?: number; cursor?: string }
export interface IPage<T> { items: readonly T[]; nextCursor?: string }
export interface IListDocuments extends IPageRequest { namespace: string; databaseId?: string; kind?: string; includeDeleted?: boolean }
export interface IDeleteDocument extends IDocumentKey, IMutation { expectedRevision: number }
export interface IArtifact {
    namespace: string;
    id: string;
    mimeType: string;
    size: number;
    hash: { algorithm: "sha256"; value: string };
    createdAt: string;
    provenance: Json;
}
export interface IBeginArtifact extends IMutation {
    namespace: string;
    mimeType: string;
    size: number;
    hash: { algorithm: "sha256"; value: string };
    provenance: Json;
}
/** No physical path or reusable bearer ticket in persisted/replayed store results. */
export interface IUpload { namespace: string; artifactId: string; uploadId: string; expiresAt: string }
export interface IFinishArtifact extends IMutation { namespace: string; uploadId: string }
export interface IPurge extends IMutation {
    namespace: string;
    databaseId?: string;
    target: { type: "document"; id: string; revision: number } | { type: "artifact"; id: string };
}
/** Internal trusted context, supplied by middleware; never accepted from tool arguments. */
export interface IStoreContext { readonly subject: string; readonly signal?: AbortSignal }
export interface IPersistenceCapabilities {
    contract: "persistence.v1";
    durability: "file-sync" | "file-and-directory-sync";
    limits: {
        maxDocumentBytes: number;
        maxArtifactBytes: number;
        maxReferences: number;
        maxPageSize: number;
        maxNamespaceBytes: number;
        idempotencyRetentionSeconds: number;
    };
}
