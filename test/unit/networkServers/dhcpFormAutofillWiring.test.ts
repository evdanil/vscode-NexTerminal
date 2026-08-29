/**
 * End-to-end wiring for the DHCP form's CIDR row and NIC-first picker, run
 * through the REAL rendered webview script (`test/helpers/formScriptHarness`)
 * with the REAL derivation (`dhcpFormAutofillFields`) answering it.
 *
 * Both ends matter and a test that stops at either cannot see the defect this
 * feature is exposed to. The script decides WHICH fields post an autofill and
 * WHEN; the derivation decides what may be written back; and the stale-answer
 * guard in between decides whether a late answer is applied to a network the
 * user has already moved away from. Only the DOM is a stand-in.
 */

import { describe, expect, it } from "vitest";
import { openForm } from "../../helpers/formScriptHarness";
import { networkServerFormDefinition, type DhcpServerFormSeed } from "../../../src/ui/formDefinitions";
import { dhcpFormAutofillFields, dhcpInterfaceChoices } from "../../../src/commands/networkServerSettings";
import type { NetworkInterfaceOption } from "../../../src/commands/networkInterfaceOptions";
import type { FormMessage, FormValues } from "../../../src/ui/formTypes";

const INTERFACES: readonly NetworkInterfaceOption[] = [
  { label: "All interfaces (0.0.0.0)", value: "" },
  { label: "eth0 — 192.168.9.5", value: "192.168.9.5", netmask: "255.255.255.0" },
  { label: "eth1 — 10.0.0.5", value: "10.0.0.5", netmask: "255.255.255.0" }
];

function dhcpForm(seed: DhcpServerFormSeed = {}) {
  return networkServerFormDefinition("dhcp", seed, {
    interfaceOptions: dhcpInterfaceChoices(INTERFACES, seed.rangeStart, seed.subnet)
  });
}

function lastAutofill(posted: readonly FormMessage[]): Extract<FormMessage, { type: "autofill" }> {
  const message = [...posted].reverse().find((entry) => entry.type === "autofill");
  expect(message, "no autofill was posted").toBeDefined();
  return message as Extract<FormMessage, { type: "autofill" }>;
}

/**
 * Answers an autofill the way `openFullForm` wires it, and delivers the result
 * exactly as `WebviewFormPanel` does: the fill when there is one, and then the
 * `autofillSettled` terminator unconditionally. Answering only the first half
 * would leave the form holding Save for a round trip the host considers over —
 * which is the whole reason the terminator exists.
 */
function answerAutofill(
  harness: ReturnType<typeof openForm>,
  interfaces: readonly NetworkInterfaceOption[] = INTERFACES
): Record<string, string> | undefined {
  const message = lastAutofill(harness.posted);
  return answer(harness, message, interfaces);
}

function answer(
  harness: ReturnType<typeof openForm>,
  message: Extract<FormMessage, { type: "autofill" }>,
  interfaces: readonly NetworkInterfaceOption[] = INTERFACES
): Record<string, string> | undefined {
  // `previousValue` is forwarded exactly as WebviewFormPanel forwards it —
  // verbatim, `undefined` included. Dropping it here would make every test in
  // this file blind to the interface-change baseline it exists to carry.
  const fills = dhcpFormAutofillFields(
    message.key,
    message.value,
    message.values,
    interfaces,
    message.previousValue
  );
  // `requestId` is echoed on both answers exactly as WebviewFormPanel echoes
  // it — it is what the webview matches its pending request against, and it is
  // read back off the posted request rather than guessed, since the counter
  // that mints it is the script's own.
  if (fills) {
    harness.deliver({
      type: "fillFields",
      key: message.key,
      value: message.value,
      values: fills,
      requestId: message.requestId
    });
  }
  harness.deliver({
    type: "autofillSettled",
    key: message.key,
    value: message.value,
    requestId: message.requestId
  });
  return fills;
}

