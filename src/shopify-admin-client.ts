export type ShopifyAppCredentials = { domain: string; clientId: string; clientSecret: string };

export class ShopifyAdminError extends Error {
  constructor(public code: "connection" | "scope") { super(`Shopify Admin API: ${code}`); }
}

export const createShopifyAdminClient = (credentials: ShopifyAppCredentials) => {
  const configured = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(credentials.domain) &&
    Boolean(credentials.clientId && credentials.clientSecret);
  type Token = { value: string; expiresAt: number; scopes: Set<string> };
  let cached: Token | null = null;
  let pending: Promise<Token> | null = null;
  const unavailable = () => new ShopifyAdminError("connection");
  const token = async (): Promise<Token> => {
    if (!configured) throw unavailable();
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetch(`https://${credentials.domain}/admin/oauth/access_token`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: credentials.clientId, client_secret: credentials.clientSecret })
        });
        if (!response.ok) throw unavailable();
        const data = await response.json() as { access_token?: unknown; expires_in?: unknown; scope?: unknown };
        if (typeof data.access_token !== "string" || !data.access_token || typeof data.expires_in !== "number" ||
            !Number.isFinite(data.expires_in) || data.expires_in <= 60) throw unavailable();
        return { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000,
          scopes: new Set(typeof data.scope === "string" ? data.scope.split(",").map((scope) => scope.trim()) : []) };
      } catch {
        // Never attach upstream responses or tokens to errors.
        throw unavailable();
      }
    })();
    try { return cached = await pending; } finally { pending = null; }
  };

  const graphql = async <T>(query: string, variables: Record<string, unknown>, requiredScopes: readonly string[]): Promise<T> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const auth = await token();
      if (!requiredScopes.every((scope) => auth.scopes.has(scope) ||
          (scope.startsWith("read_") && auth.scopes.has(`write_${scope.slice(5)}`)))) {
        // A merchant may have just granted a new scope.
        if (cached === auth) cached = null;
        throw new ShopifyAdminError("scope");
      }
      let response: Response;
      try {
        response = await fetch(`https://${credentials.domain}/admin/api/2026-10/graphql.json`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": auth.value },
          body: JSON.stringify({ query, variables })
        });
      } catch { throw unavailable(); }
      if (response.status === 401 && attempt === 0) {
        if (cached === auth) cached = null;
        continue;
      }
      if (!response.ok) throw unavailable();
      try {
        const result = await response.json() as { data?: T; errors?: unknown[] };
        if (result.errors?.length || !result.data) throw unavailable();
        return result.data;
      } catch { throw unavailable(); }
    }
    throw unavailable();
  };
  return { graphql };
};
