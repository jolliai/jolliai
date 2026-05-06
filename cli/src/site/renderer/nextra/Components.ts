import type { TemplateFile } from "./Types.js";

/**
 * Emits the React components (and one shared utility) the per-endpoint MDX
 * pages import:
 *
 * - describeType (utility) — schema → human-readable type string, shared by
 *   ParamTable and SchemaBlock to keep the rendering rules in one place
 * - EndpointMeta — pill row with METHOD + path + tags + deprecation badge
 * - ParamTable — table for path/query/header/cookie parameters
 * - SchemaBlock — collapsible OpenAPI schema renderer (for request bodies)
 * - ResponseBlock — wraps SchemaBlock with status-code header
 * - AuthRequirements — list of which security schemes apply
 * - TryIt — interactive request builder with response panel
 * - CodeSwitcher — header bar (dropdown + copy) wrapping fenced code blocks,
 *   replaces Nextra's `<Tabs>` for the request samples / response examples
 *   so the picker is inline with the code panel rather than floating above
 * - Endpoint — top-level wrapper composing the above into the two-column
 *   layout the MDX shim renders into; sub-exports `EndpointDescription`
 *   and `EndpointSamples` for the shim's left/right slots
 *
 * The fenced MDX code blocks inside `<CodeSwitcher>` are still processed by
 * Nextra's MDX → Shiki pipeline, so syntax highlighting is preserved even
 * though the switcher hides/shows panes via React state.
 *
 * Components consume the theme pack's CSS variables (--primary-hue, --api-*)
 * so Forge and Atlas inherit theming automatically. The TryIt widget is the
 * only component with significant state — others are pure presentational.
 *
 * All components are emitted as `"use client"` to avoid Next.js 15 server-
 * component hydration issues when used inside MDX pages.
 */
export function generateApiComponents(): Array<TemplateFile> {
	return [
		{ path: "components/api/describeType.ts", content: DESCRIBE_TYPE },
		{ path: "components/api/EndpointMeta.tsx", content: ENDPOINT_META },
		{ path: "components/api/ParamTable.tsx", content: PARAM_TABLE },
		{ path: "components/api/SchemaBlock.tsx", content: SCHEMA_BLOCK },
		{ path: "components/api/ResponseBlock.tsx", content: RESPONSE_BLOCK },
		{ path: "components/api/AuthRequirements.tsx", content: AUTH_REQUIREMENTS },
		{ path: "components/api/TryIt.tsx", content: TRY_IT },
		{ path: "components/api/CodeSwitcher.tsx", content: CODE_SWITCHER },
		{ path: "components/api/Endpoint.tsx", content: ENDPOINT },
	];
}

/**
 * describeType — shared by ParamTable and SchemaBlock. Both components used
 * to inline near-identical copies; this version is the SchemaBlock superset
 * (handles array `items.$ref` and falls back to "array" when item type is
 * unknown), which is also correct behavior for ParamTable.
 */
const DESCRIBE_TYPE = `export function describeType(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "—";
  const s = schema as { type?: string; format?: string; $ref?: string; items?: { type?: string; $ref?: string } };
  if (s.$ref) return s.$ref.split("/").pop() ?? "object";
  if (s.type === "array") {
    if (s.items?.$ref) return \`\${s.items.$ref.split("/").pop()}[]\`;
    if (s.items?.type) return \`\${s.items.type}[]\`;
    return "array";
  }
  if (s.format) return \`\${s.type ?? "string"} (\${s.format})\`;
  return s.type ?? "object";
}
`;

/**
 * CodeSwitcher — drop-in replacement for `<Tabs>` on endpoint code panels.
 * Expects each child to be a `<div data-pane="<value>">` containing a
 * fenced markdown code block. The component renders one pane at a time
 * (the rest carry `hidden`) and a header bar with a label, a `<select>`
 * picker, and a copy button. The copy button reads `textContent` from the
 * active pane, so it captures the source of the fenced block whether or
 * not Shiki has already replaced it with highlighted spans.
 */
