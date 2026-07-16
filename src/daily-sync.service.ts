import { runHistoricalTransactionsSync } from "./historical-transactions.service";
import { runFullSync } from "./sync.service";

let isDailySyncRunning = false;

const dailySyncStatus = {
  status: "idle" as
    | "idle"
    | "running"
    | "success"
    | "partial_success"
    | "failed"
    | "skipped",
  isRunning: false,
  lastStartedAt: null as string | null,
  lastCompletedAt: null as string | null,
  lastError: null as string | null,
  lastResult: null as any,
};

function formatTallyDate(date: Date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

function getTransactionStatus(transactions: any) {
  if (transactions?.status) return transactions.status;
  if (transactions?.skipped) return "skipped";
  return "success";
}

function compactDailyResult(result: any) {
  if (!result) return null;

  return {
    skipped: Boolean(result.skipped),
    status: result.status || null,
    syncMode: result.syncMode || null,
    range: result.range || null,
    companySelection: result.companySelection || null,
    companies: result.companies
      ? {
          count: result.companies.count || 0,
          successCount: result.companies.successCount || 0,
          failedCount: result.companies.failedCount || 0,
          records: result.companies.records || [],
        }
      : null,
    failedCompanies: result.failedCompanies || [],
  };
}

function completeDailySync(result: any) {
  dailySyncStatus.status = result?.status || "success";
  dailySyncStatus.lastCompletedAt = new Date().toISOString();
  dailySyncStatus.lastError = result?.error || null;
  dailySyncStatus.lastResult = compactDailyResult(result);

  return result;
}

export function isDailySyncActive() {
  return isDailySyncRunning;
}

export function getDailySyncStatus() {
  return {
    ...dailySyncStatus,
    isRunning: isDailySyncRunning,
  };
}

export async function runDailySync() {
  if (isDailySyncRunning) {
    return {
      skipped: true,
      status: "skipped",
      message: "Previous daily sync is still running",
    };
  }

  isDailySyncRunning = true;
  dailySyncStatus.status = "running";
  dailySyncStatus.isRunning = true;
  dailySyncStatus.lastStartedAt = new Date().toISOString();
  dailySyncStatus.lastCompletedAt = null;
  dailySyncStatus.lastError = null;
  dailySyncStatus.lastResult = null;

  try {
    const lookbackDays = Math.max(
      0,
      Number(process.env.DAILY_SYNC_LOOKBACK_DAYS || 3),
    );
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - lookbackDays);

    const range = {
      fromDate: formatTallyDate(from),
      toDate: formatTallyDate(to),
    };

    console.log("[DAILY SYNC] Syncing every loaded Tally company", {
      range,
      lookbackDays,
    });

    const allLoadedCompanySelection = {
      syncAllLoadedCompanies: true,
      skipConfiguredAllowlist: true,
    };

    const masters = await runFullSync(allLoadedCompanySelection);

    if (masters?.skipped) {
      return completeDailySync({
        skipped: true,
        status: "skipped",
        syncMode: "incremental",
        range,
        companySelection: "all_loaded_companies",
        message: masters?.message || "Masters sync is already running",
        masters,
        transactions: null,
      });
    }

    const transactions = await runHistoricalTransactionsSync({
      ...range,
      ...allLoadedCompanySelection,
      modules: [
        "sales-vouchers",
        "purchase-vouchers",
        "outstandings",
        "delivery-challans",
      ],
      skipCheckpoints: true,
      syncMode: "incremental",
    });

    const transactionStatus = getTransactionStatus(transactions);
    const failed =
      masters?.status === "failed" || transactionStatus === "failed";
    const partial =
      masters?.status === "partial_success" ||
      transactionStatus === "partial_success";
    const skipped = Boolean(transactions?.skipped);

    return completeDailySync({
      skipped,
      status: skipped
        ? "skipped"
        : failed
          ? "failed"
          : partial
            ? "partial_success"
            : "success",
      syncMode: "incremental",
      range,
      companySelection: "all_loaded_companies",
      companies: masters?.companies || null,
      masters,
      transactions,
      totals: masters?.totals || {},
      failedCompanies: masters?.failedCompanies || [],
    });
  } catch (error: any) {
    dailySyncStatus.status = "failed";
    dailySyncStatus.lastCompletedAt = new Date().toISOString();
    dailySyncStatus.lastError = error?.message || "Daily sync failed";
    dailySyncStatus.lastResult = null;

    throw error;
  } finally {
    isDailySyncRunning = false;
    dailySyncStatus.isRunning = false;
  }
}
