import {
  parseTallyCompanies,
  resolveTallyCompany,
  TallyCompanyForSync,
  TallyCompanySelection,
} from "./tally-company-selector";
import { fetchTallyCompaniesXml } from "./tally.client";

type ConfiguredCompanySelector = {
  raw: string;
  name?: string | null;
  guid?: string | null;
};

function normalizeName(value?: string | null) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeGuid(value?: string | null) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function looksLikeGuid(value?: string | null) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value || "").trim(),
  );
}

function parseConfiguredToken(rawToken: string): ConfiguredCompanySelector {
  const raw = rawToken.trim();
  const separator = raw.includes("::") ? "::" : raw.includes("|") ? "|" : null;

  if (!separator) {
    return looksLikeGuid(raw)
      ? { raw, guid: raw, name: null }
      : { raw, name: raw, guid: null };
  }

  const parts = raw
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);

  const guid = parts.find((part) => looksLikeGuid(part)) || null;
  const name = parts.find((part) => !looksLikeGuid(part)) || null;

  return { raw, name, guid };
}

export function getConfiguredCompanySelectors(): ConfiguredCompanySelector[] {
  const multi = String(process.env.TALLY_COMPANIES || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parseConfiguredToken);

  if (multi.length) return multi;

  const singularGuid = String(process.env.TALLY_COMPANY_GUID || "").trim();
  const singularName = String(process.env.TALLY_COMPANY_NAME || "").trim();

  if (singularGuid || singularName) {
    return [
      {
        raw: singularGuid || singularName,
        guid: singularGuid || null,
        name: singularName || null,
      },
    ];
  }

  return [];
}

export async function getAvailableTallyCompanies(): Promise<
  TallyCompanyForSync[]
> {
  const xml = await fetchTallyCompaniesXml();
  const companies = parseTallyCompanies(String(xml || ""));

  if (!companies.length) {
    throw new Error("No Tally companies were returned by the XML endpoint.");
  }

  return companies;
}

export function getExcludedCompanySelectors(): ConfiguredCompanySelector[] {
  const rawEnv =
    process.env.EXCLUDED_TALLY_COMPANIES ||
    process.env.TALLY_EXCLUDED_COMPANIES;
  const list = rawEnv
    ? rawEnv
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : ["ATVI COMPUTECH PVT LTD CHALLAN", "Bispl", "Atvi"];

  return list.map(parseConfiguredToken);
}

export function isCompanyExcluded(company: TallyCompanyForSync): boolean {
  const excludedSelectors = getExcludedCompanySelectors();
  return excludedSelectors.some((selector) =>
    selectorMatchesCompany(selector, company),
  );
}

function selectorMatchesCompany(
  selector: ConfiguredCompanySelector,
  company: TallyCompanyForSync,
) {
  if (selector.guid) {
    return normalizeGuid(selector.guid) === normalizeGuid(company.guid);
  }

  if (selector.name) {
    return normalizeName(selector.name) === normalizeName(company.name);
  }

  return false;
}

function companyKey(company: TallyCompanyForSync) {
  return normalizeGuid(company.guid) || normalizeName(company.name);
}

export async function resolveConfiguredTallyCompanies(
  selection: TallyCompanySelection = {},
): Promise<TallyCompanyForSync[]> {
  if (selection.syncAllLoadedCompanies) {
    const loadedCompanies = await getAvailableTallyCompanies();
    const activeCompanies = loadedCompanies.filter(
      (company) => !isCompanyExcluded(company),
    );

    console.log(
      "[TALLY] Loaded companies selected for sync (after exclusion filter)",
      {
        totalCount: loadedCompanies.length,
        activeCount: activeCompanies.length,
        excludedCount: loadedCompanies.length - activeCompanies.length,
        activeCompanies: activeCompanies.map((company) => ({
          name: company.name,
          guid: company.guid || null,
        })),
      },
    );

    return activeCompanies;
  }

  const configured = getConfiguredCompanySelectors();
  const explicitGuid = String(selection.companyGuid || "").trim();
  const explicitName = String(selection.companyName || "").trim();

  if (explicitGuid || explicitName) {
    const selected = await resolveTallyCompany({
      companyGuid: explicitGuid || null,
      companyName: explicitName || null,
    });

    if (isCompanyExcluded(selected)) {
      throw new Error(
        `Requested Tally company "${selected.name}" is excluded from sync. Sync stopped for safety.`,
      );
    }

    if (
      !selection.skipConfiguredAllowlist &&
      configured.length > 0 &&
      !configured.some((selector) => selectorMatchesCompany(selector, selected))
    ) {
      throw new Error(
        `Requested Tally company "${selected.name}" is not present in TALLY_COMPANIES. Sync stopped for safety.`,
      );
    }

    return [selected];
  }

  if (!configured.length) {
    throw new Error(
      "No safe Tally company configuration found. Set TALLY_COMPANIES, or TALLY_COMPANY_GUID/TALLY_COMPANY_NAME.",
    );
  }

  const available = (await getAvailableTallyCompanies()).filter(
    (company) => !isCompanyExcluded(company),
  );
  const resolved: TallyCompanyForSync[] = [];
  const missing: string[] = [];

  for (const selector of configured) {
    const matches = available.filter((company) =>
      selectorMatchesCompany(selector, company),
    );

    if (matches.length === 1) {
      resolved.push(matches[0]);
      continue;
    }

    if (matches.length > 1) {
      throw new Error(
        `Multiple Tally companies matched configured value "${selector.raw}". Configure the company GUID explicitly.`,
      );
    }

    missing.push(selector.raw);
  }

  if (missing.length) {
    const availableText = available
      .map(
        (company) =>
          `${company.name}${company.guid ? ` [${company.guid}]` : ""}`,
      )
      .join(" | ");

    throw new Error(
      `Configured Tally companies not found or are excluded: ${missing.join(", ")}. Available: ${availableText}`,
    );
  }

  const unique = new Map<string, TallyCompanyForSync>();

  for (const company of resolved) {
    unique.set(companyKey(company), company);
  }

  return Array.from(unique.values());
}

export async function getTallyCompanyDiagnostics() {
  const configured = getConfiguredCompanySelectors();
  const excluded = getExcludedCompanySelectors();
  const available = await getAvailableTallyCompanies();
  const activeAvailable = available.filter((c) => !isCompanyExcluded(c));

  const resolved = configured.length
    ? await resolveConfiguredTallyCompanies()
    : activeAvailable;

  return {
    configured,
    excluded,
    available,
    active_available: activeAvailable,
    resolved,
    safe_to_sync: resolved.length > 0,
  };
}

