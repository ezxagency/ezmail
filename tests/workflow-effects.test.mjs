/* ACTION effects + ROLE-stop delivery, held to "never lose one silently":
   the real wfDispatchEffects / wfExecEffect / wfClaimStop and the real
   queueAppEmail (js/email.js) run in a VM against a tiny in-memory
   Firestore (docs + batch + runTransaction, every call recorded).
   Covers: honest email failure, the webhook enabled=false gate,
   dispatched/failed/skipped stamping, recipient resolution (person /
   role-pool via directory crafts / empty-pool admin fallback), the claim
   transaction that bridges a stop onto the dashboard queue, and the
   at-most-once replay guard.
   Run: node tests/workflow-effects.test.mjs */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const T = async (name, fn) => {
  try { await fn(); pass++; console.log("PASS  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "  →  " + String(e.message || e).split("\n")[0].slice(0, 160)); }
};

const FIXED_NOW = 1755302400000;
class FakeDate extends Date {}
FakeDate.now = () => FIXED_NOW;

const ctx = vm.createContext({
  console,
  Date: FakeDate,
  auth: { currentUser: { uid: "me1", email: "me@x.com" } },
  $: () => null,
  S: { worker: "Testy" },
  pad: n => String(n).padStart(2, "0"),
  // email.js needs these at call time; EmailJS stays UNCONFIGURED so the
  // transport falls through to the Firestore mail queue
  CONFIG: { emailjs: { publicKey: "", serviceId: "", templateId: "" } },
  FB_READY: true,
  esc: s => String(s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c])),
  toast: () => {}
});
vm.runInContext(readFileSync(join(here, "../js/workflow-engine.js"), "utf8"), ctx);
vm.runInContext(readFileSync(join(here, "../js/email.js"), "utf8"), ctx);
vm.runInContext(readFileSync(join(here, "../js/workflow.js"), "utf8"), ctx);

/* the harness inside the realm: an in-memory doc store behind the same db
   surface the glue uses. mailMode "deny" = the rules refusing a worker's
   mail to someone else; fetchMode controls the webhook endpoint. */
vm.runInContext(`
  __setup = (mailMode, fetchMode) => {
    __calls = [];
    __docs = {};
    __gen = 0;
    wfDirCache = null;   // wfLoadDirectory re-reads per test
    const mkDoc = (name, id) => {
      if (id === undefined) id = "gen" + (++__gen);
      const path = name + "/" + id;
      return { id, __path: path,
        get: async () => ({ exists: __docs[path] !== undefined, data: () => JSON.parse(JSON.stringify(__docs[path])) }),
        update: async patch => { __calls.push({ col: name, op: "update", id, patch }); Object.assign(__docs[path] = __docs[path] || {}, patch); }
      };
    };
    db = {
      collection: name => ({
        doc: id => mkDoc(name, id),
        add: async d => {
          __calls.push({ col: name, op: "add", doc: d });
          if (name === "mail" && mailMode === "deny"){
            const e = new Error("Missing or insufficient permissions.");
            e.code = "permission-denied";
            throw e;
          }
          __docs[name + "/gen" + (++__gen)] = d;
          return { id: "gen" + __gen };
        },
        get: async () => ({ forEach: cb => Object.keys(__docs).filter(k => k.startsWith(name + "/"))
          .forEach(k => cb({ id: k.slice(name.length + 1), data: () => JSON.parse(JSON.stringify(__docs[k])) })) })
      }),
      batch: () => {
        const ops = [];
        return {
          set: (ref, d) => ops.push({ col: ref.__path.split("/")[0], op: "batch-set", path: ref.__path, doc: d }),
          commit: async () => ops.forEach(o => { __calls.push(o); __docs[o.path] = o.doc; })
        };
      },
      runTransaction: async fn => fn({
        get: async ref => ({ exists: __docs[ref.__path] !== undefined, data: () => JSON.parse(JSON.stringify(__docs[ref.__path])) }),
        update: (ref, patch) => { __calls.push({ col: ref.__path.split("/")[0], op: "tx-update", path: ref.__path, patch }); Object.assign(__docs[ref.__path], patch); },
        set: (ref, d) => { __calls.push({ col: ref.__path.split("/")[0], op: "tx-set", path: ref.__path, doc: d }); __docs[ref.__path] = d; }
      })
    };
    fetch = async (url, opts) => {
      __calls.push({ op: "fetch", url, method: opts && opts.method, body: opts && opts.body });
      if (fetchMode === "down") throw new Error("Failed to fetch");
      return { ok: fetchMode !== "http500", status: fetchMode === "http500" ? 500 : 200 };
    };
  };
  __state = (nodeRunExtra, nodes) => ({
    run: { id: "r1", taskId: null, task: { title: "October banner", lane: "A" },
      blueprintSnapshot: { name: "Track", version: 2, nodes: nodes || [
        { id: "a1", type: "action", position: { x: 0, y: 0 }, config: { actionType: "notify" } },
        { id: "n1", type: "role", position: { x: 0, y: 0 }, config: { label: "QA pass", role: "designer", instructions: "check it", dueAfter: 2, outputs: [] } }
      ] } },
    nodeRuns: [Object.assign({ id: "nr1", nodeId: "a1", nodeType: "action",
      status: "completed", output: {} }, nodeRunExtra || {})]
  });
`, ctx);

