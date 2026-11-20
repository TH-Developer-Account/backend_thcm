// cpp.submit.controller.ts — submit a draft: pick the band, build the stages from
// the approval matrix, create ONE workflow (WF1 then WF2) and start it.
// GET  /cpp/:id/approval-preview  -> what would happen, nothing is written
// POST /cpp/:id/submit            -> does it
import { type NextFunction, type Request, type Response } from "express";
import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import { createWorkflowTemplate } from "@kernel/workflow/template.service";
import { createIterationStages } from "@kernel/workflow/workflow.helper";
import { notifyStageApprovers } from "@kernel/workflow/workflow.service";

import { CPP_APP_KEY, CPP_LOG_SUBJECT, CPP_STATUS } from "./cpp.constants";
import { rowsToSlotMap } from "./cpp.helper";
import { getConditionDef } from "./cpp.rules";
import {
	previewStagesForPlan,
	resolveTemplatesForPlan,
	type EffectiveStage,
} from "./cpp.template.sync";
import { buildCppApprovalPlan, type PlanResult } from "./cpp.workflow";

type PlanOk = Extract<PlanResult, { ok: true }>;
type PlanFail = Extract<PlanResult, { ok: false }>;

const str = (value: unknown): string =>
	typeof value === "string" ? value.trim() : "";
const asObject = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/** Loads the request (own request, same workspace). */
const loadForSubmit = async (req: Request) => {
	const userId = req.user?.id;
	const workspaceId = req.user?.workspaceId;
	if (!userId || !workspaceId) throw new ApiError(401, "Unauthorized");

	const request = await prisma.cppRequest.findUnique({
		where: { id: req.params.id as string },
	});
	if (!request || request.workspaceId !== workspaceId)
		throw new ApiError(404, "CPP request not found");
	if (request.initiatedById !== userId)
		throw new ApiError(
			403,
			"Only the person who created this request can submit it",
		);
	if (request.status !== CPP_STATUS.DRAFT)
		throw new ApiError(409, "This request has already been submitted");

	return { request, userId, workspaceId };
};

type RequestRow = Awaited<ReturnType<typeof loadForSubmit>>["request"];

/* ------------------------- completeness (routing) ------------------------- */

const ROUTING = "It decides the approval workflow.";

/** Works for Prisma Decimal, number, string or null. */
const positive = (value: unknown): boolean => {
	if (value === null || value === undefined || value === "") return false;
	const n = Number(String(value));
	return Number.isFinite(n) && n > 0;
};

const AMOUNT_LABEL = {
	ANNUALISED_VALUE: "annualised value",
	ANNUALISED_IMPACT: "annualised impact",
	ACTUAL_IMPACT: "actual impact",
} as const;

/** What must be filled before a request can enter approval. */
const completenessProblems = (request: RequestRow): string[] => {
	const problems: string[] = [];
	if (!request.category) problems.push(`Category is required. ${ROUTING}`);
	if (!request.plant) problems.push(`Plant is required. ${ROUTING}`);
	if (!request.condition) problems.push(`Condition is required. ${ROUTING}`);

	const sections = Array.isArray(request.sections) ? request.sections : [];
	const data = (key: string) =>
		asObject(asObject(sections.find((s) => asObject(s).key === key)).data);
	const basic = data("basic");
	const purchasing = data("purchasing");

	if (!str(basic.reason)) problems.push("Reason is required.");
	if (!str(basic.justification)) problems.push("Justification is required.");
	const recommended = asObject(asObject(purchasing.suppliers).recommended);
	if (!str(recommended.name) && !str(recommended.code))
		problems.push("A recommended supplier is required.");

	// Band values: only the ones the condition reads (derived columns on the row,
	// filled by buildCppData from the Financial impact section on every save).
	const def = request.condition
		? getConditionDef(request.condition)
		: undefined;
	if (def) {
		if (def.partBasis === "PART_VALUE" && !positive(request.maxPartValue))
			problems.push(`The highest value per part is required. ${ROUTING}`);
		if (def.partBasis === "VARIATION_PCT" && !positive(request.maxVariationPct))
			problems.push(`The highest price variation % is required. ${ROUTING}`);
		const amount =
			def.amountBasis === "ANNUALISED_VALUE"
				? request.annualisedValue
				: def.amountBasis === "ANNUALISED_IMPACT"
					? request.annualisedImpact
					: request.actualImpact;
		if (!positive(amount))
			problems.push(
				`The ${AMOUNT_LABEL[def.amountBasis]} total on the Financial impact step is required and cannot be 0. ${ROUTING}`,
			);
	}
	return problems;
};

