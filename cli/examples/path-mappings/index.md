# Path Mappings Example

This example demonstrates `pathMappings` — remapping source folder paths to different locations in the generated site.

## What's Happening

The source folder has:
- `sql-docs/` — SQL reference documentation
- `api-docs/` — API reference documentation

But we want the site to show them under:
- `reference/sql/`
- `reference/api/`

The `pathMappings` in `site.json` handles this:

```json
{
  "pathMappings": {
    "sql-docs": "reference/sql",
    "api-docs": "reference/api"
  }
}
```

This is useful when your source folder structure doesn't match the URL hierarchy you want.
