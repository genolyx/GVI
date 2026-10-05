import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  extendedProgramPatients,
  normalizeGermlineOrder,
  type GermlineOrderInput,
} from "@shared/germlineOrder";
import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

const selectClass =
  "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm";

function Field({
  label,
  required,
  invalid,
  children,
}: {
  label: string;
  required?: boolean;
  invalid?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<{ id?: string; className?: string }>, {
        id,
        className: cn(
          (children.props as { className?: string }).className,
          invalid && "border-destructive"
        ),
      })
    : children;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {child}
    </div>
  );
}

export function GermlineOrderFields({
  value,
  onChange,
}: {
  value: GermlineOrderInput;
  onChange: (value: GermlineOrderInput) => void;
}) {
  const set = (patch: Partial<GermlineOrderInput>) =>
    onChange(normalizeGermlineOrder({ ...value, ...patch }));
  const service = value.service ?? "carrier_screening";
  const patients = extendedProgramPatients(value.otherTestType);
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="space-y-4 rounded-xl border border-border/70 p-4">
        <h3 className="text-sm font-semibold">Test type and report pairing</h3>
        {service === "carrier_screening" ? (
          <>
            <Field label="Report mode">
              <select
                className={selectClass}
                value={value.reportMode}
                onChange={event =>
                  set({ reportMode: event.target.value as GermlineOrderInput["reportMode"] })
                }
              >
                <option value="single">Single</option>
                <option value="couples">Couples</option>
              </select>
            </Field>
            {value.reportMode === "couples" ? (
              <Field
                label="Partner order ID"
                required
                invalid={!value.partnerCaseNumber.trim()}
              >
                <Input
                  value={value.partnerCaseNumber}
                  onChange={event => set({ partnerCaseNumber: event.target.value })}
                  placeholder="Other case number"
                />
              </Field>
            ) : null}
          </>
        ) : null}
        <Field label="Prior order (follow-up)">
          <Input
            value={value.priorCaseNumber}
            onChange={event => set({ priorCaseNumber: event.target.value })}
          />
        </Field>
      </section>
      <section className="space-y-4 rounded-xl border border-border/70 p-4">
        <h3 className="text-sm font-semibold">Hospital and identifiers</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Hospital name">
            <Input value={value.hospitalName} onChange={event => set({ hospitalName: event.target.value })} />
          </Field>
          <Field label="Doctor">
            <Input value={value.doctor} onChange={event => set({ doctor: event.target.value })} />
          </Field>
          <Field label="Medical record ID">
            <Input value={value.medicalRecordId} onChange={event => set({ medicalRecordId: event.target.value })} />
          </Field>
          <Field label="Sample ID">
            <Input value={value.sampleId} onChange={event => set({ sampleId: event.target.value })} />
          </Field>
        </div>
        <Field label="Clinical information">
          <Textarea
            value={value.clinicalInformation}
            onChange={event => set({ clinicalInformation: event.target.value })}
            placeholder="Relevant clinical notes for this order"
          />
        </Field>
      </section>
      <section className="space-y-4 rounded-xl border border-border/70 p-4">
        <h3 className="text-sm font-semibold">Patient</h3>
        <Field label="Patient name" required invalid={!value.patientName.trim()}>
          <Input value={value.patientName} onChange={event => set({ patientName: event.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Patient birth" required invalid={!value.patientBirth.trim()}>
            <Input type="date" value={value.patientBirth} onChange={event => set({ patientBirth: event.target.value })} />
          </Field>
          <Field label="Patient gender" required invalid={!value.patientGender}>
            <select
              className={selectClass}
              value={value.patientGender}
              onChange={event =>
                set({ patientGender: event.target.value as GermlineOrderInput["patientGender"] })
              }
            >
              <option value="">Select…</option>
              <option>Female</option>
              <option>Male</option>
              <option>Other</option>
            </select>
          </Field>
        </div>
        <Field label="Affected" required invalid={!value.affected}>
          <select
            className={selectClass}
            value={value.affected}
            onChange={event =>
              set({ affected: event.target.value as GermlineOrderInput["affected"] })
            }
          >
            <option value="">Select…</option>
            <option value="Yes">Yes</option>
            <option value="No">No</option>
          </select>
        </Field>
        {patients.patient2 ? (
          <div className="space-y-3 border-t border-border/70 pt-3">
            <p className="text-xs font-medium">
              Patient 2 (ExomeDuo, CouplesCarrier, ExomeMaxDuo, or trio)
            </p>
            <Field label="Name" required invalid={!value.patient2Name.trim()}>
              <Input value={value.patient2Name} onChange={event => set({ patient2Name: event.target.value })} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Birth" required invalid={!value.patient2Birth.trim()}>
                <Input type="date" value={value.patient2Birth} onChange={event => set({ patient2Birth: event.target.value })} />
              </Field>
              <Field label="Gender" required invalid={!value.patient2Gender}>
                <select
                  className={selectClass}
                  value={value.patient2Gender}
                  onChange={event =>
                    set({ patient2Gender: event.target.value as GermlineOrderInput["patient2Gender"] })
                  }
                >
                  <option value="">Select…</option>
                  <option>Female</option>
                  <option>Male</option>
                  <option>Other</option>
                </select>
              </Field>
            </div>
            <Field label="Affected" required invalid={!value.patient2Affected}>
              <select
                className={selectClass}
                value={value.patient2Affected}
                onChange={event =>
                  set({ patient2Affected: event.target.value as GermlineOrderInput["patient2Affected"] })
                }
              >
                <option value="">Select…</option>
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            </Field>
          </div>
        ) : null}
        {patients.patient3 ? (
          <div className="space-y-3 border-t border-border/70 pt-3">
            <p className="text-xs font-medium">Patient 3 (ExomeTrio / ExomeMaxTrio)</p>
            <Field label="Name" required invalid={!value.patient3Name.trim()}>
              <Input value={value.patient3Name} onChange={event => set({ patient3Name: event.target.value })} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Birth" required invalid={!value.patient3Birth.trim()}>
                <Input type="date" value={value.patient3Birth} onChange={event => set({ patient3Birth: event.target.value })} />
              </Field>
              <Field label="Gender" required invalid={!value.patient3Gender}>
                <select
                  className={selectClass}
                  value={value.patient3Gender}
                  onChange={event =>
                    set({ patient3Gender: event.target.value as GermlineOrderInput["patient3Gender"] })
                  }
                >
                  <option value="">Select…</option>
                  <option>Female</option>
                  <option>Male</option>
                  <option>Other</option>
                </select>
              </Field>
            </div>
            <Field label="Affected" required invalid={!value.patient3Affected}>
              <select
                className={selectClass}
                value={value.patient3Affected}
                onChange={event =>
                  set({ patient3Affected: event.target.value as GermlineOrderInput["patient3Affected"] })
                }
              >
                <option value="">Select…</option>
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            </Field>
          </div>
        ) : null}
      </section>
      <section className="space-y-4 rounded-xl border border-border/70 p-4">
        <h3 className="text-sm font-semibold">Sample and report details</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Sample collection date" required invalid={!value.sampleCollectionDate.trim()}>
            <Input type="date" value={value.sampleCollectionDate} onChange={event => set({ sampleCollectionDate: event.target.value })} />
          </Field>
          <Field label="Receipt date">
            <Input type="date" value={value.receiptDate} onChange={event => set({ receiptDate: event.target.value })} />
          </Field>
          <Field label="Report language" required invalid={!value.reportLanguage}>
            <select
              className={selectClass}
              value={value.reportLanguage}
              onChange={event =>
                set({ reportLanguage: event.target.value as GermlineOrderInput["reportLanguage"] })
              }
            >
              <option value="">Select…</option>
              <option value="EN">English (EN)</option>
              <option value="CN">Chinese (CN)</option>
              <option value="KO">Korean (KO)</option>
              <option value="EN,CN">English + Chinese</option>
            </select>
          </Field>
          <Field label="Report type" required invalid={!value.reportType}>
            <select
              className={selectClass}
              value={value.reportType}
              onChange={event =>
                set({ reportType: event.target.value as GermlineOrderInput["reportType"] })
              }
            >
              <option value="">Select…</option>
              <option value="Printout">Printout</option>
              <option value="Email">Email</option>
              <option value="Portal">Portal</option>
            </select>
          </Field>
          <Field label="Sample specimen type">
            <select
              className={selectClass}
              value={value.specimenType}
              onChange={event =>
                set({ specimenType: event.target.value as GermlineOrderInput["specimenType"] })
              }
            >
              <option value="Blood">Blood</option>
              <option value="Saliva">Saliva</option>
              <option value="Other">Other</option>
            </select>
          </Field>
          <Field label="Sample barcode">
            <Input value={value.sampleBarcode} onChange={event => set({ sampleBarcode: event.target.value })} />
          </Field>
        </div>
      </section>
    </div>
  );
}
