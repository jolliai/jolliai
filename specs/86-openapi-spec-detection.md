# OpenAPI Spec Detection

## Topic Statement

Sniff arbitrary `.json`, `.yaml`, and `.yml` files in the source content tree for OpenAPI 3.x structural markers without relying on filename conventions, returning a parsed document when the markers match and a null result otherwise.

## Scope

In scope: parsing JSON and YAML 1.2 file contents; checking the parsed result for the two structural markers required by the OpenAPI specification (a top-level `openapi` field and a top-level `info` object); reporting whether a given file extension is one this stage will attempt to sniff at all; tolerating parse failures by treating them as "not OpenAPI" rather than aborting the build.

Out of scope: walking `paths`, resolving `$ref` pointers, validating that operations have unique `(tag, operationId)` pairs, or producing the intermediate representation downstream emitters consume — those happen in a later parsing stage. Filename-based shortcuts are also out of scope: a file named `openapi.json` is not treated specially, and a file with an unrelated name is not skipped.

## Data Contracts

Inputs:
- `content` — the full text of a single file, as a string.
- `ext` — the file extension including the leading dot, case-insensitive (`.json`, `.yaml`, `.yml`, or anything else).

Outputs:
- A parsed OpenAPI document object when both structural markers are present.
- A null result when the file fails to parse, the parsed result is not a plain object, the `openapi` marker is missing or not a non-empty string, or the `info` marker is missing or not a non-null object.

A separate predicate reports whether an extension is in the sniff-eligible set (`.json`, `.yaml`, `.yml`, case-insensitive). Extensions outside that set are not parsed and yield a null result.

The structural marker check is intentionally minimal — `openapi` must be a string of length at least one, and `info` must be a non-null object that is not an array. Deeper validation (operations, refs, collisions) is the next stage's responsibility.

## Behavior

The detector lower-cases the extension before dispatching. For `.json` the contents are parsed with the standard JSON parser. For `.yaml` and `.yml` the contents are parsed with a YAML 1.2 parser. Any other extension immediately yields a null result without attempting to parse.

When the parser throws, the detector catches the error and returns null — a malformed JSON or YAML file in the content tree is treated as "not an OpenAPI spec" rather than as a fatal build error, so non-OpenAPI files in the same tree do not break the site build.

After parsing, the detector verifies the result is a non-null, non-array object. It then checks the two structural markers: the top-level `openapi` field must be a non-empty string, and the top-level `info` field must be a non-null object that is not an array. A failure on either marker yields null.

A document that passes both checks is returned as the parsed object — this is the input the next parsing stage consumes.

Detection considers any file with an eligible extension regardless of name. A file called `petstore.yaml`, `routes.json`, or `internal-api.yml` is sniffed exactly the same way as one called `openapi.yaml`. Filename conventions are not part of the detection contract.

## Notable Behavior

Parse failures and structural-marker failures are not distinguished in the return value — both yield null. The caller cannot tell whether a file was malformed JSON or a valid JSON document missing the `openapi` field. A diagnostic warning is surfaced for parse failures so authors of partially-broken specs are not silently ignored, but the detection result itself remains a single null.

The `openapi` field's value is checked only for being a non-empty string. The detector does not enforce that it starts with `3.` here — that constraint is documented as part of the contract but not gated at this stage. Documents declaring `openapi: 2.0.0` parse as far as detection but will fail later when the parser walks structures unique to 3.x.

YAML parsing is YAML 1.2 conformant — the same multi-document, anchor, and tag handling the underlying YAML library implements. Multi-document YAML files are not specially split; the parser's default behavior applies.

## Shared Behavior

The downstream parser stage assumes the document already passed detection — it does not re-check the `openapi` and `info` markers and may behave undefined on a raw document that bypassed this stage.

The renderer-agnostic intermediate representation is built only after detection succeeds. The detection result is the contract boundary between "any file in the content tree" and "this is a candidate spec".
