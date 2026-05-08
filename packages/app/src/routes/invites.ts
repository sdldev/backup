import { Elysia } from 'elysia';
import type { Db } from '../db';
import { acceptInvite, createWorkspaceInvite, previewInvite } from '../services/invites';
import { getSessionFromRequest } from '../services/sessions';

type InviteRoutesOptions = { db: Db };

export function inviteRoutes({ db }: InviteRoutesOptions) {
  return new Elysia()
    .post('/v1/workspaces/:workspaceId/invites', async ({ params, body, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
      const payload = body as { email?: string; role?: 'admin' | 'member' | 'owner' };
      const result = await createWorkspaceInvite(db, { workspaceId: params.workspaceId, actorUserId: session.user.id, email: payload.email ?? '', role: payload.role ?? 'member' });
      return status(201, { data: result.invite, invite_token: result.token });
    })
    .get('/v1/invites/:token', async ({ params }) => ({ data: await previewInvite(db, params.token) }))
    .post('/v1/invites/:token/accept', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
      const result = await acceptInvite(db, params.token, session.user.id);
      return { data: { workspace_id: result.membership.workspaceId, workspace_slug: result.workspace.slug, role: result.membership.role } };
    });
}
