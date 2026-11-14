## What and why

<!-- One logical change. Link the issue if there is one. -->

## How it was tested

- [ ] `npm test` passes
- [ ] `npm run lint` passes
- [ ] New parsing or statistics logic has unit tests (with an anonymized fixture if it comes from a real device)
- [ ] CLI behaviour changes have an integration test against `test/fake-adb.mjs`
- [ ] If I ran it against a real device: only read-only commands, or with the device owner's consent

## Checklist

- [ ] No runtime dependencies added
- [ ] Works on Windows, Linux and macOS (host paths via `node:path`; device paths stay POSIX)
- [ ] Anything sent to the device shell is quoted or validated
- [ ] No serial numbers, LAN IPs, personal paths or e-mails in code, fixtures or docs
- [ ] `CHANGELOG.md` updated under "Unreleased"; README / SKILL.md updated if behaviour changed
