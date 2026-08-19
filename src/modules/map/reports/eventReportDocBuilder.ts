import { displayValue, displayDate } from "@pdf/pdfFieldFormatter";
import { ResolvedField } from "./eventReportAggregator";
import { TATA_HITACHI_LOGO_DATA_URI } from "../../../assets/TataHitachiLogo";

// ─────────────────────────────────────────────────────────────────────────────
// eventReportDocBuilder.ts
//
// Pure function: resolved field data → pdfmake docDefinition. No S3, no
// Prisma, no async — everything it needs arrives already resolved from
// eventReportGenerator.services.ts. Keeping this pure means the layout can
// be iterated on and eyeballed without re-running the aggregator or
// touching the database.
//
// SHELL REDESIGN (this pass) — matches the branded "Test Results" mockup:
// orange title banner, orange "Test Results" section banner, zebra-striped
// key/value table, bordered Comments box, side "STRICTLY FOR INTERNAL USE
// ONLY" strips, TATA HITACHI logo top-right. Same shell is reused for every
// event-type template (18 templates) and for both LEAD_FORM and DATA_FORM
// sourceTypes — only the title, field rows, and table variant (single vs.
// benchmarking) change per template.
//
// KNOWN SIMPLIFICATIONS vs. the mockup (flagged for review, not silently
// decided):
//   - Banner corners are square, not rounded (pdfmake table cells don't
//     support corner radius; would need a canvas-drawn shape layered under
//     text, which is meaningfully more fragile to maintain for a solo-dev
//     KISS bias).
//   - Zebra striping alternates strictly every row. The mockup's shading
//     isn't a strict alternation (some rows are peach two in a row) — that
//     looked like manual/content-driven shading rather than a fixed
//     pattern, so strict alternation is the simplest faithful equivalent.
//   - No per-page repeating header — logo/top strap render once, at the
//     top of the document, not on every page. Add a `header:` callback
//     later if reports commonly span multiple pages and need this.
//   - Benchmarking's comparison-summary bullets (e.g. "ZX220GI IS BETTER
//     THAN EC220DL... Fuel Efficiency by 9.0%") are NOT implemented —
//     there's no field in BuildEventReportDocParams carrying that computed
//     comparison text/numbers yet. Needs a source (aggregator? computed in
//     eventReportGenerator.services.ts?) before this can be wired in.
//   - No SPoC / contact-person footer line (mockup 2) — no such field
//     currently flows into this builder; not fabricated.
//   - Logo is a low-res placeholder cropped from a screenshot (see
//     tataHitachiLogo.asset.ts) — swap for the real asset before production.
// ─────────────────────────────────────────────────────────────────────────────

type ImageWithData = {
  position: number;
  caption: string | null;
  dataUri: string;
};

type BuildEventReportDocParams = {
  proposalNumber: string;
  reportTitle: string; // e.g. "Standalone Product Study – R215L in Earthwork"
  reportSubtitle?: string | null; // e.g. product-study type name; replaces the old static hint text
  inputFields: ResolvedField[];
  outcomeFields: ResolvedField[];
  dualVariant: boolean;
  eventHighlights: string | null;
  images: ImageWithData[];
};

const IMAGE_CELL_WIDTH = 220;

// ── Brand constants ────────────────────────────────────────────────────────
// Sampled from the provided mockup screenshots, not from official brand
// guidelines — confirm exact hex values against Tata Hitachi's brand kit
// if one exists before treating these as final.
const BRAND_ORANGE = "#E97132";
const BRAND_PEACH = "#FBE3D6";
const BRAND_GREY_TEXT = "#555555";
const STRICT_USE_TEXT = "STRICTLY FOR TATA HITACHI INTERNAL USE ONLY";

// Renders a single resolved value for display — dates get the shared date
// formatter, everything else falls back to displayValue's "—" for empty.
function formatFieldValue(value: unknown): string {
  if (value instanceof Date) return displayDate(value);
  if (typeof value === "number")
    return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return displayValue(value as string | null | undefined);
}

// ── Banner (title bar / section bar) ─────────────────────────────────────────
// Shared by the top title banner and the "Test Results" section banner —
// same visual treatment (orange fill, white text), only content differs.