const CODE_SWITCHER = `"use client";

import { Children, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

interface Option {
  value: string;
  label: string;
}

interface CodeSwitcherProps {
  /** Picker options in display order. The first option is the initial selection. */
  options: Array<Option>;
  /** "Request" / "Response" or any short heading for the panel. */
  label: string;
  /**
   * Children whose top-level wrapper is \`<div data-pane="<value>">\` for
   * each option in \`options\`. Markdown fenced code blocks inside those
   * wrappers are processed by Nextra so Shiki highlighting is preserved.
   */
  children: ReactNode;
}

interface PaneProps {
  "data-pane"?: string;
}

function getPaneValue(child: ReactNode): string | undefined {
  if (!isValidElement(child)) return undefined;
  const props = (child as ReactElement<PaneProps>).props;
  return props["data-pane"];
}

export default function CodeSwitcher({ options, label, children }: CodeSwitcherProps) {
  const initial = options[0]?.value ?? "";
  const [active, setActive] = useState<string>(initial);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const copyTimer = useRef<number | null>(null);

  // Reset selection if the parent rerenders with a new option set (e.g.,
  // navigating between endpoints with different status codes).
  useEffect(() => {
    if (!options.some(o => o.value === active)) {
      setActive(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only resync when the option list shape changes
  }, [options.map(o => o.value).join("|")]);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  function handleCopy() {
    const body = bodyRef.current;
    if (!body) return;
    const pane = body.querySelector<HTMLElement>(\`[data-pane="\${CSS.escape(active)}"]\`);
    const code = pane?.querySelector("code")?.textContent ?? pane?.textContent ?? "";
    if (!code) return;
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }

  const childArray = Children.toArray(children);

  return (
    <div className="api-code-switcher">
      <div className="api-code-switcher-toolbar">
        <span className="api-code-switcher-label">{label}</span>
        <select
          className="api-code-switcher-select"
          value={active}
          onChange={e => setActive(e.target.value)}
          aria-label={\`Select \${label.toLowerCase()}\`}
        >
          {options.map(o => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="api-code-switcher-copy"
          data-copied={copied ? "true" : "false"}
          onClick={handleCopy}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="api-code-switcher-body" ref={bodyRef}>
        {childArray.map((child, i) => {
          const value = getPaneValue(child);
          if (!value) return null;
          return (
            <div
              key={value || i}
              className="api-code-switcher-pane"
              data-pane={value}
              hidden={value !== active}
            >
              {child}
            </div>
          );
        })}
      </div>
    </div>
  );
}
`;

const ENDPOINT_META = `"use client";

interface EndpointMetaProps {
  method: string;
  path: string;
  tags: Array<string>;
  deprecated?: boolean;
}

export default function EndpointMeta({ method, path, tags, deprecated }: EndpointMetaProps) {
  const methodClass = \`api-method api-method-\${method.toLowerCase()}\`;
  return (
    <div className="api-endpoint-meta">
      <span className={methodClass}>{method.toUpperCase()}</span>
      <code className="api-endpoint-path">{path}</code>
      {tags.map(t => (
        <span key={t} className="api-endpoint-tag">{t}</span>
      ))}
      {deprecated && <span className="api-endpoint-deprecated">Deprecated</span>}
    </div>
  );
}
`;

const PARAM_TABLE = `"use client";

import { describeType } from "./describeType";

interface Param {
  name: string;
  required: boolean;
  description?: string;
  schema?: unknown;
}

interface ParamTableProps {
  kind: "path" | "query" | "header" | "cookie";
  params: Array<Param>;
}

export default function ParamTable({ kind, params }: ParamTableProps) {
  if (params.length === 0) return null;
  const heading = kind.charAt(0).toUpperCase() + kind.slice(1);
  return (
    <div className="api-param-section">
      <h3 className="api-param-section-title">{heading} parameters</h3>
      <table className="api-param-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Required</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {params.map(p => (
            <tr key={p.name}>
              <td><code>{p.name}</code></td>
              <td>{describeType(p.schema)}</td>
              <td>{p.required ? "Yes" : "No"}</td>
              <td>{p.description ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
`;

