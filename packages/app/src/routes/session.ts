import { Elysia } from 'elysia';
import type { Db } from '../db';
import { clearSessionCookie, getSessionFromRequest, invalidateSessionFromRequest } from '../services/sessions';

type SessionRoutesOptions = {
  db: Db;
};

export function sessionRoutes({ db }: SessionRoutesOptions) {
  return new Elysia({ prefix: '/v1' })
    .get('/session', async ({ request, status }) => {
      const session = await getSessionFromRequest(db, request);

      if (!session) {
        return status(401, {
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Authentication required',
          },
        });
      }

      return {
        data: {
          session_id: session.sessionId,
          user: {
            id: session.user.id,
            email: session.user.email,
            name: session.user.name,
            avatar_url: session.user.avatarUrl,
          },
        },
      };
    })
    .post('/auth/logout', async ({ request }) => {
      await invalidateSessionFromRequest(db, request);
      return new Response(JSON.stringify({ data: { logged_out: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': clearSessionCookie() },
      });
    });
}