const planFor = async (
	request: RequestRow,
	workspaceId: string,
): Promise<PlanResult> => {
	const rows = await prisma.cppSlotAssignment.findMany({
		where: { workspaceId },
	});
	const text = (v: unknown) =>
		v === null || v === undefined ? null : String(v);
	return buildCppApprovalPlan({
		category: request.category ?? "",
		plant: request.plant ?? "",
		condition: request.condition ?? "",
		maxPartValue: text(request.maxPartValue),
		maxVariationPct: text(request.maxVariationPct),
		annualisedValue: text(request.annualisedValue),
		annualisedImpact: text(request.annualisedImpact),
		actualImpact: text(request.actualImpact),
		slots: rowsToSlotMap(rows),
	});
};

const withNames = async (plan: PlanOk, stages: EffectiveStage[]) => {
	const ids = [
		...new Set([
			...stages.flatMap((s) => s.approvers.map((a) => a.userId)),
			...plan.priceFeedingUserIds,
		]),
	];
	const users = await prisma.user.findMany({
		where: { id: { in: ids } },
		select: { id: true, first_name: true, last_name: true, email: true },
	});
	const byId = new Map(
		users.map((u) => [
			u.id,
			{
				id: u.id,
				name: `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim(),
				email: u.email,
			},
		]),
	);
	const people = (list: string[]) =>
		list.map((id) => byId.get(id) ?? { id, name: id, email: null });
	return {
		ruleId: plan.ruleId,
		bandLabel: plan.bandLabel,
		level: plan.level,
		warnings: plan.warnings,
		stages: stages.map((s) => ({
			order: s.stageOrder,
			name: s.name,
			phase: s.phase,
			strategy: s.strategy,
			minApprovals: s.minApprovals,
			approvers: people(s.approvers.map((a) => a.userId)),
		})),
		priceFeeding: people(plan.priceFeedingUserIds),
	};
};

// GET /cpp/:id/approval-preview — read-only; safe to call any time.
export const previewCppApproval = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const { request, workspaceId } = await loadForSubmit(req);

		const problems = completenessProblems(request);
		if (problems.length) {
			res.status(200).json({ success: true, data: { ok: false, problems } });
			return;
		}

		const plan = await planFor(request, workspaceId);
		if (!plan.ok) {
			res.status(200).json({
				success: true,
				data: { ok: false, problems: (plan as PlanFail).problems },
			});
			return;
		}
		const app = await prisma.app.findFirst({
			where: { key: CPP_APP_KEY },
			select: { id: true },
		});
		const stages = app
			? await previewStagesForPlan(plan as PlanOk, {
					workspaceId,
					appId: app.id,
				})
			: (plan as PlanOk).stages.map((s) => ({
					name: s.name,
					stageOrder: s.stageOrder,
					strategy: s.strategy,
					minApprovals: s.minApprovals ?? null,
					approvers: s.approverIds.map((id) => ({
						userId: id,
						isExternalApprover: false,
					})),
					phase: s.phase,
				}));
		res.status(200).json({
			success: true,
			data: { ok: true, ...(await withNames(plan as PlanOk, stages)) },
		});
	} catch (error) {
		next(error);
	}
};

// POST /cpp/:id/submit
export const submitCppRequest = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	let adHocTemplateId: string | null = null;
	try {
		const { request, userId, workspaceId } = await loadForSubmit(req);

		const missing = completenessProblems(request);
		if (missing.length)
			throw new ApiError(400, `Cannot submit yet: ${missing.join(" ")}`);

		const planResult = await planFor(request, workspaceId);
		if (!planResult.ok)
			throw new ApiError(
				422,
				`Cannot start the approval: ${(planResult as PlanFail).problems.join(" ")}`,
			);
		const plan = planResult as PlanOk;

		const app = await prisma.app.findFirst({
			where: { key: CPP_APP_KEY },
			select: { id: true },
		});
		if (!app)
			throw new ApiError(500, "CPP app is not set up (seed the app first)");

		// The ONE reusable template of this band (its stages are tagged WF1, and WF2 for committee
		// bands). The matrix save creates it; if it does not exist yet it is created here from the
		// matrix. The request uses the template as it is NOW, including any edit an admin made.
		let templateId: string;
		let stages: EffectiveStage[];
		try {
			const resolved = await resolveTemplatesForPlan(plan, {
				workspaceId,
				appId: app.id,
				actorId: userId,
			});
			if (resolved.problems.length)
				throw new ApiError(
					422,
					`Cannot start the approval: ${resolved.problems.join(" ")}`,
				);
			templateId = resolved.templateId;
			stages = resolved.stages;
		} catch (templateError) {
			if (templateError instanceof ApiError) throw templateError;
			// Never leave a request stuck because the shared templates could not be
			// read: fall back to a private one-off copy of the matrix chain.
			console.error(
				"CPP: shared templates unavailable, using a one-off template",
				templateError,
			);
			const fallback = await createWorkflowTemplate(
				{
					name: `CPP ${request.referenceNumber} — ${plan.ruleId}`,
					description: plan.bandLabel,
					workspaceId,
					appId: app.id,
					metaData_1: plan.ruleId,
					metaData_2: "",
					metaData_3: "CPP_ONE_OFF",
					isReusable: false,
					stages: plan.stages.map((s) => ({
						name: s.name,
						stageOrder: s.stageOrder,
						strategy: s.strategy,
						minApprovals: s.minApprovals,
						approverIds: s.approverIds.map((id) => ({ userId: id })),
					})),
				},
				userId,
				"USER",
			);
			templateId = fallback.id;
			adHocTemplateId = fallback.id;
			stages = plan.stages.map((s) => ({
				name: s.name,
				stageOrder: s.stageOrder,
				strategy: s.strategy,
				minApprovals: s.minApprovals ?? null,
				approvers: s.approverIds.map((id) => ({
					userId: id,
					isExternalApprover: false,
				})),
				phase: s.phase,
			}));
		}

		const result = await prisma.$transaction(async (tx) => {
			// Claim the draft first: a double click or a second tab loses here.
			const claimed = await tx.cppRequest.updateMany({
				where: { id: request.id, status: CPP_STATUS.DRAFT },
				data: { status: CPP_STATUS.IN_PROGRESS, submittedAt: new Date() },
			});
			if (claimed.count === 0)
				throw new ApiError(409, "This request has already been submitted");

			const workflow = await tx.workflowInstance.create({
				data: {
					templateId,
					workspaceId,
					appId: app.id,
					subjectType: "CPP_REQUEST",
					subjectId: request.id,
					currentStage: 1,
					iteration: 1,
					isActive: true,
					workflowType: "STANDARD",
				},
			});

			const { createdStages, firstStageInstanceId } =
				await createIterationStages(tx, {
					workflowId: workflow.id,
					iteration: 1,
					templateStages: stages.map((s) => ({
						name: s.name,
						stageOrder: s.stageOrder,
						strategy: s.strategy,
						minApprovals: s.minApprovals,
						approvers: s.approvers,
					})),
					activateFirst: true,
				});

			await tx.activityLog.create({
				data: {
					subjectType: CPP_LOG_SUBJECT.REQUEST,
					subjectId: request.id,
					actorId: userId,
					action: "CPP_SUBMITTED",
					workflowId: workflow.id,
					metadata: {
						ruleId: plan.ruleId,
						templateId,
						sharedTemplate: adHocTemplateId === null,
						band: plan.bandLabel,
						level: plan.level,
						stages: stages.map((s) => ({
							order: s.stageOrder,
							name: s.name,
							approverIds: s.approvers.map((a) => a.userId),
						})),
						priceFeedingUserIds: plan.priceFeedingUserIds,
					},
				},
			});

			return {
				workflowId: workflow.id,
				firstStageId: firstStageInstanceId,
				firstStageApproverIds:
					createdStages
						.find((s) => s.id === firstStageInstanceId)
						?.approvals.map((a) => a.approverId) ?? [],
			};
		});

		// Notify only after the commit, like every other workflow in this app.
		if (result.firstStageId)
			await notifyStageApprovers({
				workflowId: result.workflowId,
				subjectType: "CPP_REQUEST",
				subjectId: request.id,
				appId: app.id,
				stageId: result.firstStageId,
				approverIds: result.firstStageApproverIds,
			}).catch(() => undefined); // a mail problem must not undo a successful submit

		res.status(200).json({
			success: true,
			message: "CPP request submitted for approval",
			data: {
				workflowId: result.workflowId,
				ruleId: plan.ruleId,
				stages: stages.length,
			},
		});
	} catch (error) {
		// Only a one-off fallback template is removed; shared templates are kept.
		if (adHocTemplateId)
			await prisma.workflowTemplate
				.delete({ where: { id: adHocTemplateId } })
				.catch(() => undefined);
		next(error);
	}
};

/* ------------------------------- resubmit -------------------------------- */
// POST /cpp/:id/resubmit — after an approver asked for a clarification, the proposer
// edits the request (every tab) and sends it again. The SAME workflow instance restarts
// at stage 1 of the same iteration the clarification drafted. The stages are rebuilt from the
// template of the CURRENT band, so a changed category / plant / condition / amount (or a
// changed approval matrix) lands on the right approvers. Nothing is approved twice.
export const resubmitCppRequest = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const userId = req.user?.id;
		const workspaceId = req.user?.workspaceId;
		if (!userId || !workspaceId) throw new ApiError(401, "Unauthorized");

		const request = await prisma.cppRequest.findUnique({
			where: { id: req.params.id as string },
		});
		if (!request || request.workspaceId !== workspaceId)
			throw new ApiError(404, "CPP request not found");
		if (request.initiatedById !== userId)
			throw new ApiError(
				403,
				"Only the person who created this request can resubmit it",
			);
		if (request.status !== CPP_STATUS.CLARIFICATION_REQUESTED)
			throw new ApiError(
				409,
				"This request is not waiting for a clarification",
			);

		const missing = completenessProblems(request);
		if (missing.length)
			throw new ApiError(400, `Cannot resubmit yet: ${missing.join(" ")}`);

		const planResult = await planFor(request, workspaceId);
		if (!planResult.ok)
			throw new ApiError(
				422,
				`Cannot restart the approval: ${(planResult as PlanFail).problems.join(" ")}`,
			);
		const plan = planResult as PlanOk;

		const app = await prisma.app.findFirst({
			where: { key: CPP_APP_KEY },
			select: { id: true },
		});
		if (!app)
			throw new ApiError(500, "CPP app is not set up (seed the app first)");

		const resolved = await resolveTemplatesForPlan(plan, {
			workspaceId,
			appId: app.id,
			actorId: userId,
		});
		if (resolved.problems.length)
			throw new ApiError(
				422,
				`Cannot restart the approval: ${resolved.problems.join(" ")}`,
			);
		const { templateId, stages } = resolved;

		const result = await prisma.$transaction(async (tx) => {
			const workflow = await tx.workflowInstance.findFirst({
				where: {
					subjectType: "CPP_REQUEST",
					subjectId: request.id,
					isActive: true,
				},
				orderBy: { created_at: "desc" },
				include: { stages: { where: { isCurrentIteration: true } } },
			});
			if (!workflow)
				throw new ApiError(
					409,
					"This request has no active workflow to resubmit",
				);
			if (workflow.stages.some((stage) => stage.status === "IN_PROGRESS"))
				throw new ApiError(
					409,
					"The approval is already running for this request",
				);

			// Claim it first: a double click or a second tab loses here.
			const claimed = await tx.cppRequest.updateMany({
				where: { id: request.id, status: CPP_STATUS.CLARIFICATION_REQUESTED },
				data: { status: CPP_STATUS.IN_PROGRESS },
			});
			if (claimed.count === 0)
				throw new ApiError(409, "This request has already been resubmitted");

			// The draft the clarification built is stale now: replace it with the current band's stages.
			await tx.stageInstance.deleteMany({
				where: {
					workflowId: workflow.id,
					isCurrentIteration: true,
					iteration: workflow.iteration,
				},
			});
			await tx.workflowInstance.update({
				where: { id: workflow.id },
				data: { templateId, currentStage: 1 },
			});

			const { createdStages, firstStageInstanceId } =
				await createIterationStages(tx, {
					workflowId: workflow.id,
					iteration: workflow.iteration,
					templateStages: stages.map((s) => ({
						name: s.name,
						stageOrder: s.stageOrder,
						strategy: s.strategy,
						minApprovals: s.minApprovals,
						approvers: s.approvers,
					})),
					activateFirst: true,
				});

			await tx.activityLog.create({
				data: {
					subjectType: CPP_LOG_SUBJECT.REQUEST,
					subjectId: request.id,
					actorId: userId,
					action: "CPP_RESUBMITTED",
					workflowId: workflow.id,
					metadata: {
						ruleId: plan.ruleId,
						templateId,
						band: plan.bandLabel,
						level: plan.level,
						iteration: workflow.iteration,
						stages: stages.map((s) => ({
							order: s.stageOrder,
							name: s.name,
							approverIds: s.approvers.map((a) => a.userId),
						})),
					},
				},
			});

			return {
				workflowId: workflow.id,
				firstStageId: firstStageInstanceId,
				firstStageApproverIds:
					createdStages
						.find((s) => s.id === firstStageInstanceId)
						?.approvals.map((a) => a.approverId) ?? [],
			};
		});

		if (result.firstStageId)
			await notifyStageApprovers({
				workflowId: result.workflowId,
				subjectType: "CPP_REQUEST",
				subjectId: request.id,
				appId: app.id,
				stageId: result.firstStageId,
				approverIds: result.firstStageApproverIds,
			}).catch(() => undefined);

		res.status(200).json({
			success: true,
			message: "CPP request resubmitted for approval",
			data: {
				workflowId: result.workflowId,
				ruleId: plan.ruleId,
				stages: stages.length,
			},
		});
	} catch (error) {
		next(error);
	}
};
