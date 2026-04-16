/**
 * Gate State Manager — registered service
 *
 * Caches rules.md, deflection templates, pre-check allowlist.
 * Tracks consecutive API failures. Manages proposal workflow state.
 * Does NOT spawn sessions — the Gate is an inline Haiku call.
 */

import { readFileSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";

interface GateStateManagerOpts {
  gatePath: string;
  logger: { info: Function; warn: Function; error: Function };
  consecutiveFailureThreshold: number;
}

interface GateState {
  rules: string;
  rulesMtime: number;
  templates: { interlopers: string[]; friends: string[] };
  templatesMtime: number;
  precheckAllowlist: Set<string>;
  precheckMtime: number;
  consecutiveFailures: number;
  lastTemplateIndex: { interlopers: number; friends: number };
}

export function createGateStateManager(opts: GateStateManagerOpts) {
  const rulesPath = join(opts.gatePath, "rules.md");
  const templatesPath = join(opts.gatePath, "degraded_templates.md");
  const precheckPath = join(opts.gatePath, "precheck_allowlist.json");
  const historyPath = join(opts.gatePath, "history.ndjson");
  const incidentsPath = join(
    opts.gatePath,
    "..",
    "security",
    "interloper-incidents.ndjson"
  );

  const state: GateState = {
    rules: "",
    rulesMtime: 0,
    templates: { interlopers: [], friends: [] },
    templatesMtime: 0,
    precheckAllowlist: new Set(),
    precheckMtime: 0,
    consecutiveFailures: 0,
    lastTemplateIndex: { interlopers: -1, friends: -1 },
  };

  function refreshRules(): void {
    try {
      const mtime = statSync(rulesPath).mtimeMs;
      if (mtime > state.rulesMtime) {
        state.rules = readFileSync(rulesPath, "utf-8");
        state.rulesMtime = mtime;
        opts.logger.info("[trust-gate:gate-state] Rules reloaded");
      }
    } catch (err: any) {
      opts.logger.error(`[trust-gate:gate-state] Failed to load rules: ${err?.message}`);
    }
  }

  function refreshTemplates(): void {
    try {
      const mtime = statSync(templatesPath).mtimeMs;
      if (mtime > state.templatesMtime) {
        const content = readFileSync(templatesPath, "utf-8");
        // Parse simple format: ## For Interlopers / ## For Friends sections
        const interlopers: string[] = [];
        const friends: string[] = [];
        let section = "";
        for (const line of content.split("\n")) {
          if (line.includes("For Interlopers")) section = "interlopers";
          else if (line.includes("For Friends")) section = "friends";
          else if (line.startsWith("- ")) {
            const template = line.slice(2).replace(/^"|"$/g, "").trim();
            if (section === "interlopers") interlopers.push(template);
            else if (section === "friends") friends.push(template);
          }
        }
        state.templates = { interlopers, friends };
        state.templatesMtime = mtime;
      }
    } catch (err: any) {
      opts.logger.error(`[trust-gate:gate-state] Failed to load templates: ${err?.message}`);
    }
  }

  function refreshPrecheck(): void {
    try {
      const mtime = statSync(precheckPath).mtimeMs;
      if (mtime > state.precheckMtime) {
        const data = JSON.parse(readFileSync(precheckPath, "utf-8"));
        state.precheckAllowlist = new Set(
          (data.allowed ?? []).map((s: string) => s.toLowerCase().trim())
        );
        state.precheckMtime = mtime;
      }
    } catch (err: any) {
      opts.logger.error(`[trust-gate:gate-state] Failed to load precheck allowlist: ${err?.message}`);
    }
  }

  function getDeflectionTemplate(tier: string): string {
    const key = tier === "friend" ? "friends" : "interlopers";
    const templates = state.templates[key];
    if (!templates || templates.length === 0) return "one sec";
    // Rotate — don't repeat consecutively
    let idx = (state.lastTemplateIndex[key] + 1) % templates.length;
    state.lastTemplateIndex[key] = idx;
    return templates[idx];
  }

  function logVerdict(entry: Record<string, any>): void {
    try {
      const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n";
      appendFileSync(historyPath, line);
    } catch {
      // Best-effort logging
    }
  }

  function logIncident(entry: Record<string, any>): void {
    try {
      const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n";
      appendFileSync(incidentsPath, line);
    } catch {
      // Best-effort logging
    }
  }

  function recordFailure(): void {
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= opts.consecutiveFailureThreshold) {
      opts.logger.error(
        `[trust-gate:gate-state] ${state.consecutiveFailures} consecutive Gate API failures — NOTIFY principal`
      );
      // TODO: emit NOTIFY to principal channel when messaging integration is ready
    }
  }

  function recordSuccess(): void {
    if (state.consecutiveFailures > 0) {
      opts.logger.info(
        `[trust-gate:gate-state] Gate recovered after ${state.consecutiveFailures} failures`
      );
    }
    state.consecutiveFailures = 0;
  }

  return {
    id: "gate-state-manager",

    start() {
      refreshRules();
      refreshTemplates();
      refreshPrecheck();
      opts.logger.info("[trust-gate:gate-state] Service started");
    },

    stop() {
      opts.logger.info("[trust-gate:gate-state] Service stopped");
    },

    // Public API for hook handlers
    getRules: () => { refreshRules(); return state.rules; },
    isPrecheckPass: (draft: string) => {
      refreshPrecheck();
      return state.precheckAllowlist.has(draft.toLowerCase().trim());
    },
    getDeflectionTemplate,
    logVerdict,
    logIncident,
    recordFailure,
    recordSuccess,
    getStatus: () => ({
      rulesLoaded: state.rules.length > 0,
      rulesMtime: new Date(state.rulesMtime).toISOString(),
      precheckEntries: state.precheckAllowlist.size,
      consecutiveFailures: state.consecutiveFailures,
      templatesLoaded: {
        interlopers: state.templates.interlopers.length,
        friends: state.templates.friends.length,
      },
    }),
    getRecentIncidents: () => {
      try {
        const content = readFileSync(incidentsPath, "utf-8");
        const lines = content.trim().split("\n").slice(-20); // last 20
        return lines.map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}
