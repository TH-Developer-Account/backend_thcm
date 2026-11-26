// cpp.workflow.service.ts — everything that touches the database for CPP approvals.
// (cpp.template.sync.ts and the logic of cpp.submit.controller.ts merged in here.)
//
//   TEMPLATES   The reusable approval templates and the approval matrix.
//     Admin saves the matrix the first time    -> the templates are CREATED from it
//     Admin changes a seat / replaces a person -> that person is swapped inside the templates
//                                                 (everything else in a template stays as edited)
//     A request is submitted                   -> it uses the templates as they are now
//     Templates can be edited in the Workflows screen. A request copies its approvers into its
//     own workflow when it is submitted, so editing a template never changes a request's history.
//     (Requests still waiting on a stage do pick up approver changes made to the WF1 template:
//     that is how a leaver is replaced.) Only workflow templates are written here: never user
//     records, profiles or permissions.
//
//   SUBMIT      preview / submit / resubmit: pick the band, build the stages from the matrix,
//     create ONE workflow (WF1 then WF2) and start it.
//
// The plan itself (which band, which seats) is pure and lives in cpp.workflow.ts. The checks
// that need no database (completeness, summary plants) live in cpp.helper.ts. No Express here:
// the controller passes plain values in and sends what comes back.
import type { Prisma } from "../../prisma/generated/prisma/client";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import {
	createWorkflowTemplate,
	updateTemplate,
} from "@kernel/workflow/template.service";
import {
	createIterationStages,
	type ReconcileNotification,
} from "@kernel/workflow/workflow.helper";
import { notifyStageApprovers } from "@kernel/workflow/workflow.service";

import {
	CPP_APP_KEY,
	CPP_LOG_SUBJECT,
	CPP_STATUS,
	CPP_SUBJECT_TYPE,
} from "./cpp.constants";
import {
	type SlotMap,
	completenessProblems,
	rowsToSlotMap,
	summaryPlantProblems,
} from "./cpp.helper";
import { readStoredPartSummary } from "./cpp.sheet";
import {
	CPP_TEMPLATE_TAG,
	type CatalogEntry,
	type Phase,
	type PlanOk,
	type PlanStage,
	buildCppApprovalPlan,
	desiredTemplates,
	getTemplateCatalog,
	planInputOf,
	splitByPhase,
	templateKey,
} from "./cpp.workflow";

type Ctx = { workspaceId: string; appId: string; actorId: string };

type StageDef = {
	name: string;
	stageOrder: number;
	strategy: "ALL" | "ANY" | "SOME";
	minApprovals: number | null;
	approvers: Array<{ userId: string; isExternalApprover: boolean }>;
};

/** A template stage as a request will use it. */
export type EffectiveStage = StageDef & { phase: Phase };

const unique = (ids: string[]) => [...new Set(ids)];

const toStageDefs = (stages: PlanStage[]): StageDef[] =>
	stages.map((stage) => ({
		name: stage.name,
		stageOrder: stage.stageOrder,
		strategy: stage.strategy,
		minApprovals: stage.minApprovals ?? null,
		approvers: unique(stage.approverIds).map((userId) => ({
			userId,
			isExternalApprover: false,
		})),
	}));

/** The app row is created by the seed; every CPP call needs its id. */
const getCppAppId = async (): Promise<string> => {
	const app = await prisma.app.findFirst({
		where: { key: CPP_APP_KEY },
		select: { id: true },
	});
	if (!app)
		throw new ApiError(500, "CPP app is not set up (seed the app first)");
	return app.id;
};

/* ============================== templates ============================== */

const templateInclude = {
	stages: {
		include: { approvers: true },
		orderBy: { stageOrder: "asc" as const },
	},
};
type ManagedTemplate = Prisma.WorkflowTemplateGetPayload<{
	include: typeof templateInclude;
}>;

