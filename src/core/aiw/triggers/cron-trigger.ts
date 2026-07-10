// triggers/cron-trigger.ts — cron sweep that enqueues AIW tasks.
//
// Mirrors the lessons' "Cron Trigger" pattern from
// `principles/06-aiws-and-afk.md` § "Trigger Types":
//
//   - Poll every N seconds (configurable)
//   - Pre-check regex before enqueuing (idempotency)
//   - Subprocess-style dispatch (we use the queue; same durability)
//
// For v1, the cron trigger is the simplest possible thing that
// works: a function the daemon's trigger loop calls with a list of
// schedule entries (workflow + prompt) to fire.
//
// Usage:
//   const trigger = startCronTrigger({
//     cwd,
//     schedules: [{ id: "nightly-refresh", workflow: "plan_build", prompt: "/refresh-surface", everySeconds: 86400 }],
//   });
//   // ...later...
//   await trigger.stop();

import { enqueueAiwTask } from "../worker.ts";
import { defaultConfigDir } from "../../agentify-config.ts";

export interface CronSchedule {
  id: string;
  workflow: "plan_build" | "plan_build_review" | "plan_build_review_fix";
  prompt: string;
  /** Seconds between firings. Default 86400 (daily). */
  everySeconds?: number;
  /** Optional cron-style constraint: only fire on these weekday numbers (0=Sun). */
  weekdays?: number[];
  /** Hour of day to fire (24h, 0-23). */
  hourOfDay?: number;
}

export interface CronTriggerOptions {
  cwd: string;
  schedules: CronSchedule[];
  pollIntervalMs?: number;
  logger?: (msg: string) => void;
  /** Override the clock for testing. */
  now?: () => number;
}

export interface RunningCronTrigger {
  stop(): Promise<void>;
  /** For tests; run one sweep. */
  sweep(): CronSweepResult;
}

export interface CronSweepResult {
  fired: Array<{ scheduleId: string; taskId: string }>;
  skipped: Array<{ scheduleId: string; reason: string }>;
}

export function startCronTrigger(options: CronTriggerOptions): RunningCronTrigger {
  const configDir = defaultConfigDir();
  const log = options.logger ?? ((m: string) => process.stderr.write(`[cron] ${m}\n`));
  const pollMs = options.pollIntervalMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const lastFired = new Map<string, number>();

  let stopped = false;
  const stopPromises: Array<() => void> = [];

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        sweep();
      } catch (err) {
        log(`sweep failed: ${(err as Error).message}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        stopPromises.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };

  void loop();

  function sweep(): CronSweepResult {
    const result: CronSweepResult = { fired: [], skipped: [] };
    const current = now();
    const date = new Date(current);
    const hour = date.getHours();
    const weekday = date.getDay();

    for (const schedule of options.schedules) {
      const last = lastFired.get(schedule.id) ?? 0;
      const elapsedSec = (current - last) / 1000;
      const interval = schedule.everySeconds ?? 86400;
      if (elapsedSec < interval) {
        result.skipped.push({ scheduleId: schedule.id, reason: "too_soon" });
        continue;
      }
      if (schedule.weekdays && !schedule.weekdays.includes(weekday)) {
        result.skipped.push({ scheduleId: schedule.id, reason: "wrong_weekday" });
        continue;
      }
      if (schedule.hourOfDay !== undefined && schedule.hourOfDay !== hour) {
        result.skipped.push({ scheduleId: schedule.id, reason: "wrong_hour" });
        continue;
      }

      // Fire it.
      const aiwId = generateCronId(schedule.id, current);
      enqueueAiwTask({
        configDir,
        triggerId: `cron-${schedule.id}`,
        aiwId,
        workflow: schedule.workflow,
        prompt: schedule.prompt,
        source: `cron:${schedule.id}`,
        cwd: options.cwd,
      });
      lastFired.set(schedule.id, current);
      result.fired.push({ scheduleId: schedule.id, taskId: aiwId });
      log(`fired ${schedule.id} (workflow=${schedule.workflow}, aiw_id=${aiwId})`);
    }
    return result;
  }

  return {
    async stop(): Promise<void> {
      stopped = true;
      while (stopPromises.length > 0) {
        const r = stopPromises.shift();
        r?.();
      }
    },
    sweep,
  };
}

function generateCronId(scheduleId: string, at: number): string {
  // 16 hex chars from the schedule id + timestamp.
  let h = 0;
  for (let i = 0; i < scheduleId.length; i++) {
    h = (h * 31 + scheduleId.charCodeAt(i)) | 0;
  }
  const seed = (h ^ at) >>> 0;
  return seed.toString(16).padStart(8, "0") + ((at >>> 0).toString(16).padStart(8, "0")).slice(0, 8);
}