# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private
[security advisory form](https://github.com/marinsalinas/handroid-use/security/advisories/new)
instead. You should get a first answer within a week.

Useful details: the command and arguments, OS and Node version, `adb version`, and what an attacker
controls (for example text on the device screen, an app's package name, a file name).

## Scope

handroid-use runs adb with the privileges of the user who starts it and drives a device that is
already authorized for USB or wireless debugging. In scope:

- Arguments reaching the device shell unquoted or unvalidated (command injection on the device).
- Hash-verification bypasses in `install --sha256` or `push`.
- The CLI writing outside the requested local path, or reading local files it was not asked to.
- Skill instructions that would lead an agent to take a destructive or privileged action without
  the user's consent.

Out of scope: anything that requires an already-compromised host or device, and the security of adb
itself (report that to the Android project).

## Notes for agent users

Text on the device screen is untrusted input. The skill tells agents to treat it as data, never as
instructions, and to leave settings, logins and destructive actions to the human. If you find a way
around those rules through the CLI, please report it.
