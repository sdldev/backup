# Landing Redesign Design

## Goal

Redesign the landing page to target and sell to web agencies and developers who manage client databases. Secondary audiences are UMKM owners, small/medium internal IT teams, and small hosting providers, but the page should lead with agency pain and outcomes.

## Constraints

- Phase 1 supports manual backups only.
- Supported databases: MySQL-family and PostgreSQL-family.
- Backup artifacts are encrypted.
- Database credentials are stored encrypted and masked after save.
- Backup artifacts can be downloaded while retained.
- Audit logs exist for important security and data access events.
- Storage providers include AWS S3, Cloudflare R2, MinIO, and local disk for self-hosted deployments.
- Do not claim automatic/scheduled backups, one-click restore, compliance certification, guaranteed recovery, zero data loss, or real-time monitoring.

## Slice 1 — Agency-focused hero and CTA

Observable behavior: a visitor immediately understands the product is for agencies managing client database backups and sees a clear CTA.

Content:

- Eyebrow: backup database untuk agency.
- H1: agency outcome, e.g. keeping client databases safe without spreadsheet-driven backup work.
- Body: MySQL/PostgreSQL backup per client, encrypted, downloadable, and recorded in audit logs.
- Primary CTA: `Mulai beta` linking to `/login`.
- Secondary CTA: `Lihat cara kerja` linking to `#cara-kerja`.
- Trust row: MySQL, PostgreSQL, S3/R2/MinIO, audit log.

Implementation:

- Keep `packages/web/src/pages/index.astro` as the landing page.
- Reuse existing `Button`, `Card`, and `ThemeToggle` components.
- Keep Indonesian copy.
- Use restrained SaaS UI: strong hierarchy, clean cards, no excessive glow or vague filler.

## Slice 2 — Problem and workflow sections

Observable behavior: a visitor sees the backup problems agencies face and how the product organizes the work.

Problem section:

- Backup client tersebar across hosting, servers, and manual notes.
- Credentials are often shared manually and are hard to control.
- It is difficult to prove when a backup was run.

Workflow section (`#cara-kerja`):

1. Create a workspace for an agency, client group, or team.
2. Add client projects.
3. Connect database sources.
4. Run backups and download retained artifacts.

Implementation:

Use page-local arrays for repeated content, rendered with Astro maps:

```ts
const workflowSteps = [
  {
    step: '01',
    title: 'Buat workspace',
    body: 'Pisahkan pekerjaan agency, client, atau tim dalam workspace.',
  },
];
```

## Slice 3 — Security and trust section

Observable behavior: a visitor understands what security controls exist without overclaiming.

Security proof points:

- Backup artifact terenkripsi.
- Credential database disimpan terenkripsi dan dimasked.
- Audit log for important actions.
- Storage can use S3, R2, MinIO, or local self-hosted storage.

Trust boundary:

Do not mention compliance certifications, guaranteed recovery, one-click restore, or automated backup scheduling.

## Slice 4 — Audience section

Observable behavior: primary and secondary audiences can identify themselves, while agency remains dominant.

Audience cards:

- Primary: agency and freelancer teams managing multiple clients.
- Secondary: UMKM owners who want safer business data.
- Secondary: internal IT teams managing operational databases.
- Secondary: small hosting providers offering backup as a client service.

The agency card should be visually and copy-wise stronger than secondary audience cards.

## Slice 5 — Phase honesty and final CTA

Observable behavior: visitors understand current product scope before conversion.

Phase honesty block:

- Current focus is manual backup.
- Useful for agencies that want a cleaner backup process and proof of work.
- Scheduled backups and notifications are planned for a later phase.
- Automatic restore is not included in the first release.

Final CTA:

- Title: secure the first client database today.
- Primary CTA: `Mulai beta` → `/login`.
- Secondary CTA: `Masuk` → `/login` or omitted if redundant.

## Data flow

The landing page remains static and prerendered:

```ts
export const prerender = true;
```

No API calls, auth checks, workspace fetches, or lead forms are needed for this redesign. CTA traffic goes to `/login`; anchor links scroll to content sections.

## Metadata

Enhance `BaseLayout` to accept a `description` prop:

```ts
type BaseLayoutProps = {
  title?: string;
  description?: string;
};
```

Landing page should pass:

```astro
<BaseLayout
  title="Backup Database Client untuk Agency — Manual Backup Portal"
  description="Backup database MySQL dan PostgreSQL untuk agency: terenkripsi, per client, bisa diunduh, dan tercatat di audit log."
>
```

## Accessibility

- Use semantic sections and headings.
- Keep CTA labels specific.
- Use visible nav anchor links: `#cara-kerja`, `#keamanan`, `#untuk-siapa`.
- Cards should be content blocks, not fake clickable buttons.
- Use existing theme tokens for contrast.

## Testing

Run:

```bash
cd packages/web
npm run typecheck
npm run build
```

Manual visual checks:

- Mobile nav wraps cleanly.
- Hero CTAs are usable on small screens.
- Desktop hero has balanced two-column layout.
- Cards stack cleanly on mobile.
- Anchor links scroll to correct sections.

Content checks:

- H1 targets agencies.
- Secondary audiences are present but not dominant.
- No overclaims about automatic backups, restore, compliance, or guarantees.
- Indonesian copy is specific and natural.
