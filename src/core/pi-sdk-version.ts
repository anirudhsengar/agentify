import { VERSION as runtimeResolvedPiSdkVersion } from "@earendil-works/pi-coding-agent";

declare const __AGENTIFY_BUNDLED_PI_SDK_VERSION__: string | undefined;

export const PI_SDK_VERSION = typeof __AGENTIFY_BUNDLED_PI_SDK_VERSION__ === "string"
  ? __AGENTIFY_BUNDLED_PI_SDK_VERSION__
  : runtimeResolvedPiSdkVersion;
