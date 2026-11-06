import { Ajv } from "ajv";
import { createRequire } from "node:module";
import { expect } from "vitest";
import { PERSISTENCE_TOOLS } from "../src/contract/persistence.protocol.js";
import type { ISlotClient } from "../src/server/persistence.slot.store.js";
const ajv = new Ajv({ strict: false, allErrors: true });
(createRequire(import.meta.url)("ajv-formats") as (a: Ajv) => void)(ajv);
const validators = new Map(PERSISTENCE_TOOLS.map(tool => [tool.name, { input: ajv.compile(tool.inputSchema), output: ajv.compile(tool.outputSchema) }]));

export function validateSlotClient(client: ISlotClient): ISlotClient {
    return {
        async callTool(name, args) {
            const validator = validators.get(name)!;
            expect(validator, `Unspecified tool ${name}`).toBeTruthy();
            expect(validator.input(args), JSON.stringify(validator.input.errors)).toBe(true);
            const result = await client.callTool(name, args);
            expect(result.structuredContent, "Missing MCP structuredContent").toBeDefined();
            expect(validator.output(result.structuredContent), JSON.stringify(validator.output.errors)).toBe(true);
            return result;
        },
    };
}