describe("DHCP form — which controls post an autofill", () => {
  it("posts the form's current values along with the network the user committed", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0", gateway: "192.168.2.1" }));
    harness.type("cidr", "10.0.0.0/24");

    const message = lastAutofill(harness.posted);
    expect(message.key).toBe("cidr");
    expect(message.value).toBe("10.0.0.0/24");
    // Without the snapshot the answer cannot tell a hand-typed gateway from a
    // stale derived one, and the hand-typed one is destroyed. Its presence in
    // the payload is the whole reason the message grew a `values` field.
    expect(message.values?.gateway).toBe("192.168.2.1");
    expect(message.values?.subnet).toBe("255.255.255.0");
  });

  it("does not post for a text field that did not opt in", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10" }));
    // Gateway, Pool Start and Subnet Mask are plain text rows. Wiring the
    // listener to every text input instead of the flagged ones would turn each
    // of them into a round trip and, worse, hand `dhcpFormAutofillFields` a
    // value it would have to be careful to ignore.
    harness.type("gateway", "10.0.0.1");
    harness.type("rangeStart", "10.0.0.20");
    harness.type("subnet", "255.255.0.0");
    expect(harness.posted.filter((message) => message.type === "autofill")).toEqual([]);
  });
});

describe("DHCP form — a network typed into the CIDR row", () => {
  it("fills the mask, the pool and the addresses that follow, and keeps the hand-set gateway", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0", gateway: "192.168.2.1" }));
    harness.type("cidr", "10.0.0.0/24");
    answerAutofill(harness);

    const values: FormValues = harness.submit();
    expect(values.subnet).toBe("255.255.255.0");
    expect(values.rangeStart).toBe("10.0.0.1");
    // Stops below eth1's own 10.0.0.5 rather than running to .253 — the pool
    // may not contain an address this machine already holds.
    expect(values.poolCount).toBe(4);
    expect(values.broadcast).toBe("10.0.0.255");
    // The decision the user made survives the network change.
    expect(values.gateway).toBe("192.168.2.1");
  });

  it("replaces a gateway that was itself derived from the previous network", () => {
    const harness = openForm(
      dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0", gateway: "192.168.2.254" })
    );
    harness.type("cidr", "10.0.0.0/24");
    answerAutofill(harness);
    expect(harness.submit().gateway).toBe("10.0.0.254");
  });

  it("writes nothing at all for a network that describes no pool", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    harness.type("cidr", "10.0.0.1/32");

    // The message is still posted — the extension host is what knows /32 has no
    // pool — but the answer is empty, so not one field moves. A derivation that
    // filled "as much as it could" would leave the mask on 255.255.255.255 with
    // the pool still on the old network.
    expect(answerAutofill(harness)).toBeUndefined();
    // And Save is usable again on the strength of the terminator alone: no
    // fillFields was ever posted for this request, so releasing on the payload
    // would leave the button dead for the life of the panel.
    expect(harness.saveDisabled()).toBe(false);
    const values = harness.submit();
    expect(values.subnet).toBe("255.255.255.0");
    expect(values.rangeStart).toBe("192.168.2.10");
  });

  it("discards an answer for a network the user has already moved away from", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    harness.type("cidr", "10.0.0.0/24");
    const first = lastAutofill(harness.posted);
    const fills = dhcpFormAutofillFields(first.key, first.value, first.values, INTERFACES)!;

    // The round trip is outrun: the user retypes before the answer lands.
    harness.type("cidr", "172.16.0.0/16");
    const second = lastAutofill(harness.posted);
    const secondFills = dhcpFormAutofillFields(second.key, second.value, second.values, INTERFACES)!;

    harness.deliver({ type: "fillFields", key: "cidr", value: "10.0.0.0/24", values: fills, requestId: first.requestId });
    harness.deliver({ type: "autofillSettled", key: "cidr", value: "10.0.0.0/24", requestId: first.requestId });

    // Read off the fields rather than through a submit: the SECOND request is
    // still outstanding, so Save is held (the late answer released its own
    // request and nothing else) and there is deliberately nothing to submit.
    harness.flushTimers();
    expect(harness.saveDisabled()).toBe(true);
    expect(harness.value("cidr")).toBe("172.16.0.0/16");
    // 10.0.0.x must not be half-applied under a row that now says 172.16.0.0/16.
    expect(harness.value("subnet")).toBe("255.255.255.0");
    expect(harness.value("rangeStart")).toBe("192.168.2.10");

    // The second (and last) outstanding request answers: only now is Save
    // actually released, and over the network the user meant, not the first
    // one they typed and moved away from.
    harness.deliver({ type: "fillFields", key: "cidr", value: "172.16.0.0/16", values: secondFills, requestId: second.requestId });
    harness.deliver({ type: "autofillSettled", key: "cidr", value: "172.16.0.0/16", requestId: second.requestId });

    expect(harness.saveDisabled()).toBe(false);
    expect(harness.value("subnet")).toBe(secondFills.subnet);
    expect(harness.value("rangeStart")).toBe(secondFills.rangeStart);
  });
});

