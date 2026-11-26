// cpp.controller.ts — thin Express handlers for the whole CPP module. Each one reads the
// request, calls the helper / service that does the work, and sends the answer.
//
//   requests      create / update / read / list / delete draft, close
//   attachments   upload / delete, and the blank summary-sheet template
//   approval      preview / submit / resubmit                 (cpp.workflow.service.ts)
//   export        Excel, SAP text files, public PDF and text   (cpp.export.service.ts)
//   matrix        admin approval matrix: who sits in which approval role
//
// Handlers throw ApiError; asyncHandler (see cpp.routes.ts) passes it to the error middleware.
// Pure rules (validation, mapping, listing, matrix coverage) live in cpp.helper.ts.
import { randomUUID } from "crypto";
import type { Request, Response } from "express";

import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import {
	deleteReportImage, // generic "delete one S3 key" despite the name
	getSignedImageUrl,
	uploadToS3,
} from "@shared/utils/aws-s3.services";
import {
	getActiveWorkflowForSubject,
	getPendingOnForMany,
} from "@kernel/workflow/workflowSubject.helper";

import {
	CPP_ATTACHMENT_TYPES,
	CPP_EDITABLE_STATUSES,
	CPP_FILE_RULES,
	CPP_LOG_SUBJECT,
	CPP_MATRIX_LOG_TARGET,
	CPP_MAX_FILE_SIZE,
	CPP_ROLES,
	CPP_STATUS,
	CPP_SUBJECT_TYPE,
	CPP_TCS_ROLE_KEY,
	type CppAttachmentType,
	scopesForRole,
	slotKey,
} from "./cpp.constants";
import {
	exportCppExcel,
	exportCppText,
	parseCppTextKind,
	pdfUrlForViewToken,
	requestIdForViewToken,
	type CppTextFile,
} from "./cpp.export.service";
import {
	type CppAttachmentWithUrl,
	type CppPerson,
	type SlotMap,
	type SlotUpdate,
	buildCppData,
	buildCppWhere,
	computeCoverage,
	fileExtension,
	fullName,
	generateCppReferenceNumber,
	isCppApprovalTab,
	newCoverageErrors,
	parseCppListingParams,
	parseSlotUpdates,
	planReplaceUser,
	resolveCppOrderBy,
	resolveCppPendingOn,
	rowsToSlotMap,
	safeFileName,
	toCppAttachment,
	toCppDetail,
	toCppListItem,
} from "./cpp.helper";
import { CPP_CHAINS, chainProblems, roleUsage } from "./cpp.rules";
import { buildPartSummaryTemplate, parsePartSummary } from "./cpp.sheet";
import {
	previewCppApproval as previewApproval,
	resubmitCppRequest as resubmitApproval,
	submitCppRequest as submitApproval,
	syncCppTemplates,
	type TemplateSyncReport,
} from "./cpp.workflow.service";
import { Prisma } from "../../prisma/generated/prisma/client";

const XLSX_MIME =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/* -------------------------------- internals ------------------------------- */

/** Who is calling. Every handler below needs both. */
const callerOf = (req: Request): { userId: string; workspaceId: string } => {
	const userId = req.user?.id;
	const workspaceId = req.user?.workspaceId;
	if (!userId || !workspaceId) throw new ApiError(401, "Unauthorized");
	return { userId, workspaceId };
};

const idOf = (req: Request): string => req.params.id as string;

/** Loads a request the caller owns, in their workspace. 404 hides other people's ids. */
const loadOwnedRequest = async (
	id: string,
	userId: string,
	workspaceId: string,
) => {
	const request = await prisma.cppRequest.findUnique({ where: { id } });
	if (!request || request.workspaceId !== workspaceId)
		throw new ApiError(404, "CPP request not found");
	if (request.initiatedById !== userId)
		throw new ApiError(403, "You do not have access to this CPP request");
	return request;
};

const assertEditable = (status: string) => {
	if (!(CPP_EDITABLE_STATUSES as readonly string[]).includes(status))
		throw new ApiError(400, "This CPP request can no longer be edited");
};

