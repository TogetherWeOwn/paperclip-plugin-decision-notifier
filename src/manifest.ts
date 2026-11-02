import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "togetherweown.decision-notifier";
export const PLUGIN_VERSION = "0.3.0";
export const STREAM_CHANNEL = "decisions";
export const SCAN_JOB_KEY = "decision-scan";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Decision Notifier",
  description:
    "Pushes pending board decisions (approvals, thread interactions and owner-assigned cards) and grouped failed agent runs onto a board-readable plugin stream, so an operator session can wait on it instead of polling. Decision events carry IDs and URLs only; run failures add a short redacted error excerpt.",
  author: "TogetherWeOwn",
  categories: ["automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issue.interactions.read",
    "approvals.read",
    "issues.orchestration.read",
    "events.subscribe",
    "jobs.schedule",
    "plugin.state.read",
    "plugin.state.write",
    "api.routes.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  jobs: [
    {
      jobKey: SCAN_JOB_KEY,
      displayName: "Scan for pending decisions",
      description:
        "Reconciles pending approvals, thread interactions and owner-assigned cards every minute, and failed agent runs every five minutes. Thread interactions are not plugin events yet (paperclipai/paperclip#4990), so this scan is how they are found.",
      schedule: "* * * * *",
    },
  ],
  apiRoutes: [
    {
      routeKey: "catch-up",
      method: "POST",
      path: "/catch-up",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      publicBaseUrl: {
        type: "string",
        default: "",
        description:
          "Base URL of the Paperclip web app, e.g. https://paperclip.example.com. Event URLs are relative paths when empty.",
      },
      ownerUserIds: {
        type: "array",
        items: { type: "string" },
        default: [],
        description:
          "User IDs whose assigned open cards count as decisions. Empty means any card assigned to a human user.",
      },
      runFailures: {
        type: "object",
        description: "Announce failed and timed-out agent runs, grouped per error signature and time window across agents.",
        properties: {
          enabled: { type: "boolean", default: true, description: "Announce failed agent runs. Cancelled runs are never announced." },
          windowMinutes: {
            type: "integer",
            minimum: 1,
            maximum: 1440,
            default: 30,
            description: "Failures with the same error inside one fixed window of this length become one item, whichever agents hit it.",
          },
        },
      },
    },
  },
};

export default manifest;
