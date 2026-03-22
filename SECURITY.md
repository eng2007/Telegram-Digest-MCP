# Security

## Supported use

This project is intended for:

- Telegram chats the authenticated user already has access to
- local summarization workflows
- local MCP integrations

It is not intended for bypassing access controls, impersonation, or hidden collection of third-party chat data.

## Sensitive data

Depending on your setup, the following data may exist locally:

- `.env` with API keys
- `.telegram-session.txt` with Telegram session data
- `.state/checkpoints.json`
- `.cache/summary-chunks/`
- `output/` reports and normalized messages

Treat these as sensitive.

## Hardening recommendations

- Keep the repository private if reports contain sensitive discussions.
- Use separate API keys for development and production use.
- Rotate LLM keys if they are ever exposed.
- Avoid committing generated summaries when they contain private content.
- Review what is sent to external LLM providers before enabling shared or hosted deployments.

## Reporting a vulnerability

If you discover a security issue, do not publish secrets or exploit details in a public issue.

Include:

- affected version or commit
- reproduction steps
- impact
- suggested mitigation if known