const SCHEMA_BLOCK = `"use client";

import { useState } from "react";
import { describeType } from "./describeType";

interface SchemaBlockProps {
  schema: unknown;
  refs?: Record<string, unknown>;
}

interface RowProps {
  name?: string;
  schema: unknown;
  refs: Record<string, unknown>;
  required?: boolean;
  depth: number;
  // Tracks the chain of $ref keys already followed on the path to this row so
  // a self-referential schema (e.g. \`Tree\` whose \`children.items\` points back
  // to \`Tree\`) doesn't render an unbounded React tree when the user expands it.
  visitedRefs?: ReadonlySet<string>;
}

function resolveRef(refs: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/components/schemas/")) return undefined;
  const name = ref.slice("#/components/schemas/".length);
  return refs[name];
}

function SchemaRow({ name, schema, refs, required, depth, visitedRefs }: RowProps) {
  const [expanded, setExpanded] = useState(depth < 1);
  if (!schema || typeof schema !== "object") return null;
  let resolved = schema as Record<string, unknown>;
  let nextVisited: ReadonlySet<string> = visitedRefs ?? new Set<string>();
  let isCircular = false;
  if ("$ref" in resolved && typeof resolved.$ref === "string") {
    const refKey = resolved.$ref;
    if (nextVisited.has(refKey)) {
      // Already followed this ref on the current path — render the row as a
      // leaf placeholder so the user still sees the type label but expansion
      // stops here.
      isCircular = true;
    } else {
      const target = resolveRef(refs, refKey);
      if (target && typeof target === "object") {
        resolved = target as Record<string, unknown>;
        nextVisited = new Set([...nextVisited, refKey]);
      }
    }
  }
  const props = (resolved.properties ?? {}) as Record<string, unknown>;
  const requiredList = Array.isArray(resolved.required) ? (resolved.required as Array<string>) : [];
  const items = resolved.items;
  const description = typeof resolved.description === "string" ? resolved.description : "";
  const typeStr = describeType(resolved);
  const hasChildren = !isCircular && (Object.keys(props).length > 0 || items !== undefined);

  return (
    <li className="api-schema-row" style={{ paddingLeft: \`\${depth * 16}px\` }}>
      <div className="api-schema-row-head">
        {hasChildren && (
          <button
            type="button"
            className="api-schema-toggle"
            onClick={() => setExpanded(v => !v)}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "−" : "+"}
          </button>
        )}
        {name && <code className="api-schema-name">{name}</code>}
        <span className="api-schema-type">{typeStr}{isCircular ? " (circular)" : ""}</span>
        {required && <span className="api-schema-required">required</span>}
      </div>
      {description && <div className="api-schema-description">{description}</div>}
      {hasChildren && expanded && (
        <ul className="api-schema-children">
          {Object.entries(props).map(([k, v]) => (
            <SchemaRow
              key={k}
              name={k}
              schema={v}
              refs={refs}
              required={requiredList.includes(k)}
              depth={depth + 1}
              visitedRefs={nextVisited}
            />
          ))}
          {items !== undefined && (
            <SchemaRow schema={items} refs={refs} depth={depth + 1} visitedRefs={nextVisited} />
          )}
        </ul>
      )}
    </li>
  );
}

export default function SchemaBlock({ schema, refs }: SchemaBlockProps) {
  if (!schema) return null;
  return (
    <div className="api-schema-block">
      <ul className="api-schema-root">
        <SchemaRow schema={schema} refs={refs ?? {}} depth={0} />
      </ul>
    </div>
  );
}
`;

const RESPONSE_BLOCK = `"use client";

import SchemaBlock from "./SchemaBlock";

interface ResponseBlockProps {
  status: string;
  description?: string;
  contentType?: string;
  schema?: unknown;
  refs?: Record<string, unknown>;
}

function statusClass(status: string): string {
  if (status.startsWith("2")) return "api-status-2xx";
  if (status.startsWith("3")) return "api-status-3xx";
  if (status.startsWith("4")) return "api-status-4xx";
  if (status.startsWith("5")) return "api-status-5xx";
  return "api-status-default";
}

export default function ResponseBlock({ status, description, contentType, schema, refs }: ResponseBlockProps) {
  return (
    <div className="api-response-block">
      <div className="api-response-header">
        <span className={\`api-response-status \${statusClass(status)}\`}>{status}</span>
        {description && <span className="api-response-description">{description}</span>}
        {contentType && <code className="api-response-contenttype">{contentType}</code>}
      </div>
      {schema !== undefined && <SchemaBlock schema={schema} refs={refs} />}
    </div>
  );
}
`;

