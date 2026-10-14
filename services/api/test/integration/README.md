# Integration tests

These run against a **running API and a real PostgreSQL** — they are the proof that the whole
thing works, not just its parts.

```bash
npm run dev -w @wetasnap/api      # terminal 1
npm run worker -w @wetasnap/api   # terminal 2
npm run smoke -w @wetasnap/api    # terminal 3
```

`npm run smoke` rebuilds the database and seeds it first, so it can be run as often as you like and
always starts from the same place. **It empties the database it points at** — check `DATABASE_URL`
in `services/api/.env` before running it anywhere that matters; the migration runner refuses to
reset when `NODE_ENV=production`.

| File | What it proves |
|---|---|
| `api.mjs` | Sign-in for all three kinds of account, the emailed code, the two doors, lockout wording, LEAD-03/05, idempotent sync, seats, the first-time setup, plan deletion rules, and that one company sees nothing of another |
| `pipeline.mjs` | The quality gate (clear, blurred, dark, too small), cropping, storing a card, the duplicate check and merge, the lead score, the contact timeline, and that a card image needs a session |

The cards in `pipeline.mjs` are drawn by the test itself, so there is no sample data to keep and the
same run works on any machine. Codes are read from the development maildir
(`services/api/storage/mail`), which is where `MAIL_DRIVER=log` writes every message.