const withSignedUrls = async <T extends { s3Key: string }>(
	attachments: T[],
): Promise<Array<T & { url: string | null }>> =>
	Promise.all(
		attachments.map(async (a) => ({
			...a,
			url: await getSignedImageUrl(a.s3Key).catch(() => null),
		})),
	);

const personOf = (u: {
	id: string;
	first_name: string | null;
	last_name: string | null;
	email: string | null;
}): CppPerson => ({ id: u.id, name: fullName(u) || null, email: u.email });

/** The request as the screens read it. 404 when it is not in the caller's workspace. */
const loadDetail = async (id: string, workspaceId: string) => {
	const row = await prisma.cppRequest.findUnique({
		where: { id },
		include: { attachments: { orderBy: { uploadedAt: "asc" } } },
	});
	if (!row || row.workspaceId !== workspaceId)
		throw new ApiError(404, "CPP request not found");
	// The proposer, for "Proposed By" on the document (the request has no relation to User).
	const initiator = await prisma.user.findUnique({
		where: { id: row.initiatedById },
		select: { id: true, first_name: true, last_name: true, email: true },
	});
	return toCppDetail(
		row,
		(await withSignedUrls(row.attachments)) as CppAttachmentWithUrl[],
		initiator ? personOf(initiator) : null,
	);
};

/** Sends a text file as a download. */
const sendTextFile = (res: Response, file: CppTextFile) => {
	res
		.status(200)
		.setHeader("Content-Type", "text/plain; charset=utf-8")
		.setHeader("Content-Disposition", `attachment; filename="${file.fileName}"`)
		.send(file.content);
};

/* ================================ requests ================================ */

// POST /cpp — creates a DRAFT. Any subset of the form may be sent (even {}).
export const createCppRequest = async (req: Request, res: Response) => {
	const { userId, workspaceId } = callerOf(req);
	const data = buildCppData(req.body ?? {});

	const created = await prisma.$transaction(async (tx) => {
		const row = await tx.cppRequest.create({
			data: {
				...(data as object),
				workspaceId,
				initiatedById: userId,
				referenceNumber: generateCppReferenceNumber(),
				status: CPP_STATUS.DRAFT,
			},
		});
		await tx.activityLog.create({
			data: {
				subjectType: CPP_LOG_SUBJECT.REQUEST,
				subjectId: row.id,
				actorId: userId,
				action: "CPP_DRAFT_CREATED",
			},
		});
		return row;
	});

	res.status(201).json({
		success: true,
		message: "CPP draft saved",
		data: await loadDetail(created.id, workspaceId),
	});
};

// PUT /cpp/:id — save changes (last save wins, like the other modules).
// Only the keys you send change (absent = untouched, null = cleared).
export const updateCppRequest = async (req: Request, res: Response) => {
	const { userId, workspaceId } = callerOf(req);
	const id = idOf(req);

	const existing = await loadOwnedRequest(id, userId, workspaceId);
	assertEditable(existing.status);

	await prisma.cppRequest.update({
		where: { id },
		data: buildCppData(req.body, existing),
	});

	res.status(200).json({
		success: true,
		message: "CPP saved",
		data: await loadDetail(id, workspaceId),
	});
};

// GET /cpp/:id — open to every signed-in user with CPP read access in the workspace:
// approvers and observers must be able to open it. Tighten here if needed.
export const getCppRequestById = async (req: Request, res: Response) => {
	const { workspaceId } = callerOf(req);
	const id = idOf(req);

	const detail = await loadDetail(id, workspaceId);
	const activeWorkflow = await getActiveWorkflowForSubject(CPP_SUBJECT_TYPE, id);
	res.status(200).json({ success: true, data: { ...detail, activeWorkflow } });
};

/**
 * Requests where I am an approver: "pendingOnMe" = my approval is waiting on a stage that is
 * running now; "approvedByMe" = I have approved. Same rule as the medical claim listing.
 */
const approvalSubjectIds = async (
	userId: string,
	tab: "pendingOnMe" | "approvedByMe",
): Promise<string[]> => {
	const approvals = await prisma.approval.findMany({
		where: {
			approverId: userId,
			status: tab === "pendingOnMe" ? "PENDING" : "APPROVED",
			stage: {
				workflow: { subjectType: CPP_SUBJECT_TYPE, isActive: true },
				...(tab === "pendingOnMe"
					? { isCurrentIteration: true, status: "IN_PROGRESS" }
					: {}),
			},
		},
		select: { stage: { select: { workflow: { select: { subjectId: true } } } } },
	});
	return [...new Set(approvals.map((a) => a.stage.workflow.subjectId))];
};