const keyOf = (t: { metaData_1: string; metaData_2: string }) =>
	`${t.metaData_1}|${t.metaData_2}`;

/** A stored template's stages, numbered after `offset` stages that come before it. */
const effectiveStages = (
	template: ManagedTemplate,
	phase: Phase,
	offset: number,
): EffectiveStage[] =>
	template.stages.map((stage) => ({
		name: stage.name,
		stageOrder: offset + stage.stageOrder,
		strategy: stage.strategy as StageDef["strategy"],
		minApprovals: stage.minApprovals ?? null,
		approvers: stage.approvers.map((a) => ({
			userId: a.userId,
			isExternalApprover: a.isExternalApprover,
		})),
		phase,
	}));

const sendNotifications = async (list: ReconcileNotification[]) => {
	for (const n of list)
		await notifyStageApprovers({
			workflowId: n.workflowId,
			subjectType: n.subjectType,
			subjectId: n.subjectId,
			appId: n.appId,
			stageId: n.stageId,
			approverIds: n.newApproverIds,
		}).catch(() => undefined); // a mail problem must never undo a saved matrix
};

/**
 * Finds the template of this shape; creates it (from `stages`) if it does not exist.
 * An existing template is never changed here. The find-or-create runs under a lock on
 * the key, so two saves or submits at the same time cannot create it twice.
 */
const findOrCreate = async (
	entry: CatalogEntry,
	stages: StageDef[],
	ctx: Ctx,
): Promise<{ template: ManagedTemplate; created: boolean }> =>
	prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cpp-template:${ctx.workspaceId}:${entry.key}`}))`;
		const current = await tx.workflowTemplate.findFirst({
			where: {
				workspaceId: ctx.workspaceId,
				appId: ctx.appId,
				metaData_1: entry.phase,
				metaData_2: entry.hash,
				metaData_3: CPP_TEMPLATE_TAG,
			},
			include: templateInclude,
		});
		if (current) return { template: current, created: false };

		const created = await tx.workflowTemplate.create({
			data: {
				name: entry.name,
				description: entry.description,
				workspaceId: ctx.workspaceId,
				appId: ctx.appId,
				ownerType: "ADMIN",
				isReusable: true,
				isActive: true,
				metaData_1: entry.phase,
				metaData_2: entry.hash,
				metaData_3: CPP_TEMPLATE_TAG,
				created_by_id: ctx.actorId,
				updated_by_id: ctx.actorId,
				stages: {
					create: stages.map((stage) => ({
						name: stage.name,
						stageOrder: stage.stageOrder,
						strategy: stage.strategy,
						minApprovals: stage.minApprovals,
						approvers: {
							create: stage.approvers.map((a) => ({
								userId: a.userId,
								isExternalApprover: a.isExternalApprover,
							})),
						},
					})),
				},
			},
			include: templateInclude,
		});
		return { template: created, created: true };
	});

/**
 * The templates a request will use (WF1, and WF2 when its band has a committee), created
 * from the matrix if they do not exist yet, and the stages they hold RIGHT NOW (edited or not),
 * numbered continuously: WF1 stages first, then WF2.
 */
const resolveTemplatesForPlan = async (
	plan: { stages: PlanStage[] },
	ctx: Ctx,
): Promise<{
	templateId: string;
	stages: EffectiveStage[];
	problems: string[];
}> => {
	const parts = splitByPhase(plan.stages);
	const catalog = getTemplateCatalog();
	const stages: EffectiveStage[] = [];
	let templateId = "";

	for (const phase of ["WF1", "WF2"] as Phase[]) {
		if (parts[phase].length === 0) continue;
		const entry = catalog.get(templateKey(phase, parts[phase]));
		if (!entry) throw new Error(`No template definition for ${phase}`);
		const { template } = await findOrCreate(
			entry,
			toStageDefs(parts[phase]),
			ctx,
		);
		if (phase === "WF1") templateId = template.id;
		stages.push(...effectiveStages(template, phase, stages.length));
	}

	// A template edited into an unusable state must stop the submit with a clear message.
	const problems: string[] = [];
	for (const stage of stages) {
		if (stage.approvers.length === 0)
			problems.push(`${stage.name}: the template has no approver in this stage.`);
		else if (
			stage.strategy === "SOME" &&
			stage.approvers.length < (stage.minApprovals ?? 1)
		)
			problems.push(
				`${stage.name}: needs ${stage.minApprovals} approvers but the template has ${stage.approvers.length}.`,
			);
	}
	return { templateId, stages, problems };
};

