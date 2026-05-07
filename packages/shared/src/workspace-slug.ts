import { RESERVED_WORKSPACE_SLUGS } from './domain';

export type WorkspaceSlugValidationResult =
  | { valid: true; slug: string }
  | { valid: false; code: 'SLUG_REQUIRED' | 'SLUG_INVALID_FORMAT' | 'SLUG_RESERVED'; message: string };

export function normalizeWorkspaceSlug(input: string): string {
  return input.trim().toLowerCase();
}

export function slugifyWorkspaceName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return slug || 'workspace';
}

export function validateWorkspaceSlug(input: string): WorkspaceSlugValidationResult {
  const slug = normalizeWorkspaceSlug(input);

  if (!slug) {
    return { valid: false, code: 'SLUG_REQUIRED', message: 'Workspace slug is required' };
  }

  if (!/^[a-z0-9-]{3,48}$/.test(slug)) {
    return {
      valid: false,
      code: 'SLUG_INVALID_FORMAT',
      message: 'Workspace slug must be 3-48 lowercase letters, numbers, or hyphens',
    };
  }

  if (RESERVED_WORKSPACE_SLUGS.has(slug)) {
    return { valid: false, code: 'SLUG_RESERVED', message: 'Workspace slug is reserved' };
  }

  return { valid: true, slug };
}

export function buildWorkspaceSlugCandidate(name: string, usedSlugs: ReadonlySet<string>): string {
  const baseSlug = slugifyWorkspaceName(name).slice(0, 48).replace(/-+$/g, '') || 'workspace';

  const baseValidation = validateWorkspaceSlug(baseSlug);
  const safeBase = baseValidation.valid ? baseValidation.slug : 'workspace';

  if (!usedSlugs.has(safeBase)) {
    return safeBase;
  }

  for (let suffix = 2; suffix <= 9999; suffix += 1) {
    const suffixText = `-${suffix}`;
    const candidate = `${safeBase.slice(0, 48 - suffixText.length).replace(/-+$/g, '')}${suffixText}`;
    if (!usedSlugs.has(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to generate available Workspace slug');
}
