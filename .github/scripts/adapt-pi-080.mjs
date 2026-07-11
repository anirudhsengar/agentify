import * as fs from "node:fs";

const file = "tests/agentify-core.test.ts";
let source = fs.readFileSync(file, "utf-8");

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pi compatibility patch '${label}' did not match`);
  source = source.replace(before, after);
}

replaceOnce(
  "remove SDK provider helper import",
  `import { getProviders } from "@earendil-works/pi-ai";\n`,
  ``,
);
replaceOnce(
  "provider auth imports",
  `import { AGENTIFY_PROVIDERS, PROVIDER_ENV_KEYS } from "../src/core/provider-auth.ts";`,
  `import {
  AGENTIFY_PROVIDERS,
  PROVIDER_ENV_KEYS,
  getProviderEnvValue,
  hasProviderEnvironmentAuth,
} from "../src/core/provider-auth.ts";`,
);
replaceOnce(
  "provider metadata test",
  `async function testProviderListMatchesPi(): Promise<void> {
  const agentifyProviders = AGENTIFY_PROVIDERS.map((provider) => provider.value).sort();
  const piProviders = getProviders().sort();
  assert.deepEqual(agentifyProviders, piProviders);
}`,
  `async function testProviderMetadataAndEnvironmentAuth(): Promise<void> {
  const values = AGENTIFY_PROVIDERS.map((provider) => provider.value);
  assert.equal(new Set(values).size, values.length, "provider IDs must be unique");
  assert.ok(values.includes("openai"));
  assert.ok(values.includes("anthropic"));
  assert.ok(values.includes("amazon-bedrock"));
  for (const provider of AGENTIFY_PROVIDERS) {
    assert.ok(provider.label.trim().length > 0, \`missing provider label: \${provider.value}\`);
    assert.ok(provider.value.trim().length > 0);
    assert.equal(new Set(provider.env).size, provider.env.length);
  }

  const previousOpenAi = process.env["OPENAI_API_KEY"];
  const previousAwsProfile = process.env["AWS_PROFILE"];
  try {
    process.env["OPENAI_API_KEY"] = "sk-test-env";
    assert.equal(hasProviderEnvironmentAuth("openai"), true);
    assert.equal(getProviderEnvValue("openai"), "sk-test-env");

    delete process.env["AWS_BEARER_TOKEN_BEDROCK"];
    process.env["AWS_PROFILE"] = "agentify-test-profile";
    assert.equal(hasProviderEnvironmentAuth("amazon-bedrock"), true);
    assert.equal(
      getProviderEnvValue("amazon-bedrock"),
      undefined,
      "ambient AWS credentials must not be forwarded as an API key",
    );
  } finally {
    if (previousOpenAi === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = previousOpenAi;
    if (previousAwsProfile === undefined) delete process.env["AWS_PROFILE"];
    else process.env["AWS_PROFILE"] = previousAwsProfile;
  }
}`,
);
replaceOnce(
  "provider test registry",
  `{ name: "providerListMatchesPi", fn: testProviderListMatchesPi },`,
  `{ name: "providerMetadataAndEnvironmentAuth", fn: testProviderMetadataAndEnvironmentAuth },`,
);

fs.writeFileSync(file, source);
console.log("Pi 0.80 provider compatibility test applied");
