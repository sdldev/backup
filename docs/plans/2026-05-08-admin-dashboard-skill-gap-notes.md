# Admin Dashboard Skill Gap Notes

Context: recent dashboard polish exposed gaps in the `admin-dashboard` skill. The skill already enforces shadcn/ui composition, semantic tokens, no SEO, and quality checks. These notes capture improvements needed so future dashboard work lands closer to the intended result without repeated correction.

Master skill copy also exists at:

- `/home/indatech/.pi/agent/skills/admin-dashboard/SKILL.md`
- `/home/indatech/Documents/AI/privat-skill/.agents/skills/admin-dashboard/SKILL.md`

## Gap 1: Dashboard shell ergonomics are underspecified

Current skill says use shadcn Sidebar but does not specify practical shell defaults.

Add guidance:

- Sidebar should be professional and compact by default.
- Avoid overly wide sidebars; target `15rem` expanded and ~`3.25rem` icon width unless product needs otherwise.
- Sidebar header height must align with main navbar height.
- Mobile sidebar should default closed/minimized.
- Content area can be full width, but prose/page descriptions need bounded line length (`max-w-3xl` / `max-w-prose`).
- Fixed/sticky navbar layouts need consistent page padding so content does not feel pasted on.

## Gap 2: Dark mode palette needs contrast and harmony rules

Current skill says use semantic tokens, but not how to make dark dashboards feel cohesive.

Add guidance:

- Prefer one dominant base hue for dark dashboards, then one controlled accent hue.
- For technical SaaS dashboards, recommended default: dark navy base + cyan accent.
- Avoid mixing default shadcn blue, gray, and custom navy without token normalization.
- Hover states should be subtle surface shifts, not saturated accent blocks.
- Active sidebar state should usually use a small accent rail + low-opacity background, not a full bright block.
- Primary/accent color should be reserved for CTA, active state, focus ring, and important status markers.

Recommended dark-first token philosophy:

```css
--background: deep navy;
--card: slightly lighter navy;
--popover: card-level navy;
--primary: cyan;
--accent: navy/slate hover wash;
--accent-foreground: cyan-tinted readable text;
--border: low-contrast slate/navy;
```

## Gap 3: Readability rules are too weak

Current skill mentions typography hierarchy, but recent work needed explicit readability checks.

Add guidance:

- Check contrast for dark mode after palette changes.
- Normal text should target at least `4.5:1`; important dashboard text should preferably be `7:1+`.
- Avoid opacity below `/55` for small text in dark mode.
- `text-muted-foreground` is usually better than `text-muted-foreground/60` for labels/descriptions in dark mode.
- Footer/version metadata can be more muted because it is non-critical.
- Full-width dashboard content is fine for grids/tables, but descriptions and prose must stay bounded.

## Gap 4: Background decoration needs mode-specific rules

Current skill does not warn about decorative patterns.

Add guidance:

- Decorative dot/grid patterns should be validated separately in light and dark mode.
- Light mode often works better clean/plain; subtle dots can feel dirty or noisy.
- Dark mode can support subtle dot/glow patterns if opacity is low and palette-aligned.
- Never let decorative backgrounds reduce readability or compete with content.

## Gap 5: Sidebar footer guidance should be stricter

Dashboard layout reference mentions version footer, but not how it should behave.

Add guidance:

- Footer metadata should be compact and quiet, not a card unless it is actionable.
- Example: `Version v0.0.0 · Updated YYYY-MM-DD`.
- Hide footer metadata on mobile and collapsed sidebar.
- Do not duplicate Logout in sidebar footer if account dropdown already contains Logout.

## Gap 6: Header control semantics need defaults

Current skill mentions navbar composition, but not visual treatment.

Add guidance:

- Header icon buttons should use muted foreground by default and accent foreground on hover.
- Notification indicator should not use destructive/red unless it means error/urgent.
- For neutral unread/activity state, use primary/accent color.
- Header controls should visually match sidebar hover/active palette.

## Gap 7: Validation should include visual state matrix

Current quality checks are mostly type/lint/build. Dashboard UI changes need screenshots.

Add guidance:

For dashboard visual work, validate:

1. Desktop light
2. Desktop dark
3. Mobile light
4. Mobile dark
5. Sidebar expanded
6. Sidebar collapsed
7. Mobile sidebar default closed
8. Hover/active nav states

Use Playwright screenshots when available.

## Gap 8: Skill should warn against generic dashboard aesthetic

Current skill says intentional design, but needs sharper anti-pattern list.

Add anti-patterns:

- Overwide sidebar
- Carded metadata/footer when plain text is enough
- Generic blue hover everywhere
- Excessive glow/gradient
- Low-contrast tiny labels in dark mode
- Decorative dots in light mode without clear benefit
- Duplicate Logout actions
- Centered max-width content when dashboard tables need full width
- Full-width prose with long unreadable lines

## Suggested insertion points

1. Add a new section after `## Principles`:
   - `## Dashboard Visual Defaults`

2. Add a new section before `## Common Mistakes`:
   - `## Visual QA Checklist`

3. Add new rows to `Common Mistakes`:
   - raw/default blue mixed with custom navy
   - mobile sidebar open by default
   - small text opacity below `/55` in dark mode
   - decorative dot background in light mode without validation
   - full-width prose after removing max-width container

## Priority

High-priority updates:

1. Dashboard shell ergonomics
2. Dark palette harmony
3. Dark readability thresholds
4. Visual QA matrix

Medium-priority updates:

1. Sidebar footer rules
2. Header control semantics
3. Decorative background guidance

Low-priority updates:

1. Specific token examples
2. Version footer copy pattern
