import {
  fileExists,
  makeCommand,
  makefileCommands,
  mergeValidationCommands,
  type BuildSystemDiscovery,
} from "./shared.ts";

function gradleWrapper(cwd: string): string[] {
  if (process.platform === "win32" && fileExists(cwd, "gradlew.bat")) {
    return ["gradlew.bat"];
  }
  if (fileExists(cwd, "gradlew")) return ["./gradlew"];
  return ["gradle"];
}

function mavenWrapper(cwd: string): string[] {
  if (process.platform === "win32" && fileExists(cwd, "mvnw.cmd")) {
    return ["mvnw.cmd"];
  }
  if (fileExists(cwd, "mvnw")) return ["./mvnw"];
  return ["mvn"];
}

export function discoverJavaBuildSystem(cwd: string): BuildSystemDiscovery | null {
  const gradleManifest = ["build.gradle.kts", "build.gradle"]
    .find((name) => fileExists(cwd, name));
  if (gradleManifest) {
    const wrapper = gradleWrapper(cwd);
    const commands = mergeValidationCommands([
      makeCommand({
        kind: "test",
        label: "gradle-test",
        argv: [...wrapper, "test"],
        detail: "Gradle test task discovered",
      }),
      makeCommand({
        kind: "typecheck",
        label: "gradle-check",
        argv: [...wrapper, "check"],
        detail: "Gradle check task discovered",
      }),
      ...makefileCommands(cwd),
    ]);
    return {
      manifest: { path: gradleManifest, ecosystem: "gradle" },
      commands,
      lockfile: fileExists(cwd, "gradle.lockfile") ? { path: "gradle.lockfile" } : null,
      requiresLockfile: false,
    };
  }
  if (!fileExists(cwd, "pom.xml")) return null;
  const wrapper = mavenWrapper(cwd);
  const commands = mergeValidationCommands([
    makeCommand({
      kind: "test",
      label: "maven-test",
      argv: [...wrapper, "-B", "test"],
      detail: "Maven test goal discovered",
    }),
    makeCommand({
      kind: "typecheck",
      label: "maven-verify",
      argv: [...wrapper, "-B", "verify"],
      required: false,
      detail: "Maven verify goal discovered",
    }),
    ...makefileCommands(cwd),
  ]);
  return {
    manifest: { path: "pom.xml", ecosystem: "maven" },
    commands,
    lockfile: null,
    requiresLockfile: false,
  };
}
