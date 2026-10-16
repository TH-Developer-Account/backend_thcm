import ApiError from "@shared/utils/apiError";

/**
 * Shape returned to the client. The frontend merges this straight into the
 * cached master list, which expects { value, label, code } (same as
 * GET /master-data), not the raw Prisma row.
 */
const toOption = (type: string, row: any) => {
	switch (type) {
		case "department":
			return {
				value: row.id,
				label: row.department_name,
				code: row.department_code,
			};
		case "region":
			return { value: row.id, label: row.region_name, code: row.region_code };
		case "branch":
			return { value: row.id, label: row.branch_name, code: row.branch_code };
		case "eventName":
			return { value: row.id, label: row.title };
		case "budgetMaster":
			return {
				value: row.id,
				label: `${row.code}`,
				description: `${row.id_desc}`,
				budgetAmount: row.value,
				fiscalYear: row.fiscal_year,
			};
		default:
			return row;
	}
};

const requireText = (value: unknown, label: string) => {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) throw new ApiError(400, `${label} is required`);
	return text;
};

const isActiveFrom = (status?: string) => (status ? status === "active" : true);

export const handleCreate = async (model: any, type: string, data: any) => {
	switch (type) {
		case "department":
			return toOption(
				type,
				await model.create({
					data: {
						department_name: requireText(data.name, "Name"),
						department_code: requireText(data.code, "Code"),
						isActive: isActiveFrom(data.status),
					},
				}),
			);

		case "region":
			return toOption(
				type,
				await model.create({
					data: {
						region_name: requireText(data.name, "Name"),
						region_code: requireText(data.code, "Code"),
						isActive: isActiveFrom(data.status),
					},
				}),
			);

		case "branch":
			return toOption(
				type,
				await model.create({
					data: {
						branch_name: requireText(data.name, "Name"),
						branch_code: requireText(data.code, "Code"),
						isActive: isActiveFrom(data.status),
					},
				}),
			);

		// EventName has no status / isActive column.
		case "eventName":
			return toOption(
				type,
				await model.create({
					data: { title: requireText(data.name, "Name") },
				}),
			);

		// BudgetMaster has no status / isActive column; all four fields are required.
		case "budgetMaster": {
			const value = Number(data.value);
			if (
				data.value === undefined ||
				data.value === "" ||
				!Number.isFinite(value)
			)
				throw new ApiError(400, "Budget amount is required");

			return toOption(
				type,
				await model.create({
					data: {
						code: requireText(data.code, "Code"),
						fiscal_year: requireText(data.fiscal_year, "Fiscal year"),
						id_desc: requireText(data.id_desc, "Description"),
						value,
					},
				}),
			);
		}

		default:
			throw new ApiError(400, "Invalid type");
	}
};

export const handleUpdate = async (model: any, type: string, data: any) => {
	switch (type) {
		case "department":
			return toOption(
				type,
				await model.update({
					where: { id: data.id },
					data: {
						...(data.name && { department_name: data.name }),
						...(data.code && { department_code: data.code }),
						...(data.status && { isActive: data.status === "active" }),
					},
				}),
			);

		case "region":
			return toOption(
				type,
				await model.update({
					where: { id: data.id },
					data: {
						...(data.name && { region_name: data.name }),
						...(data.code && { region_code: data.code }),
						...(data.status && { isActive: data.status === "active" }),
					},
				}),
			);

		case "branch":
			return toOption(
				type,
				await model.update({
					where: { id: data.id },
					data: {
						...(data.name && { branch_name: data.name }),
						...(data.code && { branch_code: data.code }),
						...(data.status && { isActive: data.status === "active" }),
					},
				}),
			);

		case "eventName":
			return toOption(
				type,
				await model.update({
					where: { id: data.id },
					data: { ...(data.name && { title: data.name }) },
				}),
			);

		case "budgetMaster":
			return toOption(
				type,
				await model.update({
					where: { id: data.id },
					data: {
						...(data.code && { code: data.code }),
						...(data.fiscal_year && { fiscal_year: data.fiscal_year }),
						...(data.id_desc && { id_desc: data.id_desc }),
						...(data.value !== undefined && { value: data.value }),
					},
				}),
			);

		default:
			throw new ApiError(400, "Invalid type");
	}
};