const AUTH_REQUIREMENTS = `"use client";

interface SecurityScheme {
  type: string;
  scheme?: string;
  in?: string;
  name?: string;
  description?: string;
}

interface AuthRequirementsProps {
  schemes: Array<{ name: string; scheme: SecurityScheme; scopes: Array<string> }>;
}

function describeScheme(scheme: SecurityScheme): string {
  if (scheme.type === "http" && scheme.scheme === "bearer") return "Bearer token";
  if (scheme.type === "http" && scheme.scheme === "basic") return "Basic auth";
  if (scheme.type === "apiKey" && scheme.in && scheme.name) return \`API key in \${scheme.in} (\${scheme.name})\`;
  if (scheme.type === "oauth2") return "OAuth 2.0";
  if (scheme.type === "openIdConnect") return "OpenID Connect";
  return scheme.type;
}

export default function AuthRequirements({ schemes }: AuthRequirementsProps) {
  if (schemes.length === 0) {
    return <p className="api-auth-none">No authentication required.</p>;
  }
  return (
    <ul className="api-auth-list">
      {schemes.map(s => (
        <li key={s.name} className="api-auth-item">
          <code className="api-auth-name">{s.name}</code>
          <span className="api-auth-description">{describeScheme(s.scheme)}</span>
          {s.scopes.length > 0 && (
            <span className="api-auth-scopes">scopes: {s.scopes.join(", ")}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
`;

