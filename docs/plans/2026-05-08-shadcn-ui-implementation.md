# shadcn UI Implementation Plan

Goal: migrate `packages/web` from custom Astro CSS to Astro + React islands + Tailwind + shadcn UI, with modern dense admin dashboard, light/dark theme toggle, and table wrappers that can later swap to TanStack Table.

Scope: frontend only. No backend/API behavior changes.

Note: repo path was not a git repository during planning, so commit steps are written for normal execution in a git checkout. If execution happens in same non-git directory, replace commit steps with manual checkpoint notes.

## Task 1: Add React, Tailwind, and shadcn foundation

<!-- tdd: trivial -->
<!-- checkpoint: done -->

Create/modify:
- `packages/web/package.json`
- `packages/web/astro.config.mjs`
- `packages/web/tailwind.config.ts`
- `packages/web/postcss.config.mjs`
- `packages/web/components.json`
- `packages/web/src/styles/globals.css`
- `packages/web/src/lib/utils.ts`

Implementation:
- Add dependencies: `@astrojs/react`, `@astrojs/tailwind`, `react`, `react-dom`, `tailwindcss`, `postcss`, `autoprefixer`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`.
- Configure Astro integrations: `react()` and `tailwind({ applyBaseStyles: false })`.
- Add shadcn-compatible Tailwind tokens using CSS variables in `globals.css`.
- Add `cn(...inputs)` helper using `clsx` + `tailwind-merge`.
- Keep `dashboard.css` in place for compatibility during migration.

Verify:
```bash
bun install
bun --filter @backup-saas/web typecheck
bun --filter @backup-saas/web build
```
Expected: both commands pass.

Commit:
```bash
git add packages/web/package.json packages/web/astro.config.mjs packages/web/tailwind.config.ts packages/web/postcss.config.mjs packages/web/components.json packages/web/src/styles/globals.css packages/web/src/lib/utils.ts bun.lock
git commit -m "feat(web): add shadcn foundation"
```

## Task 2: Add base shadcn primitives and theme toggle

<!-- tdd: new-feature -->
<!-- checkpoint: done -->

Create/modify:
- `packages/web/src/components/ui/button.tsx`
- `packages/web/src/components/ui/card.tsx`
- `packages/web/src/components/ui/badge.tsx`
- `packages/web/src/components/ui/input.tsx`
- `packages/web/src/components/ui/label.tsx`
- `packages/web/src/components/ui/select.tsx`
- `packages/web/src/components/ui/table.tsx`
- `packages/web/src/components/ui/dropdown-menu.tsx`
- `packages/web/src/components/theme/ThemeToggle.tsx`
- `packages/web/src/layouts/BaseLayout.astro`

Implementation:
- Add shadcn-style components copied/adapted locally, no external generated code required at runtime.
- Add `BaseLayout.astro` importing `../styles/globals.css`.
- Add inline theme boot script before body paint:
  - use `localStorage.theme` when set
  - otherwise use `prefers-color-scheme: dark`
  - toggle `document.documentElement.classList.toggle('dark', isDark)`
- Add `ThemeToggle` React island using localStorage and `class="dark"`.

Verify:
```bash
bun --filter @backup-saas/web typecheck
bun --filter @backup-saas/web build
```
Expected: layout compiles; theme component hydrates without SSR error.

Commit:
```bash
git add packages/web/src/components/ui packages/web/src/components/theme packages/web/src/layouts/BaseLayout.astro
git commit -m "feat(web): add shadcn primitives and theme toggle"
```

## Task 3: Migrate marketing and auth pages to BaseLayout + shadcn styling

<!-- tdd: modifying-tested-code -->
<!-- checkpoint: none -->

Modify:
- `packages/web/src/pages/index.astro`
- `packages/web/src/pages/login.astro`
- `packages/web/src/pages/invite/[token].astro`

Implementation:
- Replace direct `<html>`, `<head>`, `<body>` shell with `BaseLayout`.
- Replace `.button`, `.card`, `.auth-card`, `.hero-card`, `.marketing-*` usage with Tailwind + shadcn `Button`, `Card`, `Badge` where useful.
- Keep copy/domain terms exact: Workspace, Project, Database Source, Backup Job, Audit Log.
- Add `ThemeToggle` in marketing/auth top-right.
- Do not change API calls or redirects.

Verify:
```bash
bun --filter @backup-saas/web typecheck
bun --filter @backup-saas/web build
```
Expected: pages render and routes unchanged: `/`, `/login`, `/invite/[token]`.

Commit:
```bash
git add packages/web/src/pages/index.astro packages/web/src/pages/login.astro packages/web/src/pages/invite/[token].astro
git commit -m "feat(web): migrate public pages to shadcn"
```

## Task 4: Replace DashboardShell with modern responsive app shell

<!-- tdd: modifying-tested-code -->
<!-- checkpoint: done -->

Modify/create:
- `packages/web/src/components/DashboardShell.astro`
- `packages/web/src/components/dashboard/AppSidebar.astro`
- `packages/web/src/components/dashboard/DashboardHeader.astro`

Implementation:
- Keep existing `DashboardShell` props: `brandLabel`, `brandName`, `navItems`, `sidebarNote`.
- Move sidebar markup into `AppSidebar.astro`.
- Add modern admin shell layout:
  - sticky sidebar on desktop
  - compact top header area
  - responsive mobile stacked navigation
  - active nav state using `data-active`/Tailwind variants
  - `ThemeToggle` in shell
- Preserve logout script behavior using `API_BASE_URL` and `data-logout`.
- Replace `dashboard.css` dependency for shell with Tailwind classes.

Verify:
```bash
bun --filter @backup-saas/web typecheck
bun --filter @backup-saas/web build
```
Expected: all dashboard pages compile without changing page imports.

Commit:
```bash
git add packages/web/src/components/DashboardShell.astro packages/web/src/components/dashboard
git commit -m "feat(web): modernize dashboard shell"
```

## Task 5: Add dashboard composition components for stats, actions, empty states, and forms

<!-- tdd: new-feature -->
<!-- checkpoint: none -->

Create:
- `packages/web/src/components/dashboard/PageHeader.astro`
- `packages/web/src/components/dashboard/StatCard.astro`
- `packages/web/src/components/dashboard/ActionGroup.astro`
- `packages/web/src/components/dashboard/EmptyState.astro`
- `packages/web/src/components/dashboard/FormSection.astro`
- `packages/web/src/components/dashboard/StatusBadge.astro`

Implementation:
- `PageHeader`: eyebrow, title, description, action slot.
- `StatCard`: label, value, optional badge slot.
- `ActionGroup`: flex wrapper for buttons/links.
- `EmptyState`: title, description, action slot.
- `FormSection`: card wrapper with title/description/form slot.
- `StatusBadge`: map known statuses to variants:
  - success: `ready`, `succeeded`
  - warning: `failed`, `needs_action`, non-ready storage
  - muted/default: other statuses
- Use shadcn classes/tokens only.

Verify:
```bash
bun --filter @backup-saas/web typecheck
bun --filter @backup-saas/web build
```
Expected: new components compile.

Commit:
```bash
git add packages/web/src/components/dashboard/PageHeader.astro packages/web/src/components/dashboard/StatCard.astro packages/web/src/components/dashboard/ActionGroup.astro packages/web/src/components/dashboard/EmptyState.astro packages/web/src/components/dashboard/FormSection.astro packages/web/src/components/dashboard/StatusBadge.astro
git commit -m "feat(web): add dashboard UI building blocks"
```

## Task 6: Migrate workspace list and workspace creation flows

<!-- tdd: modifying-tested-code -->
<!-- checkpoint: none -->

Modify:
- `packages/web/src/pages/app.astro`
- `packages/web/src/pages/app/new-workspace.astro`

Implementation:
- Use `BaseLayout` + `DashboardShell` as appropriate.
- Replace old `.topbar`, `.grid`, `.card`, `.button`, `.form-grid` with new dashboard components and shadcn primitives.
- Keep create Workspace form fields, IDs, names, and submit behavior unchanged.
- Improve empty workspace state with `EmptyState`.
- Add dense modern layout; avoid decorative gradients/glows.

Verify:
```bash
bun --filter @backup-saas/web typecheck
bun --filter @backup-saas/web build
```
Expected: `/app` and `/app/new-workspace` compile; form selectors still match scripts.

Commit:
```bash
git add packages/web/src/pages/app.astro packages/web/src/pages/app/new-workspace.astro
git commit -m "feat(web): migrate workspace entry flows"
```

## Task 7: Migrate workspace dashboard and onboarding pages

<!-- tdd: modifying-tested-code -->
<!-- checkpoint: none -->

Modify:
- `packages/web/src/pages/workspace/[workspaceSlug]/index.astro`
- `packages/web/src/pages/workspace/[workspaceSlug]/onboarding.astro`

Implementation:
- Use `PageHeader`, `StatCard`, `StatusBadge`, `ActionGroup`, `Card`.
- Keep nav item hrefs unchanged.
- Preserve storage provisioning retry script selector `#retry-storage`.
- Show onboarding checklist in compact cards/list with clear completed vs pending states.
- Keep all API fetch/redirect/error logic unchanged.

