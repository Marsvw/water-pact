import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOutbox, buildModel, summaryText, statusLabel } from "../js/model.js";

const ME = "me-id";
const SAM = "sam-id";
// Wednesday 11 Nov 2026, 15:00 in Amsterdam (14:00 UTC) and 09:00 in New York.
const NOW = new Date("2026-11-11T14:00:00Z");
const TZ = "Europe/Amsterdam";

function pactFixture(overrides = {}) {
  return {
    rev: 5,
    since: "2026-09-02",
    recentFrom: "2026-11-09",
    members: [
      { id: SAM, name: "Sam", goal_ml: 2500, tz: "America/New_York", joined_at: "2026-11-02T10:00:00Z", nudged_by: null, nudged_at: null },
      { id: ME, name: "Mars", goal_ml: 2000, tz: TZ, joined_at: "2026-11-01T10:00:00Z", nudged_by: null, nudged_at: null },
    ],
    days: [
      { member_id: ME, day: "2026-11-08", total_ml: 1800, goal_ml: 1500 },
      { member_id: SAM, day: "2026-11-08", total_ml: 2500, goal_ml: 2500 },
      { member_id: ME, day: "2026-11-06", total_ml: 2000, goal_ml: 2000 },
    ],
    entries: [
      { id: "e1", member_id: ME, ml: 2000, goal_ml: 2000, at: "2026-11-09T09:00:00Z", day: "2026-11-09" },
      { id: "s1", member_id: SAM, ml: 2500, goal_ml: 2500, at: "2026-11-09T15:00:00Z", day: "2026-11-09" },
      { id: "e2", member_id: ME, ml: 2100, goal_ml: 2000, at: "2026-11-10T09:00:00Z", day: "2026-11-10" },
      { id: "s2", member_id: SAM, ml: 1000, goal_ml: 2500, at: "2026-11-10T15:00:00Z", day: "2026-11-10" },
      { id: "e3", member_id: ME, ml: 500, goal_ml: 2000, at: "2026-11-11T08:00:00Z", day: "2026-11-11" },
      { id: "e4", member_id: ME, ml: 250, goal_ml: 2000, at: "2026-11-11T11:00:00Z", day: "2026-11-11" },
      { id: "s3", member_id: SAM, ml: 750, goal_ml: 2500, at: "2026-11-11T13:30:00Z", day: "2026-11-11" },
    ],
    ...overrides,
  };
}
const build = (extra = {}) => buildModel({ pact: pactFixture(), outbox: [], memberId: ME, now: NOW, deviceTz: TZ, ...extra });

test("without data the model is not ready", () => {
  const model = buildModel({ pact: null, outbox: [], memberId: ME, now: NOW, deviceTz: TZ });
  assert.equal(model.ready, false);
  assert.deepEqual(model.people, []);
});

test("you come first, then friends by join date", () => {
  const model = build();
  assert.deepEqual(model.people.map((p) => [p.name, p.isMe]), [["Mars", true], ["Sam", false]]);
});

test("today's totals, status and last drink come from the entries", () => {
  const [me, sam] = build().people;
  assert.equal(me.totalMl, 750);
  assert.equal(me.goalMl, 2000);
  assert.equal(me.todayKey, "2026-11-11");
  assert.deepEqual(me.status, { kind: "behind", behindMl: 250 });
  assert.equal(me.expectedMl, 1000);
  assert.equal(me.lastAt, Date.parse("2026-11-11T11:00:00Z"));
  assert.equal(sam.totalMl, 750);
  assert.equal(sam.status.kind, "pace", "09:00 in New York: Sam is ahead of pace");
});

test("a friend in another time zone is measured on their own day", () => {
  // 03:00 UTC on the 12th: already the 12th in Amsterdam, still the 11th in New York.
  const model = build({ now: new Date("2026-11-12T03:00:00Z") });
  const [me, sam] = model.people;
  assert.equal(me.todayKey, "2026-11-12");
  assert.equal(me.totalMl, 0);
  assert.equal(sam.todayKey, "2026-11-11");
  assert.equal(sam.totalMl, 750);
});

test("queued drinks count immediately and queued removals hide entries", () => {
  const outbox = [
    { opId: "o1", type: "log", id: "new1", ml: 500, at: "2026-11-11T13:55:00Z", day: "2026-11-11", goalMl: 2000 },
    { opId: "o2", type: "remove", id: "e4" },
  ];
  const model = build({ outbox });
  assert.equal(model.people[0].totalMl, 1000);
  assert.equal(model.pendingCount, 2);
  const mine = model.feed.filter((f) => f.memberId === ME);
  assert.deepEqual(mine.map((f) => [f.id, f.pending]), [["new1", true], ["e3", false]]);
});

test("applyOutbox does not duplicate a drink the server already has", () => {
  const entries = [{ id: "a", member_id: ME, ml: 250, goal_ml: 2000, at: "2026-11-11T08:00:00Z", day: "2026-11-11" }];
  const outbox = [{ opId: "o", type: "log", id: "a", ml: 250, at: "2026-11-11T08:00:00Z", day: "2026-11-11", goalMl: 2000 }];
  const merged = applyOutbox(entries, outbox, ME);
  assert.equal(merged.length, 1);
  assert.notEqual(merged, entries, "returns a new array");
});