// GET /cpp?tab=myRequests|drafts|pendingOnMe|approvedByMe&search=&status=&page_index=&page_size=&sortBy=&sortOrder=
export const listCppRequests = async (req: Request, res: Response) => {
	const { userId, workspaceId } = callerOf(req);

	const params = parseCppListingParams(req.query);
	const approvalIds = isCppApprovalTab(params.tab)
		? await approvalSubjectIds(userId, params.tab)
		: [];
	const where = buildCppWhere(workspaceId, userId, params, approvalIds);

	const [rows, total] = await Promise.all([
		prisma.cppRequest.findMany({
			where,
			orderBy: resolveCppOrderBy(req.query.sortBy, req.query.sortOrder),
			skip: params.pageIndex * params.pageSize,
			take: params.pageSize,
		}),
		prisma.cppRequest.count({ where }),
	]);

	// Who each row waits on: one batched query for the page.
	const pendingOn = await getPendingOnForMany(
		CPP_SUBJECT_TYPE,
		rows.map((row) => row.id),
	);

	res.status(200).json({
		success: true,
		data: rows.map((row) => ({
			...toCppListItem(row),
			pendingOn: resolveCppPendingOn(row.status, pendingOn[row.id]),
		})),
		total,
		page_index: params.pageIndex,
		page_size: params.pageSize,
	});
};

// DELETE /cpp/:id — drafts only.
export const deleteCppDraft = async (req: Request, res: Response) => {
	const { userId, workspaceId } = callerOf(req);
	const id = idOf(req);

	const existing = await loadOwnedRequest(id, userId, workspaceId);
	if (existing.status !== CPP_STATUS.DRAFT)
		throw new ApiError(400, "Only a draft can be deleted");

	const files = await prisma.cppAttachment.findMany({
		where: { requestId: id },
		select: { s3Key: true },
	});

	await prisma.$transaction(async (tx) => {
		await tx.cppAttachment.deleteMany({ where: { requestId: id } });
		await tx.cppRequest.delete({ where: { id } });
		await tx.activityLog.create({
			data: {
				subjectType: CPP_LOG_SUBJECT.REQUEST,
				subjectId: id,
				actorId: userId,
				action: "CPP_DRAFT_DELETED",
			},
		});
	});

	// After the commit: a failed S3 delete only leaves an orphan file, never a broken row.
	await Promise.allSettled(files.map((f) => deleteReportImage(f.s3Key)));

	res.status(200).json({ success: true, message: "Draft deleted" });
};

// POST /cpp/:id/close — TCS closes the request once the SAP update is done.
// Allowed for the TCS role of the approval matrix, or anyone on the request's approval
// workflow. No mail is sent here: the approved mail is sent from the workflow's final-approval
// hook (see cpp.mail.ts).
export const closeCppRequest = async (req: Request, res: Response) => {
	const { userId, workspaceId } = callerOf(req);
	const id = idOf(req);

	const request = await prisma.cppRequest.findUnique({
		where: { id },
		select: { workspaceId: true, status: true },
	});
	if (!request || request.workspaceId !== workspaceId)
		throw new ApiError(404, "CPP request not found");
	// After the last approval the request waits in PRICE_FEEDING; closing is allowed from
	// there and moves it to COMPLETED.
	if (request.status !== CPP_STATUS.PRICE_FEEDING)
		throw new ApiError(400, "Only a request in price feeding can be closed");

	const [onWorkflow, isTcs] = await Promise.all([
		// Any approval row on this request's active workflow.
		prisma.approval.findFirst({
			where: {
				approverId: userId,
				stage: {
					workflow: { subjectType: CPP_SUBJECT_TYPE, subjectId: id, isActive: true },
				},
			},
			select: { id: true },
		}),
		// TCS users are not on the workflow; they sit in the TCS role.
		prisma.cppSlotAssignment.findFirst({
			where: { workspaceId, roleKey: CPP_TCS_ROLE_KEY, userId },
			select: { id: true },
		}),
	]);
	if (!onWorkflow && !isTcs)
		throw new ApiError(403, "Only TCS or an approver of this CPP request can close it");

	await prisma.$transaction(async (tx) => {
		await tx.cppRequest.update({
			where: { id },
			data: { status: CPP_STATUS.COMPLETED, updated_at: new Date() },
		});
		await tx.activityLog.create({
			data: {
				subjectType: CPP_LOG_SUBJECT.REQUEST,
				subjectId: id,
				actorId: userId,
				action: "CPP_CLOSED",
			},
		});
	});

	res.status(200).json({
		success: true,
		message: "CPP request closed",
		data: await loadDetail(id, workspaceId),
	});
};

