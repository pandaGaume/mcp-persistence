import { McpAdapterBase, McpBehavior, McpGrammar, type IMcpRequestContext, type McpResource, type McpResourceContent, type McpResourceTemplate, type McpTool, type McpToolResult } from "@cyanmycelium/mcp-core";
import type { IAccessCheck, IAccessDecision, IAccessGuard } from "@cyanmycelium/mcp-uns";
import type { IPersistenceStore } from "../contract/persistence.store.js";
import type { IBeginArtifact, IDeleteDocument, IDocumentKey, IFinishArtifact, IListDocuments, IPageRequest, IPurge, IPutDocument, IStoreContext } from "../contract/persistence.types.js";
import { PersistenceError } from "../contract/errors.js";
import { fail, segment } from "../contract/validation.js";
import { PersistenceResources } from "./declaration.js";
import { PERSISTENCE_TOOLS, PERSISTENCE_RESOURCE_TEMPLATES, PERSISTENCE_TOOL_DESCRIPTIONS as EN } from "../contract/persistence.protocol.js";

/** Broker caller references are request-scoped, not stable user ids. Keys are shared per namespace. */
export const MCP_STORE_CONTEXT: IStoreContext = Object.freeze({ subject: "broker-namespace" });
export const CAPABILITIES_URI = "persistence://capabilities";
type Args = Record<string, unknown>;
const FR: Record<string, string> = {
    capabilities: "Lire les limites du protocole et les garanties de durabilité.",
    get: "Lire la tête d'un document ou une révision immuable.", put: "Créer ou modifier avec expectedRevision et une clé d'idempotence.",
    list: "Lister les documents autorisés avec pagination bornée.", listRevisions: "Lister les révisions immuables d'un document autorisé.",
    delete: "Ajouter une suppression logique en conservant l'historique et les fichiers.", purge: "Purger définitivement une révision ou un artefact sans référence après rétention.",
    beginArtifact: "Réserver un transfert. Les octets passent par le point HTTP authentifié.",
    commitArtifact: "Vérifier et publier atomiquement un transfert terminé.", abortArtifact: "Annuler un transfert inactif.",
    getArtifact: "Lire les métadonnées ; les octets passent par le point HTTP authentifié.",
    uploadAccess: "Autoriser un flux de transfert et lire ses métadonnées cibles.",
};

