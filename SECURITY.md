# Security Policy

This document describes how to run the Revolut X **CLI (`revx`), MCP server, skills, and SDK** safely. These tools hold credentials that authorize **real trades with real money** on your Revolut X account — treat them with the same care as any other financial credential.

For vulnerability reports, see [Responsible disclosure](#responsible-disclosure) at the bottom of this document.

---

## Threat model at a glance

| Threat | Why it matters here | Primary mitigations |
| ------ | ------------------- | ------------------- |
| **Credential theft** (private key or API key exfiltrated) | Full trading access on your Revolut X account | Owner-only file permissions (enforced), password-protected PEM, per-purpose API keys, sandboxing |
| **Prompt injection via market data** (malicious text in ticker/order fields rendered to the agent) | Agent could follow injected instructions to place unintended trades | Keep MCP read-only, never combine this MCP with a shell/filesystem tool in the same session, require human approval for CLI trades |
| **Excessive agency** (OWASP LLM08) — autonomous agent executes trades without human review | Irreversible financial loss | Do not auto-approve `revx` commands, do not expose `revx` to agent `Bash` tools, set per-API-key daily limits on Revolut X |
| **Supply-chain compromise** (malicious npm dep or tampered MCP bundle) | Backdoored code runs with your user privileges and credentials | Pin versions, verify SBOMs, avoid `npx` for long-running processes, run in a sandbox |
| **Local compromise** (other process on the host reads `~/.config/revolut-x/`) | Key exfiltration without authentication | File permissions (`0o600`, enforced on load), full-disk encryption, dedicated user account for trading |
| **Grid-bot / monitor runaway** (long-running process keeps trading after intent changes) | Unbounded losses | Kill-switch procedure, Telegram alerts, per-API-key rate/spend caps, watchdog |

---

## 1. Principles

1. **Least privilege** — give each tool the smallest set of credentials, network destinations, filesystem paths, and operations it needs.
2. **Defense in depth** — don't rely on any one control. File permissions + sandbox + network allowlist + API-key scoping each catch a different failure mode.
3. **Human in the loop for writes** — automated read-only analysis is fine; **every order placement or cancellation should be reviewed by a human** unless you have explicitly accepted the risk of autonomous trading with a spend cap.
4. **Isolate environments** — separate machines, accounts, or containers for trading vs. development vs. personal use.

---

## 2. Credential hygiene

- **Two credentials exist per install**: the Ed25519 `private.pem` (signs every request) and the `api_key` stored in `config.json` (identifies the account). A compromise of **either one alone is not sufficient** to trade — both are required — but treat them as a single secret.
- **File permissions are enforced.** The SDK refuses to load `private.pem` or `config.json` if their mode is looser than `0o600`. If you see an *"insecure permissions"* error, run `chmod 600 ~/.config/revolut-x/<file>`. Do not work around this check.
- **Password-protect the PEM.** Wrap the key in a passphrase so a filesystem-level leak is not immediately usable:

  ```bash
  openssl pkcs8 -topk8 -in private.pem -out private.enc.pem
  # Enter a strong passphrase when prompted; store it in your password manager, not in a file.
  mv private.enc.pem private.pem
  ```

  The SDK will prompt for the passphrase on load.

- **Use per-purpose API keys.** Revolut X lets you issue multiple API keys per account. Use a separate key for each surface:
  - one for the CLI on your workstation
  - one for the MCP server
  - one for each grid bot / long-running process
  - one labelled **agentic** for AI-agent-driven sessions (only these keys reach agentic endpoints, and they must include the custom MCP headers the backend enforces)
  
  If one key is compromised, you revoke only that key.

- **Rotate on a schedule** (e.g. quarterly) and immediately if a machine is lost, shared, or re-provisioned. Rotate in Revolut X → Profile → API Keys; then run `revx configure`.

- **Never commit credentials.** The config directory is outside the repo by design. Do not back it up to a public cloud folder, a dotfiles repo, or a Dropbox/iCloud folder shared with other users.

- **Full-disk encryption is cheap insurance** — enable FileVault (macOS), BitLocker (Windows), or LUKS (Linux).

---

## 3. Running the MCP server safely

The MCP server is **read-only by design** (no order placement, modification, or cancellation). All risk therefore comes from the surrounding environment, not from the MCP server's own tools.

### 3.1 Trust the MCP host

The MCP server inherits the trust boundary of its host (Claude Desktop, Claude Code, Cursor, VS Code, custom MCP client). In particular:

- **Claude Desktop** cannot execute shell commands or read arbitrary files by default — this is the recommended host for a low-risk setup.
- **Claude Code / Cursor / VS Code** can execute shell commands via their `Bash` (or equivalent) tools when the user approves them. In these hosts, you **must not combine this MCP server with unsupervised `Bash` access to the same shell that has `revx` on PATH** — an injected prompt from market data could instruct the agent to run `revx order place …`. See §5.
- **Remote / hosted MCP hosts**: do not send your Revolut X credentials to a third-party MCP proxy. Run the server locally; keys must stay on the machine you control.

### 3.2 Network isolation

The **MCP server** talks to one host only: `https://revx.revolut.com` (overridable via the `REVOLUTX_API_URL` environment variable, which you should only use for testing against a mock server). It does **not** call Telegram or any other third-party service — that is a CLI-only surface, covered separately in §4.6.

- **Firewall / egress proxy** — if your platform allows per-process network policy, scope the server to this FQDN.
- **Container example** (Docker / Podman) — use a dedicated network with only the Revolut X endpoint reachable:

  ```bash
  docker run --rm -i \
    --network=none \
    --dns=1.1.1.1 \
    -v ~/.config/revolut-x:/config:ro \
    -e REVOLUTX_CONFIG_DIR=/config \
    revolutx-mcp
  # Then add an explicit egress allow for revx.revolut.com via your firewall / proxy.
  ```

- **Block** outbound connections to internal networks (RFC 1918 ranges, `169.254.0.0/16`, `127.0.0.0/8` beyond loopback) — prevents SSRF-style attacks that exfiltrate to metadata endpoints or local admin panels.

### 3.3 Filesystem sandboxing

The server reads exactly one directory: `~/.config/revolut-x/` (override with `REVOLUTX_CONFIG_DIR`).

- **Mount read-only.** In a container, bind-mount the config directory with `:ro`; the server does not need write access.
- **Do not mount** `$HOME`, the project tree, SSH keys, browser profiles, cloud credentials, or any other path. The MCP server has no reason to read them.
- **macOS** — consider running under `sandbox-exec` with a profile that only allows reading the config directory and networking to `revx.revolut.com`.
- **Linux** — `systemd-run --user --property=ProtectHome=true --property=ReadOnlyPaths=…` or a minimal Docker image gives equivalent isolation.

### 3.4 Treat MCP tool output as untrusted

Tickers, order books, fills, and order comments flow through the MCP server from the Revolut X API into your agent's context. **Do not treat the text content of these fields as trusted instructions.** Prompt-injection mitigations:

- Keep the MCP read-only so an injected *"cancel all orders"* is not actionable through this server.
- Do not pair this MCP with a shell tool that has `revx` on PATH in the same session (see §5).
- Review agent summaries of market data before acting on them.

---

## 4. Running the CLI (`revx`) safely

The CLI **can place, modify, and cancel orders**. Every hardening recommendation here matters more than for the MCP server.

### 4.1 Dedicated, unprivileged user

- Do not run `revx` as `root` / Administrator.
- Consider a dedicated OS user account for trading, with its own `~/.config/revolut-x/`. This isolates credentials from your daily browsing, Slack, and developer tools.

### 4.2 Review every write

- `revx order place`, `revx order cancel`, and `revx strategy grid run` move real money. **Never** pipe them from an AI agent without human approval.
- In Claude Code / Cursor, add `Bash(revx order *)` to your **deny list**, not your allow list. The infosec team's recommended scanner blacklist includes `revx` precisely because an agent with shell access and `revx` on PATH is effectively an autonomous trader.
- Use `--dry-run` on grid strategies to verify configuration before committing real capital.

### 4.3 Start small, scale deliberately

- Test with the smallest tradeable quantity first. Crypto pairs on Revolut X have minimum order sizes — use exactly that.
- Set a **per-API-key daily spend cap** on Revolut X where supported.
- Enable **MFA** on the underlying Revolut X account, and on your Revolut app.

### 4.4 Long-running processes (grid bot, monitor)

- Run in a dedicated container or VM — **not** on the same workstation you browse with.
- Enable the Telegram connector (`revx connector telegram …`) so that trades, errors, and circuit-breaks alert you in real time.
- Understand the **kill switch**: how do you stop the bot? (`Ctrl-C`, `pkill -f revx`, revoking the API key in Revolut X). Write this down before you start.
- Protect the state files (`telegram.json`, `grid_state_*.json`) — the CLI writes them `0o600`, but verify with `ls -l ~/.config/revolut-x`.
- Back up state files if losing them would be expensive; restore them atomically (move into place, don't edit in flight).
- Re-check the bot config after any dependency update — re-read its output for 15 minutes before leaving it unattended.

### 4.5 Updates

- Watch the [GitHub Releases](https://github.com/revolut-engineering/revolut-x-api/releases) page.
- Subscribe to security advisories — the repository publishes them via GitHub's Security tab.
- Each release ships with an SBOM (`sbom-api.json`, `sbom-cli.json`, `sbom-mcp.json`). Run your preferred vulnerability scanner against them (e.g. `trivy sbom …`, `grype sbom:…`).

### 4.6 Network destinations

Unlike the MCP server, the CLI reaches up to **two** external hosts:

- `https://revx.revolut.com` — always. The base URL is overridable via the `REVOLUTX_API_URL` environment variable (for testing only).
- `https://api.telegram.org` — **only** when the Telegram connector is configured via `revx connector telegram add …`. The bot token is embedded in the URL path; the CLI does not proxy Telegram traffic through any other host.

Implications for firewall / egress-proxy allowlists:

- Using Telegram alerts → allow both hosts.
- Not using Telegram alerts → allow **only** `revx.revolut.com`.
- You can stop the outbound Telegram calls at any time with `revx connector telegram disable <id>` (keeps the connection in the store but suspends it) or `revx connector telegram delete <id>` (removes it entirely).

No other outbound destinations are used by the CLI. If your monitoring tools show traffic to any other host originating from `revx`, treat it as a compromise indicator and follow §8 *Incident response*.

---

## 5. Agentic / autonomous usage (very important)

OWASP LLM08 (*Excessive Agency*) is the dominant risk when combining this project with an AI agent. Applies to Claude Code, Cursor, custom MCP clients, or any automated wrapper.

### 5.1 Do

- Use the MCP server for **analysis and read-only tool calls** — that's what it is built for.
- Keep human approval in the loop for any operation under `revx order *` or `revx strategy grid run`.
- Label the API key used in agentic sessions as **agentic** in Revolut X — the backend enforces that only those keys can accept requests from agent-origin MCP headers.
- Add this to your Claude Code `settings.json` (adjust paths to your setup):

  ```json
  {
    "permissions": {
      "deny": [
        "Bash(revx order*)",
        "Bash(revx strategy*)",
        "Bash(revx connector*)",
        "Bash(revx configure*)"
      ]
    }
  }
  ```

- If you must let an agent run `revx` at all (for read commands), prefer explicit allowlist: `Bash(revx account balances)`, `Bash(revx market ticker *)`, etc. Never allow `Bash(revx *)` or `Bash(*)`.

### 5.2 Don't

- Don't expose the `revx` CLI to the same agent session that renders untrusted text (market data, news, order comments).
- Don't run the MCP server and an unconstrained shell tool from the same client without a denylist in place.
- Don't enable auto-approve for shell commands when `revx` is on PATH.
- Don't store the Revolut X private key on a machine that also hosts agent-driven long-running daemons unless the daemons are in a separate user account or container.

---

## 6. Installation integrity

- **Install from trusted sources only**:
  - npm: `api-k9x2a`, `cli-k9x2a` (published from this repository's `release.yml` workflow).
  - MCP: the `revolutx-mcp.mcpb` artifact attached to each GitHub Release, **or** a local build from a signed commit.
  - Do not install forks or rewrapped packages without reviewing their diff against this repository.
- **Pin dependencies.** `npm ci` against the committed `package-lock.json` gives you a reproducible install.
- **Verify SBOMs.** Each release includes CycloneDX SBOMs. Scan them before deploying to a trading machine.
- **Our GitHub Actions workflows pin each `uses:` to a commit SHA** — a tag on `actions/*` cannot be hijacked by force-pushing the tag. If you fork the workflows, preserve the SHA pins.

---

## 7. Skills (Claude Code plugin)

The `skills/` folder contains Claude Code skills that teach the agent how to use `revx` commands. Important to understand:

- Skills are **instructions**, not executables. They are Markdown content loaded into the agent's context. A skill cannot itself read files, hit the network, or run commands.
- When the agent acts on a skill's instructions, it uses the normal tools (Bash, etc.) that *you* have approved — the skill just tells it which commands exist. All the CLI safety controls in §4 and §5 apply.
- Only enable skills from this repository or forks you have audited. Skills from an untrusted source can prompt the agent to run arbitrary commands as soon as it reads them.
- Review skill content before enabling: `cat skills/*/SKILL.md`.

---

## 8. Incident response

If you believe a credential has been exposed, or you see unexplained trading activity:

1. **Revoke the API key** in Revolut X → Profile → API Keys → Revoke. This invalidates every outstanding signature and is the fastest containment.
2. **Cancel outstanding orders** manually from the Revolut X web UI (do not rely on a possibly-compromised CLI).
3. **Rotate the Ed25519 keypair** (`rm ~/.config/revolut-x/private.pem ~/.config/revolut-x/public.pem`, then `revx configure generate-keypair`). Register the new public key.
4. **Audit the host** — was the machine, account, or container reachable by someone else? Are there new cron jobs, launch agents, SSH keys, or processes?
5. **Report it** via [Responsible disclosure](#responsible-disclosure) if the root cause is a bug in this project; report to Revolut directly if the root cause is on the exchange side.

---

## Responsible disclosure

Security bugs in the code of this repository should be reported **privately**, not via public issues or pull requests.

1. Preferred: open the repository's [Security tab](https://github.com/revolut-engineering/revolut-x-api/security) and click **"Report a vulnerability"** to use GitHub Private Vulnerability Reporting. If that button is not visible, PVR has not been enabled on this repo — use the fallback below.
2. Fallback: contact the maintainers directly using the contact details on their GitHub profiles (see the repository's [Contributors list](https://github.com/revolut-engineering/revolut-x-api/graphs/contributors)). Prefix the subject with **"SECURITY"** so it is not mistaken for a feature request.

Please include a clear description, reproduction steps, affected version(s), and impact. We target acknowledgement within **3 business days** and a fix within **90 days** for non-critical issues; critical issues are prioritized. Reporters are credited in the advisory unless they ask otherwise.

Out of scope here: issues in the upstream Revolut X API (report to Revolut), vulnerabilities in third-party dependencies not reachable from our code, and social engineering against your own environment.
