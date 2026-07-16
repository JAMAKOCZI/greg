# Capturing ACP fixtures (maintainers)

Phase 5 ships **anonymized** fixtures under `test/fixtures/acp/` derived from
Grok Build / ACP wire shapes (see `xai-org/grok-build` session update tests).

To capture live traffic from a real `grok` binary:

1. Run Greg with a logging bridge or tee agent stdout (do **not** commit secrets).
2. Copy `session/update` notifications that contain `tool_call` / `plan` / diffs.
3. Redact absolute home paths, tokens, and private project names.
4. Drop JSON into `test/fixtures/acp/` and extend `test/cards.test.mjs`.

Never commit `~/.grok/auth.json` or full session transcripts with private code.
