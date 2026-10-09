import type { TriagePayload, Verifier, VerifierInput, VerifyPayload } from "../types.js";

export class ScriptedVerifier implements Verifier {
  readonly name = "scripted";
  readonly inputs: VerifierInput[] = [];
  readonly triageInputs: VerifierInput[] = [];
  private i = 0;
  private t = 0;

  /**
   * @param verdicts one per verify call; the last repeats.
   * @param triages  one per triage call, `undefined` meaning "nothing to
   *   triage". Omitted entirely, this verifier has no `triage` method at all —
   *   which is the state a skill that does not execute tests should be in, and
   *   the state every existing caller was in before triage existed.
   *
   *   Unlike `verdicts`, the LAST entry does not repeat: past the end of the
   *   script every call returns `undefined`. That mirrors the real thing, where
   *   an unchanged execution report produces no second verdict — and without it
   *   a scripted triage would append an identical event on every cycle, which
   *   is exactly the behaviour the fingerprint check exists to prevent.
   */
  constructor(
    private readonly verdicts: VerifyPayload[],
    private readonly triages?: Array<TriagePayload | undefined>,
  ) {
    if (verdicts.length === 0) throw new Error("ScriptedVerifier needs at least one verdict");
    if (triages !== undefined) {
      this.triage = async (input: VerifierInput): Promise<TriagePayload | undefined> => {
        this.triageInputs.push(input);
        return triages[this.t++];
      };
    }
  }

  /** Present only when the constructor was given a triage script. */
  triage?: (input: VerifierInput) => Promise<TriagePayload | undefined>;

  async verify(input: VerifierInput): Promise<VerifyPayload> {
    this.inputs.push(input);
    const v = this.verdicts[Math.min(this.i++, this.verdicts.length - 1)]!;
    return v;
  }
}
