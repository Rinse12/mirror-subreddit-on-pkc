# AGENTS.md

- `README.md` is the design. Read it before writing code, and keep it in sync with what is built.
- Model the project layout on [../onlycats-poster](../onlycats-poster): TypeScript, vitest, a `data/` dir for signers and state, systemd units in `deploy/`.
- Media links are kept as is. Don't add re-uploading.
- One bot signer per community. Never create keys that stand in for individual Reddit users.
- Custom page sorts follow the pattern of [../active-page-sort](../active-page-sort) and the pkc-js `settings.pages` docs.
- A bug fix starts with a test that goes red on the bug: a real page saved under `tests/fixtures/`, a recorded API answer, a database state. Fix until it is green and keep the test.
- Before every commit or push, the whole suite is green: `npm test` and `npm run type-check`.
