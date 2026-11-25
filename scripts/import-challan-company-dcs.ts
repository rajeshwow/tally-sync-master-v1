import "dotenv/config";
import { importChallanCompanyDcs } from "../src/one-time-challan-import";

// Manual run of the one-time challan import (the agent also runs it
// automatically once after a sync; see src/one-time-challan-import.ts).
// Usage: npx ts-node --transpile-only scripts/import-challan-company-dcs.ts [--from 20250401] [--to 20251125]
// Without --from, each company's `from` in src/one-time-challan-import.ts is used.

function getArg(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");
const now = new Date();
const fromDate = getArg("from");
const toDate = getArg("to") || `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;

if ((fromDate && !/^\d{8}$/.test(fromDate)) || !/^\d{8}$/.test(toDate)) {
  console.error("Dates must be YYYYMMDD.");
  process.exit(1);
}

importChallanCompanyDcs(toDate, fromDate)
  .then((summary) => console.log("Done", summary))
  .catch((err) => {
    console.error("Challan import failed:", err?.message || err);
    process.exit(1);
  });
