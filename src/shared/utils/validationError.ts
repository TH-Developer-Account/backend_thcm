import ApiError from "@shared/utils/apiError";

export type FieldError = { path: string; message: string };

// 422 with per-field messages. `path` uses the same dotted form paths as the
// frontend form (e.g. "parameters.2.scoreLevels.1.score"), so the UI can put
// each message next to its field.
class ValidationError extends ApiError {
	errors: FieldError[];

	constructor(
		errors: FieldError[],
		message = "Please fix the highlighted fields",
	) {
		super(422, message);
		this.errors = errors;
	}
}

export default ValidationError;
