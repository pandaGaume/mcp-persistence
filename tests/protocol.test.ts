import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { PERSISTENCE_PROTOCOL, PERSISTENCE_TOOLS } from "../src/contract/persistence.protocol.js";

describe("published persistence.v1 contract", () => {
    it("matches the generated machine-readable artifact", () => {
        expect(JSON.parse(readFileSync("contracts/persistence.v1.json", "utf8"))).toEqual(PERSISTENCE_PROTOCOL);
    });
    it("provides complete schemas with resolvable references for all tools", () => {
        const ajv = new Ajv({ strict: false, validateFormats: false });
        expect(PERSISTENCE_TOOLS).toHaveLength(19);
        for (const tool of PERSISTENCE_TOOLS) {
            expect(() => ajv.compile(tool.inputSchema)).not.toThrow();
            expect(() => ajv.compile(tool.outputSchema)).not.toThrow();
        }
        const put = ajv.compile(PERSISTENCE_TOOLS.find(t => t.name === "persistence.put")!.inputSchema);
        const valid = { namespace: "explorer", id: "view-1", expectedRevision: 0, kind: "view", schemaVersion: "1", payload: {}, references: [], idempotencyKey: "one-operation" };
        expect(put(valid)).toBe(true);
        expect(put({ ...valid, subject: "admin" })).toBe(false);
        expect(put({ ...valid, references: [{ type: "document", namespace: "explorer", id: "view" }] })).toBe(false);
        expect(put({ ...valid, expectedRevision: -1 })).toBe(false);
    });
});
