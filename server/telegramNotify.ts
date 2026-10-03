/**
 * Outbound Telegram notices for GVI cases, workbench batches, and single variants.
 *
 * Case-classifier batches (one per germline case) are not announced here. The case
 * analysis messages already cover that work, and a notice per variant would flood
 * the chat. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_IDS (or TELEGRAM_CHAT_ID).
 */
import { and, eq } from "drizzle-orm";
import { cases, curationBatches, curationRuns, type CurationRunInput } from "../drizzle/schema";
import { isSingleVariantBatch } from "../shared/curation/workbench";
import { requireDb } from "./domain/tenant";

export type GvcEvent = "registered" | "running" | "completed" | "failed";

const STATUS: Record<GvcEvent, string> = {
  registered: "Registered",
  running: "In-Analysis",
  completed: "Completed",
  failed: "Failed",
};

const OPEN_RUN = new Set(["queued", "loading", "running"]);

export function variantSubject(input: { gene?: string | null; hgvsC?: string | null }): string {
  return [input.gene, input.hgvsC].filter(Boolean).join(" ") || "variant";
}

export function formatGvcMessage(subject: string, event: GvcEvent, reason?: string): string {
  const lines = ["[GVC]", `${subject} - ${STATUS[event]}`];
  if (event === "failed") {
    const text = (reason || "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (text) lines.push(text);
  }
  return lines.join("\n");
}

function chatIds(): string[] {
  const raw = (process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || "").trim();
  return raw.split(/[;,]/).map(part => part.trim()).filter(Boolean);
}

export function notifyGvc(subject: string, event: GvcEvent, reason?: string): void {
  if ((process.env.TELEGRAM_NOTIFY_ENABLED || "").trim().toLowerCase() === "false") return;
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const ids = chatIds();
  if (!token || !ids.length || !subject.trim()) return;
  const text = formatGvcMessage(subject, event, reason);
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  for (const chatId of ids) {
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    }).catch(error => {
      console.warn("[telegram] send failed", error);
    });
  }
}

export async function notifyCase(
  organizationId: number,
  caseId: number,
  event: GvcEvent,
  reason?: string
): Promise<void> {
  try {
    const db = await requireDb();
    const rows = await db
      .select({ caseNumber: cases.caseNumber })
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
      .limit(1);
    const caseNumber = rows[0]?.caseNumber;
    if (caseNumber) notifyGvc(caseNumber, event, reason);
  } catch (error) {
    console.warn("[telegram] case notify failed", error);
  }
}

type CurationNotice = {
  organizationId: number;
  batchId: number | null;
  input: CurationRunInput;
};

/** Single-variant runs notify that variant. Named batches notify once when the batch finishes. */
export async function notifyCuration(
  run: CurationNotice,
  event: "running" | "completed" | "failed",
  reason?: string
): Promise<void> {
  try {
    if (run.batchId == null) {
      if (event !== "running") notifyGvc(variantSubject(run.input), event, reason);
      else notifyGvc(variantSubject(run.input), "running");
      return;
    }
    const db = await requireDb();
    const batches = await db
      .select({ name: curationBatches.name })
      .from(curationBatches)
      .where(
        and(
          eq(curationBatches.id, run.batchId),
          eq(curationBatches.organizationId, run.organizationId)
        )
      )
      .limit(1);
    const name = batches[0]?.name;
    if (!name || name.startsWith("Case ")) return;
    if (isSingleVariantBatch(name)) {
      notifyGvc(variantSubject(run.input), event, reason);
      return;
    }
    if (event === "running") return;
    const rows = await db
      .select({ status: curationRuns.status })
      .from(curationRuns)
      .where(
        and(
          eq(curationRuns.organizationId, run.organizationId),
          eq(curationRuns.batchId, run.batchId)
        )
      );
    if (rows.some(row => OPEN_RUN.has(row.status))) return;
    const failed = rows.filter(row => row.status === "failed").length;
    if (failed > 0) {
      notifyGvc(name, "failed", reason || `${failed} variant(s) failed`);
    } else {
      notifyGvc(name, "completed");
    }
  } catch (error) {
    console.warn("[telegram] curation notify failed", error);
  }
}