describe("DHCP form — a NIC picked from the interface select", () => {
  it("derives the network that NIC is on and fills the pool from it", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    harness.choose("interface", "10.0.0.5");

    const message = lastAutofill(harness.posted);
    expect(message.key).toBe("interface");
    expect(message.value).toBe("10.0.0.5");
    answerAutofill(harness);

    const values = harness.submit();
    expect(values.interface).toBe("10.0.0.5");
    expect(values.cidr).toBe("10.0.0.0/24");
    expect(values.rangeStart).toBe("10.0.0.1");
    expect(values.subnet).toBe("255.255.255.0");
  });

  it("leaves the pool alone when the all-interfaces choice is picked", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    harness.choose("interface", "");

    // A blank value posts no autofill at all (the script guards on it), and
    // even if one arrived there is no single NIC to name a network from.
    expect(harness.posted.filter((message) => message.type === "autofill")).toEqual([]);
    const values = harness.submit();
    expect(values.rangeStart).toBe("192.168.2.10");
    expect(values.interface).toBe("");
  });

  it("annotates the NIC already on the pool's subnet in the rendered dropdown", () => {
    const definition = dhcpForm({ rangeStart: "10.0.0.10", subnet: "255.255.255.0" });
    const field = definition.fields.find((entry) => "key" in entry && entry.key === "interface");
    expect(field).toMatchObject({
      type: "select",
      autofill: true,
      options: expect.arrayContaining([
        { label: "eth1 — 10.0.0.5", value: "10.0.0.5", description: "matches the pool subnet" }
      ])
    });
  });

  it("leaves the TFTP interface picker a plain select with no annotations", () => {
    // TFTP has no pool, so there is nothing for a NIC to imply and nothing for
    // a subnet comparison to say. Turning autofill on there would post a
    // message the TFTP form wires no handler for.
    const definition = networkServerFormDefinition("tftp", {}, { interfaceOptions: [...INTERFACES] });
    const field = definition.fields.find((entry) => "key" in entry && entry.key === "interface");
    expect(field).not.toHaveProperty("autofill");
    expect(field).toMatchObject({ type: "select" });
  });
});

/**
 * REVIEW FINDING (P1, third round) — the interface picker's autofill has to
 * carry the address the picker held BEFORE the click, and only the round trip
 * end to end can show why.
 *
 * The script applies the selection to the DOM (`selectCustomOption`) before it
 * posts, so the `values` snapshot the host reasons over already names the NEW
 * NIC — there is no "before" left in the message unless one is put there. The
 * host's option 54 gate asks whether the configured identifier is still what
 * this fill itself wrote for the PREVIOUS network, and answering that against
 * the new NIC makes an auto-filled identifier look hand-set.
 *
 * Two NICs on ONE subnet is the fixture that makes the difference visible: the
 * network does not change at all, so nothing else in the fill moves and the
 * identifier is the only thing that can be wrong. Under the old code the form
 * saves `serverId: 10.0.0.5` with the socket bound to 10.0.0.6 — every OFFER
 * and ACK then points renewals and ZTP `siaddr` at the NIC the service just
 * stopped using.
 */
