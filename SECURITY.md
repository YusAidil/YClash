# Security Policy

## Reporting a vulnerability

Please do not report security vulnerabilities in public issues. Use GitHub's private vulnerability reporting for this repository, or contact the repository owner privately if that feature is unavailable. Do not include production tokens, passwords, private keys, or user data in a report.

## Secrets and user data

- Keep `.env`, API keys, Discord bot tokens, SSH keys, and certificates out of Git.
- Keep the `data/` directory and backups private; they contain account and timer data.
- Rotate any credential that is accidentally committed or exposed.