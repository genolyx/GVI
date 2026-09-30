import { z } from "zod";

export const GERMLINE_TEST_CATEGORIES = [
  "standard_carrier",
  "whole_exome",
  "health_screening",
  "other",
] as const;

export const GERMLINE_TEST_CATEGORY_LABEL: Record<
  (typeof GERMLINE_TEST_CATEGORIES)[number],
  string
> = {
  standard_carrier: "Carrier screening (standard)",
  whole_exome: "Whole exome",
  health_screening: "Health screening",
  other: "Other",
};

/** Service Portal order-create services. Single-gene NIPT is a separate product. */
export const GERMLINE_SERVICES = [
  "carrier_screening",
  "whole_exome",
  "health_screening",
  "extended_services",
] as const;

export type GermlineService = (typeof GERMLINE_SERVICES)[number];

export const GERMLINE_SERVICE_LABEL: Record<GermlineService, string> = {
  carrier_screening: "Carrier screening",
  whole_exome: "Whole exome",
  health_screening: "Health screening",
  extended_services: "Extended services",
};

export const GERMLINE_EXTENDED_PROGRAMS = [
  ["Exome", "Exome"],
  ["ExomeDuo", "ExomeDuo"],
  ["ExomeTrio", "ExomeTrio"],
  ["ExomeRapid", "ExomeRapid"],
  ["ExomeMax", "ExomeMax"],
  ["ExomeMaxDuo", "ExomeMaxDuo"],
  ["ExomeMaxTrio", "ExomeMaxTrio"],
  ["KaryoSeq_1Mb", "KaryoSeq >1MB"],
  ["KaryoSeqHD_50kb", "KaryoSeqHD >50kb"],
  ["WGS", "WGS"],
  ["HereditaryCancer", "Hereditary Cancer"],
  ["CouplesCarrier", "CouplesCarrier"],
] as const;

export function extendedProgramPatients(program: string) {
  return {
    patient2: PATIENT2_PROGRAMS.has(program),
    patient3: PATIENT3_PROGRAMS.has(program),
  };
}

const PATIENT2_PROGRAMS = new Set([
  "ExomeDuo",
  "CouplesCarrier",
  "ExomeMaxDuo",
  "ExomeTrio",
  "ExomeMaxTrio",
]);
const PATIENT3_PROGRAMS = new Set(["ExomeTrio", "ExomeMaxTrio"]);

export function germlineServiceFromStored(input: {
  testCategory?: string | null;
  packageCode?: string | null;
}): GermlineService {
  const category = (input.testCategory ?? "").trim();
  const packageCode = (input.packageCode ?? "").trim();
  if (category === "whole_exome" || packageCode === "WholeExome") return "whole_exome";
  if (category === "health_screening" || packageCode === "HealthScreening") {
    return "health_screening";
  }
  if (category === "other") return "extended_services";
  return "carrier_screening";
}

const blank = (max: number) => z.string().trim().max(max).default("");

export const germlineOrderSchema = z.object({
  service: z.enum(GERMLINE_SERVICES).optional(),
  testCategory: z.enum(GERMLINE_TEST_CATEGORIES).default("standard_carrier"),
  otherTestType: blank(160),
  packageCode: blank(80),
  reportMode: z.enum(["single", "couples"]).default("single"),
  partnerCaseNumber: blank(64),
  priorCaseNumber: blank(64),
  patientName: blank(160),
  patientBirth: blank(10),
  patientGender: z.enum(["", "Female", "Male", "Other"]).default(""),
  patient2Name: blank(160),
  patient2Birth: blank(10),
  patient2Gender: z.enum(["", "Female", "Male", "Other"]).default(""),
  patient2Affected: z.enum(["", "Yes", "No"]).default(""),
  patient3Name: blank(160),
  patient3Birth: blank(10),
  patient3Gender: z.enum(["", "Female", "Male", "Other"]).default(""),
  patient3Affected: z.enum(["", "Yes", "No"]).default(""),
  hospitalName: blank(200),
  doctor: blank(160),
  medicalRecordId: blank(80),
  sampleId: blank(80),
  affected: z.enum(["", "Yes", "No"]).default(""),
  clinicalInformation: blank(4000),
  sampleCollectionDate: blank(10),
  receiptDate: blank(10),
  reportLanguage: z.enum(["", "EN", "CN", "KO", "EN,CN"]).default(""),
  reportType: z.enum(["", "Printout", "Email", "Portal"]).default(""),
  specimenType: z.enum(["Blood", "Saliva", "Other"]).default("Blood"),
  sampleBarcode: blank(80),
});

export type GermlineOrderInput = z.infer<typeof germlineOrderSchema>;

export const defaultGermlineOrder: GermlineOrderInput = {
  service: "carrier_screening",
  testCategory: "standard_carrier",
  otherTestType: "",
  packageCode: "CarrierScreening",
  reportMode: "single",
  partnerCaseNumber: "",
  priorCaseNumber: "",
  patientName: "",
  patientBirth: "",
  patientGender: "",
  patient2Name: "",
  patient2Birth: "",
  patient2Gender: "",
  patient2Affected: "",
  patient3Name: "",
  patient3Birth: "",
  patient3Gender: "",
  patient3Affected: "",
  hospitalName: "",
  doctor: "",
  medicalRecordId: "",
  sampleId: "",
  affected: "",
  clinicalInformation: "",
  sampleCollectionDate: "",
  receiptDate: "",
  reportLanguage: "EN",
  reportType: "Portal",
  specimenType: "Blood",
  sampleBarcode: "",
};

