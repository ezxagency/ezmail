/* ============================================================
   EMAIL SUMMARIES
   The app is static, so "send an email" means: write a document to the
   Firestore `mail` collection and let the Trigger Email extension
   (firestore-send-email) deliver it. The extension stamps delivery
   state back onto the document, so the UI can watch that field and
   report success or failure honestly. See README for the one-time
   project setup (extension + rules).
   ============================================================ */

// [startISO, endISO] inclusive, matched against the shift's clock-in day
function summaryFilterRows(rows, startISO, endISO){
  const a = startISO ? new Date(startISO + "T00:00:00").getTime() : -Infinity;
  const b = endISO ? new Date(endISO + "T23:59:59.999").getTime() : Infinity;
  return rows.filter(r => r.startedAt >= a && r.startedAt <= b);
}

function summaryModel(rows){
  const total = rows.reduce((t, r) => t + r.netMs, 0);
  const brk = rows.reduce((t, r) => t + (r.breakMs || 0), 0);
  const rated = rows.filter(r => r.rating);
  const longest = rows.reduce((m, r) => Math.max(m, r.netMs), 0);
  const days = new Set(rows.map(r => dayStamp(r.startedAt))).size;
  return {
    shifts: rows.length, days, total, brk, longest,
    avg: rows.length ? total / rows.length : 0,
    rating: rated.length ? (rated.reduce((t, r) => t + r.rating, 0) / rated.length).toFixed(1) : null
  };
}

/* Inline-styled, table-based HTML - the only dialect every mail client
   speaks. Light body with the brand's navy header; nothing external. */
function summaryEmailHTML(name, rangeLabel, rows){
  const m = summaryModel(rows);
  const kpi = (label, value) => `
    <td style="padding:14px 8px;text-align:center;background:#f6f4ef;border-radius:10px">
      <div style="font:600 10px/1.4 Arial,sans-serif;letter-spacing:1.5px;color:#8a8578;text-transform:uppercase">${label}</div>
      <div style="font:700 20px/1.3 Arial,sans-serif;color:#161922;margin-top:4px">${value}</div>
    </td>`;
  const cell = s => `<td style="padding:9px 10px;font:13px/1.5 Arial,sans-serif;color:#2b2b28;border-bottom:1px solid #eee8db;vertical-align:top">${s}</td>`;
  const body = rows.length ? [...rows].sort((a, b) => a.startedAt - b.startedAt).map(r => {
    const tasks = taskTally(r, r.endedAt).map(t => esc(t.store) + " · " + esc(t.task) + " " + humanDur(t.ms)).join("<br>") || "—";
    return `<tr>
      ${cell("<b>" + dayStamp(r.startedAt) + "</b>")}
      ${cell(esc(r.client))}
      ${cell(clock(r.startedAt))}
      ${cell(clock(r.endedAt))}
      ${cell(r.breakMs ? humanDur(r.breakMs) : "—")}
      ${cell("<b>" + humanDur(r.netMs) + "</b>")}
      ${cell(tasks + (r.note ? `<div style="color:#8a8578;margin-top:4px">“${esc(r.note)}”</div>` : ""))}
    </tr>`;
  }).join("") : `<tr>${cell("No closed shifts in this range.")}</tr>`;
  const head = s => `<td style="padding:9px 10px;font:600 10px/1.4 Arial,sans-serif;letter-spacing:1px;color:#8a8578;text-transform:uppercase;border-bottom:2px solid #161922;text-align:left">${s}</td>`;

  return `<!doctype html><html><body style="margin:0;padding:0;background:#eeeae0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eeeae0;padding:24px 12px"><tr><td align="center">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden">
      <tr><td style="background:#161922;padding:26px 28px">
        <div style="font:800 22px/1 Arial,sans-serif;color:#ffffff;letter-spacing:1px">EZ <span style="font-weight:300">CLOCK IN</span></div>
        <div style="font:13px/1.6 Arial,sans-serif;color:#b9bcc4;margin-top:8px">Shift summary for <b style="color:#fff">${esc(name)}</b> · ${esc(rangeLabel)}</div>
      </td></tr>
      <tr><td style="padding:22px 22px 6px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>
          ${kpi("Net worked", humanDur(m.total))}
          ${kpi("Shifts", m.shifts + (m.days !== m.shifts ? " / " + m.days + "d" : ""))}
          ${kpi("Breaks", m.brk ? humanDur(m.brk) : "—")}
          ${kpi("Avg shift", m.shifts ? humanDur(m.avg) : "—")}
        </tr><tr>
          ${kpi("Longest shift", m.longest ? humanDur(m.longest) : "—")}
          ${kpi("Avg rating", m.rating ? m.rating + " / 5" : "—")}
          ${kpi("Range", esc(rangeLabel))}
          ${kpi("Generated", dayStamp(Date.now()))}
        </tr></table>
      </td></tr>
      <tr><td style="padding:14px 22px 26px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>${head("Date")}${head("Store")}${head("In")}${head("Out")}${head("Break")}${head("Net")}${head("Tasks & notes")}</tr>
          ${body}
        </table>
      </td></tr>
      <tr><td style="padding:16px 28px;background:#f6f4ef">
        <div style="font:11px/1.6 Arial,sans-serif;color:#8a8578">Sent by EZ Clock In · Ez Agency. Times are the device's local time.</div>
      </td></tr>
    </table>
  </td></tr></table>
  </body></html>`;
}

