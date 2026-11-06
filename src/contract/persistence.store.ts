import type {
    IArtifact, IBeginArtifact, IDeleteDocument, IDocument, IDocumentKey,
    IFinishArtifact, IListDocuments, IPage, IPageRequest, IPersistenceCapabilities,
    IPurge, IPutDocument, IStoreContext, IUpload,
} from "./persistence.types.js";

/** Trusted backend contract, following the direct-store/remote-slot pattern of mcp-vault. */
export interface IPersistenceStore {
    readonly id: string;
    getCapabilitiesAsync(signal?: AbortSignal): Promise<IPersistenceCapabilities>;
    getAsync(request: IDocumentKey & { revision?: number }, context: IStoreContext): Promise<IDocument>;
    putAsync(request: IPutDocument, context: IStoreContext): Promise<IDocument>;
    listAsync(request: IListDocuments, context: IStoreContext): Promise<IPage<IDocument>>;
    listRevisionsAsync(request: IDocumentKey & IPageRequest, context: IStoreContext): Promise<IPage<IDocument>>;
    /** Adds a tombstone; does not purge history or files. */
    deleteAsync(request: IDeleteDocument, context: IStoreContext): Promise<IDocument>;
    beginArtifactAsync(request: IBeginArtifact, context: IStoreContext): Promise<IUpload>;
    inspectUploadAsync(namespace: string, uploadId: string, context: IStoreContext): Promise<IUpload>;
    /** Stream bytes internally. The public endpoint must authenticate and authorize separately. */
    writeArtifactAsync(request: { namespace: string; uploadId: string; bytes: AsyncIterable<Uint8Array> }, context: IStoreContext): Promise<void>;
    commitArtifactAsync(request: IFinishArtifact, context: IStoreContext): Promise<IArtifact>;
    abortArtifactAsync(request: IFinishArtifact, context: IStoreContext): Promise<void>;
    getArtifactAsync(request: IDocumentKey, context: IStoreContext): Promise<IArtifact>;
    readArtifactAsync(request: IDocumentKey, context: IStoreContext): Promise<AsyncIterable<Uint8Array>>;
    /** Physical purge, subject to retention and incoming-reference checks. */
    purgeAsync(request: IPurge, context: IStoreContext): Promise<void>;
    closeAsync(): Promise<void>;
}
