import "dotenv/config";
import fs from "fs";
import path from "path";
import { fetchOutstandingReportXml } from "../src/tally.client";

// Run this on the machine where Tally is actually running (TALLY_URL in .env
// must be reachable). It pulls one raw "Bills Receivable" export and saves it
// to disk so we can check whether Tally's canned report XML carries any
// ledger/voucher GUID tag (LEDGERGUID, PARTYLEDGERGUID, MASTERGUID,
// VOUCHERGUID, GUID) inside/near a <BILLFIXED> block.
//
// Usage: npx ts-node scripts/dump-outstanding-xml.ts ["Company Name"]

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function toTallyDate(d: Date) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

async function main() {
  const companyName = process.argv[2] || undefined;

  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setFullYear(fromDate.getFullYear() - 2);

  const dateRange = {
    fromDate: toTallyDate(fromDate),
    toDate: toTallyDate(toDate),
  };

  console.log(
    `Fetching "Bills Receivable" from ${process.env.TALLY_URL} for company=${
      companyName || "(default/current)"
    }, range=${dateRange.fromDate}-${dateRange.toDate} ...`,
  );

  const xml = await fetchOutstandingReportXml(companyName, "receivable", dateRange);

  const outDir = path.join(__dirname, "..", "tmp");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `bills-receivable-raw-${Date.now()}.xml`);
  fs.writeFileSync(outFile, String(xml || ""), "utf8");

  console.log(`Saved raw response to: ${outFile}`);
  console.log(`Response length: ${String(xml || "").length} chars`);

  const guidTags = [
    "LEDGERGUID",
    "PARTYLEDGERGUID",
    "MASTERGUID",
    "VOUCHERGUID",
    "GUID",
  ];

  console.log("\nGUID-tag presence check:");
  for (const tag of guidTags) {
    const re = new RegExp(`<${tag}\\b`, "i");
    const count = (String(xml || "").match(new RegExp(`<${tag}\\b`, "gi")) || [])
      .length;
    console.log(`  <${tag}> present: ${re.test(String(xml || ""))} (count: ${count})`);
  }

  const billFixedCount = (
    String(xml || "").match(/<BILLFIXED\b/gi) || []
  ).length;
  console.log(`\n<BILLFIXED> block count: ${billFixedCount}`);

  const firstBlockMatch = String(xml || "").match(
    /<BILLFIXED\b[\s\S]*?<\/BILLFIXED>/i,
  );
  if (firstBlockMatch) {
    console.log("\nFirst <BILLFIXED> block (raw):\n");
    console.log(firstBlockMatch[0]);
  } else {
    console.log("\nNo <BILLFIXED> block found in response.");
  }
}

main().catch((err) => {
  console.error("Failed to fetch/dump outstanding XML:", err?.message || err);
  process.exit(1);
});
