import fs from "fs";
import path from "path";
import { pushDeliveryChallansToCrm } from "./crm.client";
import { parseDeliveryChallans } from "./mapper";
import { parseTallyCompanies } from "./tally-company-selector";
import {
  fetchHistoricalDeliveryChallansXml,
  fetchTallyCompaniesXml,
} from "./tally.client";

// ONE-TIME import of Delivery Notes from the Tally "challan" companies into
// their main companies in the CRM. Later DCs are created in the CRM itself.
//
// Runs automatically once, after a successful daily sync. When both companies
// are pushed without error it writes logs/challan-import-done.json and never
// runs again (logs/ is not part of a release, so updates keep the marker).
// If anything fails, it simply tries again after the next sync.
//
// - EXCLUDED_TALLY_COMPANIES and the normal sync are untouched: Atvi/Bispl
//   stay excluded for everything else (ledgers, stock items, vouchers).
// - Each DC is pushed under the TARGET company, so its items link to the
//   target company's products and reduce available stock (Tally stock - DC).
// - Challan numbers get a prefix (e.g. "ATVI-CH/125") so they never match an
//   existing DC of the main company with the same number.
// - Re-running is safe: the CRM updates the same voucher instead of duplicating.
//
// Remove this file and its call in index.ts once the import is done.

// from (YYYYMMDD): only challans on/after this date are imported, per company.
// Set it to the day after the last DC of that company already in the CRM.
// If either one is empty, the import does nothing.
const COMPANY_MAP = [
  {
    source: "Atvi",
    target: "ATVI Computech Private Limited - (from 1-Apr-23)",
    prefix: "", // Tally numbers (AT/DC/...) don't clash with main-company DCs
    // Last sync was 27-Aug-2026 09:43; these were already synced that day.
    from: "20260827",
    skip: ["AT/DC/26-27/276", "AT/DC/26-27/277"],
  },
  {
    source: "Bispl",
    target: "Binary Infosolutions Pvt Ltd - (from 1-Apr-2023)",
    prefix: "", // Tally numbers (BIS/DC/...) don't clash with main-company DCs
    // Last sync was 27-Aug-2026 09:44; these were already synced that day.
    from: "20260827",
    skip: ["BIS/DC/26-27/75", "BIS/DC/26-27/76"],
  },
];

const DONE_FILE = path.resolve(process.cwd(), "logs", "challan-import-done.json");

function toTallyDate(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function normalize(value?: string | null) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function recordDate(record: any) {
  return String(record?.voucherDate || record?.voucher_date || record?.date || "")
    .replace(/-/g, "")
    .slice(0, 8);
}

// Month-sized ranges keep each Tally response small.
function monthRanges(fromDate: string, toDate: string) {
  const ranges: { fromDate: string; toDate: string }[] = [];
  let start = new Date(
    Number(fromDate.slice(0, 4)),
    Number(fromDate.slice(4, 6)) - 1,
    Number(fromDate.slice(6, 8)),
  );

  while (toTallyDate(start) <= toDate) {
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
    const endText = toTallyDate(end) < toDate ? toTallyDate(end) : toDate;
    ranges.push({ fromDate: toTallyDate(start), toDate: endText });
    start = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  }

  return ranges;
}

/** fromOverride (manual script only) replaces every company's `from`. */
export async function importChallanCompanyDcs(toDate: string, fromOverride?: string) {
  const companies = parseTallyCompanies(String((await fetchTallyCompaniesXml()) || ""));
  const findCompany = (name: string) => {
    const match = companies.find((c) => normalize(c.name) === normalize(name));
    if (!match) {
      throw new Error(
        `Company "${name}" is not loaded in Tally. Loaded: ${companies.map((c) => c.name).join(" | ")}`,
      );
    }
    return match;
  };

  const summary: any[] = [];

  for (const map of COMPANY_MAP) {
    const fromDate = fromOverride || map.from;
    const source = findCompany(map.source);
    const target = findCompany(map.target);
    const records: any[] = [];
    const seen = new Set<string>();

    for (const range of monthRanges(fromDate, toDate)) {
      const xml = await fetchHistoricalDeliveryChallansXml(source.name, range);

      for (const record of parseDeliveryChallans(String(xml || "")) as any[]) {
        if (!record) continue;
        const date = recordDate(record);
        if (date && (date < range.fromDate || date > range.toDate)) continue;

        const originalNo = record.voucherNumber || record.voucherNo || record.voucher_no;
        if (!originalNo) continue;
        if (map.skip.some((no) => normalize(no) === normalize(originalNo))) continue;

        const key =
          record.voucherGuid || record.voucher_guid || record.guid || `${originalNo}::${date}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const number = `${map.prefix}${originalNo}`;
        records.push({
          ...record,
          voucherNumber: number,
          voucherNo: number,
          voucher_no: number,
          voucher_number: number,
          sourceTallyCompanyName: source.name,
          sourceVoucherNumber: originalNo,
          tallyCompanyName: target.name,
          tallyCompanyGuid: target.guid || null,
          tally_company_name: target.name,
          tally_company_guid: target.guid || null,
        });
      }
    }

    console.log(
      `[CHALLAN IMPORT] ${source.name} -> ${target.name} (${fromDate}-${toDate}): ${records.length} challan(s)`,
    );

    let result: any = null;
    if (records.length) {
      result = await pushDeliveryChallansToCrm(records, {
        companyName: target.name,
        companyGuid: target.guid || null,
        syncMode: "historical",
        fromDate,
        toDate,
        batchSize: process.env.BATCH_SIZE_DELIVERY_CHALLANS || 5,
      });
    }

    summary.push({
      fromDate,
      source: source.name,
      target: target.name,
      challans: records.length,
      uploaded: result?.uploadedRecords ?? 0,
      batches: result?.totalBatches ?? 0,
    });
  }

  return summary;
}

/** Called after each successful daily sync. Never throws. */
export async function runChallanImportOnce() {
  try {
    if (fs.existsSync(DONE_FILE)) return;

    if (!COMPANY_MAP.every((map) => /^\d{8}$/.test(map.from))) return;

    const toDate = toTallyDate(new Date());
    console.log(`[CHALLAN IMPORT] Starting one-time import up to ${toDate}`);

    const summary = await importChallanCompanyDcs(toDate);

    fs.mkdirSync(path.dirname(DONE_FILE), { recursive: true });
    fs.writeFileSync(
      DONE_FILE,
      JSON.stringify({ doneAt: new Date().toISOString(), toDate, summary }, null, 2),
      "utf8",
    );
    console.log("[CHALLAN IMPORT] Done", summary);
  } catch (error: any) {
    console.error(
      `[CHALLAN IMPORT] Failed, will retry after next sync: ${error?.message || error}`,
    );
  }
}
