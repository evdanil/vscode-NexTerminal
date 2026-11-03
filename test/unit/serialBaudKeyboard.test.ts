import { describe, expect, it } from "vitest";
import { serialFormDefinition } from "../../src/ui/formDefinitions";
import { baseWebviewJs } from "../../src/ui/shared/webviewScripts";
import { StubElement } from "../helpers/formScriptHarness";

describe("serial baud rate picker keyboard access", () => {
  it("can select Custom using the existing select's arrow keys", () => {
    const field = serialFormDefinition().fields.find((item) => "key" in item && item.key === "baudRate");
    if (!field || field.type !== "select") throw new Error("baud rate picker is not a select");

    const wrapper = new StubElement("DIV", ["custom-select"]);
    const input = wrapper.append(new StubElement("INPUT"));
    input.type = "hidden";
    input.value = field.value ?? "";
    Object.assign(input, { dispatchEvent: (event: Event) => input.dispatch(event.type) });
    const trigger = wrapper.append(new StubElement("DIV", ["custom-select-trigger"]));
    trigger.append(new StubElement("SPAN", ["custom-select-text"]));
    const dropdown = wrapper.append(new StubElement("DIV", ["custom-select-dropdown"]));
    for (const item of field.options) {
      const option = dropdown.append(new StubElement("DIV", ["custom-select-option", ...(item.value === field.value ? ["selected"] : [])]));
      option.dataset.value = item.value;
      option.textContent = item.label;
    }
    const document = { addEventListener() {}, querySelectorAll: (selector: string) => selector === ".custom-select" ? [wrapper] : [] };
    new Function("document", baseWebviewJs() + "\ninitCustomSelects();")(document);

    expect(input.value).toBe("115200");
    for (let i = 0; i < 4; i++) {
      trigger.dispatchKey("keydown", "ArrowDown"); // open
      trigger.dispatchKey("keydown", "ArrowDown"); // select next
    }
    expect(input.value).toBe("custom");
  });
});
