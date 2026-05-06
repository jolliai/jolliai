# Examples

Each folder is a self-contained Content_Folder you can run with `jolli dev`.

## Running an Example

```bash
jolli dev cli/examples/<folder-name>
```

## Examples

| Folder | What It Demonstrates |
|--------|---------------------|
| `minimal/` | Simplest possible site — just title, description, empty nav |
| `nav-links/` | Legacy `nav` field with flat navbar links |
| `header-dropdowns/` | `header.items` with direct links and dropdown menus |
| `footer-config/` | Footer with copyright, link columns, and social icons |
| `sidebar-overrides/` | Custom sidebar labels, ordering, separators, and external links |
| `theme-forge/` | Forge theme pack with custom branding, header, footer, sidebar |
| `theme-atlas/` | Atlas theme pack for an internal engineering handbook |
| `openapi-spec/` | OpenAPI spec auto-detected and rendered as API reference pages |
| `path-mappings/` | Remap source folder paths to different site URLs |

## Reference

See [site-json-reference.md](../docs/site-json-reference.md) for full documentation of all `site.json` fields.
