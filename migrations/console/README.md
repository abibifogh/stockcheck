# Console-ready migrations

**These are the files to paste into the Cloudflare D1 console.** They are the
same SQL as the migrations one directory up, with the comments removed.

## Why they exist

Cloudflare's D1 console rejects a paste whose first statement is a comment:

> The request is malformed: Requests without any query are not supported.

It strips the leading `--` lines, finds nothing left to run, and gives up on the
whole paste — including the perfectly good SQL further down. Every migration
opens with a comment block explaining why it exists, which is right for the
repository and fatal in the console. So each one gets a second copy here with
the comments taken out.

## Running one

1. Cloudflare dashboard → **Workers & Pages** → **D1** → `breakfast` → **Console**
2. Open the file here for the migration you need, copy **all** of it
3. Paste, and run

They apply in filename order. Running one you have already run is safe — every
statement is `IF NOT EXISTS` or `OR IGNORE` — with one exception noted below.

## The one that cannot be run twice

`0010_bakery.sql` ends with `ALTER TABLE ingredients ADD COLUMN is_produced`.
SQLite has no `ADD COLUMN IF NOT EXISTS`, so a second run stops there with
**"duplicate column name: is_produced"**. That message means the column is
already there and there is nothing to do — everything else in the file has
already succeeded by the time it is reached, which is why the statement is last.

## Keeping these in step

Regenerate after adding or editing a migration:

```bash
npm run sql:console
```

Do not edit the files in this directory by hand — they are generated, and the
next run will overwrite them. Edit the migration itself.
