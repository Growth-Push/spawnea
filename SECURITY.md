# Security Policy

## Supported versions

Spawnea is pre-MVP software. Until the first public release, only the latest commit on the default branch is considered supported.

## Reporting a vulnerability

Please do not open a public issue for vulnerabilities involving credential exposure, command execution, SSH handling, file transfer, sandbox escapes, or other security-sensitive behavior.

Report security concerns privately to the repository maintainers through [GitHub Security Advisories](https://github.com/Growth-Push/spawnea/security/advisories/new) or by creating a private report under the repository [Security tab](https://github.com/Growth-Push/spawnea/security/advisories).

Include, when possible:

- affected version or commit;
- reproduction steps;
- impact;
- relevant logs or screenshots with secrets removed;
- any suggested mitigation.

## Security-sensitive areas

Spawnea interacts with remote shells and developer machines. Changes involving the following require extra care:

- SSH authentication and host verification;
- shell command construction and quoting;
- local/remote filesystem paths;
- clipboard and file uploads;
- tmux command execution;
- IPC between Electron processes;
- artifact previews and untrusted file content;
- credentials, environment variables, and logs.

Artifacts detected in terminal output may point at files outside the project.
Only absolute and `~/` paths are accepted (`../` is rejected); the real target of
symlinks is resolved and re-checked; only png, jpg/jpeg, gif, webp, pdf, md, txt,
yaml/yml, json, toml, csv, ini, and conf are allowed; content must match the file
signature or be non-binary text; SVG is rejected; and the existing exclusion list
still applies. Previews read the original file and never copy it into the artifact
cache. Remote hosts are not validated for this behavior yet.

Never commit private keys, access tokens, passwords, or production secrets.

SSH connections verify the server key strictly against the user's OpenSSH
`~/.ssh/known_hosts` file. Unknown hosts, changed keys, revoked keys (`@revoked`
markers), mismatched port endpoints, and malformed entries are rejected; Spawnea
does not implement trust-on-first-use or persist host keys.