/* Queue the mail document and watch its delivery state so the toast tells
   the truth: sent, failed, or parked until delivery is enabled. Resolves
   when there is something worth telling the user. */
async function queueSummaryEmail(opts){   // { to, name, rows, rangeLabel }
  if (!FB_READY || !db){ toast("Email needs Firebase configured"); return false; }
  let ref;
  try {
    ref = await db.collection("mail").add({
      to: [opts.to],
      message: {
        subject: `Shift summary — ${opts.name} · ${opts.rangeLabel}`,
        html: summaryEmailHTML(opts.name, opts.rangeLabel, opts.rows)
      },
      // our own audit trail; the extension ignores this field
      summary: {
        forName: opts.name,
        requestedBy: (auth.currentUser && auth.currentUser.email) || "",
        rangeLabel: opts.rangeLabel,
        shifts: opts.rows.length,
        createdAt: Date.now()
      }
    });
  } catch (e) {
    console.error(e);
    // name the actual blocker: nine times out of ten it is the missing
    // `mail` rule, which is a 30-second paste in the Firebase console
    toast(e && e.code === "permission-denied"
      ? "Firestore rules are blocking the mail queue — add the mail rule from the README, then retry"
      : "Couldn't queue the email — " + ((e && e.message) || "try again"));
    return false;
  }
  return new Promise(resolve => {
    let done = false;
    const finish = (ok, msg) => {
      if (done) return;
      done = true; unsub(); clearTimeout(timer);
      toast(msg);
      resolve(ok);
    };
    const unsub = ref.onSnapshot(snap => {
      const d = snap.data() && snap.data().delivery;
      if (!d || !d.state) return;
      if (d.state === "SUCCESS") finish(true, "Summary emailed to " + opts.to);
      if (d.state === "ERROR") finish(false, "Email failed — " + ((d.error && String(d.error).slice(0, 80)) || "check the mail extension"));
    }, () => {});
    // no state after a while = extension not (yet) installed; the doc waits
    const timer = setTimeout(() =>
      finish(true, "Summary queued — it sends once email delivery is enabled"), 12000);
  });
}

const summaryISO = ts => {
  const d = new Date(ts);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
};
const summaryRangeLabel = (startISO, endISO) => {
  const f = iso => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  if (startISO && endISO) return f(startISO) + " – " + f(endISO);
  if (startISO) return "From " + f(startISO);
  if (endISO) return "Until " + f(endISO);
  return "All time";
};
