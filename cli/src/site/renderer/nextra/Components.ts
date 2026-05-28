import type { TemplateFile } from "./Types.js";

/**
 * Emits the React components (and shared utilities) the per-endpoint MDX pages
 * import. Each component is stored as a template-literal string and scaffolded
 * verbatim into the generated site under `components/api/`. They are emitted
 * as `"use client"` (except the plain `.ts` utility modules) to avoid Next.js
 * 15 server-component hydration issues when used inside MDX pages.
 *
 * The endpoint page is a single-line identity header (METHOD + path + copy +
 * "Try it" toggle) that expands an accordion holding the interactive TryIt
 * form. A shared `TryItContext` feeds the live `RequestSample` in the aside,
 * which regenerates per-language snippets as the form is filled in. Sent
 * requests are logged to `localStorage` and rendered by `HistoryItem`.
 *
 * Styling for every `.api-*` class name is supplied by the active theme — the
 * components only emit the markup contract.
 */
export function generateApiComponents(): Array<TemplateFile> {
	return [
		{ path: "components/api/describeType.ts", content: DESCRIBE_TYPE },
		{ path: "components/api/EndpointMeta.tsx", content: ENDPOINT_META },
		{ path: "components/api/ParamTable.tsx", content: PARAM_TABLE },
		{ path: "components/api/SchemaBlock.tsx", content: SCHEMA_BLOCK },
		{ path: "components/api/ResponseBlock.tsx", content: RESPONSE_BLOCK },
		{ path: "components/api/ResponseTabs.tsx", content: RESPONSE_TABS },
		{ path: "components/api/AuthRequirements.tsx", content: AUTH_REQUIREMENTS },
		{ path: "components/api/TryIt.tsx", content: TRY_IT },
		{ path: "components/api/TryItContext.tsx", content: TRY_IT_CONTEXT },
		{ path: "components/api/CodeSwitcher.tsx", content: CODE_SWITCHER },
		{ path: "components/api/CodeEditor.tsx", content: CODE_EDITOR },
		{ path: "components/api/TypedInput.tsx", content: TYPED_INPUT },
		{ path: "components/api/RequestSample.tsx", content: REQUEST_SAMPLE },
		{ path: "components/api/HistoryItem.tsx", content: HISTORY_ITEM },
		{ path: "components/api/Endpoint.tsx", content: ENDPOINT },
		{ path: "components/api/requestSnippets.ts", content: REQUEST_SNIPPETS },
		{ path: "components/api/tryItHistory.ts", content: TRY_IT_HISTORY },
		{ path: "components/api/jsonHighlight.ts", content: JSON_HIGHLIGHT },
		{ path: "components/api/serverVars.ts", content: SERVER_VARS },
		{ path: "components/api/paramSchema.ts", content: PARAM_SCHEMA },
	];
}

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

const ENDPOINT_META = `"use client";

import { useEffect, useRef, useState } from "react";
import { useTryItInputs } from "./TryItContext";

interface EndpointMetaProps {
  method: string;
  path: string;
  deprecated?: boolean;
  /** First (default) server URL; prepended to the path for the copy action. */
  server?: string;
  /** Whether the TryIt accordion below this line is currently open. */
  tryItOpen?: boolean;
  /** Toggle handler for the "Try it" button. When omitted, no button renders. */
  onToggleTryIt?: () => void;
}

export default function EndpointMeta({ method, path, deprecated, server, tryItOpen, onToggleTryIt }: EndpointMetaProps) {
  const methodClass = \`api-method api-method-\${method.toLowerCase()}\`;
  const { resolvedServerUrl } = useTryItInputs();
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  function handleCopy() {
    // Copy the full URL: resolved server (variables substituted, trailing slash
    // trimmed) + path. Falls back to the raw \`server\` prop if context is absent.
    const base = resolvedServerUrl || server || "";
    const fullUrl = base.replace(/\\/+$/, "") + path;
    void navigator.clipboard.writeText(fullUrl).then(() => {
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="api-endpoint-meta">
      <div className="api-endpoint-target">
        <span className={methodClass}>{method.toUpperCase()}</span>
        <code className="api-endpoint-path">{path}</code>
        {deprecated && <span className="api-endpoint-deprecated">Deprecated</span>}
        <button
          type="button"
          className="api-endpoint-path-copy"
          data-copied={copied ? "true" : "false"}
          onClick={handleCopy}
          aria-label="Copy path"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {onToggleTryIt && (
        <button
          type="button"
          className="api-endpoint-tryit-toggle"
          aria-expanded={tryItOpen ? "true" : "false"}
          onClick={onToggleTryIt}
        >
          Try it
          <span className="api-endpoint-tryit-toggle-arrow" aria-hidden="true">▶</span>
        </button>
      )}
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

const RESPONSE_TABS = `"use client";

import { useState } from "react";
import SchemaBlock from "./SchemaBlock";

interface OperationResponse {
  status: string;
  description?: string;
  contentType?: string;
  schema?: unknown;
}

interface ResponseTabsProps {
  responses: Array<OperationResponse>;
  refs?: Record<string, unknown>;
}

/**
 * Content-side Response section as a tabbed panel — the same visual treatment as
 * the aside Response switcher (reusing the .api-code-switcher classes), but the
 * body holds the response **schema** tree rather than an example body. Status
 * codes are the tabs; the selected response's description becomes the sub-header.
 */
