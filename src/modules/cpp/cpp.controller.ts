import { randomUUID } from "crypto";
import { type NextFunction, type Request, type Response } from "express";
import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import {
	deleteReportImage, // generic "delete one S3 key" despite the name
	getSignedImageUrl,
	uploadToS3,
} from "@shared/utils/aws-s3.services";

import {
	CPP_ATTACHMENT_TYPES,
	CPP_EDITABLE_STATUSES,
	CPP_FILE_RULES,
	CPP_LOG_SUBJECT,
	CPP_MATRIX_LOG_TARGET,
	CPP_MAX_FILE_SIZE,
	CPP_ROLES,
	CPP_STATUS,
	type CppAttachmentType,
	scopesForRole,
} from "./cpp.constants";
import {
	type CppAttachmentWithUrl,
	type SlotUpdate,
	buildCppData,
	buildCppWhere,
	computeCoverage,
	fileExtension,
	generateCppReferenceNumber,
	newCoverageErrors,
	parseCppListingParams,
	parseSlotUpdates,
	planReplaceUser,
	resolveCppOrderBy,
	rowsToSlotMap,
	safeFileName,
	toCppDetail,
	toCppListItem,
} from "./cpp.helper";
import { CPP_CHAINS, chainProblems, roleUsage } from "./cpp.rules";

/* ===== controller ===== */
// cpp.controller.ts — save side of a CPP request: create / update draft / read /
// list / delete draft / attachments. Submit + approval workflow come next.

/* -------------------------------- internals ------------------------------- */

const requireWorkspaceId = (req: Request): string => {
	const workspaceId = req.user?.workspaceId;
	if (!workspaceId) throw new ApiError(401, "Unauthorized");
	return workspaceId;
};

const requireUserId = (req: Request): string => {
	const userId = req.user?.id;
	if (!userId) throw new ApiError(401, "Unauthorized");
	return userId;
};

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

const loadDetail = async (id: string) => {
	const row = await prisma.cppRequest.findUnique({
		where: { id },
		include: { attachments: { orderBy: { uploadedAt: "asc" } } },
	});
	if (!row) throw new ApiError(404, "CPP request not found");
	return toCppDetail(
		row,
		(await withSignedUrls(row.attachments)) as CppAttachmentWithUrl[],
	);
};

/* --------------------------------- handlers ------------------------------- */

// POST /cpp — creates a DRAFT. Any subset of the form may be sent (even {}).
export const createCppRequest = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const userId = requireUserId(req);
		const workspaceId = requireWorkspaceId(req);
		const data = buildCppData(req.body ?? {});

		const created = await prisma.$transaction(async (tx) => {
			const referenceNumber = generateCppReferenceNumber();
			const row = await tx.cppRequest.create({
				data: {
					...(data as object),
					workspaceId,
					initiatedById: userId,
					referenceNumber,
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
			data: await loadDetail(created.id),
		});
	} catch (error) {
		next(error);
	}
};

// PUT /cpp/:id — save changes (last save wins, like the other modules).
// Only the keys you send change (absent = untouched, null = cleared).
export const updateCppRequest = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const userId = requireUserId(req);
		const id = req.params.id as string;
		const workspaceId = requireWorkspaceId(req);

		const existing = await loadOwnedRequest(id, userId, workspaceId);
		assertEditable(existing.status);

		const data = buildCppData(req.body, existing);

		await prisma.cppRequest.update({ where: { id }, data });

		res.status(200).json({
			success: true,
			message: "CPP saved",
			data: await loadDetail(id),
		});
	} catch (error) {
		next(error);
	}
};

// GET /cpp/:id
export const getCppRequestById = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const userId = requireUserId(req);
		const workspaceId = requireWorkspaceId(req);
		const id = req.params.id as string;

		const request = await prisma.cppRequest.findUnique({
			where: { id },
			select: { workspaceId: true },
		});
		if (!request || request.workspaceId !== workspaceId)
			throw new ApiError(404, "CPP request not found");

		// Open to every signed-in user with CPP read access in the workspace:
		// approvers and observers must be able to open it. Tighten here if needed.
		res.status(200).json({ success: true, data: await loadDetail(id) });
	} catch (error) {
		next(error);
	}
};

