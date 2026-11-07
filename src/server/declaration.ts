import { segment, text } from "../contract/validation.js";

export class PersistenceResources {
    constructor(readonly root: string) {
        if (!root.startsWith("/") || root.split("/").slice(1).some(s => { try { segment(s); return false; } catch { return true; } })) throw new Error("Invalid broker resource root");
    }
    document(namespace: string, id: string, databaseId?: string): string { return `${this.root}${databaseId && databaseId !== "default" ? `/databases/${segment(databaseId)}` : ""}/namespaces/${segment(namespace)}/documents/${segment(id)}`; }
    artifact(namespace: string, id: string): string { return `${this.root}/namespaces/${segment(namespace)}/artifacts/${segment(id)}`; }
    server(id: string): string { return `${this.root}/servers/${segment(id)}`; }
    database(id: string): string { return `${this.root}/databases/${segment(id)}`; }
}
export function buildPersistenceDeclaration(input: { version: string; namespace: string }) {
    new PersistenceResources(input.namespace); text(input.version);
    return { version: input.version, domain: "persistence", namespace: { resource: input.namespace }, capabilities: ["persistence.read", "persistence.write", "persistence.delete", "persistence.admin", "persistence.configure"], resultsRequired: ["persistence.write", "persistence.delete", "persistence.admin", "persistence.configure"] };
}
