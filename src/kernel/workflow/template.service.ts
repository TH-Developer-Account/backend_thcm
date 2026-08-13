import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

type TemplateOwnerType = "ADMIN" | "USER";

type CreateTemplateInput = {
	name: string;
	description: string;
	workspaceId: string;
	metaData_1: string;
	metaData_2: string;
	metaData_3: string;
	appId: string;
	isReusable?: boolean; // defaults to true; ad-hoc callers pass false
	stages: {
		name: string;
		stageOrder: number;
		strategy: "ALL" | "ANY" | "SOME";
		minApprovals?: number;
		approverIds: { userId: string; isExternalApprover?: boolean }[];
	}[];
};

// ─────────────────────────────────────────────────────────────────────────────
// assertCanMutateTemplate
//
// Single ownership guard shared by updateTemplate and deleteTemplate, so the
// "who can touch this template" rule lives in exactly one place. An admin
// caller can mutate anything; a regular caller can only mutate a template
// they personally own (ownerType USER + created_by_id === them).
// ─────────────────────────────────────────────────────────────────────────────

export const assertCanMutateTemplate = (
	template: { ownerType: TemplateOwnerType; created_by_id: string },
	caller: { userId: string; isSuperAdmin: boolean },
) => {
	if (caller.isSuperAdmin) return;

	const isOwnUserTemplate =
		template.ownerType === "USER" && template.created_by_id === caller.userId;

	if (!isOwnUserTemplate) {
		throw new ApiError(
			403,
			"You do not have permission to modify this template",
		);
	}
};

// ─────────────────────────────────────────────────────────────────────────────
// createWorkflowTemplate
//
// ownerType is resolved by the controller (never trust the client to say
// "I'm an admin") and passed in here. When a USER creates their own
// template, we self-assign it via WorkFlowTemplateUser in the same
// transaction — that's the only "assignment" a personal template ever
// gets, and it's what makes it show up in that user's own template list
// and in the assign/preview template lookup later.
// ─────────────────────────────────────────────────────────────────────────────

export const createWorkflowTemplate = async (
	input: CreateTemplateInput,
	userId: string,
	ownerType: TemplateOwnerType,
) => {
	return prisma.$transaction(async (tx) => {
		const template = await tx.workflowTemplate.create({
			data: {
				name: input.name,
				description: input.description,
				workspaceId: input.workspaceId,
				created_by_id: userId,
				updated_by_id: userId,
				appId: input.appId,
				metaData_1: input.metaData_1,
				metaData_2: input.metaData_2,
				metaData_3: input.metaData_3,
				ownerType,
				isReusable: input.isReusable ?? true,

				stages: {
					create: input.stages.map((stage) => ({
						name: stage.name,
						stageOrder: stage.stageOrder,
						strategy: stage.strategy,
						minApprovals: stage.minApprovals,

						approvers: {
							create: stage.approverIds.map((user) => ({
								userId: user.userId,
								isExternalApprover: user.isExternalApprover ?? false,
							})),
						},
					})),
				},
			},
			include: {
				stages: {
					include: { approvers: true },
				},
				app: true,
			},
		});

		if (ownerType === "USER") {
			await tx.workFlowTemplateUser.create({
				data: { templateId: template.id, userId },
			});
		}

		return template;
	});
};

export const updateTemplate = async (
	templateId: string,
	payload: any,
	caller: { userId: string; isSuperAdmin: boolean },
) => {
	const {
		name,
		metaData_1,
		metaData_2,
		metaData_3,
		isActive,
		isReusable, // ✅ NEW — lets a user "promote" a fork to reusable, or vice versa
		stages, // full replacement expected
		appId,
	} = payload;

	return prisma.$transaction(async (tx) => {
		// 1. Check template exists
		const existing = await tx.workflowTemplate.findUnique({
			where: { id: templateId },
			include: { workflowInstances: true },
		});

		if (!existing) throw new ApiError(404, "Template not found");

		// 2. Ownership guard — admins can mutate anything, a regular caller only
		//    their own USER-owned templates.
		assertCanMutateTemplate(existing, caller);

		// 3. Prevent breaking active workflows
		const activeInstances = existing.workflowInstances.filter(
			(w) => w.status === "IN_PROGRESS",
		);

		if (activeInstances.length > 0) {
			throw new ApiError(
				409,
				"Cannot modify template with active workflows. Create new version instead.",
			);
		}

		// 4. Update basic fields
		await tx.workflowTemplate.update({
			where: { id: templateId },
			data: {
				name,
				metaData_1,
				metaData_2,
				metaData_3,
				isActive,
				...(isReusable !== undefined && { isReusable }),
				updated_by_id: caller.userId,
				appId,
			},
		});

		if (!stages) return { message: "Template updated (no stage change)" };

		// 5. Delete existing stages (cascade deletes approvers)
		await tx.templateStage.deleteMany({
			where: { templateId },
		});

		// 6. Recreate stages
		for (const stage of stages) {
			const createdStage = await tx.templateStage.create({
				data: {
					templateId,
					name: stage.name,
					stageOrder: stage.stageOrder,
					strategy: stage.strategy,
					minApprovals: stage.minApprovals,
				},
			});

			if (stage.approverIds?.length) {
				await tx.templateApprover.createMany({
					data: stage.approverIds.map(
						(approver: { userId: string; isExternalApprover?: boolean }) => ({
							stageId: createdStage.id,
							userId: approver.userId,
							isExternalApprover: approver.isExternalApprover ?? false,
						}),
					),
				});
			}
		}

		return { message: "Template updated successfully" };
	});
};

