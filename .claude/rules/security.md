# Security

Never commit secrets. The secrets PostToolUse hook runs gitleaks on the edited file only (including untracked text) with redaction enabled.

Do not paste live credentials into source, logs, receipts, or chat. Fixture tokens used in negative tests are concatenated at runtime from inert parts.

If a secret is found: rotate the credential, then remove it. Deleting the line without rotation is not a fix.

Do not disable the secrets hook to land a change.
