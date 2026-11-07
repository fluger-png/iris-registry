import type { Prisma, PrismaClient } from "@prisma/client";

const PAGE_SIZE = 50;
const number = new Intl.NumberFormat("en-US");
const average = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const normalizeEmail = (email: string | null): string => email?.trim().toLowerCase() ?? "";

export const getAdminCurrentOwnerEmail = (
  artwork: { status: string; owner_email: string | null; assigned_customer_email: string | null }
): string => artwork.status === "activated" ? normalizeEmail(artwork.owner_email ?? artwork.assigned_customer_email) : "";

export type AdminOwnersQuery = { search: string; sort: "asc" | "desc"; page: number };

export const parseAdminOwnersQuery = (query: Record<string, unknown>): AdminOwnersQuery => {
  const page = typeof query.page === "string" && /^\d+$/.test(query.page) ? Number(query.page) : 1;
  return {
    search: typeof query.q === "string" ? query.q.trim().slice(0, 200) : "",
    sort: query.sort === "asc" ? "asc" : "desc",
    page: Number.isSafeInteger(page) && page > 0 ? page : 1
  };
};

export const buildAdminOwnersHref = (query: AdminOwnersQuery, email?: string): string => {
  const params = new URLSearchParams();
  if (email) params.set("from", "owners");
  if (query.search) params.set("q", query.search);
  if (query.sort === "asc") params.set("sort", query.sort);
  if (query.page > 1) params.set("page", String(query.page));
  const path = email ? `/admin/customers/${encodeURIComponent(email)}` : "/admin/owners";
  return params.size ? `${path}?${params}` : path;
};

type OwnerRow = { email: string; name: string | null; held: number };
type OwnerIdentity = { display_name: string | null; username: string };
type AdminOwnersPage = {
  query: AdminOwnersQuery;
  rows: OwnerRow[];
  matched: number;
  ownerCount: number;
  totalHeld: number;
  repeatOwners: number;
};

const fold = (value: string): string => value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ");
const compactIrisId = (value: string): string => value.toLowerCase().replace(/^iris\s+no\.?\s*/, "").replace(/[^a-z0-9]/g, "");

export const loadAdminOwners = async (
  db: Pick<PrismaClient, "artwork" | "irisUser" | "shopifyOrder">,
  query: AdminOwnersQuery,
  displayIrisId: (id: string, collection: { edition_size: number } | null) => string,
  extractCustomerName: (order: Prisma.JsonValue) => string | null
): Promise<AdminOwnersPage> => {
  const artworks = await db.artwork.findMany({
    where: { status: "activated", OR: [{ owner_email: { not: null } }, { assigned_customer_email: { not: null } }] },
    select: { iris_id: true, status: true, owner_email: true, assigned_customer_email: true, collection: { select: { edition_size: true } } }
  });
  const holdings = new Map<string, number>();
  const irisMatches = new Set<string>();
  const serial = compactIrisId(query.search);
  for (const artwork of artworks) {
    const email = getAdminCurrentOwnerEmail(artwork);
    if (!email) continue;
    holdings.set(email, (holdings.get(email) ?? 0) + 1);
    if (serial && (compactIrisId(artwork.iris_id).includes(serial) || compactIrisId(displayIrisId(artwork.iris_id, artwork.collection)).includes(serial))) {
      irisMatches.add(email);
    }
  }

  const owners = Array.from(holdings, ([email, held]) => ({ email, held })).sort((a, b) =>
    (query.sort === "asc" ? a.held - b.held : b.held - a.held) || a.email.localeCompare(b.email)
  );
  const pageNumber = (count: number): number => Math.min(query.page, Math.max(1, Math.ceil(count / PAGE_SIZE)));
  const paginate = <T>(items: T[], page: number): T[] => items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const emails = (query.search ? owners : paginate(owners, pageNumber(owners.length))).map((owner) => owner.email);
  const profiles = new Map<string, OwnerIdentity>();
  const orderNames = new Map<string, string>();
  if (emails.length) {
    const emailFilter = { in: emails, mode: "insensitive" as const };
    const [users, orders] = await Promise.all([
      db.irisUser.findMany({ where: { email: emailFilter }, select: { email: true, display_name: true, username: true } }),
      db.shopifyOrder.findMany({
        where: { email: emailFilter },
        select: { email: true, raw_json: true },
        orderBy: [{ created_at_shopify: { sort: "desc", nulls: "last" } }, { processed_at: { sort: "desc", nulls: "last" } }, { created_at: "desc" }, { id: "asc" }]
      })
    ]);
    for (const user of users) profiles.set(normalizeEmail(user.email), user);
    for (const order of orders) {
      const email = normalizeEmail(order.email);
      if (orderNames.has(email)) continue;
      const name = extractCustomerName(order.raw_json);
      if (name) orderNames.set(email, name);
    }
  }

  const term = fold(query.search);
  const matched = term ? owners.filter(({ email }) => {
    const profile = profiles.get(email);
    return irisMatches.has(email) || [email, profile?.display_name, profile?.username, orderNames.get(email)]
      .some((value) => value && fold(value).includes(term)) ||
      (term.startsWith("@") && term.length > 1 && !!profile?.username && fold(profile.username).includes(term.slice(1)));
  }) : owners;
  const page = pageNumber(matched.length);
  return {
    query: { ...query, page },
    rows: paginate(matched, page).map((owner) => ({
      ...owner,
      name: profiles.get(owner.email)?.display_name?.trim() || orderNames.get(owner.email) || null
    })),
    matched: matched.length,
    ownerCount: owners.length,
    totalHeld: owners.reduce((sum, owner) => sum + owner.held, 0),
    repeatOwners: owners.filter((owner) => owner.held > 1).length
  };
};

