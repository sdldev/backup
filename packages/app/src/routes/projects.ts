import { Elysia, t } from 'elysia';
import type { Db } from '../db';
import { getSessionFromRequest } from '../services/sessions';
import { createProject, listProjects } from '../services/projects';

type ProjectRoutesOptions = {
  db: Db;
};

const createProjectBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 120 }),
  website_url: t.Optional(t.String({ maxLength: 300 })),
});

function serializeProject(project: Awaited<ReturnType<typeof listProjects>>[number]) {
  return {
    id: project.id,
    workspace_id: project.workspaceId,
    name: project.name,
    website_url: project.websiteUrl,
    created_by_user_id: project.createdByUserId,
    created_at: project.createdAt.toISOString(),
    updated_at: project.updatedAt.toISOString(),
  };
}

export function projectRoutes({ db }: ProjectRoutesOptions) {
  return new Elysia({ prefix: '/v1/workspaces/:workspaceId/projects' })
    .get('/', async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) {
        return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
      }

      const rows = await listProjects(db, params.workspaceId, session.user.id);
      return { data: rows.map(serializeProject) };
    })
    .post(
      '/',
      async ({ body, params, request, status }) => {
        const session = await getSessionFromRequest(db, request);
        if (!session) {
          return status(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
        }

        const project = await createProject(db, {
          workspaceId: params.workspaceId,
          userId: session.user.id,
          name: body.name,
          websiteUrl: body.website_url,
        });

        return status(201, { data: serializeProject(project) });
      },
      { body: createProjectBody },
    );
}
