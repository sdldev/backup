import { describe, expect, test } from 'bun:test';
import { buildWorkspaceSlugCandidate, slugifyWorkspaceName, validateWorkspaceSlug } from './workspace-slug';

describe('Workspace slug helpers', () => {
  test('slugifies Workspace names', () => {
    expect(slugifyWorkspaceName('My Agency, Inc.')).toBe('my-agency-inc');
    expect(slugifyWorkspaceName('  Café Backup  ')).toBe('cafe-backup');
    expect(slugifyWorkspaceName('!!!')).toBe('workspace');
  });

  test('validates allowed slug format', () => {
    expect(validateWorkspaceSlug('agency-123')).toEqual({ valid: true, slug: 'agency-123' });
    expect(validateWorkspaceSlug('Agency-123')).toEqual({ valid: true, slug: 'agency-123' });
  });

  test('rejects empty, too short, too long, and invalid characters', () => {
    expect(validateWorkspaceSlug('')).toMatchObject({ valid: false, code: 'SLUG_REQUIRED' });
    expect(validateWorkspaceSlug('ab')).toMatchObject({ valid: false, code: 'SLUG_INVALID_FORMAT' });
    expect(validateWorkspaceSlug('a'.repeat(49))).toMatchObject({ valid: false, code: 'SLUG_INVALID_FORMAT' });
    expect(validateWorkspaceSlug('agency_team')).toMatchObject({ valid: false, code: 'SLUG_INVALID_FORMAT' });
  });

  test('rejects reserved slugs', () => {
    expect(validateWorkspaceSlug('admin')).toMatchObject({ valid: false, code: 'SLUG_RESERVED' });
    expect(validateWorkspaceSlug('v1')).toMatchObject({ valid: false, code: 'SLUG_INVALID_FORMAT' });
    expect(validateWorkspaceSlug('login')).toMatchObject({ valid: false, code: 'SLUG_RESERVED' });
  });

  test('builds deduped candidates', () => {
    expect(buildWorkspaceSlugCandidate('My Agency', new Set())).toBe('my-agency');
    expect(buildWorkspaceSlugCandidate('My Agency', new Set(['my-agency']))).toBe('my-agency-2');
    expect(buildWorkspaceSlugCandidate('Workspace', new Set(['workspace']))).toBe('workspace-2');
    expect(buildWorkspaceSlugCandidate('Admin', new Set(['workspace']))).toBe('workspace-2');
  });

  test('keeps candidate within 48 characters when adding suffix', () => {
    const name = 'a'.repeat(60);
    const slug = buildWorkspaceSlugCandidate(name, new Set(['a'.repeat(48)]));
    expect(slug).toHaveLength(48);
    expect(slug.endsWith('-2')).toBe(true);
  });
});
