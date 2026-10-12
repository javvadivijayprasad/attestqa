import { describe, it, expect } from "vitest";
import { descriptorOf, secondOpinion } from "../src/heal/second-opinion.js";
import { rankCandidates } from "../src/heal/locator.js";

/** The Juice Shop login form as Playwright's snapshot recorded it (20261011T230623Z). */
const SNAPSHOT = [
  '- textbox "Email" [ref=e1]',
  '- textbox "Password" [ref=e2]',
  '- button "Forgot your password?" [ref=e3]',
  '- button "Login" [ref=e4]',
  '- checkbox "Remember me" [ref=e5]',
  '- link "Not yet a customer?" [ref=e6]',
].join("\n");

describe("pw-self-heal as a second opinion on a heal", () => {
  it("reads what each kind of locator asked for", () => {
    expect(descriptorOf('page.getByRole("button", { name: "Log in" })')).toEqual({
      kind: "role",
      value: "button",
      options: { name: "Log in" },
    });
    expect(descriptorOf("getByTestId('save')")).toEqual({ kind: "testid", value: "save" });
    expect(descriptorOf('page.locator("#loginButton")')).toEqual({
      kind: "css",
      value: "#loginButton",
    });
  });

  it('agrees with attestqa that "Log in" is the button named "Login"', async () => {
    const failed = 'getByRole("button", { name: "Log in" })';
    const ours = rankCandidates(SNAPSHOT, failed);
    const second = await secondOpinion(failed, ours, ours[0]);
    expect(second?.best).toBe('page.getByRole("button", { name: "Login" })');
    expect(second?.agrees).toBe(true);
    expect(second?.wouldHeal).toBe(true);
    expect(second?.limitation).toMatch(/accessibility snapshot only/);
  });

  it("is absent, not an error, when there is nothing to rank", async () => {
    expect(await secondOpinion("", [], undefined)).toBeUndefined();
  });
});
