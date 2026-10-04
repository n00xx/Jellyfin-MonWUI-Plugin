// Regression test for the expired-membership "blink": every managed home row module retried a
// row that rendered empty, every 1.4 s, forever. A user who can see nothing (an expired Neexy
// membership leaves one empty library) never gets out of that loop, and neither does a normal
// user whose "Continue watching" is simply empty. These two primitives are what the row modules
// now use to tell "there is nothing to show" (final) apart from "it failed" (retry, a few times).

import {
  createRetryBudget,
  createRowOutcomeTracker,
  recordRowOutcome,
  isRowSettledEmpty,
} from "../Resources/slider/modules/homeRowRetry.js";

let failures = 0;
const fail = (msg) => { failures++; console.log("  FAIL " + msg); };
const ok = (msg) => console.log("  ok   " + msg);
const expectEq = (label, got, want) => {
  if (got === want) ok(`${label} -> ${JSON.stringify(got)}`);
  else fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

console.log("retry budget: backs off, then stops");
{
  const budget = createRetryBudget({ maxAttempts: 3, baseDelayMs: 1400, maxDelayMs: 60_000 });
  expectEq("attempt 1", budget.next(), 1400);
  expectEq("attempt 2", budget.next(), 2800);
  expectEq("attempt 3", budget.next(), 5600);
  expectEq("attempt 4 is refused", budget.next(), null);
  expectEq("still refused", budget.next(), null);
  expectEq("attempts counted", budget.attempts, 3);
  budget.reset();
  expectEq("reset gives the full budget back", budget.next(), 1400);
}

console.log("\nretry budget: delay is capped");
{
  const budget = createRetryBudget({ maxAttempts: 6, baseDelayMs: 1000, maxDelayMs: 3000 });
  const delays = [budget.next(), budget.next(), budget.next(), budget.next()];
  expectEq("capped sequence", JSON.stringify(delays), JSON.stringify([1000, 2000, 3000, 3000]));
}

console.log("\nretry budget: nonsense options fall back to sane defaults");
{
  const budget = createRetryBudget({ maxAttempts: -2, baseDelayMs: "x" });
  const first = budget.next();
  if (Number.isFinite(first) && first > 0) ok(`first delay is a positive number (${first})`);
  else fail(`first delay should be a positive number, got ${first}`);
}

console.log("\nrow outcome: only a completed run of definite empties is settled");
{
  const settled = createRowOutcomeTracker(2);
  recordRowOutcome(settled, "empty");
  recordRowOutcome(settled, "empty");
  settled.completed = true;
  expectEq("two empty rows, run completed", isRowSettledEmpty(settled), true);

  const unfinished = createRowOutcomeTracker(2);
  recordRowOutcome(unfinished, "empty");
  expectEq("run not completed (page left mid-run)", isRowSettledEmpty(unfinished), false);

  const errored = createRowOutcomeTracker(2);
  recordRowOutcome(errored, "empty");
  recordRowOutcome(errored, "error");
  errored.completed = true;
  expectEq("a fetch error is not 'empty'", isRowSettledEmpty(errored), false);

  const stale = createRowOutcomeTracker(1);
  recordRowOutcome(stale, "stale");
  stale.completed = true;
  expectEq("an invalidated render is not 'empty'", isRowSettledEmpty(stale), false);

  const pending = createRowOutcomeTracker(1);
  recordRowOutcome(pending, "pending");
  pending.completed = true;
  expectEq("a deferred fetch still in flight is not 'empty'", isRowSettledEmpty(pending), false);

  const rendered = createRowOutcomeTracker(2);
  recordRowOutcome(rendered, "empty");
  recordRowOutcome(rendered, "rendered");
  rendered.completed = true;
  expectEq("something rendered (then vanished) is not 'empty'", isRowSettledEmpty(rendered), false);

  const silent = createRowOutcomeTracker(2);
  recordRowOutcome(silent, "empty");
  silent.completed = true;
  expectEq("a planned row that never reported is not 'empty'", isRowSettledEmpty(silent), false);

  const nothingPlanned = createRowOutcomeTracker(0);
  nothingPlanned.completed = true;
  expectEq("no row planned at all (no library of that kind)", isRowSettledEmpty(nothingPlanned), true);

  expectEq("no tracker (the run bailed before planning)", isRowSettledEmpty(null), false);
}

console.log("\nrow outcome: a pending row can resolve later");
{
  const t = createRowOutcomeTracker(1);
  recordRowOutcome(t, "pending");
  t.completed = true;
  recordRowOutcome(t, "empty", { resolvesPending: true });
  expectEq("pending resolved to empty", isRowSettledEmpty(t), true);
  expectEq("pending count back to zero", t.pending, 0);
}

console.log("\nrow outcome: unknown kinds are ignored, not counted as empty");
{
  const t = createRowOutcomeTracker(1);
  recordRowOutcome(t, "banana");
  t.completed = true;
  expectEq("nothing recorded", t.empty + t.error + t.rendered + t.stale + t.pending, 0);
  recordRowOutcome(null, "empty");
  ok("recording on a null tracker does not throw");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
