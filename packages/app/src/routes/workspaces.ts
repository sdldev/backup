import { Elysia, t } from "elysia";
import type { Db } from "../db";
import { getSessionFromRequest } from "../services/sessions";
import { provisionPlatformManagedStorage } from "../services/storage-provisioning";
import {
  createWorkspace,
  getWorkspaceForUser,
  getWorkspaceForUserBySlug,
  listWorkspacesForUser,
} from "../services/workspaces";

type WorkspaceRoutesOptions = {
  db: Db;
};

const createWorkspaceBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 120 }),
  slug: t.Optional(t.String({ minLength: 1, maxLength: 48 })),
  timezone: t.String({ minLength: 1, maxLength: 80 }),
  requested_plan: t.Optional(
    t.Union([t.Literal("basic"), t.Literal("pro"), t.Literal("agency")]),
  ),
});

function serializeWorkspaceRow(
  row: Awaited<ReturnType<typeof listWorkspacesForUser>>[number],
) {
  return {
    workspace: {
      id: row.workspace.id,
      name: row.workspace.name,
      slug: row.workspace.slug,
      timezone: row.workspace.timezone,
      storage_status: row.workspace.storageStatus,
      onboarding_step: row.workspace.onboardingStep,
      created_at: row.workspace.createdAt.toISOString(),
    },
    membership: {
      id: row.membership.id,
      role: row.membership.role,
    },
    plan: {
      id: row.plan.id,
      slug: row.plan.slug,
      name: row.plan.name,
    },
  };
}

export function workspaceRoutes({ db }: WorkspaceRoutesOptions) {
  return new Elysia({ prefix: "/v1" })
    .get("/workspaces", async ({ request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) {
        return status(401, {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required",
          },
        });
      }

      const rows = await listWorkspacesForUser(db, session.user.id);
      return { data: rows.map(serializeWorkspaceRow) };
    })
    .get("/workspaces/by-slug/:slug", async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) {
        return status(401, {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required",
          },
        });
      }

      const row = await getWorkspaceForUserBySlug(
        db,
        session.user.id,
        params.slug,
      );
      if (!row) {
        return status(404, {
          error: { code: "RESOURCE_NOT_FOUND", message: "Workspace not found" },
        });
      }

      return { data: serializeWorkspaceRow(row) };
    })
    .post("/workspaces/:workspaceId/storage/provision/retry", async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) {
        return status(401, {
          error: { code: "UNAUTHENTICATED", message: "Authentication required" },
        });
      }

      const result = await provisionPlatformManagedStorage(db, params.workspaceId, session.user.id);
      return {
        data: {
          workspace: {
            id: result.workspace.id,
            storage_status: result.workspace.storageStatus,
          },
          storage_config: {
            id: result.storageConfig.id,
            provider: result.storageConfig.provider,
            mode: result.storageConfig.mode,
            status: result.storageConfig.status,
            is_current: result.storageConfig.isCurrent,
          },
        },
      };
    })
    .get("/workspaces/:workspaceId", async ({ params, request, status }) => {
      const session = await getSessionFromRequest(db, request);
      if (!session) {
        return status(401, {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required",
          },
        });
      }

      const row = await getWorkspaceForUser(
        db,
        session.user.id,
        params.workspaceId,
      );
      if (!row) {
        return status(404, {
          error: { code: "RESOURCE_NOT_FOUND", message: "Workspace not found" },
        });
      }

      return { data: serializeWorkspaceRow(row) };
    })
    .post(
      "/workspaces",
      async ({ body, request, status }) => {
        const session = await getSessionFromRequest(db, request);
        if (!session) {
          return status(401, {
            error: {
              code: "UNAUTHENTICATED",
              message: "Authentication required",
            },
          });
        }

        const result = await createWorkspace(db, {
          name: body.name,
          slug: body.slug,
          timezone: body.timezone,
          requestedPlan: body.requested_plan,
          ownerUserId: session.user.id,
        });

        return status(201, {
          data: {
            workspace: {
              id: result.workspace.id,
              name: result.workspace.name,
              slug: result.workspace.slug,
              timezone: result.workspace.timezone,
              storage_status: result.workspace.storageStatus,
              onboarding_step: result.workspace.onboardingStep,
              created_at: result.workspace.createdAt.toISOString(),
            },
            membership: {
              id: result.ownerMembership.id,
              role: result.ownerMembership.role,
            },
            pending_plan_request: result.pendingPlanRequest
              ? {
                  id: result.pendingPlanRequest.id,
                  status: result.pendingPlanRequest.status,
                  created_at: result.pendingPlanRequest.createdAt.toISOString(),
                }
              : null,
          },
        });
      },
      {
        body: createWorkspaceBody,
      },
    );
}
