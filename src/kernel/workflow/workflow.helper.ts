import { prisma } from "@shared/config/prisma";
import {
	StageStatus,
	ApprovalStatus,
	Prisma,
} from "../../prisma/generated/prisma/client";
import ApiError from "@shared/utils/apiError";

// ─────────────────────────────────────────────────────────────────────────────
// forkTemplateForClarify
//
// Called when the proposer edits stages/approvers while resolving a Clarify.
// We never mutate the workflow's existing template in place — that template
// may be reused by other instances, and an in-place edit would silently
// change workflows that never asked for it.
//
// Instead: clone the template + its stages/approvers into a new one-off
// WorkflowTemplate (ownerType USER, isReusable false), apply the requested
// stage list onto the clone, and hand back its id/stages so the caller can
// repoint WorkflowInstance.templateId and read stages from the fork.
//
// `editedStages` is a FULL replacement list — same shape template
// create/update already accept — no partial-merge logic to maintain.
// ─────────────────────────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

export const forkTemplateForClarify = async (
	tx: Tx,
	originalTemplate: {
		name: string;
		description: string;
		workspaceId: string;
		appId: string;
		metaData_1: string;
		metaData_2: string;
		metaData_3: string;
	},
	editedStages: Array<{
		stageOrder: number;
		strategy: "ALL" | "ANY" | "SOME";
		minApprovals?: number | null;
		approvers: Array<{ approverId: string; isExternalApprover?: boolean }>;
	}>,
	userId: string,
) => {
	return tx.workflowTemplate.create({
		data: {
			name: `${originalTemplate.name} (edited)`,
			description: originalTemplate.description,
			workspaceId: originalTemplate.workspaceId,
			appId: originalTemplate.appId,
			metaData_1: originalTemplate.metaData_1,
			metaData_2: originalTemplate.metaData_2,
			metaData_3: originalTemplate.metaData_3,
			ownerType: "USER",
			isReusable: false,
			created_by_id: userId,
			updated_by_id: userId,
			stages: {
				create: editedStages.map((stage) => ({
					name: `Stage ${stage.stageOrder}`,
					stageOrder: stage.stageOrder,
					strategy: stage.strategy,
					minApprovals: stage.minApprovals ?? null,
					approvers: {
						create: stage.approvers.map((approver) => ({
							userId: approver.approverId,
							isExternalApprover: approver.isExternalApprover ?? false,
						})),
					},
				})),
			},
		},
		include: {
			stages: { include: { approvers: true }, orderBy: { stageOrder: "asc" } },
		},
	});
};

// ─────────────────────────────────────────────────────────────────────────────
// createIterationStages
//
// Materializes StageInstance + Approval rows for one iteration of a
// WorkflowInstance, from a resolved template's stages. Single place for this
// so callers (activate-stage: no-edit resubmit, edited-stage resubmit,
// template-swap resubmit) never hand-roll the same create loop three times.
//
// `activateFirst: true` flips stage 1 straight to IN_PROGRESS (the resubmit
// case). `activateFirst: false` leaves everything PENDING (the clarify-time
// draft case) — kept as a param rather than a second near-duplicate function.
// ─────────────────────────────────────────────────────────────────────────────

type TemplateStageInput = {
	name: string;
	stageOrder: number;
	strategy: "ALL" | "ANY" | "SOME";
	minApprovals?: number | null;
	approvers: Array<{ userId: string; isExternalApprover?: boolean }>;
};

export const createIterationStages = async (
	tx: Tx,
	params: {
		workflowId: string;
		iteration: number;
		templateStages: TemplateStageInput[];
		activateFirst: boolean;
	},
) => {
	const createdStages = [];
	let firstStageInstanceId: string | undefined;

	for (const templateStage of params.templateStages) {
		const isFirstStage = templateStage.stageOrder === 1;
		const shouldActivate = isFirstStage && params.activateFirst;

		const stage = await tx.stageInstance.create({
			data: {
				stageName: templateStage.name,
				workflowId: params.workflowId,
				stageOrder: templateStage.stageOrder,
				iteration: params.iteration,
				isCurrentIteration: true,
				strategy: templateStage.strategy,
				minApprovals: templateStage.minApprovals ?? null,
				status: shouldActivate ? "IN_PROGRESS" : "PENDING",
				startedAt: shouldActivate ? new Date() : null,
				approvals: {
					create: templateStage.approvers.map((a) => ({
						approverId: a.userId,
						status: "PENDING",
						isExternalApprover: a.isExternalApprover ?? false,
					})),
				},
			},
			include: { approvals: true },
		});

		createdStages.push(stage);
		if (isFirstStage) firstStageInstanceId = stage.id;
	}

	return { createdStages, firstStageInstanceId };
};

