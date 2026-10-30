import type { TDocumentDefinitions } from "pdfmake/interfaces";

// pdfmake 0.3.x restructured its package: the root `require("pdfmake")`
// export is no longer the printer class (it's an unrelated virtual-fs/
// access-policy object used for client-side rendering). The actual
// PdfPrinter class now lives at pdfmake/js/Printer, as a default export.
// @types/pdfmake's declarations don't reflect this either, so this stays
// typed as `any` at the library boundary.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PdfPrinter: any = require("pdfmake/js/Printer").default;

// Standard 14 fonts are built into pdfmake's PDF spec support — no font
// files to ship. Swap this table if a custom brand font is needed later.
const fonts = {
  Helvetica: {
    normal: "Helvetica",
    bold: "Helvetica-Bold",
    italics: "Helvetica-Oblique",
    bolditalics: "Helvetica-BoldOblique",
  },
};

// pdfmake 0.3.x's constructor unconditionally calls urlResolver.resolve()
// on every font descriptor while resolving fonts — even standard built-in
// fonts like Helvetica that aren't URLs at all — and then awaits
// urlResolver.resolved(). We have no remote fonts to fetch, so this is a
// deliberate no-op stub, not a real resolver implementation.
const noopUrlResolver = {
  resolve: () => {},
  resolved: async () => {},
};

const printer = new PdfPrinter(fonts, undefined, noopUrlResolver);

export async function renderPdfBuffer(
  docDefinition: TDocumentDefinitions,
): Promise<Buffer> {
  const pdfDoc = await printer.createPdfKitDocument(docDefinition);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    pdfDoc.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdfDoc.on("end", () => resolve(Buffer.concat(chunks)));
    pdfDoc.on("error", reject);

    pdfDoc.end();
  });
}
