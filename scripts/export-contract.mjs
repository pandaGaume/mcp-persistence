import { mkdirSync, writeFileSync } from "node:fs";
import { PERSISTENCE_PROTOCOL } from "../dist/contract/persistence.protocol.js";
mkdirSync(new URL("../contracts/", import.meta.url), { recursive: true });
writeFileSync(new URL("../contracts/persistence.v1.json", import.meta.url), JSON.stringify(PERSISTENCE_PROTOCOL, null, 2) + "\n");
