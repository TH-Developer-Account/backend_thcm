import { displayValue, displayDate } from "@pdf/pdfFieldFormatter";
import { ResolvedField } from "./eventReportAggregator";
import { TATA_HITACHI_LOGO_DATA_URI } from "../../../assets/TataHitachiLogo";

// ─────────────────────────────────────────────────────────────────────────────
// eventReportDocBuilder.ts
//
// Pure function: resolved field data → pdfmake docDefinition. No S3, no
// Prisma, no async — everything it needs arrives already resolved from
// eventReportGenerator.services.ts.
//
// THIS PASS: wires in the benchmark comparison bullets (previously flagged
// as not implemented — data now exists via
// eventReportAggregator.ts's resolveBenchmarkComparison, which produces
// ResolvedField entries shaped { reportLabel, percentBetter, betterVariant }
// for BENCHMARK_PERCENT_BETTER outcome fields). Also restores currency
// formatting for "Cost per ..." fields, which existed in an earlier pass
// of this file and was dropped during the branded-shell redesign.
//
// KNOWN SIMPLIFICATIONS (carried over, still true):
//   - Banner corners square, not rounded.
//   - Zebra striping alternates strictly every row.
//   - No per-page repeating header.
//   - No SPoC / contact-person footer line.
//   - Logo is a placeholder asset — swap before production.
// ─────────────────────────────────────────────────────────────────────────────

type ImageWithData = {
  position: number;
  caption: string | null;
  dataUri: string;
};

type BuildEventReportDocParams = {
  proposalNumber: string;
  reportTitle: string;
  reportSubtitle?: string | null;
  inputFields: ResolvedField[];
  outcomeFields: ResolvedField[];
  dualVariant: boolean;
  eventHighlights: string | null;
  images: ImageWithData[];
};

const IMAGE_CELL_WIDTH = 220;

const BRAND_ORANGE = "#E97132";
const BRAND_PEACH = "#FBE3D6";
const BRAND_GREY_TEXT = "#555555";
const STRICT_USE_TEXT = "STRICTLY FOR TATA HITACHI INTERNAL USE ONLY";
const CURRENCY_LABEL_PREFIX = "Cost per";

function isCurrencyField(reportLabel: string): boolean {
  return reportLabel.startsWith(CURRENCY_LABEL_PREFIX);
}

