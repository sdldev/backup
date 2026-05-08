# Dark Navy + Cyan Palette Implementation Plan

Goal: polish dashboard colors into a cohesive dark-first navy UI with controlled cyan accents, while keeping light mode clean and neutral.

Scope:
- `packages/web/src/styles/globals.css`
- `packages/web/src/components/dashboard/DashboardFrame.tsx`
- Existing shadcn-style tokens and Tailwind classes only.
- Verify with `bun --filter @backup-saas/web typecheck` and Playwright screenshots for light/dark desktop + mobile.

## Task 1: Normalize global dark palette tokens
<!-- tdd: trivial -->
<!-- checkpoint: none -->

Modify `packages/web/src/styles/globals.css` dark token block.

Set dark mode to a coherent Navy + Cyan palette:

```css
.dark {
  --background: 222 47% 6%;
  --foreground: 210 40% 96%;
  --card: 222 44% 8%;
  --card-foreground: 210 40% 96%;
  --popover: 222 44% 8%;
  --popover-foreground: 210 40% 96%;
  --primary: 199 89% 48%;
  --primary-foreground: 222 47% 6%;
  --secondary: 220 32% 12%;
  --secondary-foreground: 210 35% 92%;
  --muted: 220 30% 13%;
  --muted-foreground: 215 18% 66%;
  --accent: 220 34% 12%;
  --accent-foreground: 199 95% 76%;
  --destructive: 0 62.8% 30.6%;
  --destructive-foreground: 210 40% 98%;
  --border: 218 28% 18%;
  --input: 218 28% 18%;
  --ring: 199 89% 48%;
  --dashboard-surface-dark: 222 47% 6%;
  --dashboard-surface-dot: 215 20% 65% / 0.16;
  --dashboard-surface-glow: 199 89% 48% / 0.12;
}
```

Also ensure sidebar tokens exist in `.dark` if currently missing:

```css
.dark {
  --sidebar: 224 48% 7%;
  --sidebar-foreground: 214 32% 88%;
  --sidebar-primary: 199 89% 48%;
  --sidebar-primary-foreground: 222 47% 6%;
  --sidebar-accent: 220 36% 12%;
  --sidebar-accent-foreground: 199 95% 76%;
  --sidebar-border: 218 28% 17%;
  --sidebar-ring: 199 89% 48%;
}
```

Validation:

```bash
bun --filter @backup-saas/web typecheck
```

Expected:
- 0 errors.

Commit:

```bash
git add packages/web/src/styles/globals.css
git commit -m "style(web): align dark palette with navy cyan"
```

## Task 2: Tune dashboard surface and hero colors
<!-- tdd: trivial -->
<!-- checkpoint: none -->

Modify `packages/web/src/styles/globals.css` dashboard surface and hero tokens/classes.

Target behavior:
- Dark page background remains deep navy.
- Content dot/glow is subtle cyan, not bright blue.
- Hero gradient feels part of same palette.
- Light sidebar stays plain without dot.
- Dark sidebar keeps subtle dot/glow.

Use these hero token values in `:root` or `.dark` as appropriate:

```css
--dashboard-hero-from: 224 54% 10%;
--dashboard-hero-mid: 214 54% 18%;
--dashboard-hero-to: 199 64% 28%;
--dashboard-hero-accent: 199 89% 48% / 0.16;
--dashboard-hero-pattern: 199 95% 76% / 0.18;
```

Keep light sidebar:

```css
.dashboard-sidebar-surface:not(#x) {
  min-height: 100vh;
  background-color: hsl(var(--sidebar));
}
```

Keep dark sidebar:

```css
.dark .dashboard-sidebar-surface:not(#x) {
  background-color: hsl(var(--dashboard-surface-dark));
  background-image:
    radial-gradient(circle at 1px 1px, rgb(148 163 184 / 0.12) 1px, transparent 0),
    radial-gradient(circle at top left, hsl(var(--dashboard-surface-glow)), transparent 340px) !important;
}
```

Validation:

