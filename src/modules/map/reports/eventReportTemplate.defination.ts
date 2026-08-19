import { EventReportTemplateConfig } from "./eventReportTemplate.types";

const EPC_INPUT_FIELDS = {
  event: {
    reportLabel: "Event",
    source: { kind: "EPC_FIELD", path: "event_name.title" } as const,
  },
  eventDateFrom: (label = "Event Date") => ({
    reportLabel: label,
    source: { kind: "EPC_FIELD", path: "event_from_date" } as const,
  }),
  location: (label = "Location") => ({
    reportLabel: label,
    source: { kind: "EPC_FIELD", path: "location" } as const,
  }),
  district: {
    reportLabel: "District",
    source: { kind: "EPC_FIELD", path: "district" } as const,
  },
  state: {
    reportLabel: "State",
    source: { kind: "EPC_FIELD", path: "state" } as const,
  },
  dealership: {
    reportLabel: "Dealership",
    source: { kind: "EPC_FIELD", path: "dealership" } as const,
  },
};

const STANDARD_PARTICIPANT_OUTCOMES = [
  { reportLabel: "Total Participants", computation: { kind: "COUNT_ALL" } },
  {
    reportLabel: "No. of Customers",
    computation: {
      kind: "COUNT_BY_PARTICIPANT_TYPE",
      value: ["CUSTOMER", "CUSTOMER_KEY_ACCOUNT"],
    },
  },
  {
    reportLabel: "No. of Financier Representatives",
    computation: {
      kind: "COUNT_BY_PARTICIPANT_TYPE",
      value: "FINANCIER_EXECUTIVE",
    },
  },
  {
    reportLabel: "No. of Hitachi Representatives",
    computation: {
      kind: "COUNT_BY_PARTICIPANT_TYPE",
      value: "HITACHI_REPRESENTATIVE",
    },
  },
  {
    reportLabel: "No. of Tata Hitachi Representatives",
    computation: {
      kind: "COUNT_BY_PARTICIPANT_TYPE",
      value: "TATA_HITACHI_EXECUTIVE",
    },
  },
  {
    reportLabel: "No. of Dealer Representatives",
    computation: {
      kind: "COUNT_BY_PARTICIPANT_TYPE",
      value: "DEALERSHIP_EXECUTIVE",
    },
  },
  {
    reportLabel: "Hot Enquiries",
    computation: { kind: "COUNT_BY_PARTICIPANT_STATUS", value: "HOT_ENQUIRY" },
  },
  {
    reportLabel: "Warm Enquiries",
    computation: { kind: "COUNT_BY_PARTICIPANT_STATUS", value: "WARM_ENQUIRY" },
  },
  {
    reportLabel: "Cold Enquiries",
    computation: { kind: "COUNT_BY_PARTICIPANT_STATUS", value: "COLD_ENQUIRY" },
  },
  {
    reportLabel: "No. of Key Handovers",
    computation: { kind: "COUNT_BY_PARTICIPANT_STATUS", value: "KEY_HANDOVER" },
  },
  {
    reportLabel: "No. of Bookings",
    computation: { kind: "COUNT_BY_PARTICIPANT_STATUS", value: "BOOKING" },
  },
  {
    reportLabel: "No. of Felicitations",
    computation: { kind: "COUNT_BY_PARTICIPANT_STATUS", value: "FELICITATION" },
  },
] as const;