// ─────────────────────────────────────────────────────────────────────────────
// assertTemplateAssignable
//
// Same eligibility rule attachWorkflowController's Case A already enforces
// for "attach an existing reusable template" — pulled out here so
// activateFirstStageController's template-swap-on-resubmit path can reuse it
// instead of re-deriving the same checks.
// ─────────────────────────────────────────────────────────────────────────────

export const assertTemplateAssignable = async (
	tx: Tx,
	params: {
		templateId: string;
		appId: string;
		userId: string;
		isSuperAdmin: boolean;
	},
) => {
	const template = await tx.workflowTemplate.findUnique({
		where: { id: params.templateId },
		include: {
			stages: { include: { approvers: true }, orderBy: { stageOrder: "asc" } },
		},
	});

	if (!template) throw new ApiError(404, "Workflow template not found");
	// if (!template.isActive || !template.isReusable) {
	//   throw new ApiError(400, "This template is not available for use");
	// }
	if (!template.isActive) {
		throw new ApiError(400, "This template is not available for use");
	}
	if (template.appId !== params.appId) {
		throw new ApiError(
			400,
			"This template belongs to a different app than this record",
		);
	}

	if (!params.isSuperAdmin) {
		const isAssigned = await tx.workFlowTemplateUser.findUnique({
			where: {
				templateId_userId: {
					templateId: params.templateId,
					userId: params.userId,
				},
			},
		});
		if (!isAssigned) {
			throw new ApiError(403, "You are not assigned to this workflow template");
		}
	}

	return template;
};

export const buildWorkflowStages = (templateStages: any[]) => {
	return templateStages.map((stage: any) => ({
		name: stage.name,
		stageOrder: stage.stageOrder,
		strategy: stage.strategy,
		minApprovals: stage.minApprovals,
		stageName: stage.name,
		status:
			stage.stageOrder === 1 ? StageStatus.IN_PROGRESS : StageStatus.PENDING,

		approvals: {
			create: stage.approvers.map((a: any) => ({
				approverId: a.userId,
				status: ApprovalStatus.PENDING,
				isExternalApprover: a.isExternalApprover,
			})),
		},
	}));
};

export const approveStage = async ({
	stageId,
	userId,
}: {
	stageId: string;
	userId: string;
}) => {
	return prisma.$transaction(async (tx) => {
		// 1. Mark approval
		await tx.approval.update({
			where: {
				stageId_approverId: {
					stageId,
					approverId: userId,
				},
			},
			data: {
				status: "APPROVED",
				actedAt: new Date(),
			},
		});

		const stage = await tx.stageInstance.findUnique({
			where: { id: stageId },
			include: { approvals: true, workflow: true },
		});

		const approvedCount = stage!.approvals.filter(
			(a) => a.status === "APPROVED",
		).length;

		const total = stage!.approvals.length;

		let isStageApproved = false;

		switch (stage!.strategy) {
			case "ALL":
				isStageApproved = approvedCount === total;
				break;
			case "ANY":
				isStageApproved = approvedCount >= 1;
				break;
			case "SOME":
				isStageApproved = approvedCount >= (stage!.minApprovals || 1);
				break;
		}

		if (!isStageApproved) return;

		// 2. Approve stage
		await tx.stageInstance.update({
			where: { id: stageId },
			data: { status: "APPROVED" },
		});

		// 3. Move to next stage
		const nextStage = await tx.stageInstance.findFirst({
			where: {
				workflowId: stage!.workflowId,
				stageOrder: stage!.stageOrder + 1,
			},
		});

		if (nextStage) {
			await tx.stageInstance.update({
				where: { id: nextStage.id },
				data: { status: "IN_PROGRESS" },
			});

			await tx.workflowInstance.update({
				where: { id: stage!.workflowId },
				data: { currentStage: nextStage.stageOrder },
			});
		} else {
			// final stage
			await tx.workflowInstance.update({
				where: { id: stage!.workflowId },
				data: { status: "APPROVED" },
			});
		}
	});
};
