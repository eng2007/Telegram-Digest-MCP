# Contributing

Thanks for considering a contribution.

## Development workflow

1. Fork the repository.
2. Create a feature branch.
3. Install dependencies:

```bash
npm install
```

4. Run checks before opening a PR:

```bash
npm test
npm run check
```

## Project structure

- `src/index.js` CLI entrypoint
- `src/mcp-server.js` MCP stdio server entrypoint
- `src/lib/config.js` shared config and persistence helpers
- `src/lib/telegram.js` Telegram client and message normalization
- `src/lib/summarizer.js` LLM calling and chunk summarization
- `src/lib/reports.js` markdown, JSON, and HTML report generation
- `config/` runtime configuration files
- `test/` automated tests

## Contribution guidelines

- Keep changes focused and small when possible.
- Add or update tests when behavior changes.
- Do not commit secrets, `.env`, session files, or generated output.
- Preserve the project's legal/safe-use posture:
  only support chats the authenticated user already has legitimate access to.

## Pull requests

A good PR should include:

- what changed
- why it changed
- how it was tested
- any migration or config impact
