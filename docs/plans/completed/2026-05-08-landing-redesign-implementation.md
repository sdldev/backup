# Landing Redesign Implementation Plan

Based on `docs/plans/2026-05-08-landing-redesign-design.md`.

## Task 1: Add landing metadata support and agency hero

<!-- tdd: modifying-tested-code -->
<!-- checkpoint: none -->

Files to modify:

- `packages/web/src/layouts/BaseLayout.astro`
- `packages/web/src/pages/index.astro`

Goal: visitor immediately sees agency-focused positioning, clear CTA, and SEO description metadata.

Steps:

1. Run baseline checks:

   ```bash
   cd packages/web
   npm run typecheck
   npm run build
   ```

   Expected: both commands exit 0 before changes.

2. Modify `packages/web/src/layouts/BaseLayout.astro`:

   - Change props type to include `description?: string`.
   - Default title remains `Manual Backup SaaS Beta`.
   - Add default description for existing pages.
   - Add meta description in `<head>`.

   Target shape:

   ```astro
   const {
     title = 'Manual Backup SaaS Beta',
     description = 'Manual Backup Portal untuk backup database terenkripsi.',
   } = Astro.props as { title?: string; description?: string };
   ```

   Add inside `<head>`:

   ```astro
   <meta name="description" content={description} />
   ```

3. Replace current landing hero in `packages/web/src/pages/index.astro` with agency-focused nav + hero.

   Keep imports:

   ```astro
   import { ThemeToggle } from '../components/theme/ThemeToggle';
   import { Button } from '../components/ui/button';
   import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
   import BaseLayout from '../layouts/BaseLayout.astro';
   ```

   Use layout props:

   ```astro
   <BaseLayout
     title="Backup Database Client untuk Agency — Manual Backup Portal"
     description="Backup database MySQL dan PostgreSQL untuk agency: terenkripsi, per client, bisa diunduh, dan tercatat di audit log."
   >
   ```

   Nav content:

   - Brand: `Manual Backup` / `Portal`
   - Links: `Cara kerja` → `#cara-kerja`, `Keamanan` → `#keamanan`, `Untuk siapa` → `#untuk-siapa`
   - Button: `Masuk` → `/login`

   Hero content:

   - Eyebrow: `Backup database untuk agency`
   - H1: `Jaga database client tetap aman, tanpa spreadsheet backup`
   - Body: `Kelola backup database MySQL dan PostgreSQL per client. Backup terenkripsi, bisa diunduh saat dibutuhkan, dan setiap tindakan penting tercatat di audit log.`
   - Primary CTA: `Mulai beta` → `/login`
   - Secondary CTA: `Lihat cara kerja` → `#cara-kerja`
   - Trust items rendered from:

     ```ts
     const trustItems = ['MySQL', 'PostgreSQL', 'S3/R2/MinIO', 'Audit log'];
     ```

   Add a right-side card titled `Operasi backup client` with rows:

   - `Mode backup` / `Manual`
   - `Database` / `MySQL + PostgreSQL`
   - `Artifact` / `Terenkripsi`
   - `Bukti kerja` / `Audit log`

4. Run verification:

   ```bash
   cd packages/web
   npm run typecheck
   npm run build
   ```

   Expected: both exit 0.

5. Manual content check:

   - H1 targets agency.
   - Hero does not mention automatic/scheduled backup, restore, compliance, or guarantees.
   - Primary CTA points to `/login`.
   - Secondary CTA points to `#cara-kerja`.
   - Meta description appears in rendered page source.

6. Commit:

   ```bash
   git add packages/web/src/layouts/BaseLayout.astro packages/web/src/pages/index.astro
   git commit -m "feat(web): retarget landing hero"
   ```

## Task 2: Add agency pain and workflow sections

<!-- tdd: new-feature -->
<!-- checkpoint: none -->

Files to modify:

- `packages/web/src/pages/index.astro`

Goal: visitor sees agency backup problems and understands end-to-end product workflow.

Steps:

1. Add page-local arrays near top of `index.astro`:

   ```ts
   const painPoints = [
     {
       title: 'Backup client tersebar',
       body: 'Sebagian ada di hosting, sebagian di server sendiri, sebagian hanya dicatat manual. Tim sulit tahu backup mana yang masih valid.',
     },
     {
       title: 'Credential sulit dikontrol',
       body: 'Akses database sering dibagikan lewat chat atau dokumen internal. Saat tim berubah, jejak akses makin sulit dirapikan.',
     },
     {
       title: 'Bukti backup tidak rapi',
       body: 'Client bertanya kapan backup terakhir dibuat, tetapi tim harus mencari log, file, atau screenshot dari banyak tempat.',
     },
   ];

   const workflowSteps = [
     {
       step: '01',
       title: 'Buat workspace',
       body: 'Pisahkan pekerjaan agency, client group, atau tim internal dalam workspace yang jelas.',
     },
     {
       step: '02',
       title: 'Tambah project client',
       body: 'Kelompokkan website, aplikasi, atau aset client agar backup tidak tercampur.',
     },
     {
       step: '03',
       title: 'Sambungkan database source',
       body: 'Daftarkan database MySQL atau PostgreSQL yang perlu diamankan untuk tiap project.',
     },
     {
       step: '04',
       title: 'Jalankan dan unduh backup',
       body: 'Buat backup manual, simpan artifact terenkripsi, lalu unduh saat dibutuhkan selama masa retensi.',
     },
   ];
   ```

2. Add problem section after hero:

   - Eyebrow: `Masalah agency`
   - Heading: `Backup client sering gagal bukan karena teknis, tapi karena prosesnya berantakan`
   - Render `painPoints` as three `Card` components.

