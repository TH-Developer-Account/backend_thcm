export const handleCreate = async (model: any, type: string, data: any) => {
  switch (type) {
    case "department":
      return model.create({
        data: {
          department_name: data.name,
          status: data.status ?? "active",
        },
      });

    case "region":
      return model.create({
        data: {
          region_name: data.name,
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

    case "region":
      return model.update({
        where: { id: data.id },
        data: {
          ...(data.name && { region_name: data.name }),
          ...(data.status && { status: data.status }),
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

    default:
      throw new Error("Invalid type");
  }
};