describe("DHCP form — switching between two NICs on the SAME subnet", () => {
  /** eth1 and eth2 differ in nothing but their host octet. */
  const SAME_SUBNET: readonly NetworkInterfaceOption[] = [
    { label: "All interfaces (0.0.0.0)", value: "" },
    { label: "eth1 — 10.0.0.5", value: "10.0.0.5", netmask: "255.255.255.0" },
    { label: "eth2 — 10.0.0.6", value: "10.0.0.6", netmask: "255.255.255.0" }
  ];

  /** The form as it stands after a previous fill: bound to .5, option 54 .5. */
  function boundToFive() {
    const seed = {
      rangeStart: "10.0.0.1",
      rangeEnd: "10.0.0.4",
      subnet: "255.255.255.0",
      bindAddress: "10.0.0.5",
      serverId: "10.0.0.5"
    };
    return networkServerFormDefinition("dhcp", seed, {
      interfaceOptions: dhcpInterfaceChoices(SAME_SUBNET, seed.rangeStart, seed.subnet)
    });
  }

  it("posts the NIC the picker held before the click, which the values snapshot no longer can", () => {
    const harness = openForm(boundToFive());
    harness.choose("interface", "10.0.0.6");

    const message = lastAutofill(harness.posted);
    expect(message.value).toBe("10.0.0.6");
    // The snapshot is taken after the selection landed in the DOM, so it says
    // .6 — which is precisely why the old address needs its own field.
    expect(message.values?.interface).toBe("10.0.0.6");
    expect(message.previousValue).toBe("10.0.0.5");
  });

  it("refreshes the server identifier to the newly bound NIC", () => {
    const harness = openForm(boundToFive());
    harness.choose("interface", "10.0.0.6");
    answerAutofill(harness, SAME_SUBNET);

    const values = harness.submit();
    expect(values.interface).toBe("10.0.0.6");
    // The whole point: the socket is about to bind .6, so option 54 and BOOTP
    // siaddr must say .6. Left at .5, renewals go unanswered.
    expect(values.serverId).toBe("10.0.0.6");
    // Same subnet either side, so nothing else moved.
    expect(values.subnet).toBe("255.255.255.0");
    expect(values.rangeStart).toBe("10.0.0.1");
  });

  it("reports the value the form OPENED with on the very first change, not undefined", () => {
    // Nothing has been selected yet in this session, so a record kept only by
    // previous selections (the write-only `dataset.prev`) would be empty here —
    // and the first NIC switch after opening the form is the common case, not
    // an edge one. The capture reads the rendered control instead.
    const harness = openForm(boundToFive());
    expect(harness.posted.filter((entry) => entry.type === "autofill")).toEqual([]);
    harness.choose("interface", "10.0.0.6");
    expect(lastAutofill(harness.posted).previousValue).toBe("10.0.0.5");
  });

  it("sends no previous value for a CIDR commit, which cannot move the bind address", () => {
    const harness = openForm(boundToFive());
    harness.type("cidr", "192.168.9.0/24");
    // Committing a network changes that row alone, so the snapshot's bind
    // address is the address either side and the host's fallback is exact.
    // Sending the CIDR row's own former text here would be answering a
    // different question with a value that is not an address at all.
    expect(lastAutofill(harness.posted).previousValue).toBeUndefined();
  });
});

/**
 * REVIEW FINDING (P1) — Save against an autofill still in flight.
 *
 * The submission is collected synchronously from the DOM, and the fill that is
 * about to change that DOM is a round trip. Nothing but this hold stands
 * between "typed a network, clicked Save" and a record saved on the PREVIOUS
 * network with the typed one thrown away — `cidr` is an input shape the
 * settings layer never writes (see the "never writes the CIDR row as a setting"
 * test in networkServerCommands.test.ts), so the network the user entered
 * survives nowhere else.
 */