/** Read-only twin of resolveTemplatesForPlan for the preview: never creates anything. */
const previewStagesForPlan = async (
	plan: { stages: PlanStage[] },
	ctx: { workspaceId: string; appId: string },
): Promise<EffectiveStage[]> => {
	const parts = splitByPhase(plan.stages);
	const catalog = getTemplateCatalog();
	const stages: EffectiveStage[] = [];

	for (const phase of ["WF1", "WF2"] as Phase[]) {
		if (parts[phase].length === 0) continue;
		const entry = catalog.get(templateKey(phase, parts[phase]));
		const template = entry
			? await prisma.workflowTemplate.findFirst({
					where: {
						workspaceId: ctx.workspaceId,
						appId: ctx.appId,
						metaData_1: phase,
						metaData_2: entry.hash,
						metaData_3: CPP_TEMPLATE_TAG,
					},
					include: templateInclude,
				})
			: null;

		const offset = stages.length;
		if (template) stages.push(...effectiveStages(template, phase, offset));
		else
			for (const stage of toStageDefs(parts[phase]))
				stages.push({ ...stage, stageOrder: offset + stage.stageOrder, phase });
	}
	return stages;
};

/* ------------------------- matrix screen: sync ------------------------- */

export type TemplateSyncReport = {
	created: number;
	/** Existing templates where a changed seat was swapped in. */
	updated: number;
	unchanged: number;
	/** Templates that cannot be created yet (an empty seat, committee smaller than 3). */
	notReady: number;
	notReadyExamples: Array<{ name: string; problems: string[] }>;
	errors: string[];
};

const seatUsers = (map: SlotMap, seats: string[]) =>
	unique(seats.flatMap((seat) => map.get(seat) ?? []));

/**
 * One seat changed in the matrix -> swap exactly that change inside the templates that use
 * the seat. Anything else an admin edited in a template is left alone.
 */
const swapSeatChanges = (
	template: ManagedTemplate,
	entry: CatalogEntry,
	before: SlotMap,
	after: SlotMap,
): StageDef[] | null => {
	let changed = false;
	const next: StageDef[] = template.stages.map((stage) => {
		const seats = entry.stageSeats[stage.stageOrder - 1] ?? [];
		const was = seatUsers(before, seats);
		const now = seatUsers(after, seats);
		const removed = was.filter((id) => !now.includes(id));
		const added = now.filter((id) => !was.includes(id));
		const touched = seats.length > 0 && (removed.length > 0 || added.length > 0);

		let approvers = stage.approvers.map((a) => ({
			userId: a.userId,
			isExternalApprover: a.isExternalApprover,
		}));
		let strategy = stage.strategy as StageDef["strategy"];

		if (touched) {
			const kept = approvers.filter((a) => !removed.includes(a.userId));
			const fresh = added
				.filter((id) => !kept.some((a) => a.userId === id))
				.map((userId) => ({ userId, isExternalApprover: false }));
			approvers = [...kept, ...fresh];
			// One person = they must approve; several = any one of them (a committee stays SOME).
			if (strategy === "ALL" && approvers.length > 1) strategy = "ANY";
			if (strategy === "ANY" && approvers.length === 1) strategy = "ALL";
			changed = true;
		}

		return {
			name: stage.name,
			stageOrder: stage.stageOrder,
			strategy,
			minApprovals: stage.minApprovals ?? null,
			approvers,
		};
	});
	return changed ? next : null;
};

