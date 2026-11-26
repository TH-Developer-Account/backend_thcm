// NOTE (flagged, not fixed — out of scope for the Division/Designation/
// CostCenter/Vertical work this file was touched for): the
// "branch"/"eventScale"/"eventName" cases below write a `status` field that
// doesn't exist on those Prisma models — Branch et al. have `isActive:
// Boolean`, not `status`, per schema.prisma. Since ManageMasterPayload
// (frontend) never actually sends `data.status` either, `status: data.status
// ?? "active"` always evaluates to `status: "active"` on create, which would
// throw "Unknown argument `status`" against the real schema — these cases
// look to already be broken. Worth a dedicated fix; the
// division/designation/costCenter/zone/vertical/gradeEligibility cases below
// use `isActive` (or, for vertical/gradeEligibility, nothing — neither has a
// status/isActive column at all) correctly instead of copying this pattern.
export const handleCreate = async (model: any, type: string, data: any) => {
  switch (type) {
    case "branch":
      return model.create({
        data: {
          branch_name: data.name,
          status: data.status ?? "active",
        },
      });

    case "eventScale":
      return model.create({
        data: {
          title: data.name,
          status: data.status ?? "active",
        },
      });

    case "eventName":
      return model.create({
        data: {
          title: data.name,
          status: data.status ?? "active",
        },
      });

    case "budgetMaster":
      return model.create({
        data: {
          code: data.code,
          fiscal_year: data.fiscal_year,
          id_desc: data.id_desc,
          value: data.value,
          status: data.status ?? "active",
        },
      });

    case "division":
      return model.create({
        data: {
          name: data.name,
          isActive: data.isActive ?? true,
        },
      });

    case "designation":
      return model.create({
        data: {
          name: data.name,
          isActive: data.isActive ?? true,
        },
      });

    case "costCenter":
      return model.create({
        data: {
          code: data.code,
          name: data.name,
          isActive: data.isActive ?? true,
        },
      });

    // Zone (formerly the separate Region master — same table now; see
    // schema.prisma) uses region_code/region_name, not name — region_code
    // is unique and required, so it must be supplied on create.
    case "zone":
      return model.create({
        data: {
          region_code: data.code,
          region_name: data.name,
          isActive: data.isActive ?? true,
        },
      });

    // Vertical is scoped under a Division (divisionId is required — see
    // schema.prisma's @@unique([name, divisionId])) and, unlike every other
    // case above, has no isActive/status column at all: there's nothing to
    // default here. code is optional (EOR carries no Vertical code), so it's
    // only included when supplied.
    case "vertical":
      return model.create({
        data: {
          name: data.name,
          divisionId: data.divisionId,
          ...(data.code && { code: data.code }),
        },
      });

    // Grade Eligibility: grade (unique) + annualCap, no isActive/status
    // column either (see schema.prisma's GradeEligibility model). annualCap
    // is nullable on the model — updateUserHrData.ts/backfillHrMasters.ts
    // insert a grade discovered from EOR with annualCap = null, to be filled
    // in here — but the Masters admin form (masters.config.ts) marks it
    // required, so a manual create from that screen always supplies one.
    case "gradeEligibility":
      return model.create({
        data: {
          grade: data.grade,
          annualCap: data.annualCap,
        },
      });

    default:
      throw new Error("Invalid type");
  }
};

export const handleUpdate = async (model: any, type: string, data: any) => {
  switch (type) {
    case "branch":
      return model.update({
        where: { id: data.id },
        data: {
          ...(data.name && { branch_name: data.name }),
          ...(data.status && { status: data.status }),
        },
      });

    case "eventScale":
      return model.update({
        where: { id: data.id },
        data: {
          ...(data.name && { title: data.name }),
          ...(data.status && { status: data.status }),
        },
      });

    case "eventName":
      return model.update({
        where: { id: data.id },
        data: {
          ...(data.name && { title: data.name }),
          ...(data.status && { status: data.status }),
        },
      });

    case "budgetMaster":
      return model.update({
        where: { id: data.id },
        data: {
          ...(data.code && { code: data.code }),
          ...(data.fiscal_year && { fiscal_year: data.fiscal_year }),
          ...(data.id_desc && { id_desc: data.id_desc }),
          ...(data.value && { value: data.value }),
          ...(data.status && { status: data.status }),
        },
      });

    case "division":
      return model.update({
        where: { id: data.id },
        data: {
          ...(data.name && { name: data.name }),
          ...(typeof data.isActive === "boolean" && {
            isActive: data.isActive,
          }),
        },
      });

    case "designation":
      return model.update({
        where: { id: data.id },
        data: {
          ...(data.name && { name: data.name }),
          ...(typeof data.isActive === "boolean" && {
            isActive: data.isActive,
          }),
        },
      });

    case "costCenter":
      return model.update({
        where: { id: data.id },
        data: {
          ...(data.code && { code: data.code }),
          ...(data.name && { name: data.name }),
          ...(typeof data.isActive === "boolean" && {
            isActive: data.isActive,
          }),
        },
      });

    // Zone uses region_code/region_name, not name — see the create case above.
    case "zone":
      return model.update({
        where: { id: data.id },
        data: {
          ...(data.code && { region_code: data.code }),
          ...(data.name && { region_name: data.name }),
          ...(typeof data.isActive === "boolean" && {
            isActive: data.isActive,
          }),
        },
      });

    // Vertical: no isActive/status column — only name, divisionId (to
    // re-scope it under a different Division) and code are updatable.
    case "vertical":
      return model.update({
        where: { id: data.id },
        data: {
          ...(data.name && { name: data.name }),
          ...(data.divisionId && { divisionId: data.divisionId }),
          ...(data.code && { code: data.code }),
        },
      });

    // Grade Eligibility: grade and annualCap are both updatable. grade is
    // unique, same as every other name-only master above — renaming to an
    // existing grade is left to the DB's unique constraint to reject.
    case "gradeEligibility":
      return model.update({
        where: { id: data.id },
        data: {
          ...(data.grade && { grade: data.grade }),
          ...(data.annualCap !== undefined && { annualCap: data.annualCap }),
        },
      });

    default:
      throw new Error("Invalid type");
  }
};
