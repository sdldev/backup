export const WORKSPACE_ROLES = ['owner', 'admin', 'member'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const SUPPORTED_ENGINES = ['mysql', 'postgresql'] as const;
export type SupportedEngine = (typeof SUPPORTED_ENGINES)[number];

export const BACKUP_JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type BackupJobStatus = (typeof BACKUP_JOB_STATUSES)[number];

export const BACKUP_JOB_STAGES = [
  'queued',
  'connected',
  'dumping',
  'compressing',
  'encrypting',
  'uploading',
  'verifying',
  'succeeded',
  'failed',
] as const;
export type BackupJobStage = (typeof BACKUP_JOB_STAGES)[number];

export const RESERVED_WORKSPACE_SLUGS = new Set([
  'admin',
  'api',
  'auth',
  'login',
  'logout',
  'settings',
  'system',
  'health',
  'status',
  'support',
  'billing',
  'invite',
  'download',
  'downloads',
  'workspace',
  'workspaces',
  'v1',
]);