// GET /cpp?tab=myRequests|drafts&search=&status=&page_index=&page_size=&sortBy=&sortOrder=
export const listCppRequests = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const userId = requireUserId(req);
		const workspaceId = requireWorkspaceId(req);

		const params = parseCppListingParams(req.query);
		const where = buildCppWhere(workspaceId, userId, params);
		const orderBy = resolveCppOrderBy(req.query.sortBy, req.query.sortOrder);

		const [rows, total] = await Promise.all([
			prisma.cppRequest.findMany({
				where,
				orderBy,
				skip: params.pageIndex * params.pageSize,
				take: params.pageSize,
			}),
			prisma.cppRequest.count({ where }),
		]);

		res.status(200).json({
			success: true,
			data: rows.map(toCppListItem),
			total,
			page_index: params.pageIndex,
			page_size: params.pageSize,
		});
	} catch (error) {
		next(error);
	}
};

// DELETE /cpp/:id — drafts only.
export const deleteCppDraft = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const userId = requireUserId(req);
		const id = req.params.id as string;
		const workspaceId = requireWorkspaceId(req);

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
	} catch (error) {
		next(error);
	}
};

// POST /cpp/:id/attachments  (multipart: file, type) — one file per type; replaces.
export const uploadCppAttachment = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const userId = requireUserId(req);
		const id = req.params.id as string;
		const workspaceId = requireWorkspaceId(req);

		const type = String(req.body?.type ?? "");
		if (!(CPP_ATTACHMENT_TYPES as readonly string[]).includes(type))
			throw new ApiError(
				400,
				`type must be one of: ${CPP_ATTACHMENT_TYPES.join(", ")}`,
			);
		const attachmentType = type as CppAttachmentType;

		const file = req.file;
		if (!file) throw new ApiError(400, "A file is required");
		if (file.size > CPP_MAX_FILE_SIZE)
			throw new ApiError(400, "File is larger than 10 MB");

		const rule = CPP_FILE_RULES[attachmentType];
		const extension = fileExtension(file.originalname);
		const mimeOk = rule.mime.includes(file.mimetype.toLowerCase());
		const extOk = rule.ext.includes(extension);
		// Browsers sometimes send application/octet-stream for .xlsx/.csv — accept on extension then.
		if (
			!(mimeOk || (file.mimetype === "application/octet-stream" && extOk)) ||
			!extOk
		)
			throw new ApiError(
				400,
				`"${file.originalname}" is not supported. Use ${rule.label}.`,
			);

		const existing = await loadOwnedRequest(id, userId, workspaceId);
		assertEditable(existing.status);

		const fileName = safeFileName(file.originalname);
		const s3Key = `cpp/${id}/${attachmentType}/${randomUUID()}-${fileName}`;
		await uploadToS3(s3Key, file.buffer, file.mimetype);

		const previous = await prisma.cppAttachment.findUnique({
			where: { requestId_type: { requestId: id, type: attachmentType } },
			select: { s3Key: true },
		});

		const saved = await prisma.$transaction(async (tx) => {
			const row = await tx.cppAttachment.upsert({
				where: { requestId_type: { requestId: id, type: attachmentType } },
				create: {
					requestId: id,
					type: attachmentType,
					fileName: file.originalname,
					s3Key,
				},
				update: {
					fileName: file.originalname,
					s3Key,
					uploadedAt: new Date(),
				},
			});
			await tx.cppRequest.update({
				where: { id },
				data: { updated_at: new Date() },
			});
			return row;
		});

		if (previous && previous.s3Key !== s3Key)
			await deleteReportImage(previous.s3Key).catch(() => undefined);

		const [withUrl] = await withSignedUrls([saved]);
		res.status(201).json({
			success: true,
			data: {
				id: saved.id,
				type: saved.type,
				fileName: saved.fileName,
				uploadedAt: saved.uploadedAt,
				url: withUrl?.url ?? undefined,
			},
		});
	} catch (error) {
		next(error);
	}
};

