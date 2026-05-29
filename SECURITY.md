# Security

StandupScribe is a prototype and is not production-hardened.

## Credentials
- Put local secrets in `src/.env` or `src/.env.local`.
- Never commit `.env`, `.env.local`, or other secret-bearing env files.
- Use `src/.env.example` as the public template.

## Key handling
- Runtime API keys may also be stored in the local SQLite settings database.
- The UI masks saved keys.
- Secrets should never be written to application logs.

## Reporting
If you find a vulnerability, please open a GitHub issue with reproduction details and impact.