/* =============================== attachments =============================== */

// GET /cpp/part-summary-template — the blank summary sheet in the expected format.
export const getPartSummaryTemplate = async (req: Request, res: Response) => {
	callerOf(req);
	res
		.status(200)
		.setHeader("Content-Type", XLSX_MIME)
		.setHeader(
			"Content-Disposition",
			'attachment; filename="CPP_price-changes_template.xlsx"',
		)
		.send(await buildPartSummaryTemplate());
};

// POST /cpp/:id/attachments  (multipart: file, type) — one file per type; replaces.
export const uploadCppAttachment = async (req: Request, res: Response) => {
	const { userId, workspaceId } = callerOf(req);
	const id = idOf(req);

	const type = String(req.body?.type ?? "");
	if (!(CPP_ATTACHMENT_TYPES as readonly string[]).includes(type))
		throw new ApiError(400, `type must be one of: ${CPP_ATTACHMENT_TYPES.join(", ")}`);
	const attachmentType = type as CppAttachmentType;

	const file = req.file;
	if (!file) throw new ApiError(400, "A file is required");
	if (file.size > CPP_MAX_FILE_SIZE)
		throw new ApiError(400, "File is larger than 10 MB");

	const rule = CPP_FILE_RULES[attachmentType];
	const mimeOk = rule.mime.includes(file.mimetype.toLowerCase());
	const extOk = rule.ext.includes(fileExtension(file.originalname));
	// Browsers sometimes send application/octet-stream for .xlsx/.csv: accept on extension then.
	if (!(mimeOk || file.mimetype === "application/octet-stream") || !extOk)
		throw new ApiError(
			400,
			`"${file.originalname}" is not supported. Use ${rule.label}.`,
		);

	const existing = await loadOwnedRequest(id, userId, workspaceId);
	assertEditable(existing.status);

	// The summary sheet is read from the uploaded bytes BEFORE anything is stored, so a
	// sheet that does not fit is refused with its reason and leaves no file behind.
	const partSummary =
		attachmentType === "partSummary" ? parsePartSummary(file.buffer) : null;
	const parsedData =
		partSummary === null
			? Prisma.DbNull
			: (partSummary as unknown as Prisma.InputJsonValue);

	const s3Key = `cpp/${id}/${attachmentType}/${randomUUID()}-${safeFileName(file.originalname)}`;
	await uploadToS3(s3Key, file.buffer, file.mimetype);

	const where = { requestId_type: { requestId: id, type: attachmentType } };
	const previous = await prisma.cppAttachment.findUnique({
		where,
		select: { s3Key: true },
	});

	const saved = await prisma
		.$transaction(async (tx) => {
			const row = await tx.cppAttachment.upsert({
				where,
				create: {
					requestId: id,
					type: attachmentType,
					fileName: file.originalname,
					s3Key,
					parsedData,
				},
				update: {
					fileName: file.originalname,
					s3Key,
					uploadedAt: new Date(),
					parsedData,
				},
			});
			await tx.cppRequest.update({ where: { id }, data: { updated_at: new Date() } });
			return row;
		})
		.catch(async (error) => {
			await deleteReportImage(s3Key).catch(() => undefined);
			throw error;
		});

	if (previous && previous.s3Key !== s3Key)
		await deleteReportImage(previous.s3Key).catch(() => undefined);

	const [withUrl] = await withSignedUrls([saved]);
	res.status(201).json({
		success: true,
		data: toCppAttachment(withUrl as CppAttachmentWithUrl),
	});
};