Verify:
```bash
bun --filter @backup-saas/web typecheck
bun --filter @backup-saas/web build
```
Expected: workspace dashboard and onboarding compile; retry button remains addressable.

Commit:
```bash
git add packages/web/src/pages/workspace/[workspaceSlug]/index.astro packages/web/src/pages/workspace/[workspaceSlug]/onboarding.astro
git commit -m "feat(web): migrate workspace overview UI"
```

## Task 8: Add hybrid data table wrapper and migrate Projects views

<!-- tdd: new-feature -->
<!-- checkpoint: done -->

Create/modify:
- `packages/web/src/components/dashboard/DataTable.astro`
- `packages/web/src/pages/workspace/[workspaceSlug]/projects.astro`
- `packages/web/src/pages/workspace/[workspaceSlug]/projects/[projectId].astro`

Implementation:
- `DataTable.astro` wraps shadcn `Table` markup with slots:
  - `caption?`
  - `head`
  - default body rows
  - `empty?`
- Keep component API simple so future TanStack replacement can keep page-level columns/rows concept.
- Migrate project list and database source list from `.list-item` cards to dense table-like layout where appropriate.
- Preserve form IDs/scripts:
  - `#project-form`
  - database source form IDs/buttons/scripts in project detail page
  - run backup button selectors
