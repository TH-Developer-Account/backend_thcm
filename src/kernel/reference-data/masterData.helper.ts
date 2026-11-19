// NOTE (flagged, not fixed — out of scope for the Division/Designation/
// CostCenter work this file was touched for): the "department"/"branch"/
// "eventScale"/"eventName" cases below write a `status` field that
// doesn't exist on those Prisma models — Department/Branch all have
// `isActive: Boolean`, not `status`, per schema.prisma. Since
// ManageMasterPayload (frontend) never actually sends `data.status` either,
// `status: data.status ?? "active"` always evaluates to `status: "active"`
// on create, which would throw "Unknown argument `status`" against the real
// schema — these cases look to already be broken. Worth a dedicated fix; the
// division/designation/costCenter/zone cases below use `isActive` correctly
// instead of copying this pattern.
export const handleCreate = async (model: any, type: string, data: any) => {
  switch (type) {
    case "department":
      return model.create({
        data: {
          department_name: data.name,
          status: data.status ?? "active",
        },
      });

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

    default:
      throw new Error("Invalid type");
  }
};

export const handleUpdate = async (model: any, type: string, data: any) => {
  switch (type) {
    case "department":
      return model.update({
        where: { id: data.id },
        data: {
          ...(data.name && { department_name: data.name }),
          ...(data.status && { status: data.status }), // 🔥 soft delete here
        },
      });

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

    default:
      throw new Error("Invalid type");
  }
};