```bash
bun --filter @backup-saas/web typecheck
```

Playwright verify:
- Open `/app` with dev cookie.
- Capture dark screenshot.
- Confirm no harsh blue/glow.
- Confirm light sidebar has no dot background.

Commit:

```bash
git add packages/web/src/styles/globals.css
git commit -m "style(web): tune dashboard surface colors"
```

## Task 3: Refine sidebar nav active and hover states
<!-- tdd: trivial -->
<!-- checkpoint: none -->

Modify `packages/web/src/components/dashboard/DashboardFrame.tsx` sidebar nav item classes.

Replace current active state that uses full sidebar accent/ring with a calmer active indicator:

```tsx
className="relative h-9 rounded-lg px-2.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-primary/10 data-[active=true]:text-sidebar-accent-foreground data-[active=true]:before:absolute data-[active=true]:before:left-0 data-[active=true]:before:top-2 data-[active=true]:before:h-5 data-[active=true]:before:w-0.5 data-[active=true]:before:rounded-full data-[active=true]:before:bg-primary group-data-[collapsible=icon]:!size-9 group-data-[collapsible=icon]:!p-0"
```

Icon span should use:

```tsx
className="grid size-4 shrink-0 place-items-center text-sidebar-foreground/45 group-data-[active=true]/menu-button:text-primary [&>svg]:size-4"
```

Label span should remain:

```tsx
className="truncate text-[13px] font-medium group-data-[collapsible=icon]:hidden"
```

Validation:

```bash
bun --filter @backup-saas/web typecheck
```

Playwright verify:
- Active nav visible but not blocky.
- Hover reads cyan/slate, not generic gray.
- Collapsed icon state still centered.

Commit:

```bash
git add packages/web/src/components/dashboard/DashboardFrame.tsx
git commit -m "style(web): refine sidebar active states"
```

## Task 4: Refine header controls and avatar button feel
<!-- tdd: trivial -->
<!-- checkpoint: none -->

Modify `packages/web/src/components/dashboard/DashboardFrame.tsx` header controls.

Goal:
- Header ghost buttons feel part of navy palette.
- Hover is subtle dark slate in dark mode, neutral in light mode.
- Notification dot uses primary/cyan instead of destructive red unless there is a real error.

Change notification dot:

```tsx
<span className="absolute right-2 top-2 size-2 rounded-full bg-primary shadow-[0_0_0_2px_hsl(var(--background))]" aria-hidden="true" />
```

Optionally add shared class to header icon buttons:

```tsx
className="text-muted-foreground hover:bg-accent hover:text-accent-foreground"
```

For user avatar button:

```tsx
className="rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
```

Validation:

```bash
bun --filter @backup-saas/web typecheck
```

Playwright verify:
- Header controls hover visible in dark.
- Notification dot no longer red-alert unless intended.
- Avatar remains accessible.

Commit:

```bash
git add packages/web/src/components/dashboard/DashboardFrame.tsx
git commit -m "style(web): align header controls with palette"
```

## Task 5: Verify light/dark/mobile visual balance
<!-- tdd: trivial -->
<!-- checkpoint: done -->

Run final validation:

```bash
bun --filter @backup-saas/web typecheck
```

Use Playwright:
1. Desktop light `/app`
2. Desktop dark `/app`
3. Mobile light `/app` at `390x844`
4. Mobile dark `/app` at `390x844`

Expected:
- Light: clean neutral sidebar, no dot background.
- Dark: navy/cyan cohesive, sidebar/content balanced.
- Mobile: sidebar default closed/minimized.
- Header and sidebar row boundaries align.
- Version text hidden on mobile and collapsed sidebar.

Artifacts:
- Save screenshots under `/tmp/pi-playwright/backup/`.

Commit if any final polish needed:

```bash
git add packages/web/src/styles/globals.css packages/web/src/components/dashboard/DashboardFrame.tsx packages/web/src/components/ui/sidebar.tsx
git commit -m "style(web): polish dashboard palette"
```

Ready to execute? Run `/skill:executing-tasks`.
