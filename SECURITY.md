# Security Policy

## Supported versions

NexTerm is pre-1.0; only the latest tagged release receives security fixes.
Older tags are best-effort.

## Reporting a vulnerability

Please do **not** open a public issue for anything you believe is
exploitable. Use GitHub's **private vulnerability reporting**
(Security → Report a vulnerability) on this repository, or contact the
maintainer directly if you cannot use it.

Include: affected version/tag, platform, reproduction steps or PoC, and your
assessment of impact. You will get an initial response within 7 days; we aim
to ship a fix and a coordinated disclosure note for confirmed issues.

## Scope notes

The following areas hold the most sensitive data and are the highest-value
review targets:

- **Credential vault** (`src-tauri/src/vault.rs`): Argon2id KDF +
  AES-256-GCM at rest; master password never leaves the backend.
- **known_hosts / TOFU** (`src-tauri/src/ssh/mod.rs`): host-key pinning,
  import/export path handling.
- **Log path confinement** (`src-tauri/src/commands/mod.rs`,
  `SessionLogRoot`): IPC log paths must stay inside the configured root.
- **Session logs & scrollback snapshots**: may contain sensitive output;
  stored in user-selected directories / localStorage.
- **ZMODEM & remote-edit scratch files**: written under OS download /
  app-data directories.

Out of scope: vulnerabilities in upstream libraries that are not reachable
from NexTerm's use of them; social engineering of users into approving
host-key prompts.

## Dependency auditing

CI runs `cargo audit` (Rustsec advisory DB) and `npm audit --omit=dev`
on every push; failures block merges. Dev-only npm advisories are triaged
but do not gate.

Vulnerabilities in third-party crates that cannot be upgraded away (e.g.
version-pinned by an upstream dependency) may be ignored in
`src-tauri/.cargo/audit.toml` only with a written justification covering
exposure and a removal condition; entries are re-evaluated on every bump
of the pinning dependency. Currently triaged:

- **RUSTSEC-2023-0071** — `rsa` 0.10.0-rc.18, Marvin Attack (timing side
  channel). Pinned by `russh`'s default `rsa` feature
  (`=0.10.0-rc.18`); an exact pin cannot be overridden by `cargo update`
  or `[patch]`, and disabling the feature would drop ssh-rsa host-key /
  user-key support, breaking servers that still rely on RSA keys.
  Accepted as an SSH **client**: the vulnerable PKCS#1 v1.5
  decryption/blinding path is executed by the SSH server, and our
  client-side RSA use is a handful of signatures per handshake with no
  high-volume timing oracle. Removal condition: upgrade to a russh
  release depending on stable RustCrypto `rsa 0.10` and delete the
  ignore entry in `src-tauri/.cargo/audit.toml`.
