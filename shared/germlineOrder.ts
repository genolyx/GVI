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

const blank = (max: number) => z.string().trim().max(max).default("");

export const germlineOrderSchema = z.object({
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

export function germlineOrderRow(input: GermlineOrderInput) {
  const text = (value: string) => value.trim() || null;
  return {
    testCategory: input.testCategory,
    otherTestType: text(input.otherTestType),
    packageCode: text(input.packageCode),
    reportMode: input.reportMode,
    partnerCaseNumber: text(input.partnerCaseNumber),
    priorCaseNumber: text(input.priorCaseNumber),
    patientName: text(input.patientName),
    patientBirth: text(input.patientBirth),
    patientGender: text(input.patientGender),
    patient2Name: text(input.patient2Name),
    patient2Birth: text(input.patient2Birth),
    patient2Gender: text(input.patient2Gender),
    patient2Affected: text(input.patient2Affected),
    patient3Name: text(input.patient3Name),
    patient3Birth: text(input.patient3Birth),
    patient3Gender: text(input.patient3Gender),
    patient3Affected: text(input.patient3Affected),
    hospitalName: text(input.hospitalName),
    doctor: text(input.doctor),
    medicalRecordId: text(input.medicalRecordId),
    sampleId: text(input.sampleId),
    affected: text(input.affected),
    clinicalInformation: text(input.clinicalInformation),
    sampleCollectionDate: text(input.sampleCollectionDate),
    receiptDate: text(input.receiptDate),
    reportLanguage: text(input.reportLanguage),
    reportType: text(input.reportType),
    specimenType: input.specimenType,
    sampleBarcode: text(input.sampleBarcode),
  };
}