const TRY_IT = `"use client";

import { useEffect, useRef, useState } from "react";

interface Param {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
}

interface SecurityScheme {
  type: string;
  scheme?: string;
  in?: string;
  name?: string;
}

interface TryItProps {
  specName: string;
  method: string;
  path: string;
  servers: Array<{ url: string; description?: string }>;
  parameters: Array<Param>;
  requestBody?: { contentType: string; example?: unknown; required: boolean };
  authSchemes: Array<{ name: string; scheme: SecurityScheme }>;
}

interface ResponseState {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  /** True when the response body parsed as JSON — drives syntax highlighting. */
  bodyIsJson: boolean;
}

/**
 * Escape characters that would break out of an HTML text node. Used before
 * tokenizing JSON so the highlighter's \`<span>\` wrappers are the only HTML
 * the browser sees.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Tokenize a pretty-printed JSON string into HTML with class-tagged spans.
 * Single regex covers strings (including object keys, identified by a
 * trailing colon), \`true\`/\`false\`/\`null\`, and numbers. Other characters
 * (braces, commas, whitespace) pass through as plain text. Input must be
 * HTML-escaped first.
 */
function highlightJson(json: string): string {
  const escaped = escapeHtml(json);
  return escaped.replace(
    /("(?:\\\\.|[^"\\\\])*")(\\s*:)?|\\b(true|false|null)\\b|(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)/g,
    (_, str, colon, bool, num) => {
      if (str !== undefined) {
        const cls = colon ? "json-key" : "json-string";
        return \`<span class="\${cls}">\${str}</span>\${colon ?? ""}\`;
      }
      if (bool !== undefined) {
        const cls = bool === "null" ? "json-null" : "json-boolean";
        return \`<span class="\${cls}">\${bool}</span>\`;
      }
      return \`<span class="json-number">\${num}</span>\`;
    },
  );
}

function storageKey(specName: string, key: string): string {
  return \`jolli-tryit:\${specName}:\${key}\`;
}

function loadStored(key: string): string {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(key) ?? "";
}

function saveStored(key: string, value: string): void {
  if (typeof window === "undefined") return;
  if (value) window.sessionStorage.setItem(key, value);
  else window.sessionStorage.removeItem(key);
}

function buildAuthHeaders(
  authSchemes: TryItProps["authSchemes"],
  authValues: Record<string, string>,
): { headers: Record<string, string>; query: Record<string, string> } {
  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};
  for (const { name, scheme } of authSchemes) {
    const value = authValues[name];
    if (!value) continue;
    if (scheme.type === "http" && scheme.scheme === "bearer") {
      headers["Authorization"] = \`Bearer \${value}\`;
    } else if (scheme.type === "http" && scheme.scheme === "basic") {
      headers["Authorization"] = \`Basic \${value}\`;
    } else if (scheme.type === "apiKey" && scheme.name) {
      if (scheme.in === "header") headers[scheme.name] = value;
      else if (scheme.in === "query") query[scheme.name] = value;
    } else if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
      headers["Authorization"] = \`Bearer \${value}\`;
    }
  }
  return { headers, query };
}

function substitutePathParams(path: string, values: Record<string, string>): string {
  return path.replace(/\\{([^}]+)\\}/g, (_, name) => encodeURIComponent(values[name] ?? \`{\${name}}\`));
}

function buildUrl(
  serverUrl: string,
  path: string,
  pathValues: Record<string, string>,
  queryValues: Record<string, string>,
  authQuery: Record<string, string>,
): string {
  const cleanServer = serverUrl.replace(/\\/$/, "");
  const resolvedPath = substitutePathParams(path, pathValues);
  const allQuery = { ...queryValues, ...authQuery };
  const params = Object.entries(allQuery).filter(([_, v]) => v !== "");
  if (params.length === 0) return \`\${cleanServer}\${resolvedPath}\`;
  const qs = params.map(([k, v]) => \`\${encodeURIComponent(k)}=\${encodeURIComponent(v)}\`).join("&");
  return \`\${cleanServer}\${resolvedPath}?\${qs}\`;
}

export default function TryIt({
  specName,
  method,
  path,
  servers,
  parameters,
  requestBody,
  authSchemes,
}: TryItProps) {
  const defaultServer = servers[0]?.url ?? "";
  const [serverUrl, setServerUrl] = useState(defaultServer);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [authValues, setAuthValues] = useState<Record<string, string>>({});
  const [bodyValue, setBodyValue] = useState(
    requestBody?.example !== undefined ? JSON.stringify(requestBody.example, null, 2) : "",
  );
  const [response, setResponse] = useState<ResponseState | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [responseCopied, setResponseCopied] = useState(false);
  const responseCopyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (responseCopyTimer.current) window.clearTimeout(responseCopyTimer.current);
    },
    [],
  );

  function handleResponseCopy() {
    if (!response) return;
    void navigator.clipboard.writeText(response.body).then(() => {
      setResponseCopied(true);
      if (responseCopyTimer.current) window.clearTimeout(responseCopyTimer.current);
      responseCopyTimer.current = window.setTimeout(() => setResponseCopied(false), 1500);
    });
  }

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const { name } of authSchemes) {
      next[name] = loadStored(storageKey(specName, \`auth:\${name}\`));
    }
    setAuthValues(next);
  }, [specName, authSchemes]);

  function updateAuth(name: string, value: string) {
    setAuthValues(prev => ({ ...prev, [name]: value }));
    saveStored(storageKey(specName, \`auth:\${name}\`), value);
  }

  function updateParam(name: string, value: string) {
    setParamValues(prev => ({ ...prev, [name]: value }));
  }

  async function send() {
    if (!serverUrl) {
      setError("No server URL is configured for this spec.");
      return;
    }
    setLoading(true);
    setError(undefined);
    setResponse(undefined);

    const pathValues: Record<string, string> = {};
    const queryValues: Record<string, string> = {};
    const headerValues: Record<string, string> = {};
    for (const p of parameters) {
      const v = paramValues[\`\${p.in}:\${p.name}\`];
      if (v === undefined || v === "") continue;
      if (p.in === "path") pathValues[p.name] = v;
      else if (p.in === "query") queryValues[p.name] = v;
      else if (p.in === "header") headerValues[p.name] = v;
    }

    const auth = buildAuthHeaders(authSchemes, authValues);
    const url = buildUrl(serverUrl, path, pathValues, queryValues, auth.query);
    const headers: Record<string, string> = { ...headerValues, ...auth.headers };
    let body: string | undefined;
    if (requestBody && bodyValue.trim().length > 0) {
      headers["Content-Type"] = headers["Content-Type"] ?? requestBody.contentType;
      body = bodyValue;
    }

    try {
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = body;
      const res = await fetch(url, init);
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        respHeaders[key] = value;
      });
      const text = await res.text();
      let pretty = text;
      let bodyIsJson = false;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
        bodyIsJson = true;
      } catch {
        pretty = text;
      }
      setResponse({ status: res.status, statusText: res.statusText, headers: respHeaders, body: pretty, bodyIsJson });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(\`Request failed: \${msg}. If the server is on a different origin, the response may have been blocked by CORS.\`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="api-tryit">
      <div className="api-tryit-header">
        <span className={\`api-method api-method-\${method.toLowerCase()}\`}>{method.toUpperCase()}</span>
        <code className="api-tryit-path">{path}</code>
      </div>

      {servers.length > 1 && (
        <div className="api-tryit-field">
          <label className="api-tryit-label">Server</label>
          <select
            className="api-tryit-input"
            value={serverUrl}
            onChange={e => setServerUrl(e.target.value)}
          >
            {servers.map(s => (
              <option key={s.url} value={s.url}>
                {s.description ? \`\${s.description} — \${s.url}\` : s.url}
              </option>
            ))}
          </select>
        </div>
      )}

      {authSchemes.length > 0 && (
        <fieldset className="api-tryit-section">
          <legend>Authentication</legend>
          {authSchemes.map(({ name, scheme }) => (
            <div key={name} className="api-tryit-field">
              <label className="api-tryit-label">
                {name} <span className="api-tryit-hint">({scheme.type}{scheme.scheme ? \` \${scheme.scheme}\` : ""})</span>
              </label>
              <input
                type="password"
                className="api-tryit-input"
                value={authValues[name] ?? ""}
                onChange={e => updateAuth(name, e.target.value)}
                placeholder={scheme.scheme === "basic" ? "base64(user:password)" : "your token or key"}
              />
            </div>
          ))}
        </fieldset>
      )}

      {parameters.length > 0 && (
        <fieldset className="api-tryit-section">
          <legend>Parameters</legend>
          {parameters.map(p => {
            const key = \`\${p.in}:\${p.name}\`;
            return (
              <div key={key} className="api-tryit-field">
                <label className="api-tryit-label">
                  {p.name} <span className="api-tryit-hint">({p.in}{p.required ? ", required" : ""})</span>
                </label>
                <input
                  type="text"
                  className="api-tryit-input"
                  value={paramValues[key] ?? ""}
                  onChange={e => updateParam(key, e.target.value)}
                  placeholder={p.description ?? ""}
                />
              </div>
            );
          })}
        </fieldset>
      )}

      {requestBody && (
        <fieldset className="api-tryit-section">
          <legend>Request body ({requestBody.contentType})</legend>
          <textarea
            className="api-tryit-textarea"
            value={bodyValue}
            onChange={e => setBodyValue(e.target.value)}
            rows={8}
          />
        </fieldset>
      )}

      <button
        type="button"
        className="api-tryit-send"
        onClick={send}
        disabled={loading}
      >
        {loading ? "Sending..." : "Send request"}
      </button>

      {error && <div className="api-tryit-error">{error}</div>}

      {response && (
        <div className="api-tryit-response">
          <div className="api-tryit-response-status">
            <strong>{response.status}</strong> {response.statusText}
          </div>
          <details className="api-tryit-response-headers">
            <summary>Response headers</summary>
            <pre><code>{Object.entries(response.headers).map(([k, v]) => \`\${k}: \${v}\`).join("\\n")}</code></pre>
          </details>
          <div className="api-tryit-response-body-wrap">
            <div className="api-tryit-response-toolbar">
              <span className="api-tryit-response-label">Response body</span>
              <button
                type="button"
                className="api-code-switcher-copy"
                data-copied={responseCopied ? "true" : "false"}
                onClick={handleResponseCopy}
              >
                {responseCopied ? "Copied" : "Copy"}
              </button>
            </div>
            {response.bodyIsJson ? (
              <pre className="api-tryit-response-body">
                <code
                  className="language-json"
                  // eslint-disable-next-line react/no-danger -- input is escaped via escapeHtml before tokenization; only our own <span class="json-*"> wrappers are unescaped
                  dangerouslySetInnerHTML={{ __html: highlightJson(response.body) }}
                />
              </pre>
            ) : (
              <pre className="api-tryit-response-body">
                <code>{response.body}</code>
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
`;

