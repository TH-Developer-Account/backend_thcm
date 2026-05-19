import fs from "fs";
import path from "path";
import handlebars from "handlebars";

// ─────────────────────────────────────────────────────────────────────────────
// Template compiler
//
// Loads .hbs files from disk, compiles them with Handlebars, and returns
// the final HTML string.
//
// WHY separate from mail.service: template compilation is a pure transform
// (string in → string out). Keeping it isolated makes it independently
// testable and swappable (e.g. swap Handlebars for MJML later).
//
// Template directory: src/templates/emails/
// Base layout:        src/templates/emails/base.hbs
//
// Each content template is injected into {{{body}}} in base.hbs, so every
// mail automatically gets the shared header and footer — no duplication.
// ─────────────────────────────────────────────────────────────────────────────

// const TEMPLATES_DIR = path.resolve(__dirname, "../templates/emails");
const TEMPLATES_DIR = path.resolve(process.cwd(), "src/templates/emails");

// ── Register helper: current year for footer copyright ───────────────────────
handlebars.registerHelper("currentYear", () => new Date().getFullYear());

// ─────────────────────────────────────────────────────────────────────────────
// compileTemplate
//
// @param templateName  — filename without extension, e.g. "approval-approved"
// @param context       — data object injected into the template
// @returns             — compiled HTML string
// ─────────────────────────────────────────────────────────────────────────────

export function compileTemplate(
  templateName: string,
  context: Record<string, unknown>,
): string {
  const templatePath = path.join(TEMPLATES_DIR, `${templateName}.hbs`);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Mail template not found: ${templateName}.hbs`);
  }

  const source = fs.readFileSync(templatePath, "utf-8");
  const template = handlebars.compile(source);

  return template(context);
}
