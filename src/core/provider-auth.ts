export interface AgentifyProviderDefinition {
  label: string;
  value: string;
  /** Environment variables whose presence means the provider is configured. */
  env: readonly string[];
  /** Variables that contain a token safe to pass to AuthStorage at runtime. */
  runtimeKeyEnv?: readonly string[];
}

export const AGENTIFY_PROVIDERS = [
  { label: "Amazon Bedrock", value: "amazon-bedrock", env: ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK"], runtimeKeyEnv: ["AWS_BEARER_TOKEN_BEDROCK"] },
  { label: "Ant Ling", value: "ant-ling", env: ["ANT_LING_API_KEY"], runtimeKeyEnv: ["ANT_LING_API_KEY"] },
  { label: "Anthropic", value: "anthropic", env: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"], runtimeKeyEnv: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] },
  { label: "Azure OpenAI Responses", value: "azure-openai-responses", env: ["AZURE_OPENAI_API_KEY"], runtimeKeyEnv: ["AZURE_OPENAI_API_KEY"] },
  { label: "Cerebras", value: "cerebras", env: ["CEREBRAS_API_KEY"], runtimeKeyEnv: ["CEREBRAS_API_KEY"] },
  { label: "Cloudflare AI Gateway", value: "cloudflare-ai-gateway", env: ["CLOUDFLARE_API_KEY"], runtimeKeyEnv: ["CLOUDFLARE_API_KEY"] },
  { label: "Cloudflare Workers AI", value: "cloudflare-workers-ai", env: ["CLOUDFLARE_API_KEY"], runtimeKeyEnv: ["CLOUDFLARE_API_KEY"] },
  { label: "DeepSeek", value: "deepseek", env: ["DEEPSEEK_API_KEY"], runtimeKeyEnv: ["DEEPSEEK_API_KEY"] },
  { label: "Fireworks", value: "fireworks", env: ["FIREWORKS_API_KEY"], runtimeKeyEnv: ["FIREWORKS_API_KEY"] },
  { label: "GitHub Copilot", value: "github-copilot", env: ["COPILOT_GITHUB_TOKEN"], runtimeKeyEnv: ["COPILOT_GITHUB_TOKEN"] },
  { label: "Google Gemini", value: "google", env: ["GEMINI_API_KEY"], runtimeKeyEnv: ["GEMINI_API_KEY"] },
  { label: "Google Vertex AI", value: "google-vertex", env: ["GOOGLE_CLOUD_API_KEY", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"], runtimeKeyEnv: ["GOOGLE_CLOUD_API_KEY"] },
  { label: "Groq", value: "groq", env: ["GROQ_API_KEY"], runtimeKeyEnv: ["GROQ_API_KEY"] },
  { label: "Hugging Face", value: "huggingface", env: ["HF_TOKEN"], runtimeKeyEnv: ["HF_TOKEN"] },
  { label: "Kimi For Coding", value: "kimi-coding", env: ["KIMI_API_KEY"], runtimeKeyEnv: ["KIMI_API_KEY"] },
  { label: "MiniMax", value: "minimax", env: ["MINIMAX_API_KEY"], runtimeKeyEnv: ["MINIMAX_API_KEY"] },
  { label: "MiniMax (China)", value: "minimax-cn", env: ["MINIMAX_CN_API_KEY"], runtimeKeyEnv: ["MINIMAX_CN_API_KEY"] },
  { label: "Mistral", value: "mistral", env: ["MISTRAL_API_KEY"], runtimeKeyEnv: ["MISTRAL_API_KEY"] },
  { label: "Moonshot AI", value: "moonshotai", env: ["MOONSHOT_API_KEY"], runtimeKeyEnv: ["MOONSHOT_API_KEY"] },
  { label: "Moonshot AI (China)", value: "moonshotai-cn", env: ["MOONSHOT_API_KEY"], runtimeKeyEnv: ["MOONSHOT_API_KEY"] },
  { label: "NVIDIA NIM", value: "nvidia", env: ["NVIDIA_API_KEY"], runtimeKeyEnv: ["NVIDIA_API_KEY"] },
  { label: "OpenAI", value: "openai", env: ["OPENAI_API_KEY"], runtimeKeyEnv: ["OPENAI_API_KEY"] },
  { label: "OpenAI Codex", value: "openai-codex", env: [] },
  { label: "OpenCode Go", value: "opencode-go", env: ["OPENCODE_API_KEY"], runtimeKeyEnv: ["OPENCODE_API_KEY"] },
  { label: "OpenCode Zen", value: "opencode", env: ["OPENCODE_API_KEY"], runtimeKeyEnv: ["OPENCODE_API_KEY"] },
  { label: "OpenRouter", value: "openrouter", env: ["OPENROUTER_API_KEY"], runtimeKeyEnv: ["OPENROUTER_API_KEY"] },
  { label: "Together AI", value: "together", env: ["TOGETHER_API_KEY"], runtimeKeyEnv: ["TOGETHER_API_KEY"] },
  { label: "Vercel AI Gateway", value: "vercel-ai-gateway", env: ["AI_GATEWAY_API_KEY"], runtimeKeyEnv: ["AI_GATEWAY_API_KEY"] },
  { label: "xAI", value: "xai", env: ["XAI_API_KEY"], runtimeKeyEnv: ["XAI_API_KEY"] },
  { label: "Xiaomi MiMo", value: "xiaomi", env: ["XIAOMI_API_KEY"], runtimeKeyEnv: ["XIAOMI_API_KEY"] },
  { label: "Xiaomi MiMo Token Plan (Amsterdam)", value: "xiaomi-token-plan-ams", env: ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"], runtimeKeyEnv: ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"] },
  { label: "Xiaomi MiMo Token Plan (China)", value: "xiaomi-token-plan-cn", env: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"], runtimeKeyEnv: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"] },
  { label: "Xiaomi MiMo Token Plan (Singapore)", value: "xiaomi-token-plan-sgp", env: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"], runtimeKeyEnv: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"] },
  { label: "ZAI", value: "zai", env: ["ZAI_API_KEY"], runtimeKeyEnv: ["ZAI_API_KEY"] },
  { label: "ZAI Coding Plan (China)", value: "zai-coding-cn", env: ["ZAI_CODING_CN_API_KEY"], runtimeKeyEnv: ["ZAI_CODING_CN_API_KEY"] },
] as const satisfies readonly AgentifyProviderDefinition[];

export type AgentifyProvider = (typeof AGENTIFY_PROVIDERS)[number]["value"];

export const PROVIDER_ENV_KEYS = Array.from(
  new Set(AGENTIFY_PROVIDERS.flatMap((provider) => provider.env)),
).sort();

export function isAgentifyProvider(value: string): value is AgentifyProvider {
  return AGENTIFY_PROVIDERS.some((provider) => provider.value === value);
}

function providerDefinition(provider: AgentifyProvider): AgentifyProviderDefinition {
  const definition = AGENTIFY_PROVIDERS.find((candidate) => candidate.value === provider);
  if (!definition) throw new Error(`unknown Agentify provider: ${provider}`);
  return definition;
}

function firstEnvironmentValue(keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

export function getProviderEnvValue(provider: AgentifyProvider): string | undefined {
  return firstEnvironmentValue(providerDefinition(provider).runtimeKeyEnv ?? []);
}

export function hasProviderEnvironmentAuth(provider: AgentifyProvider): boolean {
  return firstEnvironmentValue(providerDefinition(provider).env) !== undefined;
}
