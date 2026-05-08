import { and, asc, eq, inArray } from "drizzle-orm";
import {
  ApiError,
  buildWorkspaceSlugCandidate,
  validateWorkspaceSlug,
} from "@backup-saas/shared";
import { planRequests, plans, workspaceMembers, workspaces } from "../db";
import { writeAuditEvent } from "./audit";

type WorkspaceTx = Parameters<
  Parameters<import("../db").Db["transaction"]>[0]
>[0];

export async function getWorkspaceForUser(
  db: import("../db").Db,
  userId: string,
  workspaceId: string,
) {
  const [row] = await db
    .select({
      workspace: workspaces,
      membership: workspaceMembers,
      plan: plans,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .innerJoin(plans, eq(workspaces.planId, plans.id))
    .where(
      and(eq(workspaceMembers.userId, userId), eq(workspaces.id, workspaceId)),
    )
    .limit(1);

  return row ?? null;
}

export async function getWorkspaceForUserBySlug(
  db: import("../db").Db,
  userId: string,
  slug: string,
) {
  const [row] = await db
    .select({
      workspace: workspaces,
      membership: workspaceMembers,
      plan: plans,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .innerJoin(plans, eq(workspaces.planId, plans.id))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaces.slug, slug)))
    .limit(1);

  return row ?? null;
}

export async function listWorkspacesForUser(
  db: import("../db").Db,
  userId: string,
) {
  return db
    .select({
      workspace: workspaces,
      membership: workspaceMembers,
      plan: plans,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .innerJoin(plans, eq(workspaces.planId, plans.id))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.name));
}

type CreateWorkspaceInput = {
  name: string;
  slug?: string | undefined;
  timezone: string;
  requestedPlan?: "basic" | "pro" | "agency" | undefined;
  ownerUserId: string;
};

export async function createWorkspace(
  db: import("../db").Db,
  input: CreateWorkspaceInput,
) {
  const requestedPlanSlug = input.requestedPlan ?? "basic";

  return db.transaction(async (tx) => {
    const [basicPlan] = await tx
      .select()
      .from(plans)
      .where(eq(plans.slug, "basic"))
      .limit(1);
    if (!basicPlan) {
      throw new ApiError(500, "PLAN_NOT_FOUND", "Basic plan is not configured");
    }

    const [requestedPlan] = await tx
      .select()
      .from(plans)
      .where(eq(plans.slug, requestedPlanSlug))
      .limit(1);
    if (!requestedPlan) {
      throw new ApiError(
        422,
        "PLAN_NOT_FOUND",
        "Requested plan is not configured",
      );
    }

    const slug = input.slug
      ? await validateExplicitSlug(tx, input.slug)
      : await generateAvailableSlug(tx, input.name);

    const [workspace] = await tx
      .insert(workspaces)
      .values({
        name: input.name,
        slug,
        timezone: input.timezone,
        planId: basicPlan.id,
        storageStatus: "provisioning",
        onboardingStep: "workspace_created",
      })
      .returning();

    if (!workspace) {
      throw new ApiError(
        500,
        "WORKSPACE_CREATE_FAILED",
        "Workspace could not be created",
      );
    }

    const [ownerMembership] = await tx
      .insert(workspaceMembers)
      .values({
        workspaceId: workspace.id,
        userId: input.ownerUserId,
        role: "owner",
      })
      .returning();

    if (!ownerMembership) {
      throw new ApiError(
        500,
        "WORKSPACE_OWNER_CREATE_FAILED",
        "Workspace Owner could not be created",
      );
    }

    let pendingPlanRequest = null;
    if (requestedPlan.slug !== "basic") {
      const [createdRequest] = await tx
        .insert(planRequests)
        .values({
          workspaceId: workspace.id,
          requestedPlanId: requestedPlan.id,
          requestedByUserId: input.ownerUserId,
          status: "pending",
        })
        .returning();
      pendingPlanRequest = createdRequest ?? null;
    }

    await writeAuditEvent(tx as unknown as import("../db").Db, {
      workspaceId: workspace.id,
      eventType: "workspace.created",
      actor: { type: "user", userId: input.ownerUserId },
      resourceType: "workspace",
      resourceId: workspace.id,
      metadata: { requested_plan: requestedPlan.slug },
    });

    return { workspace, ownerMembership, pendingPlanRequest };
  });
}

async function validateExplicitSlug(
  tx: WorkspaceTx,
  input: string,
): Promise<string> {
  const validation = validateWorkspaceSlug(input);
  if (!validation.valid) {
    throw new ApiError(400, validation.code, validation.message);
  }

  const [existing] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, validation.slug))
    .limit(1);
  if (existing) {
    throw new ApiError(
      409,
      "WORKSPACE_SLUG_TAKEN",
      "Workspace slug is already taken",
    );
  }

  return validation.slug;
}

async function generateAvailableSlug(
  tx: WorkspaceTx,
  name: string,
): Promise<string> {
  const firstCandidate = buildWorkspaceSlugCandidate(name, new Set());
  const candidateSlugs = Array.from({ length: 100 }, (_, index) => {
    if (index === 0) return firstCandidate;
    const suffix = `-${index + 1}`;
    return `${firstCandidate.slice(0, 48 - suffix.length).replace(/-+$/g, "")}${suffix}`;
  });

  const existingRows = await tx
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(inArray(workspaces.slug, candidateSlugs));
  const usedSlugs = new Set(existingRows.map((row) => row.slug));
  return buildWorkspaceSlugCandidate(name, usedSlugs);
}
