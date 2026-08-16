/* ACTION effects, held to "never lose one silently": the real
   wfDispatchEffects + the real queueAppEmail (js/email.js) run in a VM
   with db/fetch stubbed and every call recorded. Asserts honest failure
   when mail can't go, the webhook enabled=false gate, dispatched/failed/
   skipped stamping on the nodeRun (what the timeline renders), and the
   at-most-once retry guard.
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

const ctx = vm.createContext({
  console,
  auth: { currentUser: { uid: "admin1" } },
  $: () => null,
  // email.js needs these at call time; EmailJS stays UNCONFIGURED so the
  // transport falls through to the Firestore mail queue
  CONFIG: { emailjs: { publicKey: "", serviceId: "", templateId: "" } },
  FB_READY: true,
  esc: s => String(s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]))
});
vm.runInContext(readFileSync(join(here, "../js/workflow-engine.js"), "utf8"), ctx);
vm.runInContext(readFileSync(join(here, "../js/email.js"), "utf8"), ctx);
vm.runInContext(readFileSync(join(here, "../js/workflow.js"), "utf8"), ctx);

/* the harness inside the realm: a recording db whose mail queue can be
   told to deny (a worker mailing a client), and a recording fetch that
   can be told to fail (an unreachable webhook) */
vm.runInContext(`
  Date = { now: () => 1755302400000 };
  __calls = [];
  __setup = (mailMode, fetchMode) => {
    __calls = [];
    db = { collection: name => ({
      add: async d => {
        __calls.push({ col: name, op: "add", doc: d });
        if (name === "mail" && mailMode === "deny"){
          const e = new Error("Missing or insufficient permissions.");
          e.code = "permission-denied";
          throw e;
        }
        return { id: "doc1" };
      },
      doc: id => ({ update: async patch => { __calls.push({ col: name, op: "update", id, patch }); } })
    }) };
    fetch = async (url, opts) => {
      __calls.push({ op: "fetch", url, method: opts && opts.method, body: opts && opts.body });
      if (fetchMode === "down") throw new Error("Failed to fetch");
      return { ok: fetchMode !== "http500", status: fetchMode === "http500" ? 500 : 200 };
    };
  };
  __state = (nodeRunExtra) => ({
    run: { id: "r1", taskId: null, task: { title: "October banner", lane: "A" },
      blueprintSnapshot: { name: "Track", version: 2 } },
    nodeRuns: [Object.assign({ id: "nr1", nodeId: "a1", nodeType: "action",
      status: "completed", output: {} }, nodeRunExtra || {})]
  });
`, ctx);

const run = (setupArgs, effect) => {
  vm.runInContext(`__setup(${JSON.stringify(setupArgs[0])}, ${JSON.stringify(setupArgs[1])});
    __st = __state(); __p = wfDispatchEffects(__st, [${JSON.stringify(effect)}]);`, ctx);
  return ctx.__p.then(() => JSON.parse(JSON.stringify({ calls: ctx.__calls, state: ctx.__st })));
};
const act = (actionType, params) => ({ type: "action", nodeRunId: "nr1", nodeId: "a1", actionType, params });
const stampOf = out => {
  const u = out.calls.find(c => c.col === "nodeRuns" && c.op === "update");
  return u ? u.patch["dispatch.action"] : null;
};

await T("email with EmailJS unconfigured + mail queue denied → honest FAILED stamp, no throw", async () => {
  const out = await run(["deny", "ok"], act("email", { to: "client@x.com", subject: "Hi" }));
  const s = stampOf(out);
  assert.equal(s.state, "failed");
  assert.match(s.reason, /rules block/i);          // names the actual blocker
  assert.ok(out.calls.some(c => c.col === "mail"));  // it genuinely tried the pathway
});

await T("email with the mail queue open → dispatched via the fallback, payload correct", async () => {
  const out = await run(["allow", "ok"], act("email", { to: "client@x.com", subject: "Assets ready", message: "All done." }));
  const s = stampOf(out);
  assert.equal(s.state, "dispatched");
  assert.match(s.reason, /queued/i);
  const mail = out.calls.find(c => c.col === "mail");
  assert.deepEqual(mail.doc.to, ["client@x.com"]);
  assert.equal(mail.doc.message.subject, "Assets ready");
  assert.match(mail.doc.message.html, /October banner/);   // run/task context rode along
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

await T("at-most-once: an already-stamped effect never re-executes", async () => {
  vm.runInContext(`__setup("allow", "ok");
    __st = __state({ dispatch: { action: { state: "dispatched", at: 1 } } });
    __p = wfDispatchEffects(__st, [${JSON.stringify(act("webhook", { url: "https://hook.example/z", enabled: true }))}]);`, ctx);
  await ctx.__p;
  const calls = JSON.parse(JSON.stringify(ctx.__calls));
  assert.equal(calls.length, 0);   // no fetch, no re-stamp
});

await T("notify action still lands as an admin notification and stamps dispatched", async () => {
  const out = await run(["allow", "ok"], act("notify", { message: "Track finished" }));
  assert.equal(stampOf(out).state, "dispatched");
  const n = out.calls.find(c => c.col === "notifications");
  assert.equal(n.doc.toRole, "admin");
  assert.equal(n.doc.text, "Track finished");
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
