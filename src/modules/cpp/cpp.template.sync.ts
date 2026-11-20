// cpp.template.sync.ts — the reusable CPP approval templates and the approval matrix.
//
//   Admin saves the matrix the first time  ->  the templates are CREATED from it
//   Admin changes a seat / replaces a person ->  that person is swapped inside the templates
//                                               (everything else in a template stays as edited)
//   A request is submitted                 ->  it uses the templates as they are now
//
// Templates can be edited in the Workflows screen. A request copies its approvers
// into its own workflow when it is submitted, so editing a template never changes
// a request's history. (Requests still waiting on a stage do pick up approver
// changes made to the WF1 template: that is how a leaver is replaced.)
//
// This file only writes workflow templates. It never touches user records,
// profiles or permissions: the matrix is about CPP requests only.
import type { Prisma } from "../../prisma/generated/prisma/client";

import { prisma } from "@shared/config/prisma";
import { updateTemplate } from "@kernel/workflow/template.service";
import { notifyStageApprovers } from "@kernel/workflow/workflow.service";
import type { ReconcileNotification } from "@kernel/workflow/workflow.helper";

import { CPP_APP_KEY } from "./cpp.constants";
import { type SlotMap, rowsToSlotMap } from "./cpp.helper";
import {
	CPP_TEMPLATE_TAG,
	type CatalogEntry,
	type Phase,
	desiredTemplates,
	getTemplateCatalog,
	splitByPhase,
	templateKey,
} from "./cpp.template.catalog";
import type { PlanStage } from "./cpp.workflow";

type StageDef = {
	name: string;
	stageOrder: number;
	strategy: "ALL" | "ANY" | "SOME";
	minApprovals: number | null;
	approvers: Array<{ userId: string; isExternalApprover: boolean }>;
};

type Ctx = { workspaceId: string; appId: string; actorId: string };

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

/* ------------------------- used by submit ------------------------- */

export type EffectiveStage = {
	name: string;
	stageOrder: number;
	strategy: "ALL" | "ANY" | "SOME";
	minApprovals: number | null;
	approvers: Array<{ userId: string; isExternalApprover: boolean }>;
	phase: Phase;
};

/**
 * The templates a request will use (WF1, and WF2 when its band has a committee), created
 * from the matrix if they do not exist yet, and the stages they hold RIGHT NOW (edited or not),
 * numbered continuously: WF1 stages first, then WF2.
 */
export const resolveTemplatesForPlan = async (
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

		const offset = stages.length;
		for (const stage of template.stages)
			stages.push({
				name: stage.name,
				stageOrder: offset + stage.stageOrder,
				strategy: stage.strategy as EffectiveStage["strategy"],
				minApprovals: stage.minApprovals ?? null,
				approvers: stage.approvers.map((a) => ({
					userId: a.userId,
					isExternalApprover: a.isExternalApprover,
				})),
				phase,
			});
	}

	// A template edited into an unusable state must stop the submit with a clear message.
	const problems: string[] = [];
	for (const stage of stages) {
		if (stage.approvers.length === 0)
			problems.push(
				`${stage.name}: the template has no approver in this stage.`,
			);
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
export const previewStagesForPlan = async (
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
		if (template) {
			for (const stage of template.stages)
				stages.push({
					name: stage.name,
					stageOrder: offset + stage.stageOrder,
					strategy: stage.strategy as EffectiveStage["strategy"],
					minApprovals: stage.minApprovals ?? null,
					approvers: stage.approvers.map((a) => ({
						userId: a.userId,
						isExternalApprover: a.isExternalApprover,
					})),
					phase,
				});
		} else {
			for (const stage of toStageDefs(parts[phase]))
				stages.push({ ...stage, stageOrder: offset + stage.stageOrder, phase });
		}
	}
	return stages;
};

/* ------------------------- used by the matrix screen ------------------------- */

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
		const touched =
			seats.length > 0 && (removed.length > 0 || added.length > 0);

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
		report.errors.push(
			"The CPP app is not set up, so no templates were created.",
		);
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
			if (report.errors.length < 5)
				report.errors.push(
					`${template.name}: ${error instanceof Error ? error.message : "could not be updated"}`,
				);
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
			const { created } = await findOrCreate(
				want,
				toStageDefs(want.stages),
				ctx,
			);
			if (created) report.created++;
			else report.unchanged++;
		} catch (error) {
			if (report.errors.length < 5)
				report.errors.push(
					`${want.name}: ${error instanceof Error ? error.message : "could not be created"}`,
				);
		}
	}

	await sendNotifications(notifications);
	return report;
};

// One sync at a time per server, so two quick saves cannot interleave.
let queue: Promise<unknown> = Promise.resolve();
export const syncCppTemplates = (args: {
	workspaceId: string;
	actorId: string;
	before?: SlotMap;
}): Promise<TemplateSyncReport> => {
	const run = queue.then(() => runSync(args));
	queue = run.catch(() => undefined);
	return run;
};
