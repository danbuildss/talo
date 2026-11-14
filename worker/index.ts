import { createApp } from "./app.ts";
import { runDueSources } from "./db/collector.ts";
import type { Env } from "./env.ts";

const app = createApp();

export default {
  fetch: app.fetch,
  /** Cron Trigger (wrangler.jsonc): check a few due sources each run. */
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runDueSources(env.DB, { env }).then((outcomes) => {
        const failed = outcomes.filter((o) => o.status === "failed").length;
        console.log(`collector: ${outcomes.length} sources checked, ${failed} failed`);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