/**
 * `<Endpoint>` is the per-page wrapper that renders the entire left column
 * (title, meta, Try It, auth, parameters, schemas, response docs) from the
 * operation's JSON sidecar — and slots two MDX-authored chunks in:
 *
 *   • `<EndpointDescription>` lives between the Try It widget and the auth
 *     section. It exists as a slot (rather than a `description` prop) so
 *     spec authors can use rich MDX (markdown, links, code fences, callouts)
 *     and Nextra's MDX → Shiki pipeline still highlights any embedded code.
 *   • `<EndpointSamples>` populates the right column. The MDX shim drops
 *     `<CodeSwitcher>` blocks (request samples + response examples) inside
 *     it; keeping those as MDX-fenced code blocks is what lets Nextra's
 *     existing Shiki pipeline highlight them — moving them into the JSON
 *     would require a generator-side highlighter (extra dep) or lose
 *     syntax highlighting outright.
 *
 * The slots are detected via `Children.toArray` + a string `displayName`
 * sentinel so the runtime check survives bundler renaming. Unrecognised
 * children render in document order between description and the auth
 * section, which is harmless — typical shims have just the two slots.
 *
 * Why a slot pattern instead of `description` / `samples` props: MDX makes
 * it awkward to pass nested MDX as JSX expression-form props (`<Endpoint
 * description={<>…</>} />`); children + named markers reads naturally in
 * the generated `.mdx` and keeps the shim ~5–10 lines per endpoint.
 */
