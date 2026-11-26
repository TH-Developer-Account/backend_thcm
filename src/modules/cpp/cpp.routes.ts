// cpp.routes.ts — mounted at /api/v1/cpp (see the app.ts line in the notes).
import { Router } from "express";
import multer from "multer";

import asyncHandler from "@shared/middleware/async.middleware";
import { authorize, requireAuth } from "@kernel/auth/auth.middleware";

import {
	CPP_APP_KEY,
	CPP_MATRIX_MODULE,
	CPP_MAX_FILE_SIZE,
	CPP_MODULE,
} from "./cpp.constants";
import {
	closeCppRequest,
	createCppRequest,
	deleteCppAttachment,
	deleteCppDraft,
	downloadCppExcel,
	downloadCppText,
	downloadCppTextByToken,
	getApprovalChains,
	getApprovalMatrix,
	getCppRequestById,
	getPartSummaryTemplate,
	listCppRequests,
	previewCppApproval,
	redirectToCppPdf,
	replaceMatrixUser,
	resubmitCppRequest,
	saveApprovalMatrix,
	searchMatrixUsers,
	submitCppRequest,
	syncApprovalTemplates,
	updateCppRequest,
	uploadCppAttachment,
} from "./cpp.controller";

const router = Router();

// In-memory like the other modules; the size cap stops a huge upload being buffered.
const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: CPP_MAX_FILE_SIZE, files: 1 },
});

/* Approval matrix (admin). Registered BEFORE "/:id" so "approval-matrix" is
 * never read as a request id. */
router.get(
	"/approval-matrix",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MATRIX_MODULE, "read"),
	asyncHandler(getApprovalMatrix),
);
router.put(
	"/approval-matrix",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MATRIX_MODULE, "write"),
	asyncHandler(saveApprovalMatrix),
);
router.post(
	"/approval-matrix/replace-user",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MATRIX_MODULE, "write"),
	asyncHandler(replaceMatrixUser),
);
router.post(
	"/approval-matrix/sync-templates",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MATRIX_MODULE, "write"),
	asyncHandler(syncApprovalTemplates),
);
router.get(
	"/approval-matrix/users",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MATRIX_MODULE, "write"),
	asyncHandler(searchMatrixUsers),
);
router.get(
	"/approval-matrix/chains",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MATRIX_MODULE, "read"),
	asyncHandler(getApprovalChains),
);

/* Public PDF view (no login). The token comes from the approved mail, like the
 * vendor onboarding /public/pdf/:token route. */
router.get("/public/pdf/:token", asyncHandler(redirectToCppPdf));
router.get("/public/text/:token", asyncHandler(downloadCppTextByToken));

/* Requests */
// Above "/:id" so "part-summary-template" is not read as a request id.
router.get(
	"/part-summary-template",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MODULE, "read"),
	asyncHandler(getPartSummaryTemplate),
);
router.get(
	"/",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MODULE, "read"),
	asyncHandler(listCppRequests),
);
router.post(
	"/",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MODULE, "write"),
	asyncHandler(createCppRequest),
);

router.get(
	"/:id",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MODULE, "read"),
	asyncHandler(getCppRequestById),
);
router.put(
	"/:id",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MODULE, "write"),
	asyncHandler(updateCppRequest),
);
router.delete(
	"/:id",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MODULE, "write"),
	asyncHandler(deleteCppDraft),
);

/* Approval */
router.get(
	"/:id/approval-preview",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MODULE, "read"),
	asyncHandler(previewCppApproval),
);
router.post(
	"/:id/submit",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MODULE, "write"),
	asyncHandler(submitCppRequest),
);
router.post(
	"/:id/resubmit",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MODULE, "write"),
	asyncHandler(resubmitCppRequest),
);

/* TCS closes the request once the SAP update is done (the handler checks who may; "read" so TCS users without write access can close). */
router.post(
	"/:id/close",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MODULE, "read"),
	asyncHandler(closeCppRequest),
);

/* Export */
router.get(
	"/:id/export/excel",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MODULE, "read"),
	asyncHandler(downloadCppExcel),
);
router.get(
	"/:id/export/text",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MODULE, "read"),
	asyncHandler(downloadCppText),
);

/* Attachments */
router.post(
	"/:id/attachments",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MODULE, "write"),
	upload.single("file"),
	asyncHandler(uploadCppAttachment),
);
router.delete(
	"/:id/attachments/:attachmentId",
	requireAuth,
	authorize(CPP_APP_KEY, CPP_MODULE, "write"),
	asyncHandler(deleteCppAttachment),
);

export default router;
