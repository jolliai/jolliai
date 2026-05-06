# Footer Config Example

This example demonstrates a fully configured footer with:

- **Copyright text** — displayed at the bottom of the page
- **Link columns** — Product, Developers, Company — each with a title and list of links
- **Social links** — GitHub, Twitter, Discord, LinkedIn, YouTube icons rendered in canonical platform order

Scroll to the bottom of the page to see the footer.

## How It Works

The `footer` block in `site.json` accepts three optional fields:

- `copyright` — a string displayed as copyright text
- `columns` — an array of `{ title, links }` objects
- `socialLinks` — an object with platform names as keys and URLs as values

When `footer` is omitted or all fields are empty, a bare default footer is rendered instead.
