// A one-way, process-local inhibition, never an environment or readiness bypass.
// Direct npm startup leaves this unset and keeps the original module validation.
const startupBlockCodes = new Set([
  'ACTIVITY_ENABLED_INVALID',
  'ACTIVITY_VOLUME_SCOPE_INVALID', 'ACTIVITY_VOLUME_JOURNAL_PATH_INVALID', 'ACTIVITY_VOLUME_MOUNT_PATH_INVALID',
  'ACTIVITY_VOLUME_NOT_MOUNTED', 'ACTIVITY_VOLUME_READ_ONLY', 'ACTIVITY_VOLUME_NOT_PERSISTENT', 'ACTIVITY_VOLUME_NESTED_MOUNT',
  'ACTIVITY_VOLUME_PATH_UNSAFE', 'ACTIVITY_VOLUME_OWNER_UNEXPECTED', 'ACTIVITY_VOLUME_MODE_UNSAFE', 'ACTIVITY_VOLUME_TRAVERSAL_DENIED',
  'ACTIVITY_VOLUME_SCOPE_OWNER_INVALID', 'ACTIVITY_VOLUME_SCOPE_MODE_INVALID', 'ACTIVITY_VOLUME_SCOPE_NOT_DEDICATED', 'ACTIVITY_VOLUME_SCOPE_CHANGED',
  'ACTIVITY_VOLUME_JOURNAL_UNSAFE', 'ACTIVITY_VOLUME_JOURNAL_OWNER_MODE_INVALID', 'ACTIVITY_VOLUME_JOURNAL_CHANGED',
  'ACTIVITY_VOLUME_WRITE_FAILED', 'ACTIVITY_VOLUME_READBACK_FAILED', 'ACTIVITY_VOLUME_PROBE_CHANGED', 'ACTIVITY_VOLUME_IO_FAILED',
]);
export const isActivityStartupBlockCode = code => startupBlockCodes.has(code);
const directStartup = Object.freeze({ activityUnavailable: null });
let context;
export function initializeActivityStartup({ activityUnavailable = null } = {}) {
  if (context || (activityUnavailable !== null && !isActivityStartupBlockCode(activityUnavailable))) {
    throw Object.assign(Error('ACTIVITY_STARTUP_CONTEXT_INVALID'), { code: 'ACTIVITY_STARTUP_CONTEXT_INVALID' });
  }
  context = Object.freeze({ activityUnavailable });
  return context;
}
export const activityStartupContext = () => context ?? directStartup;