export function normalizeGermlineOrder<T extends GermlineOrderInput>(input: T): T {
  const service = input.service ?? germlineServiceFromStored(input);
  const typedOther = input.otherTestType.trim();
  const typedPackage = input.packageCode.trim();
  const program =
    service === "extended_services"
      ? typedOther ||
        (typedPackage !== "CarrierScreening" &&
        typedPackage !== "WholeExome" &&
        typedPackage !== "HealthScreening"
          ? typedPackage
          : "")
      : "";
  const needPatient2 = service === "extended_services" && PATIENT2_PROGRAMS.has(program);
  const needPatient3 = service === "extended_services" && PATIENT3_PROGRAMS.has(program);
  const couples = service === "carrier_screening" && input.reportMode === "couples";
  return {
    ...input,
    service,
    testCategory: service === "extended_services" ? "other" : "standard_carrier",
    otherTestType: program,
    packageCode:
      service === "whole_exome"
        ? "WholeExome"
        : service === "health_screening"
          ? "HealthScreening"
          : service === "extended_services"
            ? program
            : "CarrierScreening",
    reportMode: couples ? "couples" : "single",
    partnerCaseNumber: couples ? input.partnerCaseNumber : "",
    patient2Name: needPatient2 ? input.patient2Name : "",
    patient2Birth: needPatient2 ? input.patient2Birth : "",
    patient2Gender: needPatient2 ? input.patient2Gender : "",
    patient2Affected: needPatient2 ? input.patient2Affected : "",
    patient3Name: needPatient3 ? input.patient3Name : "",
    patient3Birth: needPatient3 ? input.patient3Birth : "",
    patient3Gender: needPatient3 ? input.patient3Gender : "",
    patient3Affected: needPatient3 ? input.patient3Affected : "",
  };
}

export function germlineOrderMissing(input: GermlineOrderInput): string[] {
  const order = normalizeGermlineOrder(input);
  const missing: string[] = [];
  const need = (ok: boolean, label: string) => {
    if (!ok) missing.push(label);
  };
  need(Boolean(order.patientName.trim()), "Patient name");
  need(Boolean(order.patientBirth.trim()), "Patient birth");
  need(Boolean(order.patientGender), "Patient gender");
  need(Boolean(order.affected), "Affected");
  need(Boolean(order.hospitalName.trim()), "Hospital name");
  need(Boolean(order.doctor.trim()), "Doctor");
  need(Boolean(order.sampleCollectionDate.trim()), "Sample collection date");
  need(Boolean(order.reportLanguage), "Report language");
  need(Boolean(order.reportType), "Report type");
  if (order.service === "extended_services") {
    need(Boolean(order.otherTestType.trim()), "Primary");
  }
  if (order.reportMode === "couples") {
    need(Boolean(order.partnerCaseNumber.trim()), "Partner order ID");
  }
  const patients = extendedProgramPatients(order.otherTestType);
  if (patients.patient2) {
    need(Boolean(order.patient2Name.trim()), "Patient 2 name");
    need(Boolean(order.patient2Birth.trim()), "Patient 2 birth");
    need(Boolean(order.patient2Gender), "Patient 2 gender");
    need(Boolean(order.patient2Affected), "Patient 2 affected");
  }
  if (patients.patient3) {
    need(Boolean(order.patient3Name.trim()), "Patient 3 name");
    need(Boolean(order.patient3Birth.trim()), "Patient 3 birth");
    need(Boolean(order.patient3Gender), "Patient 3 gender");
    need(Boolean(order.patient3Affected), "Patient 3 affected");
  }
  return missing;
}

export function germlineOrderRow(input: GermlineOrderInput) {
  const normalized = normalizeGermlineOrder(input);
  const text = (value: string) => value.trim() || null;
  return {
    testCategory: normalized.testCategory,
    otherTestType: text(normalized.otherTestType),
    packageCode: text(normalized.packageCode),
    reportMode: normalized.reportMode,
    partnerCaseNumber: text(normalized.partnerCaseNumber),
    priorCaseNumber: text(normalized.priorCaseNumber),
    patientName: text(normalized.patientName),
    patientBirth: text(normalized.patientBirth),
    patientGender: text(normalized.patientGender),
    patient2Name: text(normalized.patient2Name),
    patient2Birth: text(normalized.patient2Birth),
    patient2Gender: text(normalized.patient2Gender),
    patient2Affected: text(normalized.patient2Affected),
    patient3Name: text(normalized.patient3Name),
    patient3Birth: text(normalized.patient3Birth),
    patient3Gender: text(normalized.patient3Gender),
    patient3Affected: text(normalized.patient3Affected),
    hospitalName: text(normalized.hospitalName),
    doctor: text(normalized.doctor),
    medicalRecordId: text(normalized.medicalRecordId),
    sampleId: text(normalized.sampleId),
    affected: text(normalized.affected),
    clinicalInformation: text(normalized.clinicalInformation),
    sampleCollectionDate: text(normalized.sampleCollectionDate),
    receiptDate: text(normalized.receiptDate),
    reportLanguage: text(normalized.reportLanguage),
    reportType: text(normalized.reportType),
    specimenType: normalized.specimenType,
    sampleBarcode: text(normalized.sampleBarcode),
  };
}