const MACHINE_STUDY_HEADER_OUTCOMES = [
  {
    reportLabel: "Machine Model",
    computation: { kind: "DATA_FORM_VALUE", field: "machineModel" },
  },
  {
    reportLabel: "Customer Name",
    computation: { kind: "DATA_FORM_VALUE", field: "customerName" },
  },
  {
    reportLabel: "Start Date",
    computation: { kind: "DATA_FORM_VALUE", field: "startDate" },
  },
  {
    reportLabel: "End Date",
    computation: { kind: "DATA_FORM_VALUE", field: "endDate" },
  },
  {
    reportLabel: "Application",
    computation: { kind: "DATA_FORM_VALUE", field: "application" },
  },
  {
    reportLabel: "Fuel Type",
    computation: { kind: "DATA_FORM_VALUE", field: "fuelType" },
  },
  {
    reportLabel: "Start HMR",
    computation: { kind: "DATA_FORM_VALUE", field: "startHmr" },
  },
  {
    reportLabel: "End HMR",
    computation: { kind: "DATA_FORM_VALUE", field: "endHmr" },
  },
  {
    reportLabel: "Bucket (cu.m)",
    computation: { kind: "DATA_FORM_VALUE", field: "bucketVolumeCuM" },
  },
  {
    reportLabel: "AC Status",
    computation: { kind: "DATA_FORM_VALUE", field: "acStatus" },
  },
  {
    reportLabel: "Operation Mode",
    computation: { kind: "DATA_FORM_VALUE", field: "operationMode" },
  },
  {
    reportLabel: "Loading Time",
    computation: { kind: "MACHINE_STUDY_SUMMARY", field: "loadingTimeSeconds" },
  },
  {
    reportLabel: "Preparation Time",
    computation: {
      kind: "MACHINE_STUDY_SUMMARY",
      field: "preparationTimeSeconds",
    },
  },
  {
    reportLabel: "Total Time",
    computation: { kind: "MACHINE_STUDY_SUMMARY", field: "totalTimeSeconds" },
  },
  {
    reportLabel: "Total Buckets Loaded",
    computation: { kind: "MACHINE_STUDY_SUMMARY", field: "totalBucketsLoaded" },
  },
  {
    reportLabel: "Avg. Time Per Bucket",
    computation: {
      kind: "MACHINE_STUDY_SUMMARY",
      field: "avgTimePerBucketSeconds",
    },
  },
  {
    reportLabel: "Total Payload (Kg)",
    computation: { kind: "MACHINE_STUDY_SUMMARY", field: "totalPayloadKg" },
  },
  {
    reportLabel: "Ltr/hr",
    computation: { kind: "MACHINE_STUDY_SUMMARY", field: "ltrPerHr" },
  },
  {
    reportLabel: "Tons/Ltr",
    computation: { kind: "MACHINE_STUDY_SUMMARY", field: "tonsPerLtr" },
  },
  {
    reportLabel: "Tons/Hr",
    computation: { kind: "MACHINE_STUDY_SUMMARY", field: "tonsPerHr" },
  },
] as const;

