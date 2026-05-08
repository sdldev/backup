# New tenant onboarding workflow

## Canonical flow

1. User signs in with Google or GitHub OAuth.
2. If no Workspace is selected, user sees the Workspace launcher.
3. User clicks **Create Workspace**.
4. User enters Workspace name, reviews the auto-generated slug (editable before creation), and selects timezone (defaults from browser).
5. User chooses a Workspace Plan:
   - Basic is self-serve.
   - Pro and Agency are request-access plans.
   - If Pro or Agency is requested, the Workspace is still created on Basic and a plan request is queued for System Admin review.
6. Workspace is created and the creating user becomes the sole Workspace Owner.
7. Platform-managed Backup Storage is auto-provisioned immediately.
8. If Backup Storage provisioning fails, the Workspace remains created but onboarding is blocked with a retry action.
9. User creates the first Project with a required name and optional website URL.
10. User adds the first Database Source:
    - choose engine
    - enter display name
    - enter structured connection fields
    - configure advanced SSL if needed; hosted SaaS defaults to requiring TLS
    - test connection and minimal dump capability
    - confirm Retention Period
11. User saves the Database Source.
12. App prompts **Run first backup now**.
13. If user starts the first Backup Job, app opens the Backup Job detail page with SSE live progress.
14. After the first Backup succeeds, app prompts the Workspace Owner to invite team members.
15. Workspace Owner/Workspace Admin invite rules:
    - Workspace Owner can invite Workspace Admins and Workspace Members.
    - Workspace Admin can invite Workspace Members only.
    - Invite links are single-use, expire after 7 days, and embed the invited role.
16. Invitee opens the invite link, signs in with Google or GitHub OAuth, explicitly accepts the Workspace and role, then joins the Workspace.

## Notes

- A User Account can exist without a Workspace.
- Creating a Workspace makes the creator the sole Workspace Owner of that Workspace.
- Each Workspace has exactly one Workspace Owner, multiple Workspace Admins, and multiple Workspace Members.
- Ownership can be transferred to a Workspace Admin. The previous Workspace Owner becomes a Workspace Admin.
- Workspace Admins and Workspace Members join an existing Workspace through invite links; they do not register that Workspace.