// DELETE /cpp/:id/attachments/:attachmentId
export const deleteCppAttachment = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const userId = requireUserId(req);
		const id = req.params.id as string;
		const attachmentId = req.params.attachmentId as string;
		const workspaceId = requireWorkspaceId(req);

		const existing = await loadOwnedRequest(id, userId, workspaceId);
		assertEditable(existing.status);

		const attachment = await prisma.cppAttachment.findFirst({
			where: { id: attachmentId, requestId: id },
		});
		if (!attachment) throw new ApiError(404, "Attachment not found");

		await prisma.$transaction(async (tx) => {
			await tx.cppAttachment.delete({ where: { id: attachmentId } });
			await tx.cppRequest.update({
				where: { id },
				data: { updated_at: new Date() },
			});
		});
		await deleteReportImage(attachment.s3Key).catch(() => undefined);

		res.status(200).json({ success: true, message: "Attachment removed" });
	} catch (error) {
		next(error);
	}
};

/* ===== matrix.controller ===== */
// cpp.matrix.controller.ts — admin approval matrix: who sits in which approval role.
//   GET  /cpp/approval-matrix           roles, assignments, coverage problems
//   PUT  /cpp/approval-matrix           save assignments (blocks changes that leave a slot empty)
//   POST /cpp/approval-matrix/replace-user   swap one person for another in every slot
//   GET  /cpp/approval-matrix/users?search=  people picker
//   GET  /cpp/approval-matrix/chains    the 71 workflow chains (read-only preview)

type PersonRow = { id: string; name: string | null; email: string | null };

const fullName = (u: { first_name: string | null; last_name: string | null }) =>
	[u.first_name, u.last_name].filter(Boolean).join(" ").trim() || null;

const loadPeople = async (ids: string[]): Promise<Map<string, PersonRow>> => {
	if (ids.length === 0) return new Map();
	const users = await prisma.user.findMany({
		where: { id: { in: ids } },
		select: { id: true, first_name: true, last_name: true, email: true },
	});
	return new Map<string, PersonRow>(
		users.map((u) => [u.id, { id: u.id, name: fullName(u), email: u.email }]),
	);
};

const loadMatrix = async (workspaceId: string) => {
	const rows = await prisma.cppSlotAssignment.findMany({
		where: { workspaceId },
		orderBy: [{ roleKey: "asc" }, { scope: "asc" }, { position: "asc" }],
	});
	const people = await loadPeople([...new Set(rows.map((r) => r.userId))]);
	const usage = roleUsage();
	const slots = rowsToSlotMap(rows);

	return {
		roles: CPP_ROLES.map((role) => ({
			key: role.key,
			label: role.label,
			group: role.group,
			scope: role.scope,
			scopes: scopesForRole(role),
			assignable: role.assignable,
			observer: role.observer ?? false,
			note: role.note ?? null,
			usedByBands: usage.get(role.key) ?? 0,
		})),
		assignments: rows.reduce<
			Array<{
				roleKey: string;
				scope: string;
				users: Array<PersonRow | { id: string; name: null; email: null }>;
			}>
		>((list, row) => {
			let slot = list.find(
				(s) => s.roleKey === row.roleKey && s.scope === row.scope,
			);
			if (!slot) {
				slot = { roleKey: row.roleKey, scope: row.scope, users: [] };
				list.push(slot);
			}
			slot.users.push(
				people.get(row.userId) ?? { id: row.userId, name: null, email: null },
			);
			return list;
		}, []),
		coverage: computeCoverage(slots),
		updatedAt: rows.reduce<Date | null>(
			(latest, r) => (!latest || r.updated_at > latest ? r.updated_at : latest),
			null,
		),
	};
};

