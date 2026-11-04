import { prisma } from "@shared/config/prisma";

import type { AccessActor, AppSummary } from "./access.types";
import { enabledInWorkspace } from "../app/app.service";

// Name kept from the previous implementation because auth.controller.ts and
// GET /users/me send this object to the frontend unchanged.
export type UserPermissions = AccessActor;

const appSummarySelect = { id: true, key: true, name: true } as const;

function createNoAccess(): UserPermissions {
	return { isSuperAdmin: false, administeredApps: [], permissions: [] };
}

function toAppSummary(app: {
	id: string;
	key: string;
	name: string;
}): AppSummary {
	return { appId: app.id, appKey: app.key, appName: app.name };
}

async function listEnabledAppSummaries(workspaceId: string) {
	const apps = await prisma.app.findMany({
		where: enabledInWorkspace(workspaceId),
		select: appSummarySelect,
		orderBy: { name: "asc" },
	});
	return apps.map(toAppSummary);
}

export async function buildUserPermissions(
	userId: string,
	workspaceId: string,
): Promise<UserPermissions> {
	const [membership, profileAssignments, appAdministrations] =
		await Promise.all([
			prisma.workspaceUser.findUnique({
				where: { userId_workspaceId: { userId, workspaceId } },
				select: { isSuperAdmin: true },
			}),
			prisma.userProfile.findMany({
				where: {
					userId,
					workspaceId,
					profile: { app: enabledInWorkspace(workspaceId) },
				},
				select: {
					profile: {
						select: {
							app: { select: appSummarySelect },
							permissions: {
								select: { action: true, module: { select: { key: true } } },
							},
						},
					},
				},
			}),
			prisma.appAdministrator.findMany({
				where: { userId, workspaceId, app: enabledInWorkspace(workspaceId) },
				select: { app: { select: appSummarySelect } },
			}),
		]);

	if (!membership) return createNoAccess();

	return {
		isSuperAdmin: membership.isSuperAdmin,
		administeredApps: membership.isSuperAdmin
			? await listEnabledAppSummaries(workspaceId)
			: appAdministrations.map(({ app }) => toAppSummary(app)),
		permissions: profileAssignments.flatMap(({ profile }) =>
			profile.permissions.map((permission) => ({
				...toAppSummary(profile.app),
				action: permission.action,
				moduleKey: permission.module.key,
			})),
		),
	};
}