test("a drink logged then removed while offline never appears", () => {
  const outbox = [
    { opId: "o1", type: "log", id: "tmp", ml: 500, at: "2026-11-11T13:55:00Z", day: "2026-11-11", goalMl: 2000 },
    { opId: "o2", type: "remove", id: "tmp" },
  ];
  assert.deepEqual(applyOutbox([], outbox, ME), []);
});

test("the feed lists everyone's drinks today, newest first", () => {
  const model = build();
  assert.deepEqual(model.feed.map((f) => f.id), ["s3", "e4", "e3"]);
  assert.equal(model.feed[0].memberId, SAM);
});

test("past days keep the goal they were logged under", () => {
  const model = build();
  const me = model.people[0];
  // Nov 8: 1800 against a 1500 goal counts as met even though the goal is 2000 now.
  // Nov 9 and 10 met from entries. Today (750) is still open, so the run is 8, 9, 10.
  assert.equal(me.streak, 3);
  // Sam: met Nov 8 and 9, missed Nov 10.
  assert.equal(model.people[1].streak, 0);
});

test("the team streak needs everyone to hit their goal on the same days", () => {
  const model = build();
  assert.equal(model.teamStreak, 0, "Sam missed yesterday");
  const solo = buildModel({
    pact: pactFixture({ members: pactFixture().members.filter((m) => m.id === ME) }),
    outbox: [], memberId: ME, now: NOW, deviceTz: TZ,
  });
  assert.equal(solo.teamStreak, null);
});

test("the calendar shows four Monday-first weeks with a bar per person", () => {
  const { weeks } = build();
  assert.equal(weeks.length, 4);
  const thisWeek = weeks[3];
  assert.deepEqual(thisWeek.map((d) => d.key), [
    "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15",
  ]);
  assert.deepEqual(thisWeek.map((d) => d.isToday), [false, false, true, false, false, false, false]);
  assert.deepEqual(thisWeek.map((d) => d.isFuture), [false, false, false, true, true, true, true]);
  const monday = thisWeek[0];
  assert.deepEqual(monday.bars, [
    { memberId: ME, ratio: 1, met: true },
    { memberId: SAM, ratio: 1, met: true },
  ]);
  const tuesday = thisWeek[1];
  assert.deepEqual(tuesday.bars[1], { memberId: SAM, ratio: 0.4, met: false });
  assert.equal(tuesday.bars[0].ratio, 1, "ratio is capped at a full bar");
});

test("the summary sentence covers each situation", () => {
  const fmt = (model) => summaryText(model, "ml", "en-US");
  assert.equal(fmt(build()), "You need 1,250 ml more. Sam needs 1,750 ml.");

  const alone = buildModel({
    pact: pactFixture({ members: pactFixture().members.filter((m) => m.id === ME) }),
    outbox: [], memberId: ME, now: NOW, deviceTz: TZ,
  });
  assert.equal(fmt(alone), "You need 1,250 ml more today. Invite your friend to get the pact going.");

  const meDone = build({ outbox: [{ opId: "o", type: "log", id: "big", ml: 1250, at: "2026-11-11T13:00:00Z", day: "2026-11-11", goalMl: 2000 }] });
  assert.equal(fmt(meDone), "You hit your goal. Sam still needs 1,750 ml.");

  const samDone = buildModel({
    pact: pactFixture({ entries: [...pactFixture().entries, { id: "s4", member_id: SAM, ml: 1750, goal_ml: 2500, at: "2026-11-11T13:40:00Z", day: "2026-11-11" }] }),
    outbox: [], memberId: ME, now: NOW, deviceTz: TZ,
  });
  assert.equal(fmt(samDone), "Sam hit their goal. You need 1,250 ml more.");

  const both = buildModel({
    pact: pactFixture({ entries: [...pactFixture().entries, { id: "s4", member_id: SAM, ml: 1750, goal_ml: 2500, at: "2026-11-11T13:40:00Z", day: "2026-11-11" }] }),
    outbox: [{ opId: "o", type: "log", id: "big", ml: 1250, at: "2026-11-11T13:00:00Z", day: "2026-11-11", goalMl: 2000 }],
    memberId: ME, now: NOW, deviceTz: TZ,
  });
  assert.equal(fmt(both), "You both hit your goal today.");
  assert.equal(fmt({ ready: false, people: [] }), "Loading today's log…");
});

test("three or more people get a count instead of names", () => {
  const members = [...pactFixture().members, { id: "ana", name: "Ana", goal_ml: 2000, tz: TZ, joined_at: "2026-11-03T10:00:00Z", nudged_by: null, nudged_at: null }];
  const model = buildModel({ pact: pactFixture({ members }), outbox: [], memberId: ME, now: NOW, deviceTz: TZ });
  assert.equal(summaryText(model, "ml", "en-US"), "0 of 3 people have hit their goal today.");
});

test("status labels read naturally", () => {
  assert.equal(statusLabel({ kind: "done", behindMl: 0 }, "ml", "en-US"), "Goal hit");
  assert.equal(statusLabel({ kind: "pace", behindMl: 0 }, "ml", "en-US"), "On pace");
  assert.equal(statusLabel({ kind: "idle", behindMl: 0 }, "ml", "en-US"), "Not started");
  assert.equal(statusLabel({ kind: "behind", behindMl: 500 }, "ml", "en-US"), "Behind 500 ml");
});
