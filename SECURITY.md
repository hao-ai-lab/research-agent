# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT open a public issue.**
2. Use [GitHub Security Advisories](https://github.com/hao-ai-lab/research-agent/security/advisories/new) to report privately.
3. Alternatively, email the maintainers directly (see profile or CODEOWNERS).

We will acknowledge receipt within **48 hours** and aim to release a fix within **7 days** for critical issues.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| `main`  | ✅        |

## Scope

The following are in scope for security reports:

- Hardcoded secrets, API keys, or credentials in code or git history
- Authentication / authorization bypass in the server or hub
- Remote code execution via job sidecar or agent solver
- Sensitive data exposure in logs, error messages, or API responses

## Security Best Practices for Contributors

- **Never commit secrets.** Use environment variables or Modal Secrets.
- All `.env*` files and `.ra-auth-token` are gitignored.
- PRs are automatically scanned for secrets via CI (`gitleaks`).
- Auth tokens are generated locally and never stored in the repo.