export const getApprovalMatrix = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const workspaceId = requireWorkspaceId(req);
		res
			.status(200)
			.json({ success: true, data: await loadMatrix(workspaceId) });
	} catch (error) {
		next(error);
	}
};

export const saveApprovalMatrix = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const userId = requireUserId(req);
		const workspaceId = requireWorkspaceId(req);

		let updates: SlotUpdate[];
		try {
			updates = parseSlotUpdates(req.body?.assignments);
		} catch (error) {
			throw new ApiError(400, (error as Error).message);
		}

		const allIds = [...new Set(updates.flatMap((u) => u.userIds))];
		const people = await loadPeople(allIds);
		const missing = allIds.filter((id) => !people.has(id));
		if (missing.length)
			throw new ApiError(
				400,
				"Some selected users no longer exist. Reload and try again.",
			);

		const current = await prisma.cppSlotAssignment.findMany({
			where: { workspaceId },
		});
		const before = rowsToSlotMap(current);
		const after = rowsToSlotMap(current);
		for (const update of updates)
			after.set(`${update.roleKey}:${update.scope}`, update.userIds);

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

		res.status(200).json({
			success: true,
			message: "Approval matrix saved",
			data: await loadMatrix(workspaceId),
		});
	} catch (error) {
		next(error);
	}
};

// POST /approval-matrix/replace-user { fromUserId, toUserId } — the yearly handover.
export const replaceMatrixUser = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const userId = requireUserId(req);
		const workspaceId = requireWorkspaceId(req);
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
		if (fromUserId === toUserId)
			throw new ApiError(400, "Pick two different people");
		const people = await loadPeople([toUserId]);
		if (!people.has(toUserId))
			throw new ApiError(400, "The replacement user was not found");

		const rows = await prisma.cppSlotAssignment.findMany({
			where: { workspaceId },
		});
		const plan = planReplaceUser(rows, fromUserId, toUserId);
		if (plan.updates.length + plan.deletes.length === 0)
			throw new ApiError(
				404,
				"That person is not assigned to any approval role",
			);

		await prisma.$transaction(async (tx) => {
			if (plan.updates.length)
				await tx.cppSlotAssignment.updateMany({
					where: { id: { in: plan.updates } },
					data: { userId: toUserId, updatedById: userId },
				});
			if (plan.deletes.length)
				await tx.cppSlotAssignment.deleteMany({
					where: { id: { in: plan.deletes } },
				});
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

		// Requests already in flight keep their own snapshot of approvers (added with the workflow step).
		res.status(200).json({
			success: true,
			message: `Replaced in ${plan.updates.length + plan.deletes.length} role(s)`,
			data: await loadMatrix(workspaceId),
		});
	} catch (error) {
		next(error);
	}
};

// GET /approval-matrix/users?search=  (same workspace, active users only)
export const searchMatrixUsers = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		const workspaceId = requireWorkspaceId(req);
		const search =
			typeof req.query.search === "string"
				? req.query.search.trim().slice(0, 60)
				: "";
		const contains = { contains: search, mode: "insensitive" as const };
		const users = await prisma.user.findMany({
			where: {
				is_active: true,
				workspaceUsers: { some: { workspaceId } },
				...(search
					? {
							OR: [
								{ first_name: contains },
								{ last_name: contains },
								{ email: contains },
							],
						}
					: {}),
			},
			select: { id: true, first_name: true, last_name: true, email: true },
			orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
			take: 25,
		});
		res.status(200).json({
			success: true,
			data: users.map((u) => ({ id: u.id, name: fullName(u), email: u.email })),
		});
	} catch (error) {
		next(error);
	}
};

// GET /approval-matrix/chains
export const getApprovalChains = async (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	try {
		requireUserId(req);
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
	} catch (error) {
		next(error);
	}
};
