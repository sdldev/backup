# Desktop dashboard style implementation

Goal: make all `DashboardShell` pages follow desktop style from reference PNGs while leaving PNG files untouched/untracked. `/app` gets full reference layout with mock/sample content when workspace data is empty. Existing workspace/project/settings pages inherit new shell/sidebar/header/card rhythm without large domain rewrites.

## Task 1: Apply global dashboard shell frame

<!-- tdd: trivial -->
<!-- checkpoint: done -->

Modify:
- `packages/web/src/components/DashboardShell.astro`
- `packages/web/src/components/dashboard/DashboardHeader.astro`
- `packages/web/src/components/dashboard/AppSidebar.astro`

Changes:
- Keep existing props and slots unchanged: `brandLabel`, `brandName`, `navItems`, `sidebarNote`, default slot.
- `DashboardShell.astro`:
  - desktop grid: fixed `260px` sidebar + fluid content.
  - page background uses subtle dotted/grid texture matching reference.
  - main width remains `max-w-7xl`, padding tuned to `p-4 md:p-6`.
  - no `rightRail` slot yet; keep shell backwards compatible.
- `DashboardHeader.astro`:
  - add left title area (`Dashboard` fallback) and right controls.
  - keep `ThemeToggle client:load`.
  - add simple settings/bell/user icon buttons using text/svg or lucide-compatible markup; avoid new dependencies.
- `AppSidebar.astro`:
  - permanent dark sidebar in light and dark themes.
  - compact nav rows with subtle active state like screenshot.
  - brand block with small geometric mark using CSS only.
  - note and logout stay at bottom.

Verification:
```bash
bun --filter @backup-saas/web typecheck
```
Expected: Astro check passes.

Commit:
```bash
git add packages/web/src/components/DashboardShell.astro packages/web/src/components/dashboard/DashboardHeader.astro packages/web/src/components/dashboard/AppSidebar.astro
git commit -m "style(web): update dashboard shell frame"
```

## Task 2: Restyle reusable dashboard primitives

<!-- tdd: trivial -->
<!-- checkpoint: none -->

Modify:
- `packages/web/src/components/dashboard/StatCard.astro`
- `packages/web/src/components/dashboard/PageHeader.astro`
- optional: `packages/web/src/styles/globals.css`

Changes:
- `StatCard.astro`:
  - card matches reference: rounded-xl, subtle border, soft shadow, compact label/value rhythm.
  - support optional description/icon via existing slot only; do not change props.
- `PageHeader.astro`:
  - make header less marketing-like, more app-like: compact eyebrow/title/description/actions.
  - spacing compatible with all existing pages.
- `globals.css` only if needed:
  - add tiny dashboard texture utility or body font tweak.
  - no broad destructive theme changes.

Verification:
```bash
bun --filter @backup-saas/web typecheck
```
Expected: Astro check passes.

Commit:
```bash
git add packages/web/src/components/dashboard/StatCard.astro packages/web/src/components/dashboard/PageHeader.astro packages/web/src/styles/globals.css
git commit -m "style(web): polish dashboard primitives"
```

## Task 3: Rebuild `/app` as reference-style dashboard

<!-- tdd: modifying-tested-code -->
<!-- checkpoint: done -->

Modify:
- `packages/web/src/pages/app.astro`

Changes:
- Preserve API fetch and auth redirects exactly.
- Derive display records:
  - if `payload.data.length > 0`, use real workspaces.
  - if empty, use mock/sample workspace/activity data with visible `Sample`/`Demo` label.
- Replace current page body with:
  - hero panel: `Welcome back, superadmin` or neutral current user fallback if no user available.
  - summary stat row: total workspaces, storage ready, active scope/manual backups.
  - recent activity/workspace timeline from real data or sample data.
  - desktop right rail inside page grid: April 2026 static calendar + upcoming events, matching PNG structure.
- Keep action links valid: create workspace, open workspace when real; sample rows should not link to fake workspace or should link to `/app/new-workspace` clearly.
- No PNG asset usage; recreate style in CSS/Tailwind.

Verification:
```bash
bun --filter @backup-saas/web typecheck
```
Expected: Astro check passes.

Manual visual check:
```bash
bun --filter @backup-saas/web dev
```
Open `/app` desktop width. Confirm layout resembles reference: dark sidebar, topbar, hero, cards, activity, right calendar. Confirm empty data still shows sample content labelled sample/demo.

Commit:
```bash
git add packages/web/src/pages/app.astro
git commit -m "style(web): rebuild app dashboard layout"
```

## Task 4: Align workspace dashboard page with new desktop rhythm

<!-- tdd: modifying-tested-code -->
<!-- checkpoint: none -->

Modify:
- `packages/web/src/pages/workspace/[workspaceSlug]/index.astro`

Changes:
- Keep API fetch, redirects, navItems unchanged.
- Retain domain actions: switch workspace, manage projects, onboarding/projects/backups/audit links.
- Restyle body to fit reference:
  - optional hero/welcome card using workspace name.
  - stat cards in compact horizontal row.
  - operations panel + next actions as large card + side card.
- If operational data absent, use sample placeholders labelled `Sample`/`Coming soon`, not fake real metrics.

Verification:
```bash
bun --filter @backup-saas/web typecheck
```
Expected: Astro check passes.

Commit:
```bash
git add 'packages/web/src/pages/workspace/[workspaceSlug]/index.astro'
git commit -m "style(web): align workspace dashboard"
```

## Task 5: Smoke-check all DashboardShell pages

<!-- tdd: trivial -->
<!-- checkpoint: done -->

Inspect pages using `DashboardShell`:
- `packages/web/src/pages/app/new-workspace.astro`
- `packages/web/src/pages/workspace/[workspaceSlug]/onboarding.astro`
- `packages/web/src/pages/workspace/[workspaceSlug]/projects.astro`
- `packages/web/src/pages/workspace/[workspaceSlug]/projects/[projectId].astro`
- `packages/web/src/pages/workspace/[workspaceSlug]/backups.astro`
- `packages/web/src/pages/workspace/[workspaceSlug]/backups/[backupId].astro`
- `packages/web/src/pages/workspace/[workspaceSlug]/backup-jobs/[jobId].astro`
- `packages/web/src/pages/workspace/[workspaceSlug]/settings/audit-log.astro`
- `packages/web/src/pages/workspace/[workspaceSlug]/settings/members.astro`

Changes:
- Only adjust page-level spacing/classes if new shell causes obvious cramped or broken layout.
- Do not rewrite domain functionality.
- Ensure all pages still render inside dark sidebar/topbar frame.

Verification:
```bash
bun --filter @backup-saas/web typecheck
bun run format:check
```
Expected: typecheck and prettier check pass, or document any pre-existing format noise before touching.

Commit:
```bash
git add packages/web/src/pages packages/web/src/components/dashboard packages/web/src/components/DashboardShell.astro packages/web/src/styles/globals.css
git commit -m "style(web): smoke fix dashboard pages"
```

## Final verification

Run:
```bash
git status --short
bun --filter @backup-saas/web typecheck
```

Expected:
- Source changes committed.
- PNG files remain untracked and untouched.
- `git status --short` may still show original untracked PNG files and `.cursor/` only.