- Keep API logic unchanged.

Verify:
```bash
bun --filter @backup-saas/web typecheck
bun --filter @backup-saas/web build
```
Expected: Projects pages compile; scripts still find same IDs.

Commit:
```bash
git add packages/web/src/components/dashboard/DataTable.astro packages/web/src/pages/workspace/[workspaceSlug]/projects.astro packages/web/src/pages/workspace/[workspaceSlug]/projects/[projectId].astro
git commit -m "feat(web): migrate projects to shadcn tables"
```

## Task 9: Migrate Backups and Backup Job views

<!-- tdd: modifying-tested-code -->
<!-- checkpoint: none -->

Modify:
- `packages/web/src/pages/workspace/[workspaceSlug]/backups.astro`
- `packages/web/src/pages/workspace/[workspaceSlug]/backups/[backupId].astro`
- `packages/web/src/pages/workspace/[workspaceSlug]/backup-jobs/[jobId].astro`

Implementation:
- Replace summary cards with `StatCard`.
- Replace backup list with `DataTable`.
- Use `StatusBadge` for Backup and Backup Job statuses/stages.
- Preserve button IDs/scripts:
  - `#download-backup`
  - `#delete-backup`
  - `#cancel-job`
- Keep metadata block readable in dark/light modes using token-based code block styling.
- Keep destructive action visual distinct but do not alter API calls.