const runSync = async (args: {
	workspaceId: string;
	actorId: string;
	/** The matrix BEFORE this change. Omit to only create missing templates. */
	before?: SlotMap;
}): Promise<TemplateSyncReport> => {
	const report: TemplateSyncReport = {
		created: 0,
		updated: 0,
		unchanged: 0,
		notReady: 0,
		notReadyExamples: [],
		errors: [],
	};

	const app = await prisma.app.findFirst({
		where: { key: CPP_APP_KEY },
		select: { id: true },
	});
	if (!app) {
		report.errors.push("The CPP app is not set up, so no templates were created.");
		return report;
	}
	const ctx: Ctx = {
		workspaceId: args.workspaceId,
		actorId: args.actorId,
		appId: app.id,
	};

	const rows = await prisma.cppSlotAssignment.findMany({
		where: { workspaceId: ctx.workspaceId },
	});
	const after = rowsToSlotMap(rows);
	const catalog = getTemplateCatalog();

	const managed = await prisma.workflowTemplate.findMany({
		where: {
			workspaceId: ctx.workspaceId,
			appId: ctx.appId,
			metaData_3: CPP_TEMPLATE_TAG,
		},
		include: templateInclude,
	});
	const existingKeys = new Set(managed.map(keyOf));
	const notifications: ReconcileNotification[] = [];
	const failure = (name: string, error: unknown, fallback: string) => {
		if (report.errors.length < 5)
			report.errors.push(
				`${name}: ${error instanceof Error ? error.message : fallback}`,
			);
	};

	// 1. Existing templates: swap in what changed in the matrix.
	for (const template of managed) {
		const entry = catalog.get(keyOf(template));
		const stages =
			entry && args.before
				? swapSeatChanges(template, entry, args.before, after)
				: null;
		if (!entry || !stages) {
			report.unchanged++;
			continue;
		}
		try {
			const result = await updateTemplate(
				template.id,
				{
					stages: stages.map((stage) => ({
						name: stage.name,
						stageOrder: stage.stageOrder,
						strategy: stage.strategy,
						minApprovals: stage.minApprovals ?? undefined,
						approverIds: stage.approvers,
					})),
				},
				// Internal call: the caller already passed the matrix permission check.
				{ userId: ctx.actorId, isSuperAdmin: true },
			);
			notifications.push(...result.notifications);
			report.updated++;
		} catch (error) {
			failure(template.name, error, "could not be updated");
		}
	}

	// 2. Missing templates that are ready (every seat filled): create them from the matrix.
	for (const want of desiredTemplates(after)) {
		if (existingKeys.has(want.key)) continue;
		if (want.problems.length > 0) {
			report.notReady++;
			if (report.notReadyExamples.length < 5)
				report.notReadyExamples.push({
					name: want.name,
					problems: want.problems.slice(0, 2),
				});
			continue;
		}
		try {
			const { created } = await findOrCreate(want, toStageDefs(want.stages), ctx);
			if (created) report.created++;
			else report.unchanged++;
		} catch (error) {
			failure(want.name, error, "could not be created");
		}
	}

	await sendNotifications(notifications);
	return report;
};

// One sync at a time per server, so two quick saves cannot interleave.
let syncQueue: Promise<unknown> = Promise.resolve();
export const syncCppTemplates = (args: {
	workspaceId: string;
	actorId: string;
	before?: SlotMap;
}): Promise<TemplateSyncReport> => {
	const run = syncQueue.then(() => runSync(args));
	syncQueue = run.catch(() => undefined);
	return run;
};

/* ================================ submit ================================ */