describe("DHCP form — Save while an autofill is in flight", () => {
  it("holds the submission until the typed network has been derived, then submits the DERIVED values", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    harness.type("cidr", "10.0.0.0/24");

    // Save, before the answer lands. Nothing may go out: the values collected
    // here are 192.168.2.x, and posting them saves the old pool while the
    // network that would have replaced it is dropped on the floor.
    // The hold itself lands one macrotask after the request is posted (see
    // postAutofill), which a browser reaches before the user's next gesture.
    harness.flushTimers();
    expect(harness.saveDisabled()).toBe(true);
    expect(harness.attemptSubmit()).toBeUndefined();
    expect(harness.posted.some((message) => message.type === "submit")).toBe(false);

    answerAutofill(harness);

    // The Save the user asked for happens, over the values that answer wrote —
    // it is deferred, not discarded (Enter submits a form whatever the buttons
    // look like, so dropping it would be its own defect).
    const submitted = harness.posted.filter((message) => message.type === "submit");
    expect(submitted).toHaveLength(1);
    const values = submitted[0].type === "submit" ? submitted[0].values : {};
    expect(values.subnet).toBe("255.255.255.0");
    expect(values.rangeStart).toBe("10.0.0.1");
    expect(values.broadcast).toBe("10.0.0.255");
    expect(harness.saveDisabled()).toBe(false);
  });

  it("holds it for a NIC picked from the select too, not only for the CIDR row", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    harness.choose("interface", "10.0.0.5");

    harness.flushTimers();
    expect(harness.saveDisabled()).toBe(true);
    expect(harness.attemptSubmit()).toBeUndefined();
    answerAutofill(harness);

    const submitted = harness.posted.filter((message) => message.type === "submit");
    expect(submitted).toHaveLength(1);
    const values = submitted[0].type === "submit" ? submitted[0].values : {};
    expect(values.rangeStart).toBe("10.0.0.1");
    expect(values.cidr).toBe("10.0.0.0/24");
  });

  it("submits immediately once the answer has landed — the normal-speed path is untouched", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    harness.type("cidr", "10.0.0.0/24");
    answerAutofill(harness);

    expect(harness.saveDisabled()).toBe(false);
    const values = harness.submit();
    expect(values.rangeStart).toBe("10.0.0.1");
    expect(harness.posted.filter((message) => message.type === "submit")).toHaveLength(1);
  });

  /**
   * REVIEW FINDING (P2) — the hold must not eat the very click that triggered
   * the round trip.
   *
   * Clicking Save while the CIDR row still has focus is ONE gesture, and the
   * browser delivers it in this order: mousedown on the button, the blur-driven
   * "change" on the input (which is what posts the autofill), mouseup, click.
   * A hold applied synchronously from that change handler lands between the
   * mousedown and the click, and a browser refuses to dispatch a click on a
   * control that is disabled by then — so no click, no "submit" event, and the
   * deferral in the submit handler is never reached at all. The round trip
   * finishes, Save comes back, and the user's click is simply gone.
   *
   * `clickSave()` is the pointer path and honours `disabled`; `attemptSubmit()`
   * is the Enter-key path, which a disabled button never blocked.
   */
  it("defers the Save clicked in the SAME gesture that committed the CIDR row, instead of swallowing the click (kills disabling the button synchronously in postAutofill: the browser suppresses the click, no submit event fires, and the Save is discarded rather than held)", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));

    // The blur-driven change fires the autofill. Still inside that gesture, so
    // no macrotask has run yet — `flushTimers` is deliberately NOT called.
    harness.type("cidr", "10.0.0.0/24");
    expect(harness.saveDisabled()).toBe(false);

    // …and the click that caused the blur lands. It must reach the form, where
    // the existing deferral holds it: nothing is posted yet.
    expect(harness.clickSave()).toBeUndefined();
    expect(harness.posted.some((message) => message.type === "submit")).toBe(false);

    // Only now does the hold apply — in time to refuse a SECOND click, which is
    // what it is for.
    harness.flushTimers();
    expect(harness.saveDisabled()).toBe(true);
    expect(harness.clickSave()).toBeUndefined();

    answerAutofill(harness);

    // The click the user actually made is honoured, over the derived values.
    const submitted = harness.posted.filter((message) => message.type === "submit");
    expect(submitted).toHaveLength(1);
    const values = submitted[0].type === "submit" ? submitted[0].values : {};
    expect(values.rangeStart).toBe("10.0.0.1");
    expect(values.broadcast).toBe("10.0.0.255");
    expect(harness.saveDisabled()).toBe(false);
  });

  /**
   * REVIEW FINDING (P2) — answers are correlated by REQUEST ID, not by the
   * key/value pair they echo.
   *
   * The same network can be asked about twice before either answer returns —
   * type it, change it, change it back — and each request is answered twice
   * (the fill, then the unconditional terminator). Correlating on key/value,
   * the FIRST request's two answers retire both of the identical entries, so a
   * request that has not been answered at all is released early and a deferred
   * Save goes out over the snapshot its own answer was about to correct.
   */
  it("keeps a repeated network's second request outstanding until its OWN answer lands (kills correlating answers by the key/value they echo: the first request's fill and terminator retire both identical entries, releasing a request nobody answered)", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));

    // A → B → A, all three committed before any answer is delivered.
    harness.type("cidr", "10.0.0.0/24");
    harness.type("cidr", "172.16.0.0/16");
    harness.type("cidr", "10.0.0.0/24");
    harness.flushTimers();

    const requests = harness.posted.filter((message) => message.type === "autofill");
    expect(requests).toHaveLength(3);
    // Three requests, three distinct ids — the point of minting them.
    const ids = requests.map((message) => (message.type === "autofill" ? message.requestId : undefined));
    expect(new Set(ids).size).toBe(3);

    // The user asks to Save. Held, because three round trips are outstanding.
    expect(harness.attemptSubmit()).toBeUndefined();

    // The first two answer, in order, exactly as WebviewFormPanel posts them.
    answer(harness, requests[0] as Extract<FormMessage, { type: "autofill" }>);
    answer(harness, requests[1] as Extract<FormMessage, { type: "autofill" }>);

    // The THIRD is still in the air, so Save is still held and nothing has been
    // submitted. Under key/value correlation the first request's pair of
    // answers has already retired the third request's entry, the second one
    // empties the list, and the held Save fires here.
    expect(harness.saveDisabled()).toBe(true);
    expect(harness.posted.some((message) => message.type === "submit")).toBe(false);

    // Its own answer, and only its own, releases it.
    answer(harness, requests[2] as Extract<FormMessage, { type: "autofill" }>);
    expect(harness.saveDisabled()).toBe(false);
    const submitted = harness.posted.filter((message) => message.type === "submit");
    expect(submitted).toHaveLength(1);
    const values = submitted[0].type === "submit" ? submitted[0].values : {};
    expect(values.cidr).toBe("10.0.0.0/24");
    expect(values.rangeStart).toBe("10.0.0.1");
  });

  /**
   * REVIEW FINDING (P2) — a late answer must not overwrite a target field the
   * user edited AFTER the request went out.
   *
   * The extension host decides what it may fill from the values SNAPSHOT the
   * request carried (isAutoFillable: blank, or still holding what the previous
   * network derived). Edit a target while the round trip is out and that
   * decision is about a value the field no longer holds. The existing
   * stale-answer guard cannot see it: it asks only whether the field the
   * request was ABOUT — the CIDR row — still holds the value it was about, and
   * it does. Nothing has moved the CIDR; the TARGET moved.
   */
  it("keeps a gateway hand-typed while the answer was in flight, and still applies the untouched fields (kills applying every returned value blind: the host cleared a blank gateway for filling, and the value the user typed a moment later is silently replaced by the derived one)", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    harness.type("cidr", "10.0.0.0/24");
    const request = lastAutofill(harness.posted);
    // The host answers the snapshot as it was: gateway was blank, so the fill
    // includes one.
    const fills = dhcpFormAutofillFields(request.key, request.value, request.values, INTERFACES)!;
    expect(fills.gateway).toBe("10.0.0.254");
    // Option 54 is the NIC's address, not the gateway — eth1 holds 10.0.0.5.
    expect(fills.serverId).toBe("10.0.0.5");

    // …and only now, still before the answer lands, the user types a gateway
    // of their own.
    harness.type("gateway", "10.0.0.99");

    harness.deliver({
      type: "fillFields",
      key: request.key,
      value: request.value,
      values: fills,
      requestId: request.requestId
    });
    harness.deliver({
      type: "autofillSettled",
      key: request.key,
      value: request.value,
      requestId: request.requestId
    });

    // Their edit stands.
    expect(harness.value("gateway")).toBe("10.0.0.99");
    // Everything they did NOT touch still lands — skipping the whole answer
    // would throw away the mask and the pool over one edited field.
    expect(harness.value("subnet")).toBe("255.255.255.0");
    expect(harness.value("rangeStart")).toBe("10.0.0.1");
    expect(harness.value("broadcast")).toBe("10.0.0.255");
    expect(harness.value("serverId")).toBe("10.0.0.5");
    expect(harness.saveDisabled()).toBe(false);
  });

  it("applies an answer that matches no pending request unchanged, as it always has", () => {
    // A hand-built message with an id this script never minted — there is no
    // snapshot to judge it against, so the lenient path is the one that was
    // there before, matching how an unrenderable key is treated.
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    harness.deliver({
      type: "fillFields",
      key: "cidr",
      // Echoes the CIDR row as it stands, so the existing stale-answer guard
      // lets it through and the no-snapshot path is what is actually exercised.
      value: harness.value("cidr"),
      values: { subnet: "255.255.254.0", rangeStart: "10.4.6.1" },
      requestId: 9999
    });
    expect(harness.value("subnet")).toBe("255.255.254.0");
    expect(harness.value("rangeStart")).toBe("10.4.6.1");
  });

  it("never holds a form with no autofill-capable control at all", () => {
    // The TFTP editor posts no autofill from anywhere, so Save must behave as it
    // always has: enabled at open, submitting on the spot.
    const harness = openForm(networkServerFormDefinition("tftp", {}, { interfaceOptions: [...INTERFACES] }));
    expect(harness.saveDisabled()).toBe(false);
    expect(harness.attemptSubmit()).toBeDefined();
  });
});

