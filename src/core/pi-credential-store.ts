import * as fs from "node:fs";
import * as path from "node:path";
import {
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCredential(value: unknown): value is Credential {
  if (!isRecord(value)) return false;
  if (value.type === "api_key") {
    return (value.key === undefined || typeof value.key === "string")
      && (value.env === undefined || isRecord(value.env));
  }
  return value.type === "oauth"
    && typeof value.refresh === "string"
    && typeof value.access === "string"
    && typeof value.expires === "number";
}

function readCredentials(filePath: string): Record<string, Credential> {
  if (!fs.existsSync(filePath)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!isRecord(parsed)) throw new Error(`Credential file at ${filePath} must contain an object`);
  const credentials: Record<string, Credential> = {};
  for (const [provider, credential] of Object.entries(parsed)) {
    if (!isCredential(credential)) {
      throw new Error(`Credential file at ${filePath} contains an invalid entry for ${provider}`);
    }
    credentials[provider] = credential;
  }
  return credentials;
}

function writeCredentials(filePath: string, credentials: Record<string, Credential>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

/** Agentify-owned credential adapter for the Pi 0.83 CredentialStore contract. */
export class AgentifyCredentialStore implements CredentialStore {
  readonly #filePath: string;
  #pending: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  read(providerId: string): Promise<Credential | undefined> {
    return Promise.resolve(readCredentials(this.#filePath)[providerId]);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(readCredentials(this.#filePath)).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    let result: Credential | undefined;
    const operation = this.#pending.then(async () => {
      const credentials = readCredentials(this.#filePath);
      result = await fn(credentials[providerId]);
      if (result !== undefined) {
        credentials[providerId] = result;
        writeCredentials(this.#filePath, credentials);
      }
    });
    this.#pending = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }

  async delete(providerId: string): Promise<void> {
    const operation = this.#pending.then(() => {
      const credentials = readCredentials(this.#filePath);
      if (!(providerId in credentials)) return;
      delete credentials[providerId];
      writeCredentials(this.#filePath, credentials);
    });
    this.#pending = operation.then(() => undefined, () => undefined);
    await operation;
  }

  async has(providerId: string): Promise<boolean> {
    return (await this.read(providerId)) !== undefined;
  }

  set(providerId: string, credential: Credential): Promise<Credential | undefined> {
    return this.modify(providerId, async () => credential);
  }
}

export interface AgentifyModelRuntime {
  credentialStore: AgentifyCredentialStore;
  modelRegistry: ModelRegistry;
  modelRuntime: ModelRuntime;
}

export async function createAgentifyModelRuntime(input: {
  authFile: string;
  modelsFile: string;
  runtimeApiKey?: { provider: string; key: string };
}): Promise<AgentifyModelRuntime> {
  const credentialStore = new AgentifyCredentialStore(input.authFile);
  const modelRuntime = await ModelRuntime.create({
    credentials: credentialStore,
    modelsPath: input.modelsFile,
    allowModelNetwork: false,
  });
  if (input.runtimeApiKey) {
    await modelRuntime.setRuntimeApiKey(input.runtimeApiKey.provider, input.runtimeApiKey.key);
  }
  return {
    credentialStore,
    modelRuntime,
    modelRegistry: new ModelRegistry(modelRuntime),
  };
}
