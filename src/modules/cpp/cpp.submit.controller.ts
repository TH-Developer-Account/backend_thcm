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

/** What must be filled before a request can enter approval. */
const completenessProblems = (request: RequestRow): string[] => {
	const problems: string[] = [];
	if (!request.category) problems.push("Category is required.");
	if (!request.plant) problems.push("Plant is required.");
	if (!request.condition) problems.push("Condition is required.");

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

const withNames = async (plan: PlanOk) => {
	const ids = [
		...new Set([
			...plan.stages.flatMap((s) => s.approverIds),
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
		stages: plan.stages.map((s) => ({
			order: s.stageOrder,
			name: s.name,
			phase: s.phase,
			strategy: s.strategy,
			minApprovals: s.minApprovals ?? null,
			approvers: people(s.approverIds),
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
		res.status(200).json({
			success: true,
			data: { ok: true, ...(await withNames(plan as PlanOk)) },
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

		// One-off template that records exactly who was in each seat today.
		// Later matrix changes never rewrite this request's chain by accident.
		const template = await createWorkflowTemplate(
			{
				name: `CPP ${request.referenceNumber} — ${plan.ruleId}`,
				description: plan.bandLabel,
				workspaceId,
				appId: app.id,
				metaData_1: plan.ruleId,
				metaData_2: "",
				metaData_3: "",
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
		adHocTemplateId = template.id;

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
					templateId: template.id,
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
					templateStages: plan.stages.map((s) => ({
						name: s.name,
						stageOrder: s.stageOrder,
						strategy: s.strategy,
						minApprovals: s.minApprovals,
						approvers: s.approverIds.map((id) => ({ userId: id })),
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
						band: plan.bandLabel,
						level: plan.level,
						stages: plan.stages.map((s) => ({
							order: s.stageOrder,
							name: s.name,
							approverIds: s.approverIds,
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
				stages: plan.stages.length,
			},
		});
	} catch (error) {
		// Nothing was created for this request: remove the unused one-off template.
		if (adHocTemplateId)
			await prisma.workflowTemplate
				.delete({ where: { id: adHocTemplateId } })
				.catch(() => undefined);
		next(error);
	}
};
