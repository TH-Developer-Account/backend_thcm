/* ===== constants ===== */
// cpp.constants.ts — keys and allow-lists shared by the CPP controller + helper.

export const CPP_APP_KEY = "CPP";
export const CPP_MODULE = "CPP_REQUEST";

/** ActivityLog.subjectType (WorkflowSubjectType enum). Matrix audit rows use it too, tagged by metadata.target. */
export const CPP_LOG_SUBJECT = { REQUEST: "CPP_REQUEST" } as const;
export const CPP_MATRIX_LOG_TARGET = "APPROVAL_MATRIX";
/** Admin screen that assigns people to approval roles (seed it like CPP_REQUEST). */
export const CPP_MATRIX_MODULE = "CPP_APPROVAL_MATRIX";

/**
 * DRAFT -> IN_PROGRESS (WF 1, then WF 2 if the band needs the committee)
 *       -> PRICE_FEEDING (SCM Head does the price-feeding task) -> COMPLETED.
 * CLARIFICATION_REQUESTED = sent back to the proposer for a document / data change.
 */
export const CPP_STATUS = {
	DRAFT: "DRAFT",
	IN_PROGRESS: "IN_PROGRESS",
	CLARIFICATION_REQUESTED: "CLARIFICATION_REQUESTED",
	PRICE_FEEDING: "PRICE_FEEDING",
	COMPLETED: "COMPLETED",
} as const;

/**
 * The database column is a plain String (no Prisma enum), so adding a status
 * is a code change here only — no migration. Always compare against CPP_STATUS,
 * never a typed string literal.
 */
export type CppStatusValue = (typeof CPP_STATUS)[keyof typeof CPP_STATUS];
export const CPP_STATUSES: readonly CppStatusValue[] =
	Object.values(CPP_STATUS);
export const isCppStatus = (value: unknown): value is CppStatusValue =>
	typeof value === "string" &&
	(CPP_STATUSES as readonly string[]).includes(value);

/** Statuses a requester may still edit. */
export const CPP_EDITABLE_STATUSES: readonly CppStatusValue[] = [
	CPP_STATUS.DRAFT,
	CPP_STATUS.CLARIFICATION_REQUESTED,
];

export const CPP_MATERIAL_TYPES = ["Direct", "Indirect"] as const;
export const CPP_PRICE_TYPES = ["STANDARD", "SUBCONTRACTING"] as const;
export const CPP_EFFECTS = ["Quality", "Cost", "Delivery"] as const;
/** "Applicable plants" on the form (different from the routing plant). */
export const CPP_APPLICABLE_PLANTS = ["DWD", "KGP", "SPARE"] as const;

/**
 * Attachment slots. "purchasingFile" is the Excel (Purchase Info Record) that
 * is handed to TCS; the other ten are the "Attachments Required" list in the
 * CPP format. One file per slot — uploading again replaces it.
 */
export const CPP_ATTACHMENT_TYPES = [
	"purchasingFile",
	"modelImpact",
	"zbc",
	"commodityTrend",
	"ecn",
	"nesting",
	"comparativeQuote",
	"addDeleteList",
	"oldCost",
	"clpSpares",
	"steelApproval",
	"annualisedImpact",
	"partSummary",
] as const;
export type CppAttachmentType = (typeof CPP_ATTACHMENT_TYPES)[number];

export const CPP_MAX_FILE_SIZE = 10 * 1024 * 1024; // matches the frontend 10 MB limit

const SPREADSHEET_MIME = [
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.ms-excel",
	"text/csv",
	"application/csv",
];
const SPREADSHEET_EXT = ["xlsx", "xls", "csv"];

const DOCUMENT_MIME = [
	"application/pdf",
	"image/jpeg",
	"image/png",
	"application/msword",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	...SPREADSHEET_MIME,
];
const DOCUMENT_EXT = [
	"pdf",
	"jpg",
	"jpeg",
	"png",
	"doc",
	"docx",
	...SPREADSHEET_EXT,
];

