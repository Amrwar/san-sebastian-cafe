import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./Button";
import { CheckboxField, SelectField, TextField } from "./Field";

afterEach(cleanup);

describe("form fields", () => {
  it("associates label, hint and error with the input", () => {
    render(<TextField label="Email" hint="We send a code" error="Invalid email" name="email" />);
    const input = screen.getByLabelText("Email");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    const ids = describedBy.split(" ");
    expect(ids).toHaveLength(2);
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
      "We send a code",
      "Invalid email",
    ]);
  });

  it("omits aria-invalid and aria-describedby when there is nothing to describe", () => {
    render(<TextField label="Name" name="name" />);
    const input = screen.getByLabelText("Name");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(input.hasAttribute("aria-describedby")).toBe(false);
  });

  it("labels selects and checkboxes", () => {
    render(
      <>
        <SelectField label="Language" name="locale" defaultValue="fr-CA">
          <option value="fr-CA">Français</option>
          <option value="en-CA">English</option>
        </SelectField>
        <CheckboxField label="Order updates" hint="Email when ready" name="orders" />
      </>,
    );
    expect(screen.getByLabelText("Language")).toHaveProperty("value", "fr-CA");
    const checkbox = screen.getByLabelText("Order updates");
    expect(checkbox.getAttribute("aria-describedby")).toBeTruthy();
  });
});

describe("Button", () => {
  it("defaults to type=button and exposes a busy state while pending", () => {
    render(<Button pending>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button).toHaveProperty("disabled", true);
  });
});