// DELETE /cpp/:id/attachments/:attachmentId
export const deleteCppAttachment = async (req: Request, res: Response) => {
	const { userId, workspaceId } = callerOf(req);
	const id = idOf(req);
	const attachmentId = req.params.attachmentId as string;

	const existing = await loadOwnedRequest(id, userId, workspaceId);
	assertEditable(existing.status);

	const attachment = await prisma.cppAttachment.findFirst({
		where: { id: attachmentId, requestId: id },
	});
	if (!attachment) throw new ApiError(404, "Attachment not found");

	await prisma.$transaction(async (tx) => {
		await tx.cppAttachment.delete({ where: { id: attachmentId } });
		await tx.cppRequest.update({ where: { id }, data: { updated_at: new Date() } });
	});
	await deleteReportImage(attachment.s3Key).catch(() => undefined);

	res.status(200).json({ success: true, message: "Attachment removed" });
};

/* ================================= approval ================================ */

// GET /cpp/:id/approval-preview — read-only; safe to call any time.
export const previewCppApproval = async (req: Request, res: Response) => {
	const caller = callerOf(req);
	const data = await previewApproval({ id: idOf(req), ...caller });
	res.status(200).json({ success: true, data });
};

// POST /cpp/:id/submit
export const submitCppRequest = async (req: Request, res: Response) => {
	const data = await submitApproval({ id: idOf(req), ...callerOf(req) });
	res
		.status(200)
		.json({ success: true, message: "CPP request submitted for approval", data });
};

// POST /cpp/:id/resubmit — after a clarification, restarts the approval.
export const resubmitCppRequest = async (req: Request, res: Response) => {
	const data = await resubmitApproval({ id: idOf(req), ...callerOf(req) });
	res
		.status(200)
		.json({ success: true, message: "CPP request resubmitted for approval", data });
};

/* ================================== export ================================= */

// GET /cpp/:id/export/excel — the summary table only.
export const downloadCppExcel = async (req: Request, res: Response) => {
	const { workspaceId } = callerOf(req);
	const { fileName, buffer } = await exportCppExcel(idOf(req), workspaceId);
	res
		.status(200)
		.setHeader("Content-Type", XLSX_MIME)
		.setHeader("Content-Disposition", `attachment; filename="${fileName}"`)
		.send(buffer);
};

// GET /cpp/:id/export/text?file=me11|changeinfo — ZINFOUPDATE_ME11 (default) or ZCHANGEINFO.
export const downloadCppText = async (req: Request, res: Response) => {
	const { workspaceId } = callerOf(req);
	const kind = parseCppTextKind(req.query.file);
	sendTextFile(res, await exportCppText(idOf(req), kind, workspaceId));
};

// GET /cpp/public/pdf/:token — the token comes from the approved mail (purpose VIEW_PDF).
// Never marked used, so the TCS team can open it without a login.
export const redirectToCppPdf = async (req: Request, res: Response) => {
	res.redirect(await pdfUrlForViewToken(String(req.params.token)));
};

// GET /cpp/public/text/:token?file=me11|changeinfo — same file as the mail attachment, no login.
export const downloadCppTextByToken = async (req: Request, res: Response) => {
	const id = await requestIdForViewToken(String(req.params.token));
	sendTextFile(res, await exportCppText(id, parseCppTextKind(req.query.file)));
};

/* ================================== matrix ================================= */
// Admin approval matrix: who sits in which approval role.
//   GET  /cpp/approval-matrix                 roles, assignments, coverage problems
//   PUT  /cpp/approval-matrix                 save assignments (blocks changes that leave a slot empty)
//   POST /cpp/approval-matrix/replace-user    swap one person for another in every slot
//   POST /cpp/approval-matrix/sync-templates  rebuild the workflow templates from the matrix
//   GET  /cpp/approval-matrix/users?search=   people picker
//   GET  /cpp/approval-matrix/chains          the 71 workflow chains (read-only preview)

const loadPeople = async (ids: string[]): Promise<Map<string, CppPerson>> => {
	if (ids.length === 0) return new Map();
	const users = await prisma.user.findMany({
		where: { id: { in: ids } },
		select: { id: true, first_name: true, last_name: true, email: true },
	});
	return new Map(users.map((u) => [u.id, personOf(u)]));
};