function formatFieldValue(value: unknown, isCurrency = false): string {
  if (value instanceof Date) return displayDate(value);
  if (typeof value === "number") {
    return isCurrency
      ? `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
      : value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }
  return displayValue(value as string | null | undefined);
}

// ── Type guard — isolates the BENCHMARK_PERCENT_BETTER-shaped fields from
// the rest of a template's outcomeFields, used both to build the
// comparison box and to exclude them from the main data table. ────────────

function isComparisonField(
  field: ResolvedField,
): field is Extract<ResolvedField, { percentBetter: number | null }> {
  return "percentBetter" in field;
}

// ── Banner (title bar / section bar) ─────────────────────────────────────────

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

// ── Benchmark comparison box ──────────────────────────────────────────────────
// Bordered box, orange-accented, one bullet per BENCHMARK_PERCENT_BETTER
// field — e.g. "Tata Hitachi is better than Competition in Fuel Efficiency
// (Ltr/Hr) by 9.0%". Mirrors the mockup's bullet-list callout that sits
// between the title banner and the "Test Results" table. Returns an empty
// array when there's nothing to show (no comparison fields, or every
// comparison came back null — e.g. one machine's study data incomplete),
// so it's safe to always call and spread into content.

function buildBenchmarkComparisonBox(outcomeFields: ResolvedField[]): any[] {
  const comparisons = outcomeFields.filter(isComparisonField);
  if (comparisons.length === 0) return [];

  const bulletLines = comparisons.map((field) => {
    if (field.percentBetter === null || field.betterVariant === null) {
      return {
        text: `${field.reportLabel}: comparison not available`,
        fontSize: 10,
        color: BRAND_GREY_TEXT,
      };
    }
    const winner =
      field.betterVariant === "tataHitachi" ? "Tata Hitachi" : "Competition";
    const loser =
      field.betterVariant === "tataHitachi" ? "Competition" : "Tata Hitachi";
    return {
      text: `${winner} is better than ${loser} in ${field.reportLabel} by ${field.percentBetter.toFixed(1)}%`,
      fontSize: 10,
      bold: true,
    };
  });

  return [
    {
      table: {
        widths: ["100%"],
        body: [
          [
            {
              stack: [
                {
                  text: "Comparison Summary :",
                  bold: true,
                  fontSize: 10,
                  margin: [0, 0, 0, 6],
                },
                { ul: bulletLines },
              ],
            },
          ],
        ],
      },
      layout: {
        hLineWidth: () => 1,
        vLineWidth: () => 1,
        hLineColor: () => BRAND_ORANGE,
        vLineColor: () => BRAND_ORANGE,
        paddingLeft: () => 10,
        paddingRight: () => 10,
        paddingTop: () => 8,
        paddingBottom: () => 8,
        fillColor: () => BRAND_PEACH,
      },
      margin: [0, 0, 0, 12],
    },
  ];
}

// ── Input / single-variant outcome table — two columns: label, value ─────────

function buildKeyValueTable(fields: ResolvedField[]): any {
  return {
    table: {
      widths: ["40%", "60%"],
      body: fields.map((field) => {
        const value = "value" in field ? field.value : null;
        return [
          { text: field.reportLabel, bold: true, fontSize: 10 },
          {
            text: formatFieldValue(value, isCurrencyField(field.reportLabel)),
            fontSize: 10,
          },
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
// Excludes BENCHMARK_PERCENT_BETTER fields — those render in the comparison
// box above, not as rows here (they have no tataHitachiValue/
// competitionValue to show, only a single derived percentage).

function buildBenchmarkingTable(fields: ResolvedField[]): any {
  const tableFields = fields.filter((f) => !isComparisonField(f));

  return {
    table: {
      widths: ["34%", "33%", "33%"],
      body: [
        [
          { text: "", bold: true, fontSize: 10 },
          { text: "Tata Hitachi", bold: true, fontSize: 10 },
          { text: "Competition", bold: true, fontSize: 10 },
        ],
        ...tableFields.map((field) => {
          const tataHitachiValue =
            "tataHitachiValue" in field ? field.tataHitachiValue : null;
          const competitionValue =
            "competitionValue" in field ? field.competitionValue : null;
          const currency = isCurrencyField(field.reportLabel);
          return [
            { text: field.reportLabel, bold: true, fontSize: 10 },
            {
              text: formatFieldValue(tataHitachiValue, currency),
              fontSize: 10,
            },
            {
              text: formatFieldValue(competitionValue, currency),
              fontSize: 10,
            },
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
              { ul: bulletLines.map((line) => ({ text: line, fontSize: 10 })) },
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
      paddingBottom: () => 40,
    },
    margin: [0, 8, 0, 0],
  };
}

// ── Image grid ─────────────────────────────────────────────────────────────

function chunkIntoPairs<T>(items: T[]): T[][] {
  const pairs: T[][] = [];
  for (let i = 0; i < items.length; i += 2) {
    pairs.push(items.slice(i, i + 2));
  }
  return pairs;
}

function buildImageCell(image: ImageWithData | undefined): any {
  if (!image) return {};

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

// ── Page background ──────────────────────────────────────────────────────────

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
  ];

  if (params.dualVariant) {
    content.push(...buildBenchmarkComparisonBox(params.outcomeFields));
  }

  content.push(
    buildBanner("Test Results"),
    params.dualVariant
      ? buildBenchmarkingTable(params.outcomeFields)
      : buildKeyValueTable(params.inputFields.concat(params.outcomeFields)),
  );

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
