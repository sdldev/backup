import { Elysia } from 'elysia';
import type { Db } from '../db';
import { changeWorkspaceMemberRole, listWorkspaceMembers, removeWorkspaceMember, toSafeWorkspaceMember, transferWorkspaceOwnership } from '../services/members';
import { getSessionFromRequest } from '../services/sessions';

type MemberRoutesOptions = { db: Db };

export function memberRoutes({ db }: MemberRoutesOptions) {
  return new Elysia({ prefix: '/v1/workspaces/:workspaceId/members' })
    .get('', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
      return { data: await listWorkspaceMembers(db, params.workspaceId, session.user.id) };
    })
    .patch('/:memberUserId/role', async ({ params, body, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
      const payload = body as { role?: 'admin' | 'member' | 'owner' };
      const member = await changeWorkspaceMemberRole(db, params.workspaceId, session.user.id, params.memberUserId, payload.role ?? 'member');
      return { data: toSafeWorkspaceMember(member) };
    })
    .delete('/:memberUserId', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
      await removeWorkspaceMember(db, params.workspaceId, session.user.id, params.memberUserId);
      return status(204);
    })
    .post('/ownership-transfer', async ({ params, body, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
      const payload = body as { new_owner_user_id?: string };
      const member = await transferWorkspaceOwnership(db, params.workspaceId, session.user.id, payload.new_owner_user_id ?? '');
      return { data: toSafeWorkspaceMember(member) };
    });
}