const loadMatrix = async (workspaceId: string) => {
	const rows = await prisma.cppSlotAssignment.findMany({
		where: { workspaceId },
		orderBy: [{ roleKey: "asc" }, { scope: "asc" }, { position: "asc" }],
	});
	const people = await loadPeople([...new Set(rows.map((r) => r.userId))]);
	const usage = roleUsage();

	const assignments: Array<{ roleKey: string; scope: string; users: CppPerson[] }> = [];
	for (const row of rows) {
		let slot = assignments.find(
			(s) => s.roleKey === row.roleKey && s.scope === row.scope,
		);
		if (!slot) {
			slot = { roleKey: row.roleKey, scope: row.scope, users: [] };
			assignments.push(slot);
		}
		slot.users.push(
			people.get(row.userId) ?? { id: row.userId, name: null, email: null },
		);
	}

	return {
		roles: CPP_ROLES.map((role) => ({
			key: role.key,
			label: role.label,
			group: role.group,
			scope: role.scope,
			scopes: scopesForRole(role),
			assignable: role.assignable,
			observer: role.observer ?? false,
			recipient: role.recipient ?? false,
			note: role.note ?? null,
			usedByBands: usage.get(role.key) ?? 0,
		})),
		assignments,
		coverage: computeCoverage(rowsToSlotMap(rows)),
		updatedAt: rows.reduce<Date | null>(
			(latest, r) => (!latest || r.updated_at > latest ? r.updated_at : latest),
			null,
		),
	};
};

/**
 * Creates the reusable approval templates that do not exist yet and swaps the changed
 * people into the ones that do (everything else an admin edited in a template stays).
 * Writes workflow templates only, never user records. Never throws: the matrix change is
 * already saved, so a problem here is reported, not fatal (a request being submitted builds
 * any missing template by itself).
 */
const refreshTemplates = async (
	workspaceId: string,
	actorId: string,
	before?: SlotMap,
): Promise<TemplateSyncReport | { error: string }> => {
	try {
		return await syncCppTemplates({ workspaceId, actorId, before });
	} catch (error) {
		console.error("CPP: template sync failed", error);
		return {
			error:
				"Matrix saved, but the workflow templates could not be refreshed. Use Sync templates to retry.",
		};
	}
};

export const getApprovalMatrix = async (req: Request, res: Response) => {
	const { workspaceId } = callerOf(req);
	res.status(200).json({ success: true, data: await loadMatrix(workspaceId) });
};

export const saveApprovalMatrix = async (req: Request, res: Response) => {
	const { userId, workspaceId } = callerOf(req);

	let updates: SlotUpdate[];
	try {
		updates = parseSlotUpdates(req.body?.assignments);
	} catch (error) {
		throw new ApiError(400, (error as Error).message);
	}

	const allIds = [...new Set(updates.flatMap((u) => u.userIds))];
	const people = await loadPeople(allIds);
	if (allIds.some((id) => !people.has(id)))
		throw new ApiError(400, "Some selected users no longer exist. Reload and try again.");

	const current = await prisma.cppSlotAssignment.findMany({ where: { workspaceId } });
	const before = rowsToSlotMap(current);
	const after = rowsToSlotMap(current);
	for (const update of updates)
		after.set(slotKey(update.roleKey, update.scope), update.userIds);

	// Never let a save make things worse: an emptied slot would strand requests.
	const worse = newCoverageErrors(before, after);
	if (worse.length)
		throw new ApiError(
			400,
			`Not saved. ${worse.map((issue) => issue.message).join(" ")}`,
		);

	await prisma.$transaction(async (tx) => {
		for (const update of updates) {
			await tx.cppSlotAssignment.deleteMany({
				where: { workspaceId, roleKey: update.roleKey, scope: update.scope },
			});
			if (update.userIds.length)
				await tx.cppSlotAssignment.createMany({
					data: update.userIds.map((id, position) => ({
						workspaceId,
						roleKey: update.roleKey,
						scope: update.scope,
						userId: id,
						position,
						updatedById: userId,
					})),
				});
		}
		await tx.activityLog.create({
			data: {
				subjectType: CPP_LOG_SUBJECT.REQUEST,
				subjectId: workspaceId,
				actorId: userId,
				action: "CPP_MATRIX_UPDATED",
				metadata: { target: CPP_MATRIX_LOG_TARGET },
			},
		});
	});

	const templates = await refreshTemplates(workspaceId, userId, before);
	res.status(200).json({
		success: true,
		message: "Approval matrix saved",
		data: await loadMatrix(workspaceId),
		templates,
	});
};

