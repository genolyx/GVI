import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  GERMLINE_TEST_CATEGORIES,
  GERMLINE_TEST_CATEGORY_LABEL,
  type GermlineOrderInput,
} from "@shared/germlineOrder";
import { cloneElement, isValidElement, useId, useState, type ReactElement, type ReactNode } from "react";

const selectClass =
  "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm";

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<{ id?: string }>, { id })
        : children}
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
    onChange({ ...value, ...patch });
  const [showPatient2, setShowPatient2] = useState(
    Boolean(value.patient2Name || value.patient2Birth || value.patient2Gender)
  );
  const [showPatient3, setShowPatient3] = useState(
    Boolean(value.patient3Name || value.patient3Birth || value.patient3Gender)
  );
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="space-y-4 rounded-xl border border-border/70 p-4">
        <h3 className="text-sm font-semibold">Test type and report pairing</h3>
        <Field label="Test category">
          <select
            className={selectClass}
            value={value.testCategory}
            onChange={event =>
              set({
                testCategory: event.target.value as GermlineOrderInput["testCategory"],
              })
            }
          >
            {GERMLINE_TEST_CATEGORIES.map(item => (
              <option key={item} value={item}>
                {GERMLINE_TEST_CATEGORY_LABEL[item]}
              </option>
            ))}
          </select>
        </Field>
        {value.testCategory === "other" ? (
          <Field label="Other test type">
            <Input
              value={value.otherTestType}
              onChange={event => set({ otherTestType: event.target.value })}
            />
          </Field>
        ) : null}
        <Field label="Package code (test type)">
          <Input
            value={value.packageCode}
            onChange={event => set({ packageCode: event.target.value })}
            placeholder="CarrierScreening"
          />
        </Field>
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
          <Field label="Partner order ID">
            <Input
              value={value.partnerCaseNumber}
              onChange={event => set({ partnerCaseNumber: event.target.value })}
              placeholder="Other case number"
            />
          </Field>
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
        <Field label="Affected">
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
        <Field label="Patient name">
          <Input value={value.patientName} onChange={event => set({ patientName: event.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Patient birth">
            <Input type="date" value={value.patientBirth} onChange={event => set({ patientBirth: event.target.value })} />
          </Field>
          <Field label="Patient gender">
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
        {showPatient2 ? (
          <div className="space-y-3 border-t border-border/70 pt-3">
            <p className="text-xs font-medium">Patient 2</p>
            <Field label="Name">
              <Input value={value.patient2Name} onChange={event => set({ patient2Name: event.target.value })} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Birth">
                <Input type="date" value={value.patient2Birth} onChange={event => set({ patient2Birth: event.target.value })} />
              </Field>
              <Field label="Gender">
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
            <Field label="Affected">
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
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => setShowPatient2(true)}>
            Add patient 2
          </Button>
        )}
        {showPatient3 ? (
          <div className="space-y-3 border-t border-border/70 pt-3">
            <p className="text-xs font-medium">Patient 3</p>
            <Field label="Name">
              <Input value={value.patient3Name} onChange={event => set({ patient3Name: event.target.value })} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Birth">
                <Input type="date" value={value.patient3Birth} onChange={event => set({ patient3Birth: event.target.value })} />
              </Field>
              <Field label="Gender">
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
            <Field label="Affected">
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
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => setShowPatient3(true)}>
            Add patient 3
          </Button>
        )}
      </section>
      <section className="space-y-4 rounded-xl border border-border/70 p-4">
        <h3 className="text-sm font-semibold">Sample and report details</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Sample collection date">
            <Input type="date" value={value.sampleCollectionDate} onChange={event => set({ sampleCollectionDate: event.target.value })} />
          </Field>
          <Field label="Receipt date">
            <Input type="date" value={value.receiptDate} onChange={event => set({ receiptDate: event.target.value })} />
          </Field>
          <Field label="Report language">
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
          <Field label="Report type">
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
