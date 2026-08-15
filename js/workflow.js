/* ============================================================
   WORKFLOW BUILDER — UI + Firestore glue.
   The routed #/workflow page: blueprints an admin draws, runs
   that ride them. Pure transition/validation logic lives in
   js/workflow-engine.js (loaded just before this file); this
   file owns the DOM and every Firestore read/write.

   Step 1 shell: the page renders an empty state. The builder
   canvas (Drawflow), runs board and watchers land in later steps.

   Pinned for the run steps: a worker-driven advance may write
   ONLY ['status','activeNodeIds','hops','completedAt'] on a run
   doc - the firestore.rules allowlist rejects anything else, so
   one stray field in that update would stall real runs mid-
   flight. blueprintSnapshot is written once at run creation and
   never again.
   ============================================================ */

function enterWorkflowPage(){
  const box = $("workflowBody");
  if (!box) return;
  box.innerHTML = `
    <div class="fpage-panel">
      <div class="empty">
        <span class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2.5" width="6" height="5" rx="1.5"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/><path d="M12 7.5V11M12 11H5.5v5M12 11h6.5v5"/></svg>
        </span>
        ${isAdmin
          ? "No blueprints yet. The builder lands here next — draw how work moves, publish, and runs ride the tracks."
          : "Nothing here yet. When a task stops at you, it lands here."}
      </div>
    </div>`;
}