/** Loads the request for its proposer; same workspace, expected status. */
const loadOwnRequest = async (
	args: { id: string; userId: string; workspaceId: string },
	rule: { verb: "submit" | "resubmit"; status: string; wrongStatus: string },
) => {
	const request = await prisma.cppRequest.findUnique({ where: { id: args.id } });
	if (!request || request.workspaceId !== args.workspaceId)
		throw new ApiError(404, "CPP request not found");
	if (request.initiatedById !== args.userId)
		throw new ApiError(
			403,
			`Only the person who created this request can ${rule.verb} it`,
		);
	if (request.status !== rule.status) throw new ApiError(409, rule.wrongStatus);
	return request;
};
type RequestRow = Awaited<ReturnType<typeof loadOwnRequest>>;

/** Everything that must be true before a request can enter (or re-enter) approval. */
const allProblems = async (request: RequestRow): Promise<string[]> => {
	const found = await prisma.cppRequest.findUnique({
		where: { id: request.id },
		select: {
			attachments: {
				where: { type: "partSummary" },
				select: { parsedData: true },
			},
		},
	});
	return [
		...completenessProblems(request),
		...summaryPlantProblems(
			readStoredPartSummary(found?.attachments[0]?.parsedData),
			request.sections,
		),
	];
};

const planFor = async (request: RequestRow) => {
	const rows = await prisma.cppSlotAssignment.findMany({
		where: { workspaceId: request.workspaceId },
	});
	return buildCppApprovalPlan(planInputOf(request, rowsToSlotMap(rows)));
};

const stageInput = (stages: EffectiveStage[]) =>
	stages.map((s) => ({
		name: s.name,
		stageOrder: s.stageOrder,
		strategy: s.strategy,
		minApprovals: s.minApprovals,
		approvers: s.approvers,
	}));

const stageSummary = (stages: EffectiveStage[]) =>
	stages.map((s) => ({
		order: s.stageOrder,
		name: s.name,
		approverIds: s.approvers.map((a) => a.userId),
	}));

/** The plan's own stages, as a request would use them when no template is available. */
const planStagesAsEffective = (plan: PlanOk): EffectiveStage[] =>
	plan.stages.map((s) => ({
		name: s.name,
		stageOrder: s.stageOrder,
		strategy: s.strategy,
		minApprovals: s.minApprovals ?? null,
		approvers: unique(s.approverIds).map((userId) => ({
			userId,
			isExternalApprover: false,
		})),
		phase: s.phase,
	}));

/**
 * Creates the stages of one iteration, starts the first and writes the audit entry.
 * Runs inside the caller's transaction (no network calls in here: Prisma times out at 5 s).
 */
const startStages = async (
	tx: Prisma.TransactionClient,
	args: {
		workflowId: string;
		iteration: number;
		stages: EffectiveStage[];
		requestId: string;
		actorId: string;
		action: "CPP_SUBMITTED" | "CPP_RESUBMITTED";
		metadata: Prisma.InputJsonObject;
	},
) => {
	const { createdStages, firstStageInstanceId } = await createIterationStages(tx, {
		workflowId: args.workflowId,
		iteration: args.iteration,
		templateStages: stageInput(args.stages),
		activateFirst: true,
	});

	await tx.activityLog.create({
		data: {
			subjectType: CPP_LOG_SUBJECT.REQUEST,
			subjectId: args.requestId,
			actorId: args.actorId,
			action: args.action,
			workflowId: args.workflowId,
			metadata: { ...args.metadata, stages: stageSummary(args.stages) },
		},
	});

	return {
		workflowId: args.workflowId,
		firstStageId: firstStageInstanceId,
		firstStageApproverIds:
			createdStages
				.find((s) => s.id === firstStageInstanceId)
				?.approvals.map((a) => a.approverId) ?? [],
	};
};

/** Notify only after the commit, like every other workflow in this app. */
const notifyFirstStage = async (
	started: Awaited<ReturnType<typeof startStages>>,
	requestId: string,
	appId: string,
) => {
	if (!started.firstStageId) return;
	await notifyStageApprovers({
		workflowId: started.workflowId,
		subjectType: CPP_SUBJECT_TYPE,
		subjectId: requestId,
		appId,
		stageId: started.firstStageId,
		approverIds: started.firstStageApproverIds,
	}).catch(() => undefined); // a mail problem must not undo a successful submit
};

