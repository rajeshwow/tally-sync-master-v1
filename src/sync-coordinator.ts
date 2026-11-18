import axios from "axios";
import { getAvailableTallyCompanies } from "./company-registry";
import {
  claimSyncTurnFromCrm,
  releaseSyncTurnInCrm,
  sendSourceHeartbeatToCrm,
  type AgentLiveStatus,
  type SyncTurnDecision,
} from "./crm.client";

/**
 * Multi-machine coordination.
 *
 * Every machine running this agent heartbeats to the CRM once a minute with
 * "is Tally open here". Before a scheduled sync the agent asks the CRM for
 * the sync turn. The CRM grants it to:
 *   1. the machine the admin selected in Tally Sync > Sync Sources, if that
 *      machine is online with Tally open, otherwise
 *   2. the online machine whose Tally has been open the longest.
 * Only one machine holds the turn at a time; the admin's choice applies
 * from the next sync and never stops a sync that is already running.
 *
 * Disable with TALLY_SYNC_COORDINATION=false (old behaviour: always sync).
 */

function readBoolEnv(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "y"].includes(raw.trim().toLowerCase());
}

const COORDINATION_ENABLED = readBoolEnv("TALLY_SYNC_COORDINATION", true);
const HEARTBEAT_SECONDS = Math.max(
  20,
  Number(process.env.TALLY_SYNC_HEARTBEAT_SECONDS || 60),
);
const TALLY_PROBE_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.TALLY_PROBE_TIMEOUT_MS || 5000),
);
const COMPANY_REFRESH_MS = 5 * 60 * 1000;
/** What to do when the CRM cannot be reached for the claim: "skip" | "sync". */
const ON_CLAIM_ERROR =
  (process.env.TALLY_SYNC_COORDINATION_ON_ERROR || "skip").toLowerCase() ===
  "sync"
    ? "sync"
    : "skip";

let tallyOpen = false;
let tallyOpenSince: string | null = null;
let companies: string[] | null = null;
let companiesFetchedAt = 0;
let crmSupportsCoordination = true;
let heartbeatTimer: NodeJS.Timeout | null = null;
let isSyncingProvider: () => boolean = () => false;

const lastDecision = {
  at: null as string | null,
  allowed: null as boolean | null,
  reason: null as string | null,
  selectedSource: null as string | null,
};

export function isSyncCoordinationEnabled() {
  return COORDINATION_ENABLED;
}

/** True when the Tally HTTP server on TALLY_URL answers at all. */
async function probeTally(): Promise<boolean> {
  const url = process.env.TALLY_URL;
  if (!url) return false;
  try {
    await axios.get(url, {
      timeout: TALLY_PROBE_TIMEOUT_MS,
      validateStatus: () => true,
    });
    return true;
  } catch {
    return false;
  }
}

async function refreshTallyState(isSyncing: boolean) {
  // While syncing, Tally is open by definition and may be too busy to probe.
  const open = isSyncing ? true : await probeTally();

  if (open && !tallyOpen) tallyOpenSince = new Date().toISOString();
  if (!open) {
    tallyOpenSince = null;
    companies = null;
  }
  tallyOpen = open;

  if (
    open &&
    !isSyncing &&
    Date.now() - companiesFetchedAt > COMPANY_REFRESH_MS
  ) {
    companiesFetchedAt = Date.now();
    try {
      const list = await getAvailableTallyCompanies();
      companies = list
        .map((c: any) => String(c?.name || c?.companyName || "").trim())
        .filter(Boolean);
    } catch {
      // company list is informational only
    }
  }
}

function currentStatus(isSyncing: boolean): AgentLiveStatus {
  return {
    tallyOpen,
    tallyOpenSince,
    isSyncing,
    companies,
  };
}

function isNotFound(error: any) {
  return error?.response?.status === 404;
}

async function heartbeatOnce() {
  if (!crmSupportsCoordination) return;
  const syncing = isSyncingProvider();
  try {
    await refreshTallyState(syncing);
    await sendSourceHeartbeatToCrm(currentStatus(syncing));
  } catch (error: any) {
    if (isNotFound(error)) {
      crmSupportsCoordination = false;
      console.warn(
        "[SYNC COORDINATION] CRM does not support machine selection yet; syncing without coordination",
      );
      return;
    }
    console.warn(
      "[SYNC COORDINATION] Heartbeat failed",
      error?.response?.status || error?.message || error,
    );
  }
}

export function startSyncCoordinator(isSyncing: () => boolean) {
  if (!COORDINATION_ENABLED || heartbeatTimer) return;
  isSyncingProvider = isSyncing;

  void heartbeatOnce();
  heartbeatTimer = setInterval(() => void heartbeatOnce(), HEARTBEAT_SECONDS * 1000);
  heartbeatTimer.unref?.();

  console.log("[SYNC COORDINATION] Started", {
    heartbeatSeconds: HEARTBEAT_SECONDS,
    onClaimError: ON_CLAIM_ERROR,
  });
}

/** Ask the CRM whether this machine should run the upcoming scheduled sync. */
export async function claimSyncTurn(): Promise<SyncTurnDecision> {
  if (!COORDINATION_ENABLED) {
    return { allowed: true, reason: "coordination_disabled" };
  }
  if (!crmSupportsCoordination) {
    return { allowed: true, reason: "crm_without_coordination" };
  }

  await refreshTallyState(false);

  let decision: SyncTurnDecision;
  try {
    decision = await claimSyncTurnFromCrm(currentStatus(false));
  } catch (error: any) {
    if (isNotFound(error)) {
      crmSupportsCoordination = false;
      decision = { allowed: true, reason: "crm_without_coordination" };
    } else {
      decision = {
        allowed: ON_CLAIM_ERROR === "sync",
        reason: `claim_failed: ${error?.response?.status || error?.message || "unknown"}`,
      };
    }
  }

  lastDecision.at = new Date().toISOString();
  lastDecision.allowed = decision.allowed;
  lastDecision.reason = decision.reason;
  lastDecision.selectedSource = decision.selected_source || null;

  return decision;
}

export async function releaseSyncTurn() {
  if (!COORDINATION_ENABLED || !crmSupportsCoordination) return;
  try {
    await releaseSyncTurnInCrm();
  } catch (error: any) {
    // Lease expires on its own in the CRM; just log.
    console.warn(
      "[SYNC COORDINATION] Release failed",
      error?.response?.status || error?.message || error,
    );
  }
  void heartbeatOnce();
}

export function getSyncCoordinationStatus() {
  return {
    enabled: COORDINATION_ENABLED,
    crm_supports_coordination: crmSupportsCoordination,
    tally_open: tallyOpen,
    tally_open_since: tallyOpenSince,
    loaded_companies: companies,
    last_decision: { ...lastDecision },
  };
}