3. Add workflow section with `id="cara-kerja"`:

   - Eyebrow: `Cara kerja`
   - Heading: `Satu alur untuk semua database client`
   - Render `workflowSteps` as four `Card` components.

4. Run verification:

   ```bash
   cd packages/web
   npm run typecheck
   npm run build
   ```

   Expected: both exit 0.

5. Manual content check:

   - Problem section clearly targets agency workflows.
   - Workflow section uses workspace → project → database source → backup.
   - No claim about scheduling or restore.

6. Commit:

   ```bash
   git add packages/web/src/pages/index.astro
   git commit -m "feat(web): explain agency backup workflow"
   ```

## Task 3: Add security, audience, phase honesty, and final CTA sections

<!-- tdd: new-feature -->
<!-- checkpoint: none -->

Files to modify:

- `packages/web/src/pages/index.astro`

Goal: visitor understands trust boundaries, sees secondary audience fit, and gets final conversion prompt without overclaiming.

Steps:

1. Add page-local arrays near top of `index.astro`:

   ```ts
   const securityPoints = [
     'Backup artifact disimpan terenkripsi.',
     'Credential database disimpan terenkripsi dan dimasked setelah tersimpan.',
     'Audit log mencatat tindakan penting seperti akses, perubahan credential, dan download backup.',
     'Storage dapat memakai AWS S3, Cloudflare R2, MinIO, atau local disk untuk self-hosted deployment.',
   ];

   const audiences = [
     {
       label: 'Primary',
       title: 'Agency dan freelancer team',
       body: 'Kelola backup database untuk banyak client dari satu portal tanpa spreadsheet dan catatan manual.',
     },
     {
       label: 'Secondary',
       title: 'Owner UMKM',
       body: 'Jaga database toko, website, atau sistem operasional tetap punya salinan yang bisa diunduh.',
     },
     {
       label: 'Secondary',
       title: 'Internal IT',
       body: 'Rapikan backup manual database operasional dengan workspace, project, dan audit log.',
     },
     {
       label: 'Secondary',
       title: 'Hosting kecil',
       body: 'Siapkan layanan backup database sebagai add-on untuk client yang butuh bukti kerja lebih rapi.',
     },
   ];
   ```

2. Add security section with `id="keamanan"`:

   - Eyebrow: `Keamanan`
   - Heading: `Dibuat untuk backup yang bisa dipercaya, bukan sekadar file dump`
   - Render `securityPoints` as list/cards.
   - Include a short note: `Tidak ada klaim compliance atau zero data loss. Fokus rilis awal adalah backup manual yang terenkripsi dan bisa diaudit.`

3. Add audience section with `id="untuk-siapa"`:

   - Eyebrow: `Untuk siapa`
   - Heading: `Fokus untuk agency, tetap berguna untuk tim lain`
   - Render `audiences` as cards.
   - Make agency card visually stronger using existing Tailwind classes, e.g. border primary/background accent. Do not introduce new component files.

4. Add phase honesty section:

   Text must include:

   - `Saat ini fokus ke manual backup.`
   - `Scheduled backup dan notifikasi direncanakan untuk fase berikutnya.`
   - `Restore otomatis belum termasuk di rilis awal.`

5. Add final CTA:

   - Heading: `Amankan database client pertama hari ini`
   - Body: `Mulai dari satu workspace, satu project, dan satu database source. Rapikan proses backup sebelum client membutuhkannya.`
   - Button: `Mulai beta` → `/login`

6. Run verification:

   ```bash
   cd packages/web
   npm run typecheck
   npm run build
   ```

   Expected: both exit 0.

7. Manual content check:

   - Security claims match context.
   - Secondary audiences present but agency remains primary.
   - Phase honesty block explicitly avoids overclaim.
   - Final CTA is visible after all trust/phase content.

8. Commit:

   ```bash
   git add packages/web/src/pages/index.astro
   git commit -m "feat(web): add landing trust and audience sections"
   ```

## Task 4: Final landing polish and verification

<!-- tdd: trivial -->
<!-- checkpoint: done -->

Files to modify:

- `packages/web/src/pages/index.astro`
- `packages/web/src/layouts/BaseLayout.astro` only if metadata needs adjustment

Goal: landing reads cleanly, is responsive, and passes build checks.

Steps:

1. Review `packages/web/src/pages/index.astro` for:

   - Semantic section order.
   - One H1 only.
   - Section IDs: `cara-kerja`, `keamanan`, `untuk-siapa`.
   - No fake clickable cards.
   - No overclaims: automatic/scheduled backup as current feature, one-click restore, compliance certification, zero data loss, guaranteed recovery, or real-time monitoring.

2. Polish responsive classes if needed:

   - Mobile: stack hero and cards.
   - Desktop: hero two-column layout.
   - Nav links should wrap or hide gracefully on narrow widths.
   - CTA buttons remain tappable.

3. Run final checks:

   ```bash
   cd packages/web
   npm run typecheck
   npm run build
   ```

   Expected: both exit 0.

4. Optional local visual smoke:

   ```bash
   cd packages/web
   npm run dev
   ```

   Open `/` and verify:

   - Nav anchors scroll correctly.
   - Theme toggle still works.
   - Light/dark contrast is acceptable.
   - Hero, problem, workflow, security, audience, phase honesty, and final CTA sections are visible.

5. Show diff for review:

   ```bash
   git diff -- packages/web/src/pages/index.astro packages/web/src/layouts/BaseLayout.astro
   ```

6. Commit after human checkpoint approval:

   ```bash
   git add packages/web/src/pages/index.astro packages/web/src/layouts/BaseLayout.astro
   git commit -m "chore(web): polish landing page"
   ```