// POST /approval-matrix/replace-user { fromUserId, toUserId } — the yearly handover.
export const replaceMatrixUser = async (req: Request, res: Response) => {
	const { userId, workspaceId } = callerOf(req);
	const { fromUserId, toUserId } = (req.body ?? {}) as {
		fromUserId?: unknown;
		toUserId?: unknown;
	};
	if (
		typeof fromUserId !== "string" ||
		typeof toUserId !== "string" ||
		!fromUserId ||
		!toUserId
	)
		throw new ApiError(400, "fromUserId and toUserId are required");
	if (fromUserId === toUserId) throw new ApiError(400, "Pick two different people");
	if (!(await loadPeople([toUserId])).has(toUserId))
		throw new ApiError(400, "The replacement user was not found");

	const rows = await prisma.cppSlotAssignment.findMany({ where: { workspaceId } });
	const plan = planReplaceUser(rows, fromUserId, toUserId);
	const changed = plan.updates.length + plan.deletes.length;
	if (changed === 0)
		throw new ApiError(404, "That person is not assigned to any approval role");

	await prisma.$transaction(async (tx) => {
		if (plan.updates.length)
			await tx.cppSlotAssignment.updateMany({
				where: { id: { in: plan.updates } },
				data: { userId: toUserId, updatedById: userId },
			});
		if (plan.deletes.length)
			await tx.cppSlotAssignment.deleteMany({ where: { id: { in: plan.deletes } } });
		await tx.activityLog.create({
			data: {
				subjectType: CPP_LOG_SUBJECT.REQUEST,
				subjectId: workspaceId,
				actorId: userId,
				action: "CPP_MATRIX_USER_REPLACED",
				metadata: { target: CPP_MATRIX_LOG_TARGET },
			},
		});
	});

	// The new person is swapped into the templates too, and requests still waiting move to them.
	const templates = await refreshTemplates(workspaceId, userId, rowsToSlotMap(rows));
	res.status(200).json({
		success: true,
		message: `Replaced in ${changed} role(s)`,
		data: await loadMatrix(workspaceId),
		templates,
	});
};

// GET /approval-matrix/users?search=  (same workspace, active users only)
export const searchMatrixUsers = async (req: Request, res: Response) => {
	const { workspaceId } = callerOf(req);
	const search =
		typeof req.query.search === "string" ? req.query.search.trim().slice(0, 60) : "";
	const contains = { contains: search, mode: "insensitive" as const };

	const users = await prisma.user.findMany({
		where: {
			is_active: true,
			workspaceUsers: { some: { workspaceId } },
			...(search
				? { OR: [{ first_name: contains }, { last_name: contains }, { email: contains }] }
				: {}),
		},
		select: { id: true, first_name: true, last_name: true, email: true },
		orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
		take: 25,
	});
	res.status(200).json({ success: true, data: users.map(personOf) });
};

// POST /approval-matrix/sync-templates — rebuild the templates from the matrix as it is now
// (use it once after deploying, or to retry after a problem).
export const syncApprovalTemplates = async (req: Request, res: Response) => {
	const { userId, workspaceId } = callerOf(req);
	res.status(200).json({
		success: true,
		message: "Workflow templates refreshed",
		data: await refreshTemplates(workspaceId, userId),
	});
};

// GET /approval-matrix/chains
export const getApprovalChains = async (req: Request, res: Response) => {
	callerOf(req);
	res.status(200).json({
		success: true,
		data: CPP_CHAINS.map((chain) => ({
			ruleId: chain.ruleId,
			sheet: chain.sheet,
			block: chain.block,
			bandLabel: chain.bandLabel,
			wf1: chain.wf1,
			wf2: chain.wf2,
			priceFeeding: chain.priceFeeding,
		})),
		problems: chainProblems(),
	});
};