const J = v => JSON.parse(JSON.stringify(v));
const run = (setupArgs, effect, stateArgs) => {
  vm.runInContext(`__setup(${JSON.stringify(setupArgs[0])}, ${JSON.stringify(setupArgs[1])});
    __st = __state(${stateArgs || ""}); __p = wfDispatchEffects(__st, [${JSON.stringify(effect)}]);`, ctx);
  return ctx.__p.then(() => J({ calls: ctx.__calls, docs: ctx.__docs }));
};
const act = (actionType, params) => ({ type: "action", nodeRunId: "nr1", nodeId: "a1", actionType, params });
const stampOf = (out, type = "action") => {
  const u = out.calls.find(c => c.col === "nodeRuns" && c.op === "update");
  return u ? u.patch["dispatch." + type] : null;
};

/* ================= ACTION EFFECTS (email / webhook / notify) ================= */
await T("email with EmailJS unconfigured + mail queue denied → honest FAILED stamp, no throw", async () => {
  const out = await run(["deny", "ok"], act("email", { to: "client@x.com", subject: "Hi" }));
  const s = stampOf(out);
  assert.equal(s.state, "failed");
  assert.match(s.reason, /rules block/i);
  assert.ok(out.calls.some(c => c.col === "mail"));
});

await T("email with the mail queue open → dispatched via the fallback, payload correct", async () => {
  const out = await run(["allow", "ok"], act("email", { to: "client@x.com", subject: "Assets ready", message: "All done." }));
  const s = stampOf(out);
  assert.equal(s.state, "dispatched");
  assert.match(s.reason, /queued/i);
  const mail = out.calls.find(c => c.col === "mail");
  assert.deepEqual(mail.doc.to, ["client@x.com"]);
  assert.equal(mail.doc.message.subject, "Assets ready");
  assert.match(mail.doc.message.html, /October banner/);
  assert.match(mail.doc.message.html, /All done\./);
});

await T("email with no recipient → failed with a clear reason", async () => {
  const s = stampOf(await run(["allow", "ok"], act("email", { subject: "Hi" })));
  assert.equal(s.state, "failed");
  assert.match(s.reason, /no recipient/i);
});

await T("webhook with enabled=false is SKIPPED — fetch never happens", async () => {
  const out = await run(["allow", "ok"], act("webhook", { url: "https://hook.example/z", enabled: false }));
  const s = stampOf(out);
  assert.equal(s.state, "skipped");
  assert.match(s.reason, /disabled/i);
  assert.ok(!out.calls.some(c => c.op === "fetch"));
});