function buildBanner(title: string, subtitle?: string | null): any {
  const stackContent: any[] = [
    { text: title, color: "white", bold: true, fontSize: 13 },
  ];
  if (subtitle) {
    stackContent.push({
      text: subtitle,
      color: "white",
      italics: true,
      fontSize: 10,
      margin: [0, 2, 0, 0],
    });
  }

  return {
    table: {
      widths: ["100%"],
      body: [[{ stack: stackContent }]],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingLeft: () => 10,
      paddingRight: () => 10,
      paddingTop: () => 8,
      paddingBottom: () => 8,
      fillColor: () => BRAND_ORANGE,
    },
    margin: [0, 0, 0, 12],
  };
}

// ── Input / single-variant outcome table — two columns: label, value ─────────
// Zebra-striped: even row index = white, odd = peach.

function buildKeyValueTable(fields: ResolvedField[]): any {
  return {
    table: {
      widths: ["40%", "60%"],
      body: fields.map((field) => {
        const value = "value" in field ? field.value : null;
        return [
          { text: field.reportLabel, bold: true, fontSize: 10 },
          { text: formatFieldValue(value), fontSize: 10 },
        ];
      }),
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => "#DDDDDD",
      vLineColor: () => "#DDDDDD",
      paddingLeft: () => 8,
      paddingRight: () => 8,
      paddingTop: () => 5,
      paddingBottom: () => 5,
      fillColor: (rowIndex: number) =>
        rowIndex % 2 === 1 ? BRAND_PEACH : null,
    },
    margin: [0, 0, 0, 16],
  };
}

// ── Benchmarking outcome table — three columns: label, Tata Hitachi, Competition ──
// Header row (row 0) stays white/bold, not orange — matches the mockup,
// where only the section banner above the table is colored. Zebra striping
// starts from the first data row (row 1).

function buildBenchmarkingTable(fields: ResolvedField[]): any {
  return {
    table: {
      widths: ["34%", "33%", "33%"],
      body: [
        [
          { text: "", bold: true, fontSize: 10 },
          { text: "Tata Hitachi", bold: true, fontSize: 10 },
          { text: "Competition", bold: true, fontSize: 10 },
        ],
        ...fields.map((field) => {
          const tataHitachiValue =
            "tataHitachiValue" in field ? field.tataHitachiValue : null;
          const competitionValue =
            "competitionValue" in field ? field.competitionValue : null;
          return [
            { text: field.reportLabel, bold: true, fontSize: 10 },
            { text: formatFieldValue(tataHitachiValue), fontSize: 10 },
            { text: formatFieldValue(competitionValue), fontSize: 10 },
          ];
        }),
      ],
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => "#DDDDDD",
      vLineColor: () => "#DDDDDD",
      paddingLeft: () => 8,
      paddingRight: () => 8,
      paddingTop: () => 5,
      paddingBottom: () => 5,
      fillColor: (rowIndex: number) =>
        rowIndex > 0 && rowIndex % 2 === 0 ? BRAND_PEACH : null,
    },
    margin: [0, 0, 0, 16],
  };
}

// ── Comments box ──────────────────────────────────────────────────────────────
// Bordered box with a bold "Comments :" label and bullet lines, sourced from
// eventHighlights (split on newlines). Falls back to a few blank bullet
// lines (matching the mockup's "…" placeholders) when there's no highlight
// text yet, so the box isn't empty/awkward on reports still in progress.

const COMMENTS_PLACEHOLDER_LINE_COUNT = 3;

