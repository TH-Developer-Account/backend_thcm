// Create / update for the Masters admin (POST /master-data/manage).
//
// Changes vs the previous version (see CHANGES.md):
//  - Removed the non-existent `status` field that made department / branch /
//    eventName / budgetMaster create + update throw. Those models use
//    `isActive`, which is now only written when the caller sends a boolean
//    (never defaulted), so tables without the column are unaffected.
//  - department / branch now persist their code (department_code /
//    branch_code); before, the code from the form was silently dropped.
const active = (data: any) =>
	typeof data.isActive === "boolean" ? { isActive: data.isActive } : {};

export const handleCreate = async (model: any, type: string, data: any) => {
	switch (type) {
		case "department":
			return model.create({
				data: {
					department_name: data.name,
					...(data.code && { department_code: data.code }),
					...active(data),
				},
			});

		case "branch":
			return model.create({
				data: {
					branch_name: data.name,
					...(data.code && { branch_code: data.code }),
					...active(data),
				},
			});

		case "eventScale":
		case "eventName":
			return model.create({
				data: {
					title: data.name,
					...active(data),
				},
			});

		case "budgetMaster":
			return model.create({
				data: {
					code: data.code,
					fiscal_year: data.fiscal_year,
					id_desc: data.id_desc,
					value: data.value,
					...active(data),
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

		// Zone (formerly the separate Region master — same table now) uses
		// region_code/region_name, not name. region_code is unique + required.
		case "zone":
			return model.create({
				data: {
					region_code: data.code,
					region_name: data.name,
					isActive: data.isActive ?? true,
				},
			});

		// Grade eligibility: grade + annual cap (update case already existed).
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
		case "department":
			return model.update({
				where: { id: data.id },
				data: {
					...(data.name && { department_name: data.name }),
					...(data.code && { department_code: data.code }),
					...active(data),
				},
			});

		case "branch":
			return model.update({
				where: { id: data.id },
				data: {
					...(data.name && { branch_name: data.name }),
					...(data.code && { branch_code: data.code }),
					...active(data),
				},
			});

		case "eventScale":
		case "eventName":
			return model.update({
				where: { id: data.id },
				data: {
					...(data.name && { title: data.name }),
					...active(data),
				},
			});

		case "budgetMaster":
			return model.update({
				where: { id: data.id },
				data: {
					...(data.code && { code: data.code }),
					...(data.fiscal_year && { fiscal_year: data.fiscal_year }),
					...(data.id_desc && { id_desc: data.id_desc }),
					// `!== undefined` so a budget can be set to 0 (was `&&`).
					...(data.value !== undefined && { value: data.value }),
					...active(data),
				},
			});

		case "division":
			return model.update({
				where: { id: data.id },
				data: {
					...(data.name && { name: data.name }),
					...active(data),
				},
			});

		case "designation":
			return model.update({
				where: { id: data.id },
				data: {
					...(data.name && { name: data.name }),
					...active(data),
				},
			});

		case "costCenter":
			return model.update({
				where: { id: data.id },
				data: {
					...(data.code && { code: data.code }),
					...(data.name && { name: data.name }),
					...active(data),
				},
			});

		// Zone uses region_code/region_name, not name — see the create case.
		case "zone":
			return model.update({
				where: { id: data.id },
				data: {
					...(data.code && { region_code: data.code }),
					...(data.name && { region_name: data.name }),
					...active(data),
				},
			});

		case "gradeEligibility":
			return model.update({
				where: { id: data.id },
				data: {
					...(data.grade && { grade: data.grade }),
					...(data.annualCap && { annualCap: data.annualCap }),
				},
			});

		default:
			throw new Error("Invalid type");
	}
};