/**
 * REVIEW FINDING (P1) — Enter does not blur, so nothing was ever committed.
 *
 * The round trip starts on "change", which on a text input is a BLUR-time
 * event. Pressing Enter while the CIDR row still holds focus is the browser's
 * implicit submission: the form submits and the input keeps the caret, so
 * "change" has not run, pendingAutofills is empty, and the deferral above —
 * which is the entire defence — is reached with nothing to defer for. The
 * previous network's subnet, pool and gateway are posted as though nothing
 * had been typed, and the network that WAS typed goes nowhere, because
 * `cidr` is an input shape the settings layer never writes.
 *
 * `typeFocused` is what makes this visible at all: `type` fires "change" too,
 * which is a blur the user has not performed, and under it the defect cannot
 * be reproduced.
 */
describe("DHCP form — Enter pressed in the CIDR row", () => {
  it("commits the typed network from the keydown, before the implicit submission it causes, and saves the DERIVED values (kills committing on \"change\" alone: nothing is pending when Enter submits, so the old network is saved and the typed one is discarded)", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));

    // Typed, and the caret is still in the field — exactly as it is at the
    // instant the user reaches for Enter.
    harness.typeFocused("cidr", "10.0.0.0/24");
    expect(harness.posted.filter((message) => message.type === "autofill")).toEqual([]);

    // Enter. The commit has to happen HERE, in the keydown listener, because
    // submission is that event's default action and runs after it returns.
    harness.pressEnter("cidr");
    const requests = harness.posted.filter((message) => message.type === "autofill");
    expect(requests).toHaveLength(1);
    expect(lastAutofill(harness.posted).value).toBe("10.0.0.0/24");
    expect(harness.posted.some((message) => message.type === "submit")).toBe(false);

    // …and now the implicit submission itself. It must find the request
    // pending and be held — no preventDefault is involved, so this is the
    // browser's own submit reaching the form's handler.
    expect(harness.attemptSubmit()).toBeUndefined();
    expect(harness.posted.some((message) => message.type === "submit")).toBe(false);

    answerAutofill(harness);

    const submitted = harness.posted.filter((message) => message.type === "submit");
    expect(submitted).toHaveLength(1);
    const values = submitted[0].type === "submit" ? submitted[0].values : {};
    // The network the user actually entered, and the pool derived from it —
    // not one field of the 192.168.2.x form they replaced.
    expect(values.cidr).toBe("10.0.0.0/24");
    expect(values.subnet).toBe("255.255.255.0");
    expect(values.rangeStart).toBe("10.0.0.1");
    expect(values.broadcast).toBe("10.0.0.255");
    expect(harness.saveDisabled()).toBe(false);
  });

  it("commits once when a \"change\" follows the same Enter, rather than posting the round trip twice", () => {
    // Whether an engine also fires "change" for an Enter-driven submission is
    // not this script's to decide, so both orders have to be survivable. A
    // duplicate would be harmless — request ids make concurrent requests
    // independent — but the shared "edited" gate means the second gesture for
    // one edit finds nothing left to commit and mints nothing.
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    harness.typeFocused("cidr", "10.0.0.0/24");
    harness.pressEnter("cidr");
    harness.blur("cidr");

    expect(harness.posted.filter((message) => message.type === "autofill")).toHaveLength(1);
    answerAutofill(harness);
    expect(harness.saveDisabled()).toBe(false);
    expect(harness.submit().rangeStart).toBe("10.0.0.1");
  });

  it("posts nothing for Enter in a CIDR row the user never edited, so a hand-set pool start survives the save (kills committing on every Enter: dhcpCidrFormFills writes rangeStart unconditionally, and the snapshot guard cannot object because the field still holds what the snapshot took)", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    // The user's own pool start, and a CIDR row left exactly as rendered.
    harness.type("rangeStart", "192.168.2.50");
    harness.pressEnter("cidr");

    expect(harness.posted.filter((message) => message.type === "autofill")).toEqual([]);
    // Nothing in flight, so the implicit submission goes straight out — and
    // it carries the pool start the user typed, not the network's first host.
    expect(harness.attemptSubmit()?.rangeStart).toBe("192.168.2.50");
  });

  it("does not re-derive from a CIDR the ANSWER wrote back (kills judging the commit on whether the value changed: the host normalises the row, so a value-comparison gate reads its own fill as a fresh edit)", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    // A host part rather than a network address, so the answer writes a
    // DIFFERENT string back into the row than the user typed.
    harness.typeFocused("cidr", "10.0.0.77/24");
    harness.pressEnter("cidr");
    answerAutofill(harness);
    expect(harness.value("cidr")).toBe("10.0.0.0/24");

    const before = harness.posted.filter((message) => message.type === "autofill").length;
    harness.pressEnter("cidr");
    expect(harness.posted.filter((message) => message.type === "autofill")).toHaveLength(before);
    expect(harness.attemptSubmit()?.rangeStart).toBe("10.0.0.1");
  });

  it("ignores every other key — only Enter ends an edit", () => {
    const harness = openForm(dhcpForm({ rangeStart: "192.168.2.10", subnet: "255.255.255.0" }));
    harness.typeFocused("cidr", "10.0.0.0/24");
    // Mid-edit keystrokes must not derive a pool from a half-typed network,
    // which is the reason this row never listened to "input" in the first
    // place.
    harness.pressKey("cidr", "0");
    harness.pressKey("cidr", "Tab");
    expect(harness.posted.filter((message) => message.type === "autofill")).toEqual([]);
  });
});