export const CPP_FILE_RULES: Record<
	CppAttachmentType,
	{ mime: string[]; ext: string[]; label: string }
> = {
	purchasingFile: {
		mime: SPREADSHEET_MIME,
		ext: SPREADSHEET_EXT,
		label: "XLSX, XLS or CSV",
	},
	partSummary: {
		mime: SPREADSHEET_MIME,
		ext: SPREADSHEET_EXT,
		label: "XLSX, XLS or CSV (use the summary sheet template)",
	},
	...Object.fromEntries(
		CPP_ATTACHMENT_TYPES.filter((t) => t !== "purchasingFile" && t !== "partSummary").map((t) => [
			t,
			{
				mime: DOCUMENT_MIME,
				ext: DOCUMENT_EXT,
				label: "PDF, image, Word or Excel",
			},
		]),
	),
} as Record<
	CppAttachmentType,
	{ mime: string[]; ext: string[]; label: string }
>;

export const CPP_LISTING_SORT_FIELDS = [
	"created_at",
	"updated_at",
	"referenceNumber",
	"status",
	"category",
	"plant",
	"condition",
	"supplierName",
	"annualisedValue",
	"annualisedImpact",
	"actualImpact",
] as const;

export const CPP_MAX_PAGE_SIZE = 100;
export const CPP_DEFAULT_PAGE_SIZE = 25;

/* ===== roles ===== */
// cpp.roles.ts — the approver "slots" an admin fills in the approval matrix.
// A slot is a role (e.g. HEAD_SCM) and a scope: plant-specific roles need one
// assignment per plant (KGP, DWD); the rest have a single ALL assignment.
// The routing rules (cpp.chains.ts) only ever name roles, never people, so
// changing who sits in a role never touches the rules.

export const CPP_SLOT_SCOPES = ["ALL", "KGP", "DWD"] as const;
export type CppSlotScope = (typeof CPP_SLOT_SCOPES)[number];

export type CppRoleGroup =
	| "Requester"
	| "Recommenders"
	| "Checker"
	| "Approvers"
	| "Spares"
	| "Imports"
	| "CPP committee"
	| "Chairmen"
	| "Managing Director"
	| "Observers";

export type CppRoleDef = {
	key: string;
	label: string;
	group: CppRoleGroup;
	/** PLANT = one assignment each for KGP and DWD. ALL = a single assignment. */
	scope: "PLANT" | "ALL";
	/** false = filled by the requester / system, so the admin does not assign it. */
	assignable: boolean;
	/** Observers see requests but never act on them. */
	observer?: boolean;
	note?: string;
};

