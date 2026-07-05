// Defense-in-depth patterns for the builder subprocess.
// Source of truth for the bash blacklist and secret-path blocks.
//
// The defense tool_call hook (`../defense-hook.ts`) applies these in
// multiple layers:
//   1. SHELL_OPERATORS_REGEX — reject compound bash (&&, ||, ;, |,
//      backticks, $(), redirects) BEFORE any other check. Stops
//      payloads like `npm test && rm -rf` that would pass a naive
//      whitelist match on `npm test`.
//   2. BLACKLIST — pattern + label pairs below. Each entry is a
//      regex matched against the full command string. Categories:
//      recursive deletes, force push, dangerous resets, env dumps,
//      network exfil, raw network, privilege escalation, world-
//      writable chmods, setuid, mount, RCE, package install, raw
//      device writes, system control, scheduled tasks, and
//      interactive editors (TTY hijack risk).
//   3. Secret-path blocks — read/write/edit on `.env*`, `secrets.*`,
//      `~/.ssh/`, `/etc/`.
//
// CRITICAL RULE: the blacklist must NOT whitelist interpreters
// (`python`, `node`, `bash`) as bare commands. Pin to specific
// scripts only. A bare `python` would let a context-decayed LLM
// escape into arbitrary code execution.

/** Compound bash operators. Pre-rejected before any other check. */
export const SHELL_OPERATORS_REGEX = /(&&|\|\||;|\||`|\$\(|>|<)/;

export type BlacklistEntry = {
  pattern: RegExp;
  label: string;
};

/** Bash command patterns the subprocess is never allowed to run. */
export const BLACKLIST: ReadonlyArray<BlacklistEntry> = [
  // ===== File destruction (Phase 1.4 — expanded) =====
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*|--recursive\s+--force|--force\s+--recursive)\s+\S+/, label: "recursive delete" },
  // find -delete (catastrophic when targeting a non-empty dir)
  { pattern: /\bfind\b[^\n]*\s+-delete\b/, label: "find -delete" },

  // ===== VCS damage =====
  { pattern: /\bgit\s+push\s+(--force|-f)\b/, label: "force push" },
  { pattern: /\bgit\s+reset\s+--hard\b/, label: "destructive reset" },
  { pattern: /\bgit\s+clean\s+(-[a-z]*f|-f[dqxX]?)\b/, label: "git clean -fd" },
  { pattern: /\bgit\s+checkout\s+--\s+\./, label: "git checkout -- discard all" },

  // ===== Process killing (Phase 1.4 — expanded) =====
  { pattern: /\bkill\s+(-9|-SIGKILL)\s+-1\b/, label: "kill all processes" },
  { pattern: /\bkillall\s+(-9|--signal\s+SIGKILL)\b/, label: "killall -9" },
  { pattern: /\bpkill\s+(-9|--signal\s+SIGKILL)\b/, label: "pkill -9" },

  // ===== SQL mass-delete (Phase 1.4 — added) =====
  { pattern: /\bDELETE\s+FROM\s+\S+\s*(?!WHERE)/i, label: "SQL DELETE without WHERE" },
  { pattern: /\bTRUNCATE\s+(TABLE|)\s*\S+/i, label: "SQL TRUNCATE" },
  { pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\s+/i, label: "SQL DROP" },

  // ===== setuid/setgid/sticky (Phase 1.4 — symbolic forms) =====
  { pattern: /\bchmod\s+(-R\s+)?777\b/, label: "world-writable chmod 777" },
  { pattern: /\bchmod\s+(-R\s+)?666\b/, label: "world-writable chmod 666" },
  { pattern: /\bchmod\s+(-R\s+)?[124][0-7]{3}\b/, label: "setuid/setgid/sticky chmod (numeric)" },
  { pattern: /\bchmod\s+(-R\s+)?\+s\b/, label: "setuid/setgid (symbolic +s)" },
  { pattern: /\bchmod\s+(-R\s+)?(u|g|o)\+s\b/, label: "setuid/setgid (symbolic u/g/o+s)" },
  { pattern: /\bchown\s+-R\s+root\b/, label: "ownership change to root" },

  // ===== Network configuration (Phase 1.4 — added) =====
  { pattern: /\b(iptables|ufw|firewalld)\b/, label: "firewall configuration" },
  { pattern: /\bip6?tables\b/, label: "iptables" },

  // ===== Filesystem mount (Phase 1.4 — added) =====
  { pattern: /^\s*(mount|umount)\b/, label: "filesystem mount/umount" },

  // ===== RCE via interpreter =====
  { pattern: /\bcurl\b[^|;&]*\|\s*(bash|sh|zsh|python|node)\b/, label: "curl pipe to shell (RCE)" },
  { pattern: /\bwget\b[^|;&]*\|\s*(bash|sh|zsh|python|node)\b/, label: "wget pipe to shell (RCE)" },
  { pattern: /\bcurl\b[^|;&]*\|\s*(sudo\s+)?(bash|sh)\b/, label: "curl pipe to bash with sudo" },

  // ===== Install from URL (Phase 1.4 — added) =====
  { pattern: /\b(pip|pip3|python\s+-m\s+pip)\s+install\s+https?:\/\//, label: "pip install from URL" },
  { pattern: /\bnpm\s+install\s+https?:\/\//, label: "npm install from URL" },
  { pattern: /\bbun\s+(add|install)\s+https?:\/\//, label: "bun add from URL" },
  { pattern: /\bcurl\s+[^|;&]*\|\s*npm\s+install/i, label: "curl pipe to npm install" },

  // ===== System package install (Phase 1.4 — added) =====
  { pattern: /\bapt(-get)?\s+install\b/, label: "apt install" },
  { pattern: /\byum\s+install\b/, label: "yum install" },
  { pattern: /\bdnf\s+install\b/, label: "dnf install" },
  { pattern: /\bpacman\s+-S\b/, label: "pacman -S" },
  { pattern: /\bbrew\s+install\b/, label: "brew install" },

  // ===== Service control (Phase 1.4 — added) =====
  { pattern: /\bsystemctl\s+(start|stop|restart|enable|disable|reload)\b/, label: "systemctl service control" },
  { pattern: /\bservice\s+\S+\s+(start|stop|restart)\b/, label: "service control" },

  // ===== User management (Phase 1.4 — added) =====
  { pattern: /\b(useradd|userdel|groupadd|groupdel)\b/, label: "user/group management" },
  { pattern: /\bpasswd\b/, label: "password change" },

  // ===== chroot (Phase 1.4 — added) =====
  { pattern: /^\s*chroot\b/, label: "chroot" },

  // ===== Env dump =====
  { pattern: /\b(env|printenv)\b/, label: "env dump" },
  // Env variable reference in echo/printf. The SHELL_OPERATORS pre-check
  // blocks `echo $FOO > file` (the `>` triggers it), so reaching the
  // blacklist here means the agent is trying to read the value into
  // the LLM context. Catch it.
  { pattern: /\b(echo|printf)\s+(?:\$|\\\${)[A-Z_][A-Z0-9_]*/, label: "env variable reference in echo/printf" },
  // Procfs environ dump.
  { pattern: /\bcat\s+\/proc\/(self|\d+)\/environ\b/, label: "procfs environ dump" },

  // ===== Exfil =====
  { pattern: /\bcurl\b[^|;&]*(-T\b|--upload-file\b|--upload\b|--data\b|-d\b)\b/, label: "curl upload / data" },
  { pattern: /\b(nc|netcat)\b/, label: "raw network" },

  // ===== Privilege / ownership (additional) =====
  { pattern: /\bsudo\b/, label: "privilege escalation" },

  // ===== Filesystem format =====
  { pattern: /\bmkfs\b/, label: "filesystem format" },

  // ===== Scheduled task injection =====
  { pattern: /\b(crontab|\bat\b)\s+/, label: "scheduled task injection" },

  // ===== TUI hijack =====
  { pattern: /^\s*(vi|vim|nano|emacs)\b/, label: "interactive editor" },

  // ===== Raw device write =====
  { pattern: /\bdd\s+[^|;&]*\bof=\/dev\//, label: "raw device write" },

  // ===== System control =====
  { pattern: /\b(shutdown|poweroff|reboot|halt)\b/, label: "system control" },

  // ===== Direct reads of secret files (Phase 1.4 — added) =====
  // The LLM can read .env via `cat`, `head`, `tail`, `less`, `grep`,
  // or input redirection. These pass SHELL_OPERATORS (no compound
  // operators) but are still secret reads.
  {
    pattern: /\b(cat|head|tail|less|more|strings|xxd|od|file)\s+[^\n|;&]*\.env(\.|$|\s)/,
    label: "env file read (cat/head/tail/less/...)",
  },
  { pattern: /\bgrep\b[^\n|;&]*\s+\.env(\.|$|\s)/, label: "env file grep" },
  { pattern: /<\s*\.env(\.|$|\s)/, label: "env file read (input redirection)" },
  {
    pattern: /\b(cat|head|tail|less|more)\s+[^\n|;&]*\~?\/?\.ssh\//,
    label: "ssh key read",
  },
  {
    pattern: /\b(cat|head|tail|less|more)\s+[^\n|;&]*\bsecrets\./,
    label: "secrets file read",
  },
];

/**
 * Paths/files the subprocess is never allowed to read or write.
 * Enforced by the defense hook on `read`, `write`, and `edit` tool calls
 * (not just `bash` — the LLM can reach these via the `read` tool
 * directly, which doesn't go through SHELL_OPERATORS).
 *
 * Phase 1.4 fix: the regex now excludes `.env.sample`, `.env.example`,
 * `.env.template` (the canonical "this is a template" suffixes) via
 * a negative lookahead. This closes the false-positive on the
 * `read .env.sample` case.
 */
export const ZERO_ACCESS_PATH_REGEX = /(\.env(?!\.sample(?:\..*)?$|\.example(?:\..*)?$|\.template(?:\..*)?$)|secrets\.(?!sample(?:\..*)?$|example(?:\..*)?$|template(?:\..*)?$)|~?\/?\.ssh\/|\/etc\/)/;