await T("webhook enabled → POSTs JSON with run/task context, dispatched", async () => {
  const out = await run(["allow", "ok"], act("webhook", { url: "https://hook.example/z", enabled: true }));
  assert.equal(stampOf(out).state, "dispatched");
  const f = out.calls.find(c => c.op === "fetch");
  assert.equal(f.method, "POST");
  const body = JSON.parse(f.body);
  assert.equal(body.event, "workflow-action");
  assert.equal(body.runId, "r1");
  assert.equal(body.task.title, "October banner");
  assert.equal(body.blueprint.version, 2);
});

await T("webhook endpoint down → failed with reason, no throw", async () => {
  const s = stampOf(await run(["allow", "down"], act("webhook", { url: "https://hook.example/z", enabled: true })));
  assert.equal(s.state, "failed");
  assert.match(s.reason, /couldn't reach/i);
});

await T("webhook HTTP error → failed, names the status", async () => {
  const s = stampOf(await run(["allow", "http500"], act("webhook", { url: "https://hook.example/z", enabled: true })));
  assert.equal(s.state, "failed");
  assert.match(s.reason, /500/);
});

await T("notify action lands as an admin notification and stamps dispatched", async () => {
  const out = await run(["allow", "ok"], act("notify", { message: "Track finished" }));
  assert.equal(stampOf(out).state, "dispatched");
  const n = out.calls.find(c => c.col === "notifications");
  assert.equal(n.doc.toRole, "admin");
  assert.equal(n.doc.text, "Track finished");
});

/* ================= ROLE-STOP DELIVERY (the live-run bug) ================= */
const roleEffect = over => Object.assign(
  { type: "role-activated", nodeRunId: "nr1", nodeId: "n1", role: "designer", assigneeId: null }, over || {});
const seedDir = () => vm.runInContext(`
  __docs["directory/dA"] = { name: "Anshul", craft: "designer" };
  __docs["directory/dB"] = { name: "Bela", craft: " Designer " };   // case/space noise
  __docs["directory/dC"] = { name: "Cato", craft: "copywriter" };
`, ctx);

await T("person-assigned stop → exactly one claimable wf-stop offer to that person", async () => {
  vm.runInContext(`__setup("allow", "ok"); __st = __state({ nodeId: "n1", nodeType: "role", status: "in_progress" });
    __p = wfDispatchEffects(__st, [${JSON.stringify(roleEffect({ assigneeId: "uX", role: null }))}]);`, ctx);
  await ctx.__p;
  const out = J({ calls: ctx.__calls });
  const sets = out.calls.filter(c => c.op === "batch-set" && c.col === "notifications");
  assert.equal(sets.length, 1);
  assert.equal(sets[0].doc.toUid, "uX");
  assert.equal(sets[0].doc.kind, "wf-stop");
  assert.equal(sets[0].doc.status, "pending");
  assert.equal(sets[0].doc.stop, "QA pass");
  assert.equal(sets[0].doc.taskTitle, "October banner");
  assert.equal(stampOf(out, "role-activated").state, "dispatched");
});

await T("role stop → fans out to every directory member holding that craft (case-insensitive)", async () => {
  vm.runInContext(`__setup("allow", "ok");`, ctx);
  seedDir();
  vm.runInContext(`__st = __state({ nodeId: "n1", nodeType: "role", status: "in_progress" });
    __p = wfDispatchEffects(__st, [${JSON.stringify(roleEffect())}]);`, ctx);
  await ctx.__p;
  const out = J({ calls: ctx.__calls });
  const sets = out.calls.filter(c => c.op === "batch-set" && c.col === "notifications");
  assert.deepEqual(sets.map(s => s.doc.toUid).sort(), ["dA", "dB"]);   // the copywriter is not bothered
  const s = stampOf(out, "role-activated");
  assert.equal(s.state, "dispatched");
  assert.match(s.reason, /2 designer/);
});

await T("role stop with an EMPTY pool → admins alerted, never silent", async () => {
  vm.runInContext(`__setup("allow", "ok");`, ctx);
  seedDir();
  vm.runInContext(`__st = __state({ nodeId: "n1", nodeType: "role", status: "in_progress" });
    __p = wfDispatchEffects(__st, [${JSON.stringify(roleEffect({ role: "editor" }))}]);`, ctx);
  await ctx.__p;
  const out = J({ calls: ctx.__calls });
  const n = out.calls.find(c => c.col === "notifications" && c.op === "add");
  assert.equal(n.doc.toRole, "admin");
  assert.match(n.doc.text, /No one holds the role/);
  assert.match(stampOf(out, "role-activated").reason, /admins alerted/);
});

await T("at-most-once: a stamped role-activation never re-sends on replay", async () => {
  vm.runInContext(`__setup("allow", "ok");`, ctx);
  seedDir();
  vm.runInContext(`__st = __state({ nodeId: "n1", nodeType: "role", status: "in_progress",
      dispatch: { "role-activated": { state: "dispatched", at: 1 } } });
    __p = wfDispatchEffects(__st, [${JSON.stringify(roleEffect())}]);`, ctx);
  await ctx.__p;
  assert.equal(J(ctx.__calls).length, 0);
});

/* ================= THE CLAIM (stop → dashboard queue) ================= */
const seedClaim = () => vm.runInContext(`
  __docs["nodeRuns/r1:n1:1"] = { id: "r1:n1:1", runId: "r1", nodeId: "n1", nodeType: "role",
    status: "in_progress", assigneeId: null, output: {}, inputs: {} };
  __docs["runs/r1"] = { id: "r1", task: { title: "October banner" },
    blueprintSnapshot: { name: "Track", version: 1, nodes: [
      { id: "n1", type: "role", config: { label: "QA pass", role: "designer", instructions: "check it", dueAfter: 2 } }
    ] } };
  __docs["notifications/nt1"] = { kind: "wf-stop", status: "pending", toUid: "me1", runId: "r1", nodeRunId: "r1:n1:1" };
`, ctx);

await T("claiming a stop: one transaction claims it, creates the queue row, settles the offer", async () => {
  vm.runInContext(`__setup("allow", "ok");`, ctx);
  seedClaim();
  await vm.runInContext(`wfClaimStop("r1", "r1:n1:1", "nt1")`, ctx);
  const docs = J(ctx.__docs);
  const nr = docs["nodeRuns/r1:n1:1"];
  assert.equal(nr.assigneeId, "me1");
  assert.ok(nr.claim && nr.claim.assignmentId);
  const a = docs["assignments/" + nr.claim.assignmentId];
  assert.equal(a.toUid, "me1");
  assert.equal(a.store, "October banner");
  assert.equal(a.task, "QA pass");
  assert.equal(a.note, "check it");
  assert.equal(a.wfNodeRunId, "r1:n1:1");
  assert.equal(a.done, false);
  assert.match(a.dueDate, /^\d{4}-\d{2}-\d{2}$/);   // dueAfter hours → a real due date
  assert.equal(docs["notifications/nt1"].status, "accepted");
});

await T("a second claimer is turned away — and nothing is written", async () => {
  vm.runInContext(`__setup("allow", "ok");`, ctx);
  seedClaim();
  vm.runInContext(`__docs["nodeRuns/r1:n1:1"].assigneeId = "someoneElse";`, ctx);
  await assert.rejects(
    () => vm.runInContext(`wfClaimStop("r1", "r1:n1:1", "nt1")`, ctx),
    /already took/);
  assert.ok(!J(ctx.__calls).some(c => c.op === "tx-set"));
  assert.equal(J(ctx.__docs)["notifications/nt1"].status, "pending");
});

await T("re-accepting an already-claimed stop settles the offer without a duplicate queue row", async () => {
  vm.runInContext(`__setup("allow", "ok");`, ctx);
  seedClaim();
  await vm.runInContext(`wfClaimStop("r1", "r1:n1:1", "nt1")`, ctx);
  vm.runInContext(`__docs["notifications/nt2"] = { kind: "wf-stop", status: "pending", toUid: "me1", runId: "r1", nodeRunId: "r1:n1:1" };`, ctx);
  await vm.runInContext(`wfClaimStop("r1", "r1:n1:1", "nt2")`, ctx);
  const docs = J(ctx.__docs);
  assert.equal(Object.keys(docs).filter(k => k.startsWith("assignments/")).length, 1);
  assert.equal(docs["notifications/nt2"].status, "accepted");
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