export const CPP_ROLES: CppRoleDef[] = [
	{
		key: "A_C_MANAGER",
		label: "A/C Manager (Proposer)",
		group: "Requester",
		scope: "ALL",
		assignable: false,
		note: "The person who creates the request.",
	},

	{
		key: "CATEGORY_HEAD",
		label: "Category Head KGP/DWD",
		group: "Recommenders",
		scope: "PLANT",
		assignable: true,
	},
	{
		key: "CATEGORY_HEAD_STEEL",
		label: "Category Head for Steel KGP/DWD",
		group: "Recommenders",
		scope: "PLANT",
		assignable: true,
	},
	{
		key: "INDIRECT_HEAD",
		label: "Indirect Head KGP/DWD",
		group: "Recommenders",
		scope: "PLANT",
		assignable: true,
	},
	{
		key: "HEAD_COMP_DEV",
		label: "Head Component Development KGP/DWD",
		group: "Recommenders",
		scope: "PLANT",
		assignable: true,
	},
	{
		key: "VERTICAL_HEAD_PROPRIETARY_IMPORTS",
		label: "Vertical Head Proprietary & Imports",
		group: "Recommenders",
		scope: "ALL",
		assignable: true,
		note: "Second recommender for category DOMP.",
	},
	{
		key: "HEAD_IMPORTS_PROCUREMENT",
		label: "Head Imports Procurement",
		group: "Recommenders",
		scope: "ALL",
		assignable: true,
		note: "Second recommender for Import HCM / NON HCM (open question Q11).",
	},

	{
		key: "COST_CONTROLLER",
		label: "Cost Controller",
		group: "Checker",
		scope: "ALL",
		assignable: true,
	},

	{
		key: "HEAD_SCM",
		label: "Head SCM KGP / Head SCM DWD",
		group: "Approvers",
		scope: "PLANT",
		assignable: true,
	},
	{
		key: "HEAD_SCM_KGP_PLANT_IMPORTS",
		label: "Head - SCM KGP Plant & Imports",
		group: "Approvers",
		scope: "ALL",
		assignable: true,
		note: "Import NON HCM goes here after the Cost Controller (open question Q13).",
	},
	{
		key: "DESIGN_HEAD",
		label: "Design Head KGP/DWD",
		group: "Approvers",
		scope: "PLANT",
		assignable: true,
	},
	{
		key: "PLANT_HEAD",
		label: "Plant Head KGP/DWD",
		group: "Approvers",
		scope: "PLANT",
		assignable: true,
	},
	{
		key: "SCM_HEAD",
		label: "SCM Head",
		group: "Approvers",
		scope: "ALL",
		assignable: true,
		note: "Also does the final price-feeding task.",
	},

	{
		key: "CATEGORY_HEAD_SPARES_SOURCING",
		label: "Category Head Spares Sourcing",
		group: "Spares",
		scope: "ALL",
		assignable: true,
	},
	{
		key: "HEAD_SPARE_PARTS",
		label: "Head Spare Parts",
		group: "Spares",
		scope: "ALL",
		assignable: true,
	},
	{
		key: "SPARES_HEAD",
		label: "Spares Head",
		group: "Spares",
		scope: "ALL",
		assignable: true,
	},

	...[1, 2, 3, 4, 5, 6, 7].map(
		(n): CppRoleDef => ({
			key: `COMMITTEE_${n}`,
			label: `CPP committee member ${n}`,
			group: "CPP committee",
			scope: "ALL",
			assignable: true,
			note: n === 1 ? "Any 3 of the 7 members must approve." : undefined,
		}),
	),

	{
		key: "ALT_CHAIRMAN",
		label: "Alt Chairman - CPP",
		group: "Chairmen",
		scope: "ALL",
		assignable: true,
		note: "Parallel with the Chairman: either one can approve.",
	},
	{
		key: "CHAIRMAN",
		label: "Chairman - CPP",
		group: "Chairmen",
		scope: "ALL",
		assignable: true,
	},
	{
		key: "MD_THCM",
		label: "Managing Director (MD) - THCM",
		group: "Managing Director",
		scope: "ALL",
		assignable: true,
	},

	{
		key: "OBSERVER",
		label: "Observers",
		group: "Observers",
		scope: "ALL",
		assignable: true,
		observer: true,
		note: "Can open every CPP request, cannot approve or comment as an approver.",
	},
];

const ROLE_MAP = new Map(CPP_ROLES.map((role) => [role.key, role]));

export const getRole = (key: string): CppRoleDef | undefined =>
	ROLE_MAP.get(key);

export const CPP_ROLE_KEYS = CPP_ROLES.map((role) => role.key);

/** The scopes an admin has to fill for a role. */
export const scopesForRole = (role: CppRoleDef): CppSlotScope[] =>
	role.scope === "PLANT" ? ["KGP", "DWD"] : ["ALL"];

/** Roles the admin can assign (everything except the requester). */
export const ASSIGNABLE_ROLES = CPP_ROLES.filter((role) => role.assignable);

export const slotKey = (roleKey: string, scope: string) =>
	`${roleKey}:${scope}`;

export const isValidSlot = (roleKey: string, scope: string): boolean => {
	const role = getRole(roleKey);
	if (!role || !role.assignable) return false;
	return (scopesForRole(role) as string[]).includes(scope);
};
