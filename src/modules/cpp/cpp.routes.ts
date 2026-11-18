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
	createCppRequest,
	deleteCppAttachment,
	deleteCppDraft,
	getCppRequestById,
	listCppRequests,
	updateCppRequest,
	uploadCppAttachment,
} from "./cpp.controller";
import {
	getApprovalChains,
	getApprovalMatrix,
	replaceMatrixUser,
	saveApprovalMatrix,
	searchMatrixUsers,
} from "./cpp.controller";
import { previewCppApproval, submitCppRequest } from "./cpp.submit.controller";

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

/* Requests */
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