class PersistenceAdapter extends McpAdapterBase {
    private readonly paths: PersistenceResources;
    constructor(private readonly store: IPersistenceStore, private readonly guard: IAccessGuard, root: string) { super("persistence"); this.paths = new PersistenceResources(root); }
    private check(capability: string, kind: "document" | "artifact", key: IDocumentKey): IAccessCheck {
        return { capability: `persistence.${capability}`, resource: `persistence:${kind}:${segment(key.namespace)}/${segment(key.id)}`, resourcePath: this.paths[kind](key.namespace, key.id) };
    }
    private async decisions(checks: IAccessCheck[], request?: IMcpRequestContext): Promise<IAccessDecision[]> {
        const decisions = await this.guard.authorizeAsync(checks, request);
        if (decisions.length !== checks.length) fail("policy_denied", "No complete authorization decision");
        return decisions;
    }
    private async allowed(checks: IAccessCheck[], request?: IMcpRequestContext): Promise<IAccessDecision[]> {
        const decisions = await this.decisions(checks, request);
        if (decisions.some(d => !d.allowed || d.constraints)) {
            for (const d of decisions) if (d.allowed) this.guard.report(d, "refused", "policy_denied");
            fail("policy_denied", "Access refused");
        }
        return decisions;
    }
    private async mutation<T>(checks: IAccessCheck[], request: IMcpRequestContext | undefined, action: () => Promise<T>): Promise<T> {
        const decisions = await this.allowed(checks, request);
        try { const result = await action(); for (const d of decisions) this.guard.report(d, "success"); return result; }
        catch (error) { for (const d of decisions) this.guard.report(d, "failure", error instanceof PersistenceError ? error.code : "store_unavailable"); throw error; }
    }
    private async upload(args: Args, request?: IMcpRequestContext) {
        const namespace = segment(args.namespace), uploadId = segment(args.uploadId);
        let upload;
        try { upload = await this.store.inspectUploadAsync(namespace, uploadId, MCP_STORE_CONTEXT); }
        catch (error) {
            await this.allowed([this.check("write", "artifact", { namespace, id: "_new" })], request); throw error;
        }
        return upload;
    }
    async invoke(name: string, args: Args, request?: IMcpRequestContext): Promise<unknown> {
        if (name === "capabilities") return this.store.getCapabilitiesAsync();
        const namespace = segment(args.namespace);
        const context = MCP_STORE_CONTEXT;
        switch (name) {
            case "list": {
                const page = await this.store.listAsync(args as unknown as IListDocuments, context);
                const decisions = await this.decisions(page.items.map(d => this.check("read", "document", d)), request);
                return { ...page, items: page.items.filter((_, i) => decisions[i]?.allowed && !decisions[i]?.constraints) };
            }
            case "get":
            case "listRevisions": {
                const key = { namespace, id: segment(args.id) };
                await this.allowed([this.check("read", "document", key)], request);
                return name === "get" ? this.store.getAsync(args as unknown as IDocumentKey & { revision?: number }, context)
                    : this.store.listRevisionsAsync(args as unknown as IDocumentKey & IPageRequest, context);
            }
            case "put": {
                const input = args as unknown as IPutDocument;
                if (!Array.isArray(input.references)) fail("invalid_request", "Expected references array");
                const checks = [this.check("write", "document", { namespace, id: segment(args.id) })];
                const caps = await this.store.getCapabilitiesAsync();
                if (input.references.length > caps.limits.maxReferences) fail("invalid_request", "Too many references");
                for (const ref of input.references) { if (!ref || (ref.type !== "document" && ref.type !== "artifact")) fail("invalid_request", "Invalid reference"); checks.push(this.check("read", ref.type, ref)); }
                return this.mutation(checks, request, () => this.store.putAsync(input, context));
            }
            case "delete": return this.mutation([this.check("delete", "document", { namespace, id: segment(args.id) })], request, () => this.store.deleteAsync(args as unknown as IDeleteDocument, context));
            case "purge": {
                const input = args as unknown as IPurge;
                if (!input.target || (input.target.type !== "document" && input.target.type !== "artifact")) fail("invalid_request", "Invalid purge target");
                return this.mutation([this.check("admin", input.target.type, { namespace, id: segment(input.target.id) })], request, () => this.store.purgeAsync(input, context));
            }
            case "beginArtifact": return this.mutation([this.check("write", "artifact", { namespace, id: "_new" })], request, () => this.store.beginArtifactAsync(args as unknown as IBeginArtifact, context));
            case "uploadAccess":
            case "commitArtifact":
            case "abortArtifact": {
                const upload = await this.upload(args, request);
                const checks = [this.check("write", "artifact", { namespace, id: upload.artifactId })];
                if (name === "uploadAccess") return this.mutation(checks, request, async () => upload);
                return this.mutation<unknown>(checks, request, () => name === "commitArtifact"
                    ? this.store.commitArtifactAsync(args as unknown as IFinishArtifact, context) : this.store.abortArtifactAsync(args as unknown as IFinishArtifact, context));
            }
            case "getArtifact": {
                const key = { namespace, id: segment(args.id) };
                await this.allowed([this.check("read", "artifact", key)], request);
                return this.store.getArtifactAsync(key, context);
            }
            default: fail("invalid_request", "Unknown persistence tool");
        }
    }
    async executeToolAsync(_uri: string, tool: string, args: Args, request?: IMcpRequestContext): Promise<McpToolResult> {
        try {
            const definition = PERSISTENCE_TOOLS.find(t => t.name === tool);
            if (!definition) fail("invalid_request", "Unknown persistence tool");
            const schema = definition.inputSchema as { properties: Record<string, unknown>; required: string[] };
            if (Object.keys(args).some(k => !Object.hasOwn(schema.properties, k)) || schema.required.some(k => !Object.hasOwn(args, k))) fail("invalid_request", "Unknown or missing tool argument");
            const payload = (await this.invoke(tool.replace(/^persistence\./, ""), args, request)) ?? { ok: true };
            return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload as Record<string, unknown> };
        }
        catch (error) {
            const code = error instanceof PersistenceError ? error.code : "store_unavailable";
            const payload = { error: { code, message: error instanceof PersistenceError ? error.message : "Persistence operation failed" } };
            return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
        }
    }
    async readResourceAsync(uri: string, request?: IMcpRequestContext): Promise<McpResourceContent | undefined> {
        if (uri === CAPABILITIES_URI) return { uri, mimeType: "application/json", text: JSON.stringify(await this.store.getCapabilitiesAsync()) };
        const match = /^persistence:\/\/(documents|artifacts)\/([^/]+)\/([^/]+)(?:\/revisions\/(\d+))?$/.exec(uri);
        if (!match || (match[1] === "artifacts" && match[4])) return undefined;
        const args = { namespace: decodeURIComponent(match[2]!), id: decodeURIComponent(match[3]!), ...(match[4] ? { revision: Number(match[4]) } : {}) };
        return { uri, mimeType: "application/json", text: JSON.stringify(await this.invoke(match[1] === "documents" ? "get" : "getArtifact", args, request)) };
    }
}

export class PersistenceBehavior extends McpBehavior {
    constructor(store: IPersistenceStore, guard: IAccessGuard, options: { namespace: string }) { super(new PersistenceAdapter(store, guard, options.namespace), { namespace: "persistence" }); }
    protected override _buildResources(): McpResource[] { return [{ uri: CAPABILITIES_URI, name: "Persistence capabilities", mimeType: "application/json", description: EN.capabilities! }]; }
    protected override _buildTemplate(): McpResourceTemplate[] {
        return structuredClone(PERSISTENCE_RESOURCE_TEMPLATES);
    }
    protected override _buildGrammars(): Map<string, McpGrammar> {
        return new Map([["default:en", EN], ["default:fr", FR]].map(([key, descriptions]) => [key as string, McpGrammar.fromJSON({ tools: Object.fromEntries(Object.entries(descriptions!).map(([name, description]) => [`persistence.${name}`, { description }])) })]));
    }
    protected override _buildTools(): McpTool[] {
        return structuredClone(PERSISTENCE_TOOLS);
    }
}