export const buildAdminOwnersBody = (view: AdminOwnersPage, h: (value: string) => string): string => {
  const { query, rows, matched, ownerCount, totalHeld, repeatOwners } = view;
  const nextSort = query.sort === "desc" ? "asc" : "desc";
  const sortHref = h(buildAdminOwnersHref({ ...query, sort: nextSort, page: 1 }));
  const pageLink = (page: number) => h(buildAdminOwnersHref({ ...query, page }));
  const start = (query.page - 1) * PAGE_SIZE;
  return `
    <style>
      .main{min-width:0;}
      .owners-search{min-width:0;width:min(100%,400px);border-radius:8px;}
      .owners-search input{min-width:0;}
      .owners-search:focus-within{outline:2px solid var(--brand);outline-offset:2px;}
      .owners-search button{display:grid;place-items:center;flex:none;width:32px;height:32px;border:0;border-radius:4px;background:transparent;cursor:pointer;}
      .owners-search button:hover{background:var(--pill);}
      .owners-search button svg{color:var(--brand);}
      .owners-search .muted{flex:none;}
      .owners-table{border:1px solid var(--line);border-radius:8px;background:var(--card);}
      .owners-table td:first-child{overflow-wrap:anywhere;}
      .owners-table th:not(:first-child){width:1%;}
      .owners-table th:not(:first-child),.owners-table td:not(:first-child){white-space:nowrap;text-align:right;}
      .owners-sort{display:inline-flex;align-items:center;gap:4px;color:var(--brand);}
      .owners-pagination{flex-wrap:wrap;}
    </style>
    <div class="title-row">
      <h1>IRIS Owners</h1>
      <form class="search owners-search" method="GET" action="/admin/owners" role="search">
        ${query.sort === "asc" ? '<input type="hidden" name="sort" value="asc" />' : ""}
        <input type="search" name="q" aria-label="Search owners by name, email, or IRIS number" placeholder="Name, email, or IRIS number" maxlength="200" value="${h(query.search)}" />
        ${query.search ? `<a class="muted" href="${h(buildAdminOwnersHref({ ...query, search: "", page: 1 }))}">Clear</a>` : ""}
        <button type="submit" aria-label="Search owners" title="Search owners"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg></button>
      </form>
    </div>
    <div class="admin-stat-grid">
      <div class="admin-stat"><span>Total Owners</span><strong>${number.format(ownerCount)}</strong></div>
      <div class="admin-stat"><span>IRIS Held</span><strong>${number.format(totalHeld)}</strong></div>
      <div class="admin-stat"><span>Multi-IRIS Owners</span><strong>${number.format(repeatOwners)}</strong></div>
      <div class="admin-stat"><span>Avg. per Owner</span><strong>${average.format(ownerCount ? totalHeld / ownerCount : 0)}</strong></div>
    </div>
    <div class="owners-table">
      <table>
        <thead><tr>
          <th scope="col">Owner</th>
          <th scope="col" aria-sort="${query.sort === "desc" ? "descending" : "ascending"}"><a class="owners-sort" href="${sortHref}" title="${nextSort === "asc" ? "Sort fewest first" : "Sort most first"}">IRIS Held <span aria-hidden="true">${query.sort === "desc" ? "&#8595;" : "&#8593;"}</span></a></th>
          <th scope="col">Details</th>
        </tr></thead>
        <tbody>
          ${rows.map((row) => {
            const href = h(buildAdminOwnersHref(query, row.email));
            return `<tr><td><a class="customer-link" href="${href}">${h(row.name ?? row.email)}</a>${row.name ? `<div class="muted">${h(row.email)}</div>` : ""}</td><td><strong>${number.format(row.held)}</strong></td><td><a class="page-link" href="${href}" aria-label="View details for ${h(row.name ?? row.email)}">View</a></td></tr>`;
          }).join("") || `<tr><td colspan="3">${query.search ? "No matching owners" : "No IRIS owners yet"}</td></tr>`}
        </tbody>
      </table>
    </div>
    ${matched ? `<nav class="pagination owners-pagination" aria-label="Owners pagination">
      ${query.page > 1 ? `<a class="page-link" href="${pageLink(query.page - 1)}" rel="prev">Prev</a>` : ""}
      <span class="page-info">${number.format(start + 1)}&ndash;${number.format(start + rows.length)} of ${number.format(matched)}</span>
      ${start + rows.length < matched ? `<a class="page-link" href="${pageLink(query.page + 1)}" rel="next">Next</a>` : ""}
    </nav>` : ""}`;
};