/* ---------------------------------- preview --------------------------------- */

/** Names for the approvers of every stage, so the form can show who will be asked. */
const describePlan = async (plan: PlanOk, stages: EffectiveStage[]) => {
	const ids = unique([
		...stages.flatMap((s) => s.approvers.map((a) => a.userId)),
		...plan.priceFeedingUserIds,
	]);
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

type Caller = { id: string; userId: string; workspaceId: string };

const DRAFT_ONLY = {
	verb: "submit",
	status: CPP_STATUS.DRAFT,
	wrongStatus: "This request has already been submitted",
} as const;

/** What would happen on submit. Read-only; safe to call any time. */
export const previewCppApproval = async (caller: Caller) => {
	const request = await loadOwnRequest(caller, DRAFT_ONLY);

	const problems = await allProblems(request);
	if (problems.length) return { ok: false as const, problems };

	const plan = await planFor(request);
	if (plan.ok === false) return { ok: false as const, problems: plan.problems };

	const app = await prisma.app.findFirst({
		where: { key: CPP_APP_KEY },
		select: { id: true },
	});
	const stages = app
		? await previewStagesForPlan(plan, {
				workspaceId: caller.workspaceId,
				appId: app.id,
			})
		: planStagesAsEffective(plan);
	return { ok: true as const, ...(await describePlan(plan, stages)) };
};

/* ---------------------------------- submit ---------------------------------- */

export const submitCppRequest = async (caller: Caller) => {
	let oneOffTemplateId: string | null = null;
	try {
		const request = await loadOwnRequest(caller, DRAFT_ONLY);

		const missing = await allProblems(request);
		if (missing.length)
			throw new ApiError(400, `Cannot submit yet: ${missing.join(" ")}`);

		const plan = await planFor(request);
		if (plan.ok === false)
			throw new ApiError(
				422,
				`Cannot start the approval: ${plan.problems.join(" ")}`,
			);

		const appId = await getCppAppId();
		const ctx: Ctx = {
			workspaceId: caller.workspaceId,
			appId,
			actorId: caller.userId,
		};

		// The reusable template of this band (WF1, and WF2 for committee bands). The matrix save
		// creates it; if it does not exist yet it is created here from the matrix. The request uses
		// the template as it is NOW, including any edit an admin made.
		let templateId: string;
		let stages: EffectiveStage[];
		try {
			const resolved = await resolveTemplatesForPlan(plan, ctx);
			if (resolved.problems.length)
				throw new ApiError(
					422,
					`Cannot start the approval: ${resolved.problems.join(" ")}`,
				);
			templateId = resolved.templateId;
			stages = resolved.stages;
		} catch (templateError) {
			if (templateError instanceof ApiError) throw templateError;
			// Never leave a request stuck because the shared templates could not be read:
			// fall back to a private one-off copy of the matrix chain.
			console.error(
				"CPP: shared templates unavailable, using a one-off template",
				templateError,
			);
			stages = planStagesAsEffective(plan);
			const fallback = await createWorkflowTemplate(
				{
					name: `CPP ${request.referenceNumber} — ${plan.ruleId}`,
					description: plan.bandLabel,
					workspaceId: caller.workspaceId,
					appId,
					metaData_1: plan.ruleId,
					metaData_2: "",
					metaData_3: "CPP_ONE_OFF",
					isReusable: false,
					stages: stages.map((s) => ({
						name: s.name,
						stageOrder: s.stageOrder,
						strategy: s.strategy,
						minApprovals: s.minApprovals ?? undefined,
						approverIds: s.approvers.map((a) => ({ userId: a.userId })),
					})),
				},
				caller.userId,
				"USER",
			);
			templateId = fallback.id;
			oneOffTemplateId = fallback.id;
		}

		const started = await prisma.$transaction(async (tx) => {
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
					workspaceId: caller.workspaceId,
					appId,
					subjectType: CPP_SUBJECT_TYPE,
					subjectId: request.id,
					currentStage: 1,
					iteration: 1,
					isActive: true,
					workflowType: "STANDARD",
				},
			});

			return startStages(tx, {
				workflowId: workflow.id,
				iteration: 1,
				stages,
				requestId: request.id,
				actorId: caller.userId,
				action: "CPP_SUBMITTED",
				metadata: {
					ruleId: plan.ruleId,
					templateId,
					sharedTemplate: oneOffTemplateId === null,
					band: plan.bandLabel,
					level: plan.level,
					priceFeedingUserIds: plan.priceFeedingUserIds,
				},
			});
		});

		await notifyFirstStage(started, request.id, appId);
		return {
			workflowId: started.workflowId,
			ruleId: plan.ruleId,
			stages: stages.length,
		};
	} catch (error) {
		// Only a one-off fallback template is removed; shared templates are kept.
		if (oneOffTemplateId)
			await prisma.workflowTemplate
				.delete({ where: { id: oneOffTemplateId } })
				.catch(() => undefined);
		throw error;
	}
};

