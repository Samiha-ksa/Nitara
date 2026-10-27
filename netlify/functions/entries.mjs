import { getStore } from "@netlify/blobs";

// The two players. Everything they log is saved on the server, so both see each other's progress.
const USERS = ["Ammu", "Abbu"];
// Change this password. It is needed to wipe the race and start over.
const RESET_PASSWORD = "change-me";

// Daily exercise ids (see index.html). Each counts once per person per day.
const EXERCISE_IDS = [
  "k1", "k2", "k3", "k4", "b1", "b2", "b3", "a1", "a2", "a3", "a4", "a5", "a6",
  "s1", "s2", "c1", "c2", "c3", "c4", "c5", "c6",
];
const ENTRY_TYPES = ["steps", "water", "shake", "bike", ...EXERCISE_IDS];
// Entries that count once per person per day, always with an amount of 1.
const DAILY_ONCE = ["shake", ...EXERCISE_IDS];

// Ammu and Abbu live in Buffalo, New York. A "day" is a Buffalo calendar day (handles daylight saving),
// same as the page uses. It rolls over at midnight Buffalo time.
const DAY = 86400000, TZ = "America/New_York";
const tzFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const dayNum = (ts) => { const [y, m, d] = tzFmt.format(ts).split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY); };

const keyFor = (user) => "logs-" + user.toLowerCase();
const jKey = (user) => "journal-" + user.toLowerCase();
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

async function readAll(store) {
  const lists = await Promise.all(USERS.map((u) => store.get(keyFor(u), { type: "json" })));
  return lists.flatMap((l) => l || []).sort((a, b) => a.ts - b.ts);
}

// Days can be logged for today or up to 6 days back.
const dayOk = (day) => Number.isInteger(day) && day <= dayNum(Date.now()) && day >= dayNum(Date.now()) - 6;

export default async (req) => {
  // "strong" makes sure a tap is always read back right away (no stale results).
  const store = getStore({ name: "health-race-logs", consistency: "strong" });
  try {
    if (req.method === "GET") {
      const j = new URL(req.url).searchParams.get("journal");
      if (j !== null) {
        if (!USERS.includes(j)) return json({ error: "Invalid user" }, 400);
        return json({ journal: (await store.get(jKey(j), { type: "json" })) || [] });
      }
      return json({ logs: await readAll(store) });
    }

    if (req.method === "POST") {
      const body = await req.json();

      if (body.action === "journal") {
        const { user, prompt, text } = body;
        if (!USERS.includes(user) || typeof text !== "string" || !text.trim()) return json({ error: "Invalid entry" }, 400);
        const mine = (await store.get(jKey(user), { type: "json" })) || [];
        mine.push({ text: text.trim().slice(0, 2000), prompt: String(prompt || "").slice(0, 200), ts: Date.now() });
        const kept = mine.slice(-100);
        await store.setJSON(jKey(user), kept);
        return json({ journal: kept });
      }

      if (body.action === "add") {
        const { user, exercise, amount, day } = body.entry || {};
        if (!USERS.includes(user) || !ENTRY_TYPES.includes(exercise)) return json({ error: "Invalid entry" }, 400);
        if (!dayOk(day)) return json({ error: "Invalid day" }, 400);
        if (exercise === "steps") return json({ error: "Use set for steps" }, 400);
        if (exercise === "bike" && !(Number.isInteger(amount) && amount >= 1 && amount <= 120)) return json({ error: "Invalid amount" }, 400);
        const mine = (await store.get(keyFor(user), { type: "json" })) || [];
        if (DAILY_ONCE.includes(exercise) && mine.some((l) => l.exercise === exercise && l.day === day)) {
          return json({ error: "Already done today" }, 409);
        }
        if (exercise === "water" && mine.filter((l) => l.exercise === "water" && l.day === day).length >= 20) {
          return json({ error: "Enough water for one day!" }, 409);
        }
        const amt = exercise === "bike" ? amount : 1;
        mine.push({ user, exercise, amount: amt, day, ts: Date.now() });
        await store.setJSON(keyFor(user), mine);
      } else if (body.action === "set") {
        // Steps: type your total for the day. Replaces anything logged before for that day.
        const { user, amount, day } = body;
        if (!USERS.includes(user) || !dayOk(day)) return json({ error: "Invalid entry" }, 400);
        if (!Number.isInteger(amount) || amount < 0 || amount > 100000) return json({ error: "Invalid amount" }, 400);
        const mine = ((await store.get(keyFor(user), { type: "json" })) || []).filter((l) => !(l.exercise === "steps" && l.day === day));
        if (amount > 0) mine.push({ user, exercise: "steps", amount, day, ts: Date.now() });
        await store.setJSON(keyFor(user), mine);
      } else if (body.action === "undo") {
        const { user, exercise, day } = body;
        if (!USERS.includes(user) || !ENTRY_TYPES.includes(exercise) || !dayOk(day)) return json({ error: "Invalid undo" }, 400);
        const mine = (await store.get(keyFor(user), { type: "json" })) || [];
        let idx = -1;
        for (let i = mine.length - 1; i >= 0; i--) {
          if (mine[i].exercise === exercise && mine[i].day === day) { idx = i; break; }
        }
        if (idx === -1) return json({ error: "Nothing to undo" }, 404);
        mine.splice(idx, 1);
        await store.setJSON(keyFor(user), mine);
      } else if (body.action === "reset") {
        if (body.password !== RESET_PASSWORD) return json({ error: "Wrong password" }, 403);
        await Promise.all(USERS.map((u) => store.delete(keyFor(u))));
      } else {
        return json({ error: "Unknown action" }, 400);
      }
      return json({ logs: await readAll(store) });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    console.error(e);
    return json({ error: "Server error" }, 500);
  }
};

export const config = { path: "/api/entries" };
