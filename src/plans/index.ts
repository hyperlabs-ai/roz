// Planes del agente (roz v2). Lo que usan los demás módulos:
//  · outbox: enqueuePlan ('plan.enqueue') y notifyPlanClaimable ('plan.claimable').
//  · cron:   runPlanWatchdog (/v1/internal/plan-watchdog, cada 5 min).
//  · espejo de Linear: applyIssueTransition (issue completado/cancelado → plan hecho/cancelado).
export {
  enqueuePlan,
  notifyPlanClaimable,
  runPlanWatchdog,
  applyIssueTransition,
  listPlans,
  getPlanDetail,
  approvePlan,
  requestChanges,
  claimPlan,
  pullPlan,
  releasePlan,
  cancelPlan,
  type EnqueueResult,
  type WatchdogResult,
} from './service.js';
export { assertPlansEnabled, LINEAR_SOT_OFF_CODE } from './store.js';