const ENDPOINT = `"use client";

import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import EndpointMeta from "./EndpointMeta";
import ParamTable from "./ParamTable";
import SchemaBlock from "./SchemaBlock";
import ResponseBlock from "./ResponseBlock";
import AuthRequirements from "./AuthRequirements";
import TryIt from "./TryIt";

interface SecurityScheme {
  type: string;
  scheme?: string;
  in?: string;
  name?: string;
  description?: string;
}

interface OperationParameter {
  name: string;
  required: boolean;
  description?: string;
  schema?: unknown;
}

interface TryItParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
}

interface OperationResponse {
  status: string;
  description?: string;
  contentType?: string;
  schema?: unknown;
}

interface OperationData {
  specName: string;
  operationId: string;
  method: string;
  path: string;
  title: string;
  tags: Array<string>;
  deprecated: boolean;
  servers: Array<{ url: string; description?: string }>;
  tryItParameters: Array<TryItParameter>;
  parameters: {
    path: Array<OperationParameter>;
    query: Array<OperationParameter>;
    header: Array<OperationParameter>;
    cookie: Array<OperationParameter>;
  };
  authSchemes: Array<{ name: string; scheme: SecurityScheme; scopes: Array<string> }>;
  tryItAuthSchemes: Array<{ name: string; scheme: SecurityScheme }>;
  requestBody?: { contentType: string; required: boolean; schema?: unknown; example?: unknown };
  responses: Array<OperationResponse>;
}

interface EndpointProps {
  data: OperationData;
  refs?: Record<string, unknown>;
  children?: ReactNode;
}

/**
 * Slot marker for the inline MDX description. The shim wraps the operation's
 * description text in this and tags it with \`data-slot="description"\` so the
 * parent \`<Endpoint>\` can find it without depending on component identity —
 * which fails during SSR because \`type\` on the children of a client component
 * is the opaque RSC client reference, not the actual function.
 */
export function EndpointDescription({ children }: { "data-slot"?: string; children?: ReactNode }) {
  return <>{children}</>;
}

/**
 * Slot marker for the right-column samples block. The shim drops the
 * \`<CodeSwitcher>\` request/response panes inside this so they render in the
 * aside column rather than the main content flow. Slot detection uses the
 * \`data-slot\` prop — see EndpointDescription for the rationale.
 */
export function EndpointSamples({ children }: { "data-slot"?: string; children?: ReactNode }) {
  return <>{children}</>;
}

/**
 * Find the slot child tagged with \`data-slot={slotName}\`. We match on the
 * prop value (not on \`child.type === Component\` and not on \`displayName\`)
 * because the parent \`<Endpoint>\` runs during SSR with children whose \`type\`
 * is the RSC client reference for the slot component — an opaque object that
 * does not equal the function imported in this same module. Props, in
 * contrast, are serialized in the RSC payload and survive SSR, the client
 * boundary, hydration, and minifier passes.
 */
function findSlot(children: ReactNode, slotName: string): ReactNode {
  let found: ReactNode = null;
  Children.forEach(children, child => {
    if (!isValidElement(child)) return;
    const props = (child as ReactElement<{ "data-slot"?: string }>).props;
    if (props["data-slot"] === slotName) {
      found = child;
    }
  });
  return found;
}

function hasAnyParameters(p: OperationData["parameters"]): boolean {
  return p.path.length > 0 || p.query.length > 0 || p.header.length > 0 || p.cookie.length > 0;
}

export default function Endpoint({ data, refs, children }: EndpointProps) {
  const description = findSlot(children, "description");
  const samples = findSlot(children, "samples");
  const tagsForMeta = data.tags.filter(t => t !== "default");
  const refsMap = refs ?? {};

  return (
    <div className="api-endpoint-grid">
      <div className="api-endpoint-main">
        <h1>{data.title}</h1>

        <EndpointMeta
          method={data.method}
          path={data.path}
          tags={tagsForMeta}
          deprecated={data.deprecated}
        />

        <h2>Try it</h2>
        <TryIt
          specName={data.specName}
          method={data.method.toUpperCase()}
          path={data.path}
          servers={data.servers}
          parameters={data.tryItParameters}
          authSchemes={data.tryItAuthSchemes}
          {...(data.requestBody
            ? {
                requestBody: {
                  contentType: data.requestBody.contentType,
                  required: data.requestBody.required,
                  ...(data.requestBody.example !== undefined ? { example: data.requestBody.example } : {}),
                },
              }
            : {})}
        />

        {description}

        <h2>Authentication</h2>
        <AuthRequirements schemes={data.authSchemes} />

        {hasAnyParameters(data.parameters) && (
          <>
            <h2>Parameters</h2>
            <ParamTable kind="path" params={data.parameters.path} />
            <ParamTable kind="query" params={data.parameters.query} />
            <ParamTable kind="header" params={data.parameters.header} />
            <ParamTable kind="cookie" params={data.parameters.cookie} />
          </>
        )}

        {data.requestBody && (
          <>
            <h2>Request body</h2>
            <p>
              Content type: <code>{data.requestBody.contentType}</code>
            </p>
            {data.requestBody.schema !== undefined && (
              <SchemaBlock schema={data.requestBody.schema} refs={refsMap} />
            )}
          </>
        )}

        {data.responses.length > 0 && (
          <>
            <h2>Response</h2>
            {data.responses.map(r => (
              <ResponseBlock
                key={r.status}
                status={r.status}
                {...(r.description !== undefined ? { description: r.description } : {})}
                {...(r.contentType !== undefined ? { contentType: r.contentType } : {})}
                {...(r.schema !== undefined ? { schema: r.schema } : {})}
                refs={refsMap}
              />
            ))}
          </>
        )}
      </div>

      <div className="api-endpoint-aside">{samples}</div>
    </div>
  );
}
`;
