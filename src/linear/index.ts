// Módulo Linear de roz v2 (Linear como fuente de verdad). Los demás módulos SOLO importan de aquí;
// el contrato está en docs/roz-v2-contracts.md §a.
export { linearSourceOfTruth, assertTasksWritable, TASKS_READ_ONLY_CODE } from './enabled.js';
export {
  createIssueFromTicket,
  commentOnIssue,
  reassignIssue,
  reassignFromEvent,
  issueDescription,
  type CreateIssueFromTicketInput,
  type CreatedIssue,
} from './issues.js';
export {
  upsertMirrorFromLinear,
  retireMirror,
  recordLinearReassignment,
  transitionLivePlan,
  type MirrorResult,
  type MirrorOptions,
  type MirrorSource,
} from './mirror.js';
export {
  linearUserForDev,
  devForLinearUser,
  teamForProject,
  projectForLinear,
  labelForSolutionType,
  solutionTypeForLabels,
  stateForStatus,
  syncLinearLinks,
} from './links.js';
export { reconcileLinear, reconcileFromEvent, scheduleLinearReconcile } from './reconcile.js';
export { handleLinearWebhook, linearWebhookFromEvent, toWebhookPayload } from './webhook.js';
export { findWorkItemIdByIdentifier, currentIdentifier, resolveReference } from './legacy.js';
export { emitV2 } from './emit.js';