export const EVENT_REPORT_TEMPLATES: Record<string, EventReportTemplateConfig> =
  {
    CUSTOMER_MEET: {
      reportTemplateKey: "CUSTOMER_MEET",
      sourceType: "LEAD_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [
        EPC_INPUT_FIELDS.event,
        EPC_INPUT_FIELDS.eventDateFrom(),
        EPC_INPUT_FIELDS.location(),
        EPC_INPUT_FIELDS.district,
        EPC_INPUT_FIELDS.state,
        EPC_INPUT_FIELDS.dealership,
      ],
      outcomeFields: [...STANDARD_PARTICIPANT_OUTCOMES],
    },

    CUSTOMER_MEET_KEY_ACCOUNT: {
      reportTemplateKey: "CUSTOMER_MEET_KEY_ACCOUNT",
      sourceType: "LEAD_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [
        EPC_INPUT_FIELDS.event,
        EPC_INPUT_FIELDS.eventDateFrom(),
        EPC_INPUT_FIELDS.location(),
        EPC_INPUT_FIELDS.district,
        EPC_INPUT_FIELDS.state,
        EPC_INPUT_FIELDS.dealership,
      ],
      outcomeFields: [...STANDARD_PARTICIPANT_OUTCOMES],
    },

    PRODUCT_LAUNCH: {
      reportTemplateKey: "PRODUCT_LAUNCH",
      sourceType: "LEAD_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [
        EPC_INPUT_FIELDS.event,
        EPC_INPUT_FIELDS.eventDateFrom(),
        EPC_INPUT_FIELDS.location(),
        EPC_INPUT_FIELDS.district,
        EPC_INPUT_FIELDS.state,
        EPC_INPUT_FIELDS.dealership,
      ],
      outcomeFields: [...STANDARD_PARTICIPANT_OUTCOMES],
    },

    LOAN_MELA: {
      reportTemplateKey: "LOAN_MELA",
      sourceType: "LEAD_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [
        EPC_INPUT_FIELDS.event,
        EPC_INPUT_FIELDS.location(),
        EPC_INPUT_FIELDS.district,
        EPC_INPUT_FIELDS.state,
        EPC_INPUT_FIELDS.dealership,
      ],
      outcomeFields: [
        {
          reportLabel: "Event Date (From)",
          computation: { kind: "EARLIEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Event Date (To)",
          computation: { kind: "LATEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Total Participants",
          computation: { kind: "COUNT_ALL" },
        },
        {
          reportLabel: "No. of Customers",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: ["CUSTOMER", "CUSTOMER_KEY_ACCOUNT"],
          },
        },
        {
          reportLabel: "No. of Financier Representatives",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "FINANCIER_EXECUTIVE",
          },
        },
        {
          reportLabel: "Hot Enquiries",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "HOT_ENQUIRY",
          },
        },
        {
          reportLabel: "Warm Enquiries",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "WARM_ENQUIRY",
          },
        },
        {
          reportLabel: "Cold Enquiries",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "COLD_ENQUIRY",
          },
        },
        {
          reportLabel: "No. of Key Handovers",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "KEY_HANDOVER",
          },
        },
        {
          reportLabel: "No. of Bookings",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "BOOKING",
          },
        },
      ],
    },

    EXHIBITION: {
      reportTemplateKey: "EXHIBITION",
      sourceType: "LEAD_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [
        EPC_INPUT_FIELDS.event,
        EPC_INPUT_FIELDS.location(),
        EPC_INPUT_FIELDS.district,
        EPC_INPUT_FIELDS.state,
        EPC_INPUT_FIELDS.dealership,
      ],
      outcomeFields: [
        {
          reportLabel: "Event Date (From)",
          computation: { kind: "EARLIEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Event Date (To)",
          computation: { kind: "LATEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Total Participants",
          computation: { kind: "COUNT_ALL" },
        },
        {
          reportLabel: "No. of Customers",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: ["CUSTOMER", "CUSTOMER_KEY_ACCOUNT"],
          },
        },
        {
          reportLabel: "No. of Financier Representatives",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "FINANCIER_EXECUTIVE",
          },
        },
        {
          reportLabel: "Hot Enquiries",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "HOT_ENQUIRY",
          },
        },
        {
          reportLabel: "Warm Enquiries",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "WARM_ENQUIRY",
          },
        },
        {
          reportLabel: "Cold Enquiries",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "COLD_ENQUIRY",
          },
        },
        {
          reportLabel: "No. of Key Handovers",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "KEY_HANDOVER",
          },
        },
        {
          reportLabel: "No. of Bookings",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "BOOKING",
          },
        },
      ],
    },

    ROADSHOW: {
      reportTemplateKey: "ROADSHOW",
      sourceType: "LEAD_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [EPC_INPUT_FIELDS.event],
      outcomeFields: [
        {
          reportLabel: "Event Date (From)",
          computation: { kind: "EARLIEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Event Date (To)",
          computation: { kind: "LATEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Location(s)",
          computation: { kind: "UNIQUE_VALUES", field: "location" },
        },
        {
          reportLabel: "District(s)",
          computation: { kind: "UNIQUE_VALUES", field: "district" },
        },
        {
          reportLabel: "State(s)",
          computation: { kind: "UNIQUE_VALUES", field: "state" },
        },
        {
          reportLabel: "Dealership",
          computation: { kind: "UNIQUE_VALUES", field: "dealership" },
        },
        {
          reportLabel: "No. of Customers",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: ["CUSTOMER", "CUSTOMER_KEY_ACCOUNT"],
          },
        },
        {
          reportLabel: "Hot Enquiries",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "HOT_ENQUIRY",
          },
        },
        {
          reportLabel: "Warm Enquiries",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "WARM_ENQUIRY",
          },
        },
        {
          reportLabel: "Cold Enquiries",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "COLD_ENQUIRY",
          },
        },
        {
          reportLabel: "No. of Key Handovers",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "KEY_HANDOVER",
          },
        },
        {
          reportLabel: "No. of Bookings",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "BOOKING",
          },
        },
      ],
    },

    MACHINE_DEMONSTRATION: {
      reportTemplateKey: "MACHINE_DEMONSTRATION",
      sourceType: "DATA_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [EPC_INPUT_FIELDS.event, EPC_INPUT_FIELDS.location()],
      outcomeFields: [...MACHINE_STUDY_HEADER_OUTCOMES],
    },

    STAND_ALONE_FUEL_PRODUCTION_STUDY: {
      reportTemplateKey: "STAND_ALONE_FUEL_PRODUCTION_STUDY",
      sourceType: "DATA_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [EPC_INPUT_FIELDS.event, EPC_INPUT_FIELDS.location()],
      outcomeFields: [...MACHINE_STUDY_HEADER_OUTCOMES],
    },

    FUEL_PRODUCTION_BENCHMARKING: {
      reportTemplateKey: "FUEL_PRODUCTION_BENCHMARKING",
      sourceType: "DATA_FORM",
      minImages: 1,
      maxImages: 10,
      dualVariant: true,
      inputFields: [EPC_INPUT_FIELDS.event, EPC_INPUT_FIELDS.location()],
      outcomeFields: [...MACHINE_STUDY_HEADER_OUTCOMES],
    },

    SERVICE_CAMPAIGN: {
      reportTemplateKey: "SERVICE_CAMPAIGN",
      sourceType: "LEAD_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [EPC_INPUT_FIELDS.event],
      outcomeFields: [
        {
          reportLabel: "Event Date (From)",
          computation: { kind: "EARLIEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Date (To)",
          computation: { kind: "LATEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Location(s)",
          computation: { kind: "UNIQUE_VALUES", field: "location" },
        },
        {
          reportLabel: "District",
          computation: { kind: "UNIQUE_VALUES", field: "district" },
        },
        {
          reportLabel: "State",
          computation: { kind: "UNIQUE_VALUES", field: "state" },
        },
        {
          reportLabel: "Dealership",
          computation: { kind: "UNIQUE_VALUES", field: "dealership" },
        },
        {
          reportLabel: "No. of Customers",
          computation: { kind: "COUNT_UNIQUE", field: "companyName" },
        },
        {
          reportLabel: "Machines Models Inspected",
          computation: { kind: "LIST_UNIQUE_VALUES", field: "machineModel" },
        },
        {
          reportLabel: "Machines Units Inspected",
          computation: { kind: "COUNT_UNIQUE", field: "machineSerial" },
        },
        {
          reportLabel: "Total Value of Service Offers",
          computation: { kind: "SUM", field: "valueOfServiceOffers" },
        },
        {
          reportLabel: "Total Value of Parts Offers",
          computation: { kind: "SUM", field: "valueOfPartsOffers" },
        },
      ],
    },

    PARTS_MELA: {
      reportTemplateKey: "PARTS_MELA",
      sourceType: "LEAD_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [
        EPC_INPUT_FIELDS.event,
        EPC_INPUT_FIELDS.location(),
        EPC_INPUT_FIELDS.district,
        EPC_INPUT_FIELDS.state,
      ],
      outcomeFields: [
        {
          reportLabel: "Event date (From)",
          computation: { kind: "EARLIEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Date (To)",
          computation: { kind: "LATEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Dealership",
          computation: { kind: "UNIQUE_VALUES", field: "dealership" },
        },
        {
          reportLabel: "No. of Customers",
          computation: { kind: "COUNT_UNIQUE", field: "companyName" },
        },
        {
          reportLabel: "Total Value of Parts Billed",
          computation: { kind: "SUM", field: "valueOfPartsBilled" },
        },
        {
          reportLabel: "Total Value of Parts Offers",
          computation: { kind: "SUM", field: "valueOfPartsOffers" },
        },
      ],
    },

    PLANT_VISIT: {
      reportTemplateKey: "PLANT_VISIT",
      sourceType: "LEAD_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [
        EPC_INPUT_FIELDS.event,
        EPC_INPUT_FIELDS.eventDateFrom(),
        EPC_INPUT_FIELDS.location(),
        EPC_INPUT_FIELDS.district,
        EPC_INPUT_FIELDS.state,
      ],
      outcomeFields: [
        {
          reportLabel: "Dealership",
          computation: { kind: "UNIQUE_VALUES", field: "dealership" },
        },
        {
          reportLabel: "No. of Customers",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: ["CUSTOMER", "CUSTOMER_KEY_ACCOUNT"],
          },
        },
        {
          reportLabel: "No. of Financier Representatives",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "FINANCIER_EXECUTIVE",
          },
        },
        {
          reportLabel: "No. of Hitachi Representatives",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "HITACHI_REPRESENTATIVE",
          },
        },
        {
          reportLabel: "No. of Tata Hitachi Representatives",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "TATA_HITACHI_EXECUTIVE",
          },
        },
        {
          reportLabel: "No. of Dealer Representatives",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "DEALERSHIP_EXECUTIVE",
          },
        },
        {
          reportLabel: "Hot Enquiries",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "HOT_ENQUIRY",
          },
        },
        {
          reportLabel: "Warm Enquiries",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "WARM_ENQUIRY",
          },
        },
        {
          reportLabel: "Cold Enquiries",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "COLD_ENQUIRY",
          },
        },
        {
          reportLabel: "No. of Key Handovers",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "KEY_HANDOVER",
          },
        },
        {
          reportLabel: "No. of Bookings",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "BOOKING",
          },
        },
        {
          reportLabel: "No. of Felicitations",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "FELICITATION",
          },
        },
      ],
    },

    TRAINING_TO_CUSTOMER_STAFF: {
      reportTemplateKey: "TRAINING_TO_CUSTOMER_STAFF",
      sourceType: "LEAD_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [
        EPC_INPUT_FIELDS.event,
        EPC_INPUT_FIELDS.location(),
        EPC_INPUT_FIELDS.district,
        EPC_INPUT_FIELDS.state,
      ],
      outcomeFields: [
        {
          reportLabel: "Event date (From)",
          computation: { kind: "EARLIEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Date (To)",
          computation: { kind: "LATEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Dealership",
          computation: { kind: "UNIQUE_VALUES", field: "dealership" },
        },
        {
          reportLabel: "No. of Customers",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "CUSTOMER_STAFF",
          },
        },
        {
          reportLabel: "No. of Tata Hitachi Representatives",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "TATA_HITACHI_EXECUTIVE",
          },
        },
        {
          reportLabel: "No. of Dealer Representatives",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "DEALERSHIP_EXECUTIVE",
          },
        },
      ],
    },

    TRAINING_TO_OPERATORS: {
      reportTemplateKey: "TRAINING_TO_OPERATORS",
      sourceType: "LEAD_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [
        EPC_INPUT_FIELDS.event,
        EPC_INPUT_FIELDS.location(),
        EPC_INPUT_FIELDS.district,
        EPC_INPUT_FIELDS.state,
      ],
      outcomeFields: [
        {
          reportLabel: "Event date (From)",
          computation: { kind: "EARLIEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Date (To)",
          computation: { kind: "LATEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Dealership",
          computation: { kind: "UNIQUE_VALUES", field: "dealership" },
        },
        {
          reportLabel: "No. of Operators",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "MACHINE_OPERATOR",
          },
        },
      ],
    },

    TRAINING_TO_MECHANICS: {
      reportTemplateKey: "TRAINING_TO_MECHANICS",
      sourceType: "LEAD_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [
        EPC_INPUT_FIELDS.event,
        EPC_INPUT_FIELDS.location(),
        EPC_INPUT_FIELDS.district,
        EPC_INPUT_FIELDS.state,
      ],
      outcomeFields: [
        {
          reportLabel: "Event date (From)",
          computation: { kind: "EARLIEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Date (To)",
          computation: { kind: "LATEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Dealership",
          computation: { kind: "UNIQUE_VALUES", field: "dealership" },
        },
        {
          reportLabel: "No. of Mechanics",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "MACHINE_MECHANIC",
          },
        },
      ],
    },

    OPERATOR_MEET: {
      reportTemplateKey: "OPERATOR_MEET",
      sourceType: "LEAD_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [
        EPC_INPUT_FIELDS.event,
        EPC_INPUT_FIELDS.location(),
        EPC_INPUT_FIELDS.district,
        EPC_INPUT_FIELDS.state,
      ],
      outcomeFields: [
        {
          reportLabel: "Event date (From)",
          computation: { kind: "EARLIEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Dealership",
          computation: { kind: "UNIQUE_VALUES", field: "dealership" },
        },
        {
          reportLabel: "No. of Operators",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "MACHINE_OPERATOR",
          },
        },
      ],
    },

    FINANCIER_MEET: {
      reportTemplateKey: "FINANCIER_MEET",
      sourceType: "LEAD_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [
        EPC_INPUT_FIELDS.event,
        EPC_INPUT_FIELDS.location("Location(s)"),
        EPC_INPUT_FIELDS.district,
        EPC_INPUT_FIELDS.state,
      ],
      outcomeFields: [
        {
          reportLabel: "Event date (From)",
          computation: { kind: "EARLIEST_DATE", field: "eventDate" },
        },
        {
          reportLabel: "Dealership",
          computation: { kind: "UNIQUE_VALUES", field: "dealership" },
        },
        {
          reportLabel: "No. of Financiers",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "FINANCIER_EXECUTIVE",
          },
        },
        {
          reportLabel: "Hot Enquiries",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "HOT_ENQUIRY",
          },
        },
        {
          reportLabel: "Warm Enquiries",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "WARM_ENQUIRY",
          },
        },
        {
          reportLabel: "Cold Enquiries",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_STATUS",
            value: "COLD_ENQUIRY",
          },
        },
      ],
    },

    GENERAL_REPORT: {
      reportTemplateKey: "GENERAL_REPORT",
      sourceType: "LEAD_FORM",
      minImages: 1,
      maxImages: 10,
      inputFields: [
        EPC_INPUT_FIELDS.event,
        EPC_INPUT_FIELDS.eventDateFrom(),
        EPC_INPUT_FIELDS.location("Location(s)"),
        EPC_INPUT_FIELDS.district,
        EPC_INPUT_FIELDS.state,
        EPC_INPUT_FIELDS.dealership,
      ],
      outcomeFields: [
        {
          reportLabel: "No. of Customers",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: ["CUSTOMER", "CUSTOMER_KEY_ACCOUNT"],
          },
        },
        {
          reportLabel: "No. of Vendors",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "VENDOR_PARTNER",
          },
        },
        {
          reportLabel: "No. of Hitachi Representatives",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "HITACHI_REPRESENTATIVE",
          },
        },
        {
          reportLabel: "No. of Financiers",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "FINANCIER_EXECUTIVE",
          },
        },
        {
          reportLabel: "No. of Tata Hitachi Executives",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "TATA_HITACHI_EXECUTIVE",
          },
        },
        {
          reportLabel: "No. of Dealership Executives",
          computation: {
            kind: "COUNT_BY_PARTICIPANT_TYPE",
            value: "DEALERSHIP_EXECUTIVE",
          },
        },
      ],
    },
  };