export default function ResponseTabs({ responses, refs }: ResponseTabsProps) {
  const [active, setActive] = useState(responses[0]?.status ?? "");
  const current = responses.find(r => r.status === active) ?? responses[0];
  if (!current) return null;

  return (
    <div className="api-code-switcher api-response-tabs">
      <div className="api-code-switcher-toolbar">
        <div className="api-code-switcher-tabs">
          {responses.map(r => (
            <button
              key={r.status}
              type="button"
              aria-pressed={r.status === active ? "true" : "false"}
              className="api-code-switcher-tab"
              data-active={r.status === active ? "true" : "false"}
              onClick={() => setActive(r.status)}
            >
              {r.status}
            </button>
          ))}
        </div>
        {current.contentType && <code className="api-response-contenttype">{current.contentType}</code>}
      </div>
      {current.description && <div className="api-code-switcher-desc">{current.description}</div>}
      {current.schema !== undefined && (
        <div className="api-code-switcher-body">
          <SchemaBlock schema={current.schema} refs={refs ?? {}} />
        </div>
      )}
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

function typeLabel(scheme: SecurityScheme): string {
  if (scheme.type === "http" && scheme.scheme === "bearer") return "Bearer token";
  if (scheme.type === "http" && scheme.scheme === "basic") return "Basic auth";
  if (scheme.type === "apiKey") return "API key";
  if (scheme.type === "oauth2") return "OAuth 2.0";
  if (scheme.type === "openIdConnect") return "OpenID Connect";
  return scheme.type;
}

function detail(scheme: SecurityScheme, scopes: Array<string>): string {
  const parts: Array<string> = [];
  if (scheme.type === "apiKey" && scheme.in) {
    parts.push(scheme.name ? \`\${scheme.in}: \${scheme.name}\` : \`in \${scheme.in}\`);
  } else if (scheme.type === "http" && (scheme.scheme === "bearer" || scheme.scheme === "basic")) {
    parts.push("Authorization header");
  }
  if (scheme.description) parts.push(scheme.description);
  if (scopes.length > 0) parts.push(\`scopes: \${scopes.join(", ")}\`);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

export default function AuthRequirements({ schemes }: AuthRequirementsProps) {
  if (schemes.length === 0) {
    return <p className="api-auth-none">No authentication required.</p>;
  }
  return (
    <table className="api-auth-table">
      <thead>
        <tr>
          <th>Scheme</th>
          <th>Type</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>
        {schemes.map(s => (
          <tr key={s.name}>
            <td>
              <code>{s.name}</code>
            </td>
            <td>{typeLabel(s.scheme)}</td>
            <td>{detail(s.scheme, s.scopes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
`;

const TRY_IT = `"use client";

import { useEffect, useState } from "react";
import { useTryItInputs } from "./TryItContext";
import { serverVariablesFor } from "./serverVars";
import TypedInput from "./TypedInput";
import CodeEditor from "./CodeEditor";
import { defaultString, typeLabel, type ParamSchema } from "./paramSchema";
import HistoryItem from "./HistoryItem";
import { HISTORY_LIMIT, historyKey, loadHistory, saveHistory, type HistoryEntry } from "./tryItHistory";

interface Param {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  /** OpenAPI schema for the value — drives the input control + default. */
  schema?: ParamSchema;
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
  servers: Array<{
    url: string;
    description?: string;
    variables?: Record<string, { default?: string; enum?: Array<string>; description?: string }>;
  }>;
  parameters: Array<Param>;
  requestBody?: { contentType: string; example?: unknown; required: boolean };
  authSchemes: Array<{ name: string; scheme: SecurityScheme }>;
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
  const {
    serverUrl,
    setServerUrl,
    serverVarValues,
    setServerVarValue,
    resolvedServerUrl,
    paramValues,
    setParamValue,
    authValues,
    setAuthValue,
    bodyValue,
    setBodyValue,
  } = useTryItInputs();
  // Variables (e.g. {defaultHost}) declared by the currently selected server.
  const selectedServer = servers.find(s => s.url === serverUrl) ?? servers[0];
  const serverVars = serverVariablesFor(selectedServer);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<Array<HistoryEntry>>([]);
  const [openHistory, setOpenHistory] = useState<Set<number>>(new Set());

  const histKey = historyKey(specName, method, path);

  // Hydrate the saved history for this operation (client-only).
  useEffect(() => {
    setHistory(loadHistory(histKey));
  }, [histKey]);

  // Seed each parameter from its schema default once per operation, so the live
  // sample reflects the spec defaults before the user touches anything. Empty
  // values are left empty (they show a \`<name>\` placeholder in the sample).
  useEffect(() => {
    for (const p of parameters) {
      const key = \`\${p.in}:\${p.name}\`;
      const def = defaultString(p.schema);
      if (def && !paramValues[key]) setParamValue(key, def);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once per operation
  }, [histKey]);

  function clearHistory() {
    setHistory([]);
    saveHistory(histKey, []);
    setOpenHistory(new Set());
  }
  function toggleHistory(ts: number) {
    setOpenHistory(prev => {
      const next = new Set(prev);
      if (next.has(ts)) next.delete(ts);
      else next.add(ts);
      return next;
    });
  }
  function updateHistoryEntry(ts: number, patch: Partial<HistoryEntry>) {
    setHistory(prev => {
      const next = prev.map(h => (h.ts === ts ? { ...h, ...patch } : h));
      saveHistory(histKey, next);
      return next;
    });
  }

  async function send() {
    if (!serverUrl) {
      setError("No server URL is configured for this spec.");
      return;
    }
    const unresolved = resolvedServerUrl.match(/\\{([^}]+)\\}/);
    if (unresolved) {
      setError(\`Set a value for the server variable "\${unresolved[1]}" before sending.\`);
      return;
    }
    setLoading(true);
    setError(undefined);

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
    const url = buildUrl(resolvedServerUrl, path, pathValues, queryValues, auth.query);
    const headers: Record<string, string> = { ...headerValues, ...auth.headers };
    let body: string | undefined;
    if (requestBody && bodyValue.trim().length > 0) {
      headers["Content-Type"] = headers["Content-Type"] ?? requestBody.contentType;
      body = bodyValue;
    }

    // Record the dispatched request in the local history log; the response is
    // patched onto this same entry (by ts) once the fetch resolves.
    const ts = Date.now();
    const entry: HistoryEntry = {
      ts,
      method,
      url,
      headers,
      ...(body !== undefined ? { body } : {}),
    };
    setHistory(prev => {
      const next = [entry, ...prev].slice(0, HISTORY_LIMIT);
      saveHistory(histKey, next);
      return next;
    });
    // Auto-expand the just-sent request, collapsing the rest.
    setOpenHistory(new Set([ts]));

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
      updateHistoryEntry(ts, {
        status: res.status,
        statusText: res.statusText,
        responseHeaders: respHeaders,
        responseBody: pretty,
        responseBodyIsJson: bodyIsJson,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updateHistoryEntry(ts, {
        error: \`Request failed: \${msg}. If the server is on a different origin, the response may have been blocked by CORS.\`,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="api-tryit">
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

      {serverVars.length > 0 && (
        <fieldset className="api-tryit-section">
          <legend>Server variables</legend>
          {serverVars.map(({ name, variable }) => (
            <div key={name} className="api-tryit-field">
              <label className="api-tryit-label">
                {name}
                {variable.description && <span className="api-tryit-hint"> — {variable.description}</span>}
              </label>
              {variable.enum && variable.enum.length > 0 ? (
                <select
                  className="api-tryit-input"
                  value={serverVarValues[name] ?? variable.default ?? ""}
                  onChange={e => setServerVarValue(name, e.target.value)}
                >
                  {variable.enum.map(opt => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  className="api-tryit-input"
                  value={serverVarValues[name] ?? ""}
                  onChange={e => setServerVarValue(name, e.target.value)}
                  placeholder={variable.default ?? name}
                />
              )}
            </div>
          ))}
        </fieldset>
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
                onChange={e => setAuthValue(name, e.target.value)}
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
                  {p.name}{" "}
                  <span className="api-tryit-hint">
                    ({p.in}, {typeLabel(p.schema)}{p.required ? ", required" : ""})
                  </span>
                </label>
                <TypedInput
                  schema={p.schema}
                  value={paramValues[key] ?? ""}
                  onChange={v => setParamValue(key, v)}
                  required={p.required}
                  {...(p.description ? { placeholder: p.description } : {})}
                />
              </div>
            );
          })}
        </fieldset>
      )}

      {requestBody && (
        <fieldset className="api-tryit-section">
          <legend>Request body ({requestBody.contentType})</legend>
          <CodeEditor
            value={bodyValue}
            onChange={setBodyValue}
            language={requestBody.contentType.includes("json") ? "json" : "text"}
            rows={8}
            ariaLabel="Request body"
          />
        </fieldset>
      )}

      <button
        type="button"
        className="api-tryit-send"
        onClick={send}
        disabled={loading}
      >
        {loading ? "Sending..." : "Send"}
      </button>

      {error && <div className="api-tryit-error">{error}</div>}

      {history.length > 0 && (
        <div className="api-tryit-history">
          <div className="api-tryit-history-head">
            <span className="api-tryit-history-title">Request history</span>
            <button type="button" className="api-tryit-history-clear" onClick={clearHistory}>
              Clear
            </button>
          </div>
          <ul className="api-tryit-history-list">
            {history.map(h => (
              <HistoryItem
                key={h.ts}
                entry={h}
                open={openHistory.has(h.ts)}
                onToggle={() => toggleHistory(h.ts)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
`;

const TRY_IT_CONTEXT = `"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { resolveServerUrl, seedServerVarValues, type ServerInfo } from "./serverVars";

interface SecurityScheme {
  type: string;
  scheme?: string;
  in?: string;
  name?: string;
}

interface AuthScheme {
  name: string;
  scheme: SecurityScheme;
}

/**
 * Shared Try-it input state. The TryIt form (left column, inside the accordion)
 * writes to it; the live RequestSample (right column) reads from it, so the
 * code sample updates as the user fills in the form. Response/loading state is
 * NOT here — that stays local to TryIt.
 */
export interface TryItInputs {
  /** All servers for the operation, incl. any \`{var}\` templates + variables. */
  servers: Array<ServerInfo>;
  /** Selected server origin (the raw URL template, possibly with \`{var}\`s). */
  serverUrl: string;
  setServerUrl: (v: string) => void;
  /** Server-variable values keyed by variable name (seeded from spec defaults). */
  serverVarValues: Record<string, string>;
  setServerVarValue: (name: string, v: string) => void;
  /**
   * The selected server URL with its \`{var}\` tokens substituted (entered value →
   * spec default → \`{var}\` left intact). This is what requests/samples build on.
   */
  resolvedServerUrl: string;
  /** Param values keyed \`\${in}:\${name}\` (path/query/header/cookie). */
  paramValues: Record<string, string>;
  setParamValue: (key: string, v: string) => void;
  /** Auth values keyed by security-scheme name. */
  authValues: Record<string, string>;
  setAuthValue: (name: string, v: string) => void;
  /** Raw request body text. */
  bodyValue: string;
  setBodyValue: (v: string) => void;
}

const TryItContext = createContext<TryItInputs | null>(null);

export function useTryItInputs(): TryItInputs {
  const ctx = useContext(TryItContext);
  if (!ctx) throw new Error("useTryItInputs must be used inside <TryItProvider>");
  return ctx;
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

export function TryItProvider({
  specName,
  servers,
  defaultServer,
  defaultBody,
  authSchemes,
  children,
}: {
  specName: string;
  servers: Array<ServerInfo>;
  defaultServer: string;
  defaultBody: string;
  authSchemes: Array<AuthScheme>;
  children: ReactNode;
}) {
  const [serverUrl, setServerUrl] = useState(defaultServer);
  const [serverVarValues, setServerVarValues] = useState<Record<string, string>>(() =>
    seedServerVarValues(servers),
  );
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [authValues, setAuthValues] = useState<Record<string, string>>({});
  const [bodyValue, setBodyValue] = useState(defaultBody);

  const resolvedServerUrl = useMemo(() => {
    const selected = servers.find(s => s.url === serverUrl);
    return resolveServerUrl(serverUrl, serverVarValues, selected?.variables);
  }, [servers, serverUrl, serverVarValues]);

  // Hydrate persisted auth values (sessionStorage) once per spec.
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const { name } of authSchemes) {
      next[name] = loadStored(storageKey(specName, \`auth:\${name}\`));
    }
    setAuthValues(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resync only when the spec changes
  }, [specName]);

  function setParamValue(key: string, v: string) {
    setParamValues(prev => ({ ...prev, [key]: v }));
  }
  function setServerVarValue(name: string, v: string) {
    setServerVarValues(prev => ({ ...prev, [name]: v }));
  }
  function setAuthValue(name: string, v: string) {
    setAuthValues(prev => ({ ...prev, [name]: v }));
    saveStored(storageKey(specName, \`auth:\${name}\`), v);
  }

  return (
    <TryItContext.Provider
      value={{ servers, serverUrl, setServerUrl, serverVarValues, setServerVarValue, resolvedServerUrl, paramValues, setParamValue, authValues, setAuthValue, bodyValue, setBodyValue }}
    >
      {children}
    </TryItContext.Provider>
  );
}
`;

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

/**
 * Split a switcher option label into a short tab label + an optional
 * description. Response options arrive combined, e.g.
 * "401 — Authentication is missing or invalid." — the status code becomes the
 * tab and the prose renders on its own line between the header and the code.
 * Labels with no separator (e.g. a language name) keep the whole label as the
 * tab and carry no description.
 */
function splitLabel(label: string): { tab: string; description: string } {
  const m = label.match(/^(.*?)\\s+[—–-]\\s+(.*)$/);
  if (m) return { tab: m[1].trim(), description: m[2].trim() };
  return { tab: label.trim(), description: "" };
}

export default function CodeSwitcher({ options, label, children }: CodeSwitcherProps) {
  const initial = options[0]?.value ?? "";
  const [active, setActive] = useState<string>(initial);
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
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
  const parsed = options.map(o => ({ ...o, ...splitLabel(o.label) }));
  const activeDescription = parsed.find(o => o.value === active)?.description ?? "";

  return (
    <div className="api-code-switcher">
      <div className="api-code-switcher-toolbar">
        <span className="api-code-switcher-label">{label}</span>
        {/* Plain toggle buttons — intentionally NOT role="tab"/"tablist", which
            would inherit the theme's global Nextra-Tabs styling (boxed header
            bar, accent active pill, top margin). aria-pressed carries the
            selected state instead. */}
        <div className="api-code-switcher-tabs">
          {parsed.map(o => (
            <button
              key={o.value}
              type="button"
              aria-pressed={o.value === active ? "true" : "false"}
              className="api-code-switcher-tab"
              data-active={o.value === active ? "true" : "false"}
              onClick={() => setActive(o.value)}
            >
              {o.tab}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="api-code-switcher-copy"
          data-copied={copied ? "true" : "false"}
          onClick={handleCopy}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {activeDescription && <div className="api-code-switcher-desc">{activeDescription}</div>}
      <div className="api-code-switcher-body api-cb-host" ref={bodyRef} data-wrap={wrap ? "true" : "false"}>
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
        <button
          type="button"
          className="api-cb-wrap"
          data-active={wrap ? "true" : "false"}
          aria-pressed={wrap ? "true" : "false"}
          aria-label="Toggle word wrap"
          title="Toggle word wrap"
          onClick={() => setWrap(w => !w)}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h18M3 12h15a3 3 0 0 1 0 6h-4m0 0 2-2m-2 2 2 2M3 18h6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
`;

const CODE_EDITOR = `"use client";

import { useRef, type KeyboardEvent } from "react";
import { escapeHtml, highlightJson } from "./jsonHighlight";

interface CodeEditorProps {
  value: string;
  onChange: (v: string) => void;
  /** Highlight language; only "json" is tokenized, others render as plain text. */
  language?: string;
  /** Minimum visible lines (drives the editor's min-height). */
  rows?: number;
  ariaLabel?: string;
}

/**
 * A dependency-free code editor: a transparent <textarea> layered over a
 * highlighted <pre> mirror of the same text. The two share identical font,
 * padding, line-height and wrapping, so the colored tokens sit exactly under
 * the (invisible) typed characters while the textarea owns editing, caret and
 * selection. Tab inserts two spaces instead of moving focus.
 *
 * This avoids pulling CodeMirror/Monaco into the scaffold (a heavier, build-
 * managed dependency). If the dev team later wants a full editor, swap this one
 * component — its props (value/onChange/language) are editor-agnostic.
 */
export default function CodeEditor({ value, onChange, language = "json", rows = 8, ariaLabel }: CodeEditorProps) {
  const preRef = useRef<HTMLPreElement | null>(null);

  const html = (language === "json" ? highlightJson(value) : escapeHtml(value)) + "\\n";

  // Keep the highlighted layer scrolled in lockstep with the textarea.
  function syncScroll(e: React.UIEvent<HTMLTextAreaElement>) {
    const pre = preRef.current;
    if (!pre) return;
    pre.scrollTop = e.currentTarget.scrollTop;
    pre.scrollLeft = e.currentTarget.scrollLeft;
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const ta = e.currentTarget;
    const { selectionStart, selectionEnd } = ta;
    const next = value.slice(0, selectionStart) + "  " + value.slice(selectionEnd);
    onChange(next);
    // Restore the caret after the inserted indent on the next tick.
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = selectionStart + 2;
    });
  }

  return (
    <div className="api-tryit-code-editor" style={{ minHeight: \`\${rows * 1.55 + 1.25}em\` }}>
      <pre className="api-tryit-code-editor-pre" aria-hidden="true" ref={preRef}>
        <code
          className={\`language-\${language}\`}
          // eslint-disable-next-line react/no-danger -- escaped via escapeHtml before tokenization; only our own <span class="json-*"> wrappers are unescaped
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
      <textarea
        className="api-tryit-code-editor-textarea"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        value={value}
        rows={rows}
        aria-label={ariaLabel ?? "Code editor"}
        onChange={e => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
`;

const TYPED_INPUT = `"use client";

import CodeEditor from "./CodeEditor";
import { inputKind, type ParamSchema } from "./paramSchema";

interface TypedInputProps {
  schema: ParamSchema | undefined;
  value: string;
  onChange: (v: string) => void;
  required: boolean;
  /** Description/hint, used as a text-input placeholder. */
  placeholder?: string;
}

/**
 * Render the input control that matches an OpenAPI parameter/property schema:
 * a select for enums and booleans, a number spinner for integer/number (with
 * min/max/step from the schema), native date pickers for date/date-time
 * formats, a password field for \`format: password\`, a multi-select for arrays
 * of enums, and a JSON code editor for objects — falling back to a plain text
 * input. The stored value is always a string (the form/sample layer keeps a
 * single \`Record<string,string>\`); coercion to the wire type happens at send.
 */
export default function TypedInput({ schema, value, onChange, required, placeholder }: TypedInputProps) {
  const s = schema ?? {};
  const kind = inputKind(s);
  const ph = placeholder || (s.example !== undefined ? String(s.example) : "");

  switch (kind) {
    case "enum":
      return (
        <select className="api-tryit-input" value={value} onChange={e => onChange(e.target.value)}>
          {!required && <option value="">—</option>}
          {(s.enum ?? []).map(o => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      );

    case "boolean":
      return (
        <select className="api-tryit-input" value={value} onChange={e => onChange(e.target.value)}>
          <option value="">—</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );

    case "integer":
    case "number":
      return (
        <input
          type="number"
          className="api-tryit-input"
          value={value}
          step={kind === "integer" ? 1 : "any"}
          {...(s.minimum !== undefined ? { min: s.minimum } : {})}
          {...(s.maximum !== undefined ? { max: s.maximum } : {})}
          onChange={e => onChange(e.target.value)}
          placeholder={ph}
        />
      );

    case "date":
      return (
        <input type="date" className="api-tryit-input" value={value} onChange={e => onChange(e.target.value)} />
      );

    case "datetime":
      return (
        <input
          type="datetime-local"
          className="api-tryit-input"
          value={value}
          onChange={e => onChange(e.target.value)}
        />
      );

    case "password":
      return (
        <input
          type="password"
          className="api-tryit-input"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={ph}
        />
      );

    case "array-enum": {
      const selected = value ? value.split(",") : [];
      return (
        <select
          multiple
          className="api-tryit-input api-tryit-input-multi"
          value={selected}
          onChange={e => onChange(Array.from(e.target.selectedOptions, o => o.value).join(","))}
        >
          {(s.items?.enum ?? []).map(o => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      );
    }

    case "array":
      return (
        <input
          type="text"
          className="api-tryit-input"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={ph || "comma-separated values"}
        />
      );

    case "object":
      return <CodeEditor value={value} onChange={onChange} language="json" rows={4} ariaLabel="JSON value" />;

    default:
      return (
        <input
          type="text"
          className="api-tryit-input"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={ph}
        />
      );
  }
}
`;

const REQUEST_SAMPLE = `"use client";

import { useEffect, useRef, useState } from "react";
import { useTryItInputs } from "./TryItContext";
import { generateSnippets, type SnippetAuth, type SnippetParam } from "./requestSnippets";

interface RequestSampleProps {
  method: string;
  path: string;
  /** Flat param list (data.tryItParameters). */
  parameters: Array<SnippetParam>;
  /** Auth schemes (data.tryItAuthSchemes). */
  authSchemes: Array<SnippetAuth>;
  requestBody?: { contentType: string };
}

/**
 * Live "Request" sample for the aside column. Reads the current Try-it inputs
 * from context and regenerates the per-language snippet on every change, so the
 * sample always reflects what the form would send (all available params/attrs
 * are shown, with \`<name>\` placeholders until filled). Mirrors CodeSwitcher's
 * markup/classes so it inherits the theme's code-switcher styling; the only
 * difference is the body is generated text, not a build-time highlighted block.
 */
export default function RequestSample({ method, path, parameters, authSchemes, requestBody }: RequestSampleProps) {
  const { resolvedServerUrl, paramValues, authValues, bodyValue } = useTryItInputs();
  const options = generateSnippets({
    method,
    path,
    serverUrl: resolvedServerUrl,
    parameters,
    authSchemes,
    bodyValue,
    paramValues,
    authValues,
    ...(requestBody ? { requestBody } : {}),
  });

  const [active, setActive] = useState(options[0]?.value ?? "curl");
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const current = options.find(o => o.value === active) ?? options[0];

  function handleCopy() {
    if (!current) return;
    void navigator.clipboard.writeText(current.code).then(() => {
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="api-code-switcher">
      <div className="api-code-switcher-toolbar">
        <span className="api-code-switcher-label">Request</span>
        <select
          className="api-code-switcher-select"
          value={active}
          onChange={e => setActive(e.target.value)}
          aria-label="Select language"
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
      <div className="api-code-switcher-body api-cb-host">
        <pre className="api-request-sample-pre" data-wrap={wrap ? "true" : "false"}>
          <code className={\`language-\${current?.lang ?? "bash"}\`}>{current?.code ?? ""}</code>
        </pre>
        <button
          type="button"
          className="api-cb-wrap"
          data-active={wrap ? "true" : "false"}
          aria-pressed={wrap ? "true" : "false"}
          aria-label="Toggle word wrap"
          title="Toggle word wrap"
          onClick={() => setWrap(w => !w)}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h18M3 12h15a3 3 0 0 1 0 6h-4m0 0 2-2m-2 2 2 2M3 18h6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
`;

const HISTORY_ITEM = `"use client";

import { useEffect, useRef, useState } from "react";
import { snippetsForRequest } from "./requestSnippets";
import { statusFamily, type HistoryEntry } from "./tryItHistory";
import { highlightJson } from "./jsonHighlight";

interface HistoryItemProps {
  entry: HistoryEntry;
  open: boolean;
  onToggle: () => void;
}

/** "x minutes/hours/days ago", switching to a plain date after 9 days. */
function relativeTime(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 9) return new Date(ts).toLocaleDateString();
  if (day >= 1) return \`\${day} day\${day === 1 ? "" : "s"} ago\`;
  if (hr >= 1) return \`\${hr} hour\${hr === 1 ? "" : "s"} ago\`;
  if (min >= 1) return \`\${min} minute\${min === 1 ? "" : "s"} ago\`;
  return "just now";
}

/** Full timestamp for the hover title: "Month Day, Year Time". */
function fullTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const WrapIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18M3 12h15a3 3 0 0 1 0 6h-4m0 0 2-2m-2 2 2 2M3 18h6" />
  </svg>
);

/**
 * One request-history entry. The row (method + url + status + time) toggles an
 * expanded view that shows the sent Request as a language-switchable code sample
 * (same treatment as the right-column RequestSample) and the Response as a
 * Body/Headers tab switcher — both reusing the .api-code-switcher styling.
 */
export default function HistoryItem({ entry, open, onToggle }: HistoryItemProps) {
  const reqSnippets = snippetsForRequest({
    method: entry.method,
    url: entry.url,
    headers: entry.headers,
    ...(entry.body !== undefined ? { body: entry.body } : {}),
  });
  const [reqLang, setReqLang] = useState(reqSnippets[0]?.value ?? "curl");
  const [respTab, setRespTab] = useState<"body" | "headers">("body");
  const [reqWrap, setReqWrap] = useState(false);
  const [respWrap, setRespWrap] = useState(false);
  const [reqCopied, setReqCopied] = useState(false);
  const [respCopied, setRespCopied] = useState(false);
  const reqTimer = useRef<number | null>(null);
  const respTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (reqTimer.current) window.clearTimeout(reqTimer.current);
      if (respTimer.current) window.clearTimeout(respTimer.current);
    },
    [],
  );

  const reqCurrent = reqSnippets.find(s => s.value === reqLang) ?? reqSnippets[0];
  const headerLines = entry.responseHeaders
    ? Object.entries(entry.responseHeaders).map(([k, v]) => \`\${k}: \${v}\`).join("\\n")
    : "";
  const respText = respTab === "headers" ? headerLines : entry.responseBody ?? "";

  function handleReqCopy() {
    if (!reqCurrent) return;
    void navigator.clipboard.writeText(reqCurrent.code).then(() => {
      setReqCopied(true);
      if (reqTimer.current) window.clearTimeout(reqTimer.current);
      reqTimer.current = window.setTimeout(() => setReqCopied(false), 1500);
    });
  }
  function handleRespCopy() {
    void navigator.clipboard.writeText(respText).then(() => {
      setRespCopied(true);
      if (respTimer.current) window.clearTimeout(respTimer.current);
      respTimer.current = window.setTimeout(() => setRespCopied(false), 1500);
    });
  }

  return (
    <li className="api-tryit-history-item" data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="api-tryit-history-row"
        aria-expanded={open ? "true" : "false"}
        onClick={onToggle}
      >
        <span className={\`api-method api-method-\${entry.method.toLowerCase()}\`}>{entry.method}</span>
        <code className="api-tryit-history-url">{entry.url}</code>
        <time className="api-tryit-history-time" title={fullTimestamp(entry.ts)}>
          {relativeTime(entry.ts)}
        </time>
        {entry.status !== undefined ? (
          <span className={\`api-tryit-history-status api-status-\${statusFamily(entry.status)}\`}>{entry.status}</span>
        ) : entry.error ? (
          <span className="api-tryit-history-status api-status-err">ERR</span>
        ) : null}
      </button>

      <div className="api-tryit-history-accordion">
        <div className="api-tryit-history-accordion-inner">
          <div className="api-tryit-history-detail">
          {/* Request — code sample with a language switcher */}
          <div className="api-code-switcher">
            <div className="api-code-switcher-toolbar">
              <span className="api-code-switcher-label">Request</span>
              <select
                className="api-code-switcher-select"
                value={reqLang}
                onChange={e => setReqLang(e.target.value)}
                aria-label="Select language"
              >
                {reqSnippets.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="api-code-switcher-copy"
                data-copied={reqCopied ? "true" : "false"}
                onClick={handleReqCopy}
              >
                {reqCopied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="api-code-switcher-body api-cb-host">
              <pre className="api-request-sample-pre" data-wrap={reqWrap ? "true" : "false"}>
                <code className={\`language-\${reqCurrent?.lang ?? "bash"}\`}>{reqCurrent?.code ?? ""}</code>
              </pre>
              <button
                type="button"
                className="api-cb-wrap"
                data-active={reqWrap ? "true" : "false"}
                aria-pressed={reqWrap ? "true" : "false"}
                aria-label="Toggle word wrap"
                title="Toggle word wrap"
                onClick={() => setReqWrap(w => !w)}
              >
                <WrapIcon />
              </button>
            </div>
          </div>

          {/* Response — Body/Headers tabs, or the error */}
          {entry.error ? (
            <div className="api-tryit-error">{entry.error}</div>
          ) : entry.status !== undefined ? (
            <div className="api-code-switcher">
              <div className="api-code-switcher-toolbar">
                <span className={\`api-tryit-history-status api-status-\${statusFamily(entry.status)}\`}>
                  {entry.status}
                </span>
                {entry.statusText && (
                  <span className="api-code-switcher-label">{entry.statusText}</span>
                )}
                <div className="api-code-switcher-tabs">
                  <button
                    type="button"
                    className="api-code-switcher-tab"
                    data-active={respTab === "body" ? "true" : "false"}
                    aria-pressed={respTab === "body" ? "true" : "false"}
                    onClick={() => setRespTab("body")}
                  >
                    Body
                  </button>
                  <button
                    type="button"
                    className="api-code-switcher-tab"
                    data-active={respTab === "headers" ? "true" : "false"}
                    aria-pressed={respTab === "headers" ? "true" : "false"}
                    onClick={() => setRespTab("headers")}
                  >
                    Headers
                  </button>
                </div>
                <button
                  type="button"
                  className="api-code-switcher-copy"
                  data-copied={respCopied ? "true" : "false"}
                  onClick={handleRespCopy}
                >
                  {respCopied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="api-code-switcher-body api-cb-host" data-wrap={respWrap ? "true" : "false"}>
                <pre className="api-tryit-response-body">
                  {respTab === "body" && entry.responseBodyIsJson ? (
                    <code
                      className="language-json"
                      // eslint-disable-next-line react/no-danger -- escaped via escapeHtml before tokenization; only our own <span class="json-*"> wrappers are unescaped
                      dangerouslySetInnerHTML={{ __html: highlightJson(entry.responseBody ?? "") }}
                    />
                  ) : (
                    <code>{respText}</code>
                  )}
                </pre>
                <button
                  type="button"
                  className="api-cb-wrap"
                  data-active={respWrap ? "true" : "false"}
                  aria-pressed={respWrap ? "true" : "false"}
                  aria-label="Toggle word wrap"
                  title="Toggle word wrap"
                  onClick={() => setRespWrap(w => !w)}
                >
                  <WrapIcon />
                </button>
              </div>
            </div>
          ) : (
            <div className="api-tryit-history-pending">Waiting for response…</div>
          )}
          </div>
        </div>
      </div>
    </li>
  );
}
`;

const ENDPOINT = `"use client";

import { Children, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import EndpointMeta from "./EndpointMeta";
import ParamTable from "./ParamTable";
import SchemaBlock from "./SchemaBlock";
import ResponseTabs from "./ResponseTabs";
import AuthRequirements from "./AuthRequirements";
import TryIt from "./TryIt";
import RequestSample from "./RequestSample";
import { TryItProvider } from "./TryItContext";
import type { ParamSchema } from "./paramSchema";

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
  /** Value schema (type/format/enum/default) — drives the Try-it input control. */
  schema?: ParamSchema;
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
  servers: Array<{
    url: string;
    description?: string;
    variables?: Record<string, { default?: string; enum?: Array<string>; description?: string }>;
  }>;
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
  const refsMap = refs ?? {};
  // Default request body shown in the live sample and the Try it form.
  const defaultBody =
    data.requestBody?.example !== undefined ? JSON.stringify(data.requestBody.example, null, 2) : "";
  // The static "Request" CodeSwitcher from the MDX samples slot is replaced by
  // the live <RequestSample>; keep the rest of the slot (the Response block).
  const responseSamples = isValidElement(samples)
    ? Children.toArray((samples as ReactElement<{ children?: ReactNode }>).props.children).filter(child => {
        if (!isValidElement(child)) return true;
        const label = (child as ReactElement<{ label?: string }>).props.label;
        return typeof label !== "string" || label.toLowerCase() !== "request";
      })
    : samples;
  // The flat tryItParameters drop the value schema; re-attach it from the typed
  // \`parameters.{in}\` lists (matched by name) so the Try-it form can render a
  // type-appropriate input. (Build-team handoff: emit \`schema\` directly on
  // tryItParameters so this bridge isn't needed.)
  const schemaByKey = new Map<string, ParamSchema | undefined>();
  for (const kind of ["path", "query", "header", "cookie"] as const) {
    for (const op of data.parameters[kind]) {
      schemaByKey.set(\`\${kind}:\${op.name}\`, op.schema as ParamSchema | undefined);
    }
  }
  const tryItParameters: Array<TryItParameter> = data.tryItParameters.map(p => {
    const schema = p.schema ?? schemaByKey.get(\`\${p.in}:\${p.name}\`);
    return schema ? { ...p, schema } : p;
  });
  // The endpoint meta line carries a "Try it" toggle that expands the TryIt
  // widget below it as an accordion. State lives here because the toggle
  // button (in EndpointMeta) and the collapsible panel are siblings.
  const [tryItOpen, setTryItOpen] = useState(false);

  return (
    <TryItProvider
      specName={data.specName}
      servers={data.servers}
      defaultServer={data.servers[0]?.url ?? ""}
      defaultBody={defaultBody}
      authSchemes={data.tryItAuthSchemes}
    >
    <div className="api-endpoint-grid">
      <div className="api-endpoint-main">
        <h1>{data.title}</h1>

        <div className="api-tryit-shell" data-open={tryItOpen ? "true" : "false"}>
          <EndpointMeta
            method={data.method}
            path={data.path}
            deprecated={data.deprecated}
            server={data.servers[0]?.url}
            tryItOpen={tryItOpen}
            onToggleTryIt={() => setTryItOpen(o => !o)}
          />

          <div className="api-tryit-accordion">
            <div className="api-tryit-accordion-inner">
              <TryIt
                specName={data.specName}
                method={data.method.toUpperCase()}
                path={data.path}
                servers={data.servers}
                parameters={tryItParameters}
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
            </div>
          </div>
        </div>

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
            <ResponseTabs responses={data.responses} refs={refsMap} />
          </>
        )}
      </div>

      <div className="api-endpoint-aside">
        <RequestSample
          method={data.method}
          path={data.path}
          parameters={data.tryItParameters}
          authSchemes={data.tryItAuthSchemes}
          {...(data.requestBody ? { requestBody: { contentType: data.requestBody.contentType } } : {})}
        />
        {responseSamples}
      </div>
    </div>
    </TryItProvider>
  );
}
`;

const REQUEST_SNIPPETS = `// Pure request-snippet generator for the live "Request" sample. Given the
// operation's spec data plus the values currently entered in the Try it box,
// it resolves a single concrete request (URL incl. query, headers, body) and
// renders it as a code string in each supported language. All available
// parameters/attributes are surfaced: anything not yet filled in shows a
// \`<name>\`-style placeholder, so the sample is complete from first paint and
// updates as the user types.

export interface SnippetParam {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
}

export interface SnippetScheme {
  type: string;
  scheme?: string;
  in?: string;
  name?: string;
}

export interface SnippetAuth {
  name: string;
  scheme: SnippetScheme;
}

export interface SnippetSource {
  method: string;
  path: string;
  serverUrl: string;
  parameters: Array<SnippetParam>;
  authSchemes: Array<SnippetAuth>;
  requestBody?: { contentType: string };
  /** Raw request body text (the edited/example JSON). */
  bodyValue: string;
  /** Entered param values, keyed \`\${in}:\${name}\`. */
  paramValues: Record<string, string>;
  /** Entered auth values, keyed by scheme name. */
  authValues: Record<string, string>;
}

interface ResolvedRequest {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body: string;
  hasBody: boolean;
}

function placeholder(name: string): string {
  return \`<\${name}>\`;
}

/**
 * Collapse a request body for embedding in a snippet. The Try-it code editor
 * holds pretty-printed JSON whose newlines + indentation would otherwise spill
 * across multiple lines inside a \`curl -d '...'\` argument (or a JS/Python/Go
 * literal), making the generated request look broken. Valid JSON is
 * re-serialized compact (single line); anything else is returned trimmed but
 * otherwise unchanged, since its whitespace may be significant (raw text, a
 * form-encoded or XML body, …).
 */
function compactBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return trimmed;
  try {
    return JSON.stringify(JSON.parse(trimmed));
  } catch {
    return trimmed;
  }
}

/** Auth → header/query entries, falling back to readable placeholders. */
function resolveAuth(
  authSchemes: Array<SnippetAuth>,
  authValues: Record<string, string>,
): { headers: Record<string, string>; query: Record<string, string> } {
  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};
  for (const { name, scheme } of authSchemes) {
    const v = authValues[name] || "";
    if (scheme.type === "http" && scheme.scheme === "bearer") {
      headers["Authorization"] = \`Bearer \${v || "YOUR_TOKEN"}\`;
    } else if (scheme.type === "http" && scheme.scheme === "basic") {
      headers["Authorization"] = \`Basic \${v || "BASE64(USER:PASSWORD)"}\`;
    } else if (scheme.type === "apiKey" && scheme.name) {
      const val = v || "YOUR_API_KEY";
      if (scheme.in === "header") headers[scheme.name] = val;
      else if (scheme.in === "query") query[scheme.name] = val;
    } else if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
      headers["Authorization"] = \`Bearer \${v || "YOUR_TOKEN"}\`;
    }
  }
  return { headers, query };
}

export function resolveRequest(src: SnippetSource): ResolvedRequest {
  const pathParams = src.parameters.filter(p => p.in === "path");
  const queryParams = src.parameters.filter(p => p.in === "query");
  const headerParams = src.parameters.filter(p => p.in === "header");

  // Path: substitute entered values; keep \`{name}\` where still unfilled.
  let resolvedPath = src.path;
  for (const p of pathParams) {
    const v = src.paramValues[\`path:\${p.name}\`];
    if (v) resolvedPath = resolvedPath.replace(\`{\${p.name}}\`, encodeURIComponent(v));
  }

  const auth = resolveAuth(src.authSchemes, src.authValues);

  // Query: every available query param is shown (entered value or placeholder),
  // plus any auth keys that live in the query string.
  const queryPairs: Array<[string, string]> = [];
  for (const p of queryParams) {
    const v = src.paramValues[\`query:\${p.name}\`];
    queryPairs.push([p.name, v || placeholder(p.name)]);
  }
  for (const [k, v] of Object.entries(auth.query)) queryPairs.push([k, v]);

  const cleanServer = (src.serverUrl || "").replace(/\\/+$/, "");
  const qs = queryPairs
    .map(([k, v]) => \`\${encodeURIComponent(k)}=\${encodeURIComponent(v)}\`)
    .join("&");
  const url = \`\${cleanServer}\${resolvedPath}\${qs ? \`?\${qs}\` : ""}\`;

  // Headers: explicit header params, then auth headers, then Content-Type.
  const headers: Array<[string, string]> = [];
  for (const p of headerParams) {
    const v = src.paramValues[\`header:\${p.name}\`];
    headers.push([p.name, v || placeholder(p.name)]);
  }
  for (const [k, v] of Object.entries(auth.headers)) headers.push([k, v]);
  const hasBody = Boolean(src.requestBody) && src.bodyValue.trim().length > 0;
  if (hasBody) headers.push(["Content-Type", src.requestBody!.contentType]);

  return { method: src.method.toUpperCase(), url, headers, body: compactBody(src.bodyValue), hasBody };
}

// ── Per-language renderers ───────────────────────────────────────────────────

function indentBody(body: string, indent: string): string {
  return body
    .split("\\n")
    .map((line, i) => (i === 0 ? line : indent + line))
    .join("\\n");
}

function toCurl(r: ResolvedRequest): string {
  const lines = [\`curl -X \${r.method} '\${r.url}'\`];
  for (const [k, v] of r.headers) lines.push(\`  -H '\${k}: \${v}'\`);
  if (r.hasBody) lines.push(\`  -d '\${r.body}'\`);
  return lines.join(" \\\\\\n");
}

function headerObjectLiteral(r: ResolvedRequest, indent: string): string {
  if (r.headers.length === 0) return "{}";
  const inner = r.headers.map(([k, v]) => \`\${indent}  '\${k}': '\${v}'\`).join(",\\n");
  return \`{\\n\${inner}\\n\${indent}}\`;
}

function toJavaScript(r: ResolvedRequest): string {
  const parts = [\`  method: '\${r.method}'\`, \`  headers: \${headerObjectLiteral(r, "  ")}\`];
  if (r.hasBody) parts.push(\`  body: JSON.stringify(\${indentBody(r.body, "  ")})\`);
  return \`const response = await fetch('\${r.url}', {
\${parts.join(",\\n")}
});

const data = await response.json();
console.log(data);\`;
}

function toTypeScript(r: ResolvedRequest): string {
  const parts = [\`  method: '\${r.method}'\`, \`  headers: \${headerObjectLiteral(r, "  ")}\`];
  if (r.hasBody) parts.push(\`  body: JSON.stringify(\${indentBody(r.body, "  ")})\`);
  return \`interface ApiResponse {
  // shape your response here
}

const response: Response = await fetch('\${r.url}', {
\${parts.join(",\\n")}
});

const data = (await response.json()) as ApiResponse;
console.log(data);\`;
}

function toPython(r: ResolvedRequest): string {
  const headerLines = r.headers.map(([k, v]) => \`    "\${k}": "\${v}"\`).join(",\\n");
  const lines = [
    "import requests",
    "",
    \`url = "\${r.url}"\`,
    \`headers = {\\n\${headerLines}\\n}\`,
  ];
  if (r.hasBody) {
    lines.push(\`payload = \${indentBody(r.body, "")}\`);
    lines.push("");
    lines.push(\`response = requests.request("\${r.method.toLowerCase()}", url, headers=headers, json=payload)\`);
  } else {
    lines.push("");
    lines.push(\`response = requests.request("\${r.method.toLowerCase()}", url, headers=headers)\`);
  }
  lines.push("print(response.json())");
  return lines.join("\\n");
}

function toGo(r: ResolvedRequest): string {
  const headerSets = r.headers.map(([k, v]) => \`\\treq.Header.Set("\${k}", "\${v}")\`).join("\\n");
  const bodyDecl = r.hasBody ? \`\\tbody := strings.NewReader(\\\`\${r.body}\\\`)\\n\` : "";
  const bodyArg = r.hasBody ? "body" : "nil";
  const imports = r.hasBody
    ? \`\\t"fmt"\\n\\t"io"\\n\\t"net/http"\\n\\t"strings"\`
    : \`\\t"fmt"\\n\\t"io"\\n\\t"net/http"\`;
  return \`package main

import (
\${imports}
)

func main() {
\${bodyDecl}\\treq, err := http.NewRequest("\${r.method}", "\${r.url}", \${bodyArg})
\\tif err != nil {
\\t\\tpanic(err)
\\t}
\${headerSets}

\\tresp, err := http.DefaultClient.Do(req)
\\tif err != nil {
\\t\\tpanic(err)
\\t}
\\tdefer resp.Body.Close()

\\tout, _ := io.ReadAll(resp.Body)
\\tfmt.Println(string(out))
}\`;
}

export interface SnippetOption {
  value: string;
  label: string;
  lang: string;
  code: string;
}

function renderAll(r: ResolvedRequest): Array<SnippetOption> {
  return [
    { value: "curl", label: "cURL", lang: "bash", code: toCurl(r) },
    { value: "javascript", label: "JavaScript", lang: "js", code: toJavaScript(r) },
    { value: "typescript", label: "TypeScript", lang: "ts", code: toTypeScript(r) },
    { value: "python", label: "Python", lang: "python", code: toPython(r) },
    { value: "go", label: "Go", lang: "go", code: toGo(r) },
  ];
}

/** Build the language options + rendered code for the current request state. */
export function generateSnippets(src: SnippetSource): Array<SnippetOption> {
  return renderAll(resolveRequest(src));
}

/** Build the language snippets for an already-resolved (e.g. history) request. */
export function snippetsForRequest(req: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}): Array<SnippetOption> {
  return renderAll({
    method: req.method.toUpperCase(),
    url: req.url,
    headers: Object.entries(req.headers),
    body: compactBody(req.body ?? ""),
    hasBody: typeof req.body === "string" && req.body.trim().length > 0,
  });
}
`;

const TRY_IT_HISTORY = `// Shared types + helpers for the Try-it request history. Kept out of TryIt.tsx
// so both TryIt and HistoryItem can import them without a circular dependency.

/** One sent request plus its response, persisted to localStorage. */
export interface HistoryEntry {
  ts: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  // Response — filled in once the fetch resolves.
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBodyIsJson?: boolean;
  error?: string;
}

export const HISTORY_LIMIT = 10;

/** 2xx/3xx/4xx/5xx family for status-color styling. */
export function statusFamily(status: number): string {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500) return "5xx";
  return "default";
}

export function historyKey(specName: string, method: string, path: string): string {
  return \`jolli-tryit-history:\${specName}:\${method}:\${path}\`;
}

export function loadHistory(key: string): Array<HistoryEntry> {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Array<HistoryEntry>) : [];
  } catch {
    return [];
  }
}

export function saveHistory(key: string, entries: Array<HistoryEntry>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(entries));
  } catch {
    /* ignore quota / serialization errors */
  }
}
`;

const JSON_HIGHLIGHT = `// Lightweight JSON syntax highlighter for the Try-it response bodies. Tokenizes
// a pretty-printed JSON string into class-tagged <span>s; the input is
// HTML-escaped first so only our own <span class="json-*"> wrappers are markup.
// The \`.json-*\` colors live in the built site's styles/api.css, scoped to
// \`.api-tryit-response-body\`.

export function escapeHtml(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function highlightJson(json: string): string {
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
`;

const SERVER_VARS = `// Server-variable handling for OpenAPI server URLs. A server \`url\` may contain
// \`{name}\` templated segments (host, port, basePath, …) whose values come from
// the spec's \`server.variables\` map: each variable carries a \`default\` and an
// optional \`enum\` of allowed values. The Try-it form renders an input (or a
// select, when an enum is present) per variable, and the resolved URL is what
// every request/sample is built against.
//
// NOTE (build-team handoff): the generated operation \`_data/*.json\` currently
// drops \`server.variables\`, so only the variable *names* survive (parsed from
// the URL template here). Until the data layer emits \`variables\`, fields render
// without a default/enum and the user must type the value. Once \`variables\` is
// included, the same UI pre-fills defaults and shows enum dropdowns with no
// component changes.

export interface ServerVariable {
  default?: string;
  enum?: Array<string>;
  description?: string;
}

export interface ServerInfo {
  url: string;
  description?: string;
  variables?: Record<string, ServerVariable>;
}

const TOKEN_RE = /\\{([^}]+)\\}/g;

/** Variable names referenced in a server URL template, in order, de-duplicated. */
export function serverVariableNames(url: string): Array<string> {
  const out: Array<string> = [];
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(url)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Resolve \`{var}\` tokens in a server URL template. Per-variable precedence:
 * entered value → spec default → \`{var}\` left intact (so an unfilled,
 * default-less variable stays visible rather than collapsing to an empty
 * segment and producing a broken URL).
 */
export function resolveServerUrl(
  url: string,
  values: Record<string, string>,
  variables?: Record<string, ServerVariable>,
): string {
  return url.replace(TOKEN_RE, (_full, name: string) => {
    const entered = values[name];
    if (entered) return entered;
    const def = variables?.[name]?.default;
    if (def) return def;
    return \`{\${name}}\`;
  });
}

/** Seed variable values from spec defaults across every server (first default wins). */
export function seedServerVarValues(servers: Array<ServerInfo>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of servers) {
    for (const name of serverVariableNames(s.url)) {
      const def = s.variables?.[name]?.default;
      if (def && out[name] === undefined) out[name] = def;
    }
  }
  return out;
}

/**
 * The variables a given server exposes, in URL order. Names are always derived
 * from the URL template; metadata (default/enum/description) is attached when
 * present, falling back to an empty descriptor so the field still renders.
 */
export function serverVariablesFor(
  server: ServerInfo | undefined,
): Array<{ name: string; variable: ServerVariable }> {
  if (!server) return [];
  return serverVariableNames(server.url).map(name => ({
    name,
    variable: server.variables?.[name] ?? {},
  }));
}
`;

const PARAM_SCHEMA = `// The subset of an OpenAPI parameter/property schema the Try-it form reads to
// pick an appropriate input control. Kept deliberately permissive (everything
// optional) so it tolerates whatever the spec provides, and falls back to a
// plain text input when nothing useful is present.

export interface ParamSchema {
  /**
   * May be a single type or, in OpenAPI 3.1 / JSON Schema, an array such as
   * \`["boolean", "null"]\` for a nullable value. Read it via \`primaryType()\`,
   * never directly, so the array form is handled.
   */
  type?: string | Array<string>;
  format?: string;
  enum?: Array<string | number | boolean>;
  default?: unknown;
  example?: unknown;
  items?: ParamSchema;
  minimum?: number;
  maximum?: number;
  nullable?: boolean;
}

/**
 * The schema's effective type, tolerating the 3.1 array form: \`["boolean",
 * "null"]\` → \`"boolean"\`. Returns the first non-\`"null"\` entry of an array, the
 * string as-is, or undefined when no type is declared.
 */
export function primaryType(schema: ParamSchema | undefined): string | undefined {
  const t = schema?.type;
  if (Array.isArray(t)) return t.find(x => x !== "null");
  return t;
}

/** The concrete control the form should render for a schema. */
export type InputKind =
  | "enum" // <select> of allowed values
  | "boolean" // true / false select
  | "integer"
  | "number"
  | "date"
  | "datetime"
  | "password"
  | "array-enum" // multi-select of allowed item values
  | "array" // comma-separated scalars
  | "object" // JSON code editor
  | "text";

/** Decide which control fits a schema, honoring enum → format → type, in that order. */
export function inputKind(schema: ParamSchema | undefined): InputKind {
  const s = schema ?? {};
  if (s.enum && s.enum.length > 0) return "enum";
  const type = primaryType(s);
  if (type === "boolean") return "boolean";
  if (type === "integer") return "integer";
  if (type === "number") return "number";
  if (type === "array") {
    return s.items?.enum && s.items.enum.length > 0 ? "array-enum" : "array";
  }
  if (type === "object") return "object";
  if (type === "string" || type === undefined) {
    if (s.format === "password") return "password";
    if (s.format === "date") return "date";
    if (s.format === "date-time") return "datetime";
  }
  return "text";
}

/** A short human label for the field hint, e.g. "integer", "boolean", "array<string>". */
export function typeLabel(schema: ParamSchema | undefined): string {
  const s = schema ?? {};
  const type = primaryType(s);
  if (type === "array") {
    const item = primaryType(s.items) ?? "string";
    return \`array<\${item}>\`;
  }
  const base = type ?? "string";
  return s.format ? \`\${base}<\${s.format}>\` : base;
}

/** Stringify a schema default/example for seeding an input value. */
export function defaultString(schema: ParamSchema | undefined): string {
  const s = schema ?? {};
  const v = s.default !== undefined ? s.default : undefined;
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}
`;