function buildCommentsBox(eventHighlights: string | null): any {
  const lines = eventHighlights
    ? eventHighlights
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];

  const bulletLines =
    lines.length > 0
      ? lines
      : Array.from({ length: COMMENTS_PLACEHOLDER_LINE_COUNT }, () => "…");

  return {
    table: {
      widths: ["100%"],
      body: [
        [
          {
            stack: [
              {
                text: "Comments :",
                bold: true,
                fontSize: 10,
                margin: [0, 0, 0, 6],
              },
              {
                ul: bulletLines.map((line) => ({ text: line, fontSize: 10 })),
              },
            ],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => "#000000",
      vLineColor: () => "#000000",
      paddingLeft: () => 10,
      paddingRight: () => 10,
      paddingTop: () => 8,
      paddingBottom: () => 40, // leaves room to feel like the mockup's tall box
    },
    margin: [0, 8, 0, 0],
  };
}

// ── Image grid — 2 columns per row, caption under each image ─────────────────

function chunkIntoPairs<T>(items: T[]): T[][] {
  const pairs: T[][] = [];
  for (let i = 0; i < items.length; i += 2) {
    pairs.push(items.slice(i, i + 2));
  }
  return pairs;
}

function buildImageCell(image: ImageWithData | undefined): any {
  if (!image) return {}; // empty cell when there's an odd number of images

  return {
    stack: [
      { image: image.dataUri, width: IMAGE_CELL_WIDTH },
      {
        text: image.caption ?? "",
        fontSize: 9,
        italics: true,
        margin: [0, 4, 0, 0],
      },
    ],
    margin: [0, 0, 0, 12],
  };
}

function buildImageGrid(images: ImageWithData[]): any[] {
  const sorted = [...images].sort((a, b) => a.position - b.position);
  const rows = chunkIntoPairs(sorted);

  return rows.map((pair) => ({
    columns: [buildImageCell(pair[0]), buildImageCell(pair[1])],
    columnGap: 16,
  }));
}

// ── Header (logo + top strap) ─────────────────────────────────────────────────
// Renders once at the top of the document (not per-page — see file-level
// note on repeating headers).

function buildHeader(): any[] {
  return [
    {
      text: STRICT_USE_TEXT,
      fontSize: 7,
      color: BRAND_GREY_TEXT,
      alignment: "center",
      margin: [0, 0, 0, 4],
    },
    {
      columns: [
        { text: "", width: "*" },
        {
          width: 140,
          stack: [
            { image: TATA_HITACHI_LOGO_DATA_URI, width: 140 },
            {
              table: {
                widths: ["auto"],
                body: [
                  [
                    {
                      text: "Reliable solutions",
                      color: "white",
                      italics: true,
                      fontSize: 8,
                    },
                  ],
                ],
              },
              layout: {
                hLineWidth: () => 0,
                vLineWidth: () => 0,
                paddingLeft: () => 8,
                paddingRight: () => 8,
                paddingTop: () => 3,
                paddingBottom: () => 3,
                fillColor: () => BRAND_ORANGE,
              },
              // Aligns the tag's right edge to the stack's right edge —
              // and since the stack width (140) matches the logo's width,
              // that puts the tag directly under the logo instead of
              // independently right-aligned within its own row.
              alignment: "right",
              margin: [0, 4, 0, 0],
            },
          ],
        },
      ],
      margin: [0, 2, 0, 16],
    },
  ];
}

// ── Page background — left accent spine + side "internal use" strips ─────────
// Rendered per-page via pdfmake's `background` callback. Side strips use SVG
// since pdfmake's plain text nodes don't support arbitrary rotation.

function buildVerticalStripSvg(heightPx: number): string {
  const midY = heightPx / 2;
  return `<svg width="20" height="${heightPx}"><text x="10" y="${midY}" font-size="7" fill="${BRAND_GREY_TEXT}" text-anchor="middle" transform="rotate(-90 10,${midY})">${STRICT_USE_TEXT}</text></svg>`;
}

function pageBackground(
  _currentPage: number,
  pageSize: { width: number; height: number },
): any[] {
  return [
    {
      canvas: [
        {
          type: "rect",
          x: 0,
          y: 0,
          w: 5,
          h: pageSize.height,
          color: BRAND_ORANGE,
        },
      ],
    },
    {
      svg: buildVerticalStripSvg(pageSize.height - 80),
      absolutePosition: { x: 16, y: 40 },
    },
    {
      svg: buildVerticalStripSvg(pageSize.height - 80),
      absolutePosition: { x: pageSize.width - 30, y: 40 },
    },
  ];
}

// ── Public API ────────────────────────────────────────────────────────────────

export function buildEventReportDocDefinition(
  params: BuildEventReportDocParams,
): any {
  const content: any[] = [
    ...buildHeader(),
    buildBanner(params.reportTitle, params.reportSubtitle),
    buildBanner("Test Results"),
    params.dualVariant
      ? buildBenchmarkingTable(params.outcomeFields)
      : buildKeyValueTable(params.inputFields.concat(params.outcomeFields)),
  ];

  content.push(buildCommentsBox(params.eventHighlights));

  if (params.images.length > 0) {
    content.push(
      { text: "Pictures", fontSize: 12, bold: true, margin: [0, 16, 0, 8] },
      ...buildImageGrid(params.images),
    );
  }

  return {
    pageSize: "A4",
    pageMargins: [40, 40, 40, 60],
    background: pageBackground,
    defaultStyle: { fontSize: 10, font: "Helvetica" },
    content,
  };
}
