/**
 * The one sentence that says how a configuration consults.
 *
 * It lives in a module of its own because the policy block, the reminder note and every refusal have
 * to state the same instruction, and none of them should depend on another to do it: this file has no
 * imports, so the text can be shared in one direction only.
 *
 * `advisors` are the packaged profiles the configuration resolves, de-duplicated. `role` launch names
 * them and never counts them, so no count and no model text reaches what a model reads.
 */
export type ConsultLauncher = "role" | "tool";

export function consultSentence(
  launcher: ConsultLauncher,
  advisors: readonly string[] = [],
): string {
  if (launcher === "tool") return "Call consult_advisor once; it asks all Advisors.";
  return advisors.length === 0
    ? "Consult all Advisors in one parallel call."
    : `Consult all Advisors in one parallel call: ${advisors.join(", ")}.`;
}