/* --------------------------------- resubmit --------------------------------- */
// After an approver asked for a clarification, the proposer edits the request (every tab) and
// sends it again. The SAME workflow instance restarts at stage 1 of the same iteration the
// clarification drafted. The stages are rebuilt from the template of the CURRENT band, so a
// changed category / plant / condition / range (or a changed approval matrix) lands on the
// right approvers. Nothing is approved twice.
export const resubmitCppRequest = async (caller: Caller) => {
	const request = await loadOwnRequest(caller, {
		verb: "resubmit",
		status: CPP_STATUS.CLARIFICATION_REQUESTED,
		wrongStatus: "This request is not waiting for a clarification",
	});

	const missing = await allProblems(request);
	if (missing.length)
		throw new ApiError(400, `Cannot resubmit yet: ${missing.join(" ")}`);

	const plan = await planFor(request);
	if (plan.ok === false)
		throw new ApiError(
			422,
			`Cannot restart the approval: ${plan.problems.join(" ")}`,
		);

	const appId = await getCppAppId();
	const resolved = await resolveTemplatesForPlan(plan, {
		workspaceId: caller.workspaceId,
		appId,
		actorId: caller.userId,
	});
	if (resolved.problems.length)
		throw new ApiError(
			422,
			`Cannot restart the approval: ${resolved.problems.join(" ")}`,
		);
	const { templateId, stages } = resolved;

	const started = await prisma.$transaction(async (tx) => {
		const workflow = await tx.workflowInstance.findFirst({
			where: {
				subjectType: CPP_SUBJECT_TYPE,
				subjectId: request.id,
				isActive: true,
			},
			orderBy: { created_at: "desc" },
			include: { stages: { where: { isCurrentIteration: true } } },
		});
		if (!workflow)
			throw new ApiError(409, "This request has no active workflow to resubmit");
		if (workflow.stages.some((stage) => stage.status === "IN_PROGRESS"))
			throw new ApiError(409, "The approval is already running for this request");

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

		return startStages(tx, {
			workflowId: workflow.id,
			iteration: workflow.iteration,
			stages,
			requestId: request.id,
			actorId: caller.userId,
			action: "CPP_RESUBMITTED",
			metadata: {
				ruleId: plan.ruleId,
				templateId,
				band: plan.bandLabel,
				level: plan.level,
				iteration: workflow.iteration,
			},
		});
	});

	await notifyFirstStage(started, request.id, appId);
	return {
		workflowId: started.workflowId,
		ruleId: plan.ruleId,
		stages: stages.length,
	};
};
