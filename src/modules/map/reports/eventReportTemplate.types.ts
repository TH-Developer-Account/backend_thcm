import {
  ParticipantType,
  ParticipantStatus,
} from "../../../prisma/generated/prisma/client";
import { MachineStudySummary } from "./machineSummary";

export type InputFieldSource =
  | { kind: "EPC_FIELD"; path: string }
  | { kind: "FREE_TEXT" };

export type OutcomeComputation =
  | { kind: "COUNT_ALL" }
  | {
      kind: "COUNT_BY_PARTICIPANT_TYPE";
      value: ParticipantType | readonly ParticipantType[];
    }
  | { kind: "COUNT_BY_PARTICIPANT_STATUS"; value: ParticipantStatus }
  | {
      kind: "COST_PER_PARTICIPANT_STATUS";
      status: ParticipantStatus;
      label: string;
    }
  | {
      kind: "COUNT_UNIQUE";
      field: "name" | "phone" | "email" | "companyName" | "machineSerial";
    }
  | { kind: "LIST_UNIQUE_VALUES"; field: "machineModel" }
  | {
      kind: "UNIQUE_VALUES";
      field: "location" | "district" | "state" | "dealership";
    }
  | { kind: "EARLIEST_DATE"; field: "eventDate" }
  | { kind: "LATEST_DATE"; field: "eventDate" }
  | {
      kind: "SUM";
      field:
        | "valueOfServiceOffers"
        | "valueOfPartsOffers"
        | "valueOfPartsBilled";
    }
  | { kind: "MACHINE_STUDY_SUMMARY"; field: keyof MachineStudySummary }
  | {
      kind: "BENCHMARK_PERCENT_BETTER";
      field: "ltrPerHr" | "tonsPerHr" | "tonsPerLtr";
      label: string;
    }
  | { kind: "DATA_FORM_VALUE"; field: string };

export interface EventReportTemplateConfig {
  reportTemplateKey: string;
  sourceType: "LEAD_FORM" | "DATA_FORM";
  minImages: number;
  maxImages: number;
  dualVariant?: boolean;
  inputFields: { reportLabel: string; source: InputFieldSource }[];
  outcomeFields: { reportLabel: string; computation: OutcomeComputation }[];
}
