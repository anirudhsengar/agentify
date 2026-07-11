import * as fs from "node:fs";

function patchFile(file, patches) {
  let source = fs.readFileSync(file, "utf-8");
  for (const [label, pattern, replacement] of patches) {
    const next = source.replace(pattern, replacement);
    if (next === source) throw new Error(`patch '${label}' did not match ${file}`);
    source = next;
  }
  fs.writeFileSync(file, source);
}

patchFile("src/core/audit/defense-hook.ts", [
  [
    "all filesystem readers are path-sensitive",
    'const PATH_SENSITIVE_TOOLS = new Set(["read", ...WRITE_TOOLS]);',
    'const PATH_SENSITIVE_TOOLS = new Set(["read", "grep", "find", "ls", ...WRITE_TOOLS]);',
  ],
]);

patchFile("src/core/audit/spawn-explorer-tool.ts", [
  [
    "target path description",
    /"Directory to explore\. Absolute path or cwd-relative path\. " \+\n\s+"The sub-agent will only read files within this directory\. " \+\n\s+"If the resolved path is outside ctx\.cwd, the call is rejected " \+\n\s+"unless `allow_external_paths: true` is also passed \(logged as a " \+\n\s+"security event\)\."/,
    '"Directory to explore. Absolute path or cwd-relative path. " +\n            "The resolved path must remain inside ctx.cwd; external paths are always rejected."',
  ],
  [
    "external path option description",
    /"If true, allow target_path to resolve outside ctx\.cwd\. " \+\n\s+"Default false \(domain-locked\)\. When set, the external access is logged\."/,
    '"Deprecated compatibility field. External paths are always rejected, even when true."',
  ],
  [
    "bash cap description",
    'description: "Override the per-mode default bash invocation cap.",',
    'description: "Deprecated compatibility field. Explorer sessions never receive bash; the effective cap is always zero.",',
  ],
  [
    "tool list description",
    /"Override the tool list for the sub-agent\. Defaults are " \+\n\s+"mode-specific \(most fixed modes are read-only; pitfalls, " \+\n\s+"validation, and gap_filler get `bash`\)\. For `custom` " \+\n\s+"mode, the default is `\[\\"read\\", \\"grep\\", \\"find\\", \\"ls\\"\]`\. " \+\n\s+"If you need `bash` for a custom sub-agent, include it here\."/,
    '"Optional read-only tool subset. Allowed values are read, grep, find, and ls; shell and mutation tools are rejected."',
  ],
  [
    "tool description external path",
    /"persisted to the log dir\. target_path is domain-locked to ctx\.cwd unless " \+\n\s+"allow_external_paths is true \(logged\)\. Use the `model` parameter/,
    '"persisted to the log dir. target_path is permanently domain-locked to ctx.cwd. " +\n        "Use the `model` parameter',
  ],
  [
    "resource loader stale bash comments",
    /\s+\/\/ Explorer sub-agents read \(and, for some modes, run\n\s+\/\/ bash against\) untrusted repository content\. Attach the\n\s+\/\/ same defense hook the parent session uses: bash\n\s+\/\/ blacklist, zero-access paths, credential-store block,\n\s+\/\/ and a repository jail on writes\. Without this the\n\s+\/\/ sub-agent would run bash with no blacklist at all\.\n/,
    '\n                // Explorer sub-agents are read-only and use the same explicit\n                // repository-root policy as the parent audit.\n',
  ],
  [
    "outside path error message",
    /`If you really need to read outside ctx\.cwd, set allow_external_paths: true ` \+\n\s+`\(this is logged as a security event\)\.`,/,
    '`Explorer sessions are permanently confined to the repository.`,',
  ],
]);

console.log("final security boundary patches applied");
