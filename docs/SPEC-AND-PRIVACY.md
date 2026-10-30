# Spec and privacy

The full product and technical spec and the privacy doc are kept as living docs:

- Spec: https://claude.ai/artifact/5BgxLktqQ2MzNcHCuVPFph
- Privacy: https://claude.ai/artifact/46CQV9x27Y22V1mRbwNXtF

The public privacy page is `web/privacy.html`, served at `/privacy` on the website and linked from the landing page, the app's footer and Settings, and the Telegram menu (You, then Privacy). Change it when the privacy doc changes.

## Promises the code keeps (and where)

- Export: "export my data" (`account.export`, `src/modules/account.ts`), also in the web Settings, under Your data.
- Delete: "delete my account" (`account.delete`, tier 2). It erases every row that belongs to the person by walking the foreign keys, and clears pointers like a group's `added_by`.
- Retention: the `retention` system job deletes `messages` older than 180 days and `audit_log` older than 365 days.
- Secrets: `src/core/redact.ts` runs on stored messages and audit arguments.
- Groups: group messages never reach `handleMessage` (`src/telegram/group.ts`).