Verify:
```bash
bun --filter @backup-saas/web typecheck
bun --filter @backup-saas/web build
```
Expected: Backup pages compile; action selectors unchanged.

Commit:
```bash
git add packages/web/src/pages/workspace/[workspaceSlug]/backups.astro packages/web/src/pages/workspace/[workspaceSlug]/backups/[backupId].astro packages/web/src/pages/workspace/[workspaceSlug]/backup-jobs/[jobId].astro
git commit -m "feat(web): migrate backup operations UI"
```

## Task 10: Migrate members and audit log admin views

<!-- tdd: modifying-tested-code -->
<!-- checkpoint: none -->

Modify:
- `packages/web/src/pages/workspace/[workspaceSlug]/settings/members.astro`
- `packages/web/src/pages/workspace/[workspaceSlug]/settings/audit-log.astro`

Implementation:
- Use `PageHeader`, `StatCard`, `DataTable`, `Card`, `Badge`.
- Preserve invite form field names and submit behavior.
- Preserve generated invite link display.
- Migrate audit log to dense table/list hybrid with actor/action/time columns.
- Keep role/status badges consistent with `StatusBadge` where possible.

Verify:
```bash
bun --filter @backup-saas/web typecheck
bun --filter @backup-saas/web build
```
Expected: settings pages compile; invite form behavior unchanged.

Commit:
```bash
git add packages/web/src/pages/workspace/[workspaceSlug]/settings/members.astro packages/web/src/pages/workspace/[workspaceSlug]/settings/audit-log.astro
git commit -m "feat(web): migrate admin settings views"
```

## Task 11: Remove legacy dashboard CSS dependency

<!-- tdd: modifying-tested-code -->
<!-- checkpoint: done -->

Modify/delete:
- all `packages/web/src/pages/**/*.astro`
- `packages/web/src/components/**/*.astro`
- `packages/web/src/styles/dashboard.css`

Implementation:
- Remove remaining `<link rel="stylesheet" href="/src/styles/dashboard.css" />` references.
- Replace any remaining legacy classes:
  - `button`
  - `card`
  - `grid--stats`
  - `grid--two`
  - `list-item`
  - `form-grid`
  - `badge--ok`
  - `badge--warn`
  - `topbar`
- Delete `dashboard.css` after no references remain.

Verify:
```bash
grep -R "dashboard.css\|grid--\|form-grid\|badge--\|topbar\|list-item" -n packages/web/src || true
bun --filter @backup-saas/web typecheck
bun --filter @backup-saas/web build
```
Expected: grep returns no legacy references except intentional text if any; typecheck/build pass.

Commit:
```bash
git add packages/web/src
git rm packages/web/src/styles/dashboard.css
git commit -m "refactor(web): remove legacy dashboard css"
```

## Task 12: Final visual and accessibility pass

<!-- tdd: modifying-tested-code -->
<!-- checkpoint: done -->

Modify:
- `packages/web/src/styles/globals.css`
- any migrated page/component needing polish

Implementation:
- Check color contrast in light/dark tokens.
- Ensure focus rings visible on buttons, links, inputs, selects.
- Ensure disabled states visible and non-interactive-looking.
- Ensure semantic structure:
  - one `h1` per page
  - tables have headers
  - nav has accessible label
  - form labels tied to controls where possible
- Keep density modern but not cramped on mobile.
- Do not add decorative glow/gradient filler.

Verify:
```bash
bun --filter @backup-saas/web typecheck
bun --filter @backup-saas/web build
bun run format:check
```
Expected: all pass. If formatting fails, run `bun run format`, then re-run checks.

Commit:
```bash
git add packages/web/src
git commit -m "chore(web): polish shadcn migration"
```
