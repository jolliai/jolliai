# Pet Store API Documentation

Welcome to the Pet Store API docs. This example demonstrates how OpenAPI spec files are automatically detected and rendered as interactive API reference pages.

## How It Works

Place any `.yaml`, `.yml`, or `.json` file containing a valid OpenAPI spec in your content folder. Jolli automatically:

1. Detects the file as an OpenAPI spec (by checking for `openapi` and `info` fields)
2. Parses operations, parameters, request bodies, and responses
3. Generates per-endpoint MDX pages with code samples (cURL, JS, TS, Python, Go)
4. Renders an interactive Try It widget for each endpoint

Check the **API Reference** link in the header to see the rendered spec.