export const deleteTemplate = async (
	templateId: string,
	caller: { userId: string; isSuperAdmin: boolean },
) => {
	return prisma.$transaction(async (tx) => {
		const template = await tx.workflowTemplate.findUnique({
			where: { id: templateId },
			include: { workflowInstances: true },
		});

		if (!template) throw new ApiError(404, "Template not found");

		// Ownership guard — same rule as updateTemplate.
		assertCanMutateTemplate(template, caller);

		// 🚨 Critical Safety Check
		const hasRunningWorkflows = template.workflowInstances.some(
			(w) => w.status === "IN_PROGRESS",
		);

		if (hasRunningWorkflows) {
			throw new ApiError(
				409,
				"Cannot delete template with active workflows. Disable it instead.",
			);
		}

		// Optional: prevent delete if ANY historical workflows exist
		if (template.workflowInstances.length > 0) {
			await tx.workflowTemplate.update({
				where: { id: templateId },
				data: {
					isActive: false,
				},
			});
		} else {
			// Delete (cascade handles stages + approvers)
			await tx.workflowTemplate.delete({
				where: { id: templateId },
			});
		}

		return { message: "Template deleted successfully" };
	});
};

// ─────────────────────────────────────────────────────────────────────────────
// getTemplates
//
// Visibility rule (✅ NEW):
//   - Admin caller (isSuperAdmin) → sees every template in the workspace,
//     same as before this change.
//   - Regular caller → only templates they're assigned to via
//     WorkFlowTemplateUser — which now covers BOTH admin-assigned templates
//     AND their own self-assigned USER templates, through the same join.
//     One query shape, no OR-branch on ownerType needed.
// ─────────────────────────────────────────────────────────────────────────────

export const getTemplates = async (
	query: any,
	caller: { userId: string; isSuperAdmin: boolean },
) => {
	const {
		workspaceId,
		isActive,
		search,
		filters,
		page,
		limit,
		sortBy,
		sortOrder,
	} = query;

	const where: any = { isReusable: true };

	if (workspaceId) where.workspaceId = workspaceId;
	if (isActive !== undefined) where.isActive = isActive === "true";

	if (!caller.isSuperAdmin) {
		where.workFlowUsers = { some: { userId: caller.userId } };
	}

	// ✅ Advanced Filters
	if (filters) {
		const parsedFilters =
			typeof filters === "string" ? JSON.parse(filters) : filters;

		const { createdBy, apps } = parsedFilters;

		if (apps?.length) {
			where.appId = {
				in: Array.isArray(apps) ? apps : [apps], // fallback safety
			};
		}

		if (createdBy?.length) {
			where.created_by_id = {
				in: Array.isArray(createdBy) ? createdBy : [createdBy], // fallback safety
			};
		}
	}

	if (search?.trim()) {
		where.OR = [
			{ name: { contains: search.trim(), mode: "insensitive" } },
			{ description: { contains: search.trim(), mode: "insensitive" } },
		];
	}

	// Whitelist allowed sort fields to prevent arbitrary column injection
	const allowedSortFields = [
		"created_at",
		"updated_at",
		"name",
		"minBudget",
		"maxBudget",
	];
	const allowedSortOrders = ["asc", "desc"];

	const resolvedSortBy = allowedSortFields.includes(sortBy)
		? sortBy
		: "created_at";
	const resolvedSortOrder = allowedSortOrders.includes(sortOrder)
		? sortOrder
		: "desc";

	const [data, total] = await Promise.all([
		prisma.workflowTemplate.findMany({
			where,
			skip: (page - 1) * limit,
			take: limit,
			orderBy: { [resolvedSortBy]: resolvedSortOrder },
			include: {
				stages: {
					orderBy: { stageOrder: "asc" },
					include: {
						approvers: {
							include: {
								user: {
									select: {
										id: true,
										first_name: true,
										last_name: true,
										email: true,
									},
								},
							},
						},
					},
				},
				app: { select: { id: true, key: true, name: true } },
				created_by: { select: { first_name: true, last_name: true } },
				updated_by: { select: { first_name: true, last_name: true } },
				workFlowUsers: {
					include: {
						user: {
							select: {
								id: true,
								first_name: true,
								last_name: true,
								email: true,
							},
						},
					},
				},
			},
		}),

		prisma.workflowTemplate.count({ where }),
	]);

	return {
		data,
		meta: {
			total,
			page,
			limit,
			totalPages: Math.ceil(total / limit),
		},
	};
};

export const getTemplateById = async (templateId: string) => {
	const template = await prisma.workflowTemplate.findUnique({
		where: { id: templateId },

		include: {
			workspace: {
				select: { id: true, name: true },
			},
			stages: {
				orderBy: { stageOrder: "asc" },
				include: {
					approvers: {
						include: {
							user: {
								select: {
									id: true,
									first_name: true,
									last_name: true,
									email: true,
								},
							},
						},
					},
				},
			},
		},
	});

	if (!template) {
		throw new ApiError(404, "Template not found");
	}

	return template;
};

// ─────────────────────────────────────────────────────────────────────────────
// selectTemplate
//
// ✅ NEW: only matches against isReusable templates — an ad-hoc, one-off
// template (isReusable: false) was scaffolding for a single run and should
// never be auto-selected for a different subject later.
// ─────────────────────────────────────────────────────────────────────────────

export const selectTemplate = async ({
	workspaceId,
}: {
	workspaceId: string;
}) => {
	const templates = await prisma.workflowTemplate.findMany({
		where: {
			workspaceId,
			isActive: true,
			isReusable: true,
		},
		orderBy: {
			created_at: "desc",
		},
		include: {
			stages: {
				include: {
					approvers: true,
				},
			},
		},
	});

	if (!templates.length) {
		throw new ApiError(404, "No matching workflow template found");
	}

	return templates[0]; // highest priority
};
