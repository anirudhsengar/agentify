// Pi-style interactive authentication for `agentify login`.
//
// The provider set, display names, and login flows come from the installed Pi
// SDK (`ModelRuntime.getProviders()` and each provider's `auth` definition), so
// agentify offers exactly the options Pi offers: subscription sign-in
// (Anthropic Claude Pro/Max, OpenAI ChatGPT Plus/Pro, GitHub Copilot, …) or an
// API key. Credentials are persisted by Pi through the Agentify credential
// store (`~/.agentify/auth.json`); this module only orchestrates interaction.

import { spawn } from "node:child_process";
import * as readline from "node:readline/promises";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Provider,
} from "@earendil-works/pi-ai";
import type { AgentifyUi } from "./types.ts";

export type AuthLoginType = "oauth" | "api_key";

export interface AuthLoginOption {
  providerId: string;
  /** Pi registry display name, e.g. "Anthropic". */
  providerName: string;
  authType: AuthLoginType;
  /** Pi's own method name, e.g. "Anthropic (Claude Pro/Max)" or "Anthropic API key". */
  methodName: string;
  /** Pi's selector label for OAuth methods, e.g. "Sign in with Kimi Code". */
  loginLabel?: string;
  /** Whether Pi classifies this OAuth method as subscription-backed. */
  isSubscription: boolean;
  /**
   * True when the provider defines no interactive login and can only pick up
   * ambient credentials (env vars, cloud profiles). Choosing it prints
   * guidance instead of starting a flow.
   */
  ambientOnly: boolean;
}

/** Pi's flat login surface: every OAuth method by name, then API-key methods. */
export function buildLoginOptions(providers: readonly Provider[]): {
  subscriptions: AuthLoginOption[];
  apiKeys: AuthLoginOption[];
} {
  const subscriptions: AuthLoginOption[] = [];
  const apiKeys: AuthLoginOption[] = [];
  for (const provider of providers) {
    const oauth = provider.auth?.oauth;
    if (oauth) {
      subscriptions.push({
        providerId: provider.id,
        providerName: provider.name,
        authType: "oauth",
        methodName: oauth.name,
        ...(oauth.loginLabel !== undefined ? { loginLabel: oauth.loginLabel } : {}),
        isSubscription: oauth.isSubscription === true,
        ambientOnly: false,
      });
    }
    if (provider.auth?.apiKey) {
      apiKeys.push({
        providerId: provider.id,
        providerName: provider.name,
        authType: "api_key",
        methodName: provider.auth.apiKey.name,
        isSubscription: false,
        ambientOnly: provider.auth.apiKey.login === undefined,
      });
    }
  }
  subscriptions.sort((left, right) => left.methodName.localeCompare(right.methodName));
  apiKeys.sort((left, right) => left.providerName.localeCompare(right.providerName));
  return { subscriptions, apiKeys };
}

/** Label for one first-level entry, matching Pi's selector presentation. */
export function loginOptionLabel(option: AuthLoginOption): string {
  return option.authType === "oauth"
    ? (option.loginLabel ?? option.methodName)
    : option.providerName;
}

/** Best-effort browser launch for OAuth URLs; failures leave the printed URL. */
export function tryOpenBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? { bin: "open", args: [url] }
    : process.platform === "win32"
      ? { bin: "cmd", args: ["/c", "start", "", url] }
      : { bin: "xdg-open", args: [url] };
  try {
    const child = spawn(command.bin, command.args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The printed URL remains the fallback; a missing opener is not fatal.
  }
}

export interface AuthInteractionIO {
  ui: AgentifyUi;
  out: NodeJS.WritableStream;
  /**
   * Free-form line input that rejects when `signal` aborts. Defaults to a
   * readline prompt on the process terminal; injected by tests.
   */
  askText?: (prompt: Extract<AuthPrompt, { type: "manual_code" | "text" }>) => Promise<string>;
  /** Browser opener hook; defaults to `tryOpenBrowser`. */
  openUrl?: (url: string) => void;
}

async function defaultAskText(
  prompt: Extract<AuthPrompt, { type: "manual_code" | "text" }>,
): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : "";
    const answer = await rl.question(`${prompt.message}${suffix}\n`, {
      ...(prompt.signal !== undefined ? { signal: prompt.signal } : {}),
    });
    return answer;
  } finally {
    rl.close();
  }
}

function describeLinks(links: ReadonlyArray<{ url: string; label?: string }> | undefined): string {
  if (!links || links.length === 0) return "";
  return links.map((link) => `  - ${link.label ?? link.url}: ${link.url}`).join("\n");
}

/**
 * Adapt Pi's `AuthInteraction` contract to the agentify CLI. `manual_code`
 * prompts must support out-of-band abort (the OAuth callback server can win
 * the race against a manual paste), so they bypass clack and use readline,
 * whose `question` honors an AbortSignal.
 */
export function createAuthInteraction(io: AuthInteractionIO): AuthInteraction {
  const askText = io.askText ?? defaultAskText;
  const openUrl = io.openUrl ?? tryOpenBrowser;
  return {
    async prompt(prompt: AuthPrompt): Promise<string> {
      if (prompt.type === "secret") {
        return io.ui.promptSecret(prompt.message);
      }
      if (prompt.type === "select") {
        return io.ui.promptSelect(
          prompt.message,
          prompt.options.map((option) => ({
            label: option.description ? `${option.label} — ${option.description}` : option.label,
            value: option.id,
          })),
        );
      }
      return askText(prompt);
    },
    notify(event: AuthEvent): void {
      if (event.type === "auth_url") {
        io.out.write(`Open this URL to sign in:\n${event.url}\n`);
        if (event.instructions) io.out.write(`${event.instructions}\n`);
        openUrl(event.url);
        return;
      }
      if (event.type === "device_code") {
        io.out.write(
          `Go to ${event.verificationUri} and enter code ${event.userCode}.\n`,
        );
        return;
      }
      if (event.type === "info") {
        const links = describeLinks(event.links);
        io.out.write(`${event.message}\n${links ? `${links}\n` : ""}`);
        return;
      }
      io.out.write(`${event.message}\n`);
    },
  };
}
