import { definePlugin } from "@paperclipai/plugin-sdk";
import type { PluginApiRequestInput, PluginApiResponse, PluginContext } from "@paperclipai/plugin-sdk";
import { SCAN_JOB_KEY } from "./manifest.js";
import { DecisionNotifier } from "./notifier.js";

let notifier: DecisionNotifier | null = null;

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    const current = new DecisionNotifier(ctx);
    notifier = current;

    ctx.jobs.register(SCAN_JOB_KEY, async () => {
      await current.scanAll();
    });

    // Events give low latency; the scan job is the safety net and the only
    // source for thread interactions until they become plugin events (#4990).
    for (const name of ["approval.created", "approval.decided"] as const) {
      ctx.events.on(name, async (event) => {
        await current.onApprovalEvent(event.companyId, event.entityId);
      });
    }
    for (const name of ["issue.created", "issue.updated"] as const) {
      ctx.events.on(name, async (event) => {
        await current.onIssueEvent(event.companyId, event.entityId);
      });
    }
    // Failed and timed-out runs. Cancelled runs have their own event, which is
    // deliberately not subscribed. The scan job reconciles dropped events.
    ctx.events.on("agent.run.failed", async (event) => {
      await current.onRunFailedEvent(event.companyId, event.payload, event.occurredAt, event.entityId);
    });
    // The scan job covers the companies the plugin has been invoked for; a
    // company created after startup joins that set here, before it necessarily
    // produces one of the events above.
    ctx.events.on("company.created", async (event) => {
      await current.noteCompany(event.companyId ?? event.entityId);
    });
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (!notifier) return { status: 503, body: { error: "plugin not ready" } };
    if (input.routeKey === "catch-up") {
      const pending = await notifier.catchUp(input.companyId);
      return { status: 200, body: { pending } };
    }
    return { status: 404, body: { error: `unknown route ${input.routeKey}` } };
  },
});

export default plugin;
