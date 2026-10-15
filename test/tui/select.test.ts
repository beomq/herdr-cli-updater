import { expect, test } from "bun:test";
import { SelectComponent, SelectionError } from "../../src/tui/select";
import type { SelectionSnapshot } from "../../src/tui/select";
import type { Capability } from "../../src/adapters/types";
import type { Installation, TargetSelection } from "../../src/protocol";

const supported: Capability = { kind: "supported", reason: "verified", evidenceRef: "fixture" };
const unsupported: Capability = { kind: "unsupported", reason: "missing_bridge" };
const installation: Installation = {
  installationId: "install:a", resourcesFingerprint: "fp", family: "omo", channel: "stable",
  owner: { kind: "native", installerDigest: "digest", prefix: "/fixture" },
  installedVersion: { kind: "known", version: "1.0.0" }, executableRealpath: "/fixture/omo",
  resources: [{ resourceId: "resource", realpath: "/fixture/omo", fingerprint: "fp" }],
  lastCheck: { checkedAt: 10, result: {
    kind: "update-available", installedVersion: "1.0.0", availableVersion: "2.0.0", checkedAt: 10,
  } },
};
function target(socketId: string, paneId = "pane"): TargetSelection {
  return { targetId: `target:${socketId}:${paneId}`, runtimeId: `runtime:${paneId}`, installationId: "install:a",
    expectedBinding: { socketId, socketEpoch: "epoch", paneId, paneGeneration: 1,
      rootIncarnation: { pid: 10, startIdentity: "PRIVATE_START", executableRealpath: "/fixture/omo" },
      session: { kind: "conversation", fullId: "PRIVATE_SESSION", storagePathHash: "PRIVATE_HASH" },
      cwd: "/PRIVATE_CWD", optionsRef: "PRIVATE_OPTIONS", turnGeneration: 1, resourcesFingerprint: "fp" } };
}
export function fixture(): SelectionSnapshot {
  return { installation: structuredClone(installation), update: supported, readiness: supported,
    targets: ["socket:a", "socket:b"].map(socket => ({
      target: target(socket), runningVersion: { kind: "known", version: "0.9.0" },
      completion: supported, resume: supported, gracefulExit: supported, readiness: supported,
    })) };
}
function reviewed(input = fixture(), restart = false): SelectComponent {
  const component = new SelectComponent(input);
  if (restart) { component.input("m"); component.input(" "); }
  component.input("r");
  component.input("Enter");
  return component;
}

test("defaults to update-only and Enter opens confirmation without emitting an intent", () => {
  // Given
  const component = new SelectComponent(fixture());
  // When
  const action = component.input("Enter");
  // Then
  expect(component.mode).toBe("update-only");
  expect(component.selectedTargets).toEqual([]);
  expect(component.stage).toBe("confirming");
  expect(action).toBeNull();
});
test("requires explicit review and final confirmation and emits only a body once", () => {
  // Given
  const component = reviewed();
  // When
  const action = component.input("Enter");
  // Then
  expect(action).toEqual({ ok: true, value: { operation: "create-job", mode: "update-only",
    installation: { installationId: "install:a", resourcesFingerprint: "fp",
      owner: installation.owner, installedVersion: installation.installedVersion }, selectedTargets: [] } });
  expect(component.input("Enter")).toBeNull();
  expect(component.stage).toBe("emitted");
});
test("Enter confirmation keeps exact effects and arrows revoke dispatch readiness", () => {
  const component = new SelectComponent(fixture());
  component.input("ArrowRight");
  component.input(" ");
  const selected = component.effects;
  expect(component.input("Enter")).toBeNull();
  expect(component.stage).toBe("confirming");
  component.input("ArrowDown");
  expect(component.stage).toBe("reviewing");
  expect(component.input("Enter")).toBeNull();
  const action = component.input("Enter");
  expect(action).toEqual({ ok: true, value: { operation: "create-job", mode: "update-and-restart",
    installation: selected.installation, selectedTargets: [target("socket:a")] } });
  expect(component.effects).toEqual(selected);
  expect(component.input("Enter")).toBeNull();
});
test("Left mode change clears deliberate selections before Enter confirmation", () => {
  const component = new SelectComponent(fixture());
  component.input("ArrowRight"); component.input(" ");
  component.input("Enter"); component.input("ArrowLeft");
  expect(component.stage).toBe("choosing");
  expect(component.selectedTargets).toEqual([]);
  expect(component.input("Enter")).toBeNull();
  expect(component.input("Enter")).toEqual({ ok: true, value: { operation: "create-job", mode: "update-only",
    installation: component.effects.installation, selectedTargets: [] } });
});
test("Escape returns direct confirmation to choosing without dispatching", () => {
  const component = new SelectComponent(fixture());
  expect(component.input("Enter")).toBeNull();
  expect(component.input("Escape")).toBeNull();
  expect(component.stage).toBe("choosing");
  expect(component.input("Escape")).toBeNull();
  expect(component.stage).toBe("cancelled");
  expect(component.input("Enter")).toBeNull();
});
test("keeps socket-local runtime collisions separate and reviews only deliberate exact effects", () => {
  // Given
  const component = new SelectComponent(fixture());
  component.input("m"); component.input(" "); component.input("ArrowDown"); component.input(" ");
  // When
  component.input("r"); component.input("Enter");
  const result = component.input("Enter");
  // Then
  expect(component.effects.restartTargets).toEqual([target("socket:a"), target("socket:b")]);
  expect(result?.ok).toBe(true);
  if (!result?.ok) throw new TypeError("expected body");
  expect(result.value.selectedTargets).toEqual([target("socket:a"), target("socket:b")]);
  expect(Object.isFrozen(result.value.selectedTargets[0]?.expectedBinding.session)).toBe(true);
});
test("switching back to update-only clears all restart selections", () => {
  // Given
  const component = reviewed(fixture(), true);
  // When
  component.input("m");
  // Then
  expect(component.mode).toBe("update-only");
  expect(component.selectedTargets).toEqual([]);
  expect(component.stage).toBe("choosing");
});
test.each(["update", "readiness"] as const)("blocks unsupported %s at review", field => {
  // Given
  const snapshot = { ...fixture(), [field]: unsupported };
  const component = new SelectComponent(snapshot);
  // When
  const action = component.input("r");
  // Then
  expect(action).toEqual({ ok: false, error: { code: "unsupported" } });
  expect(component.canReview).toBe(false);
});
test.each(["completion", "resume", "gracefulExit", "readiness"] as const)(
  "keeps update-only valid but blocks target with unsupported %s", field => {
    // Given
    const snapshot = fixture();
    const component = new SelectComponent({ ...snapshot,
      targets: snapshot.targets.map(row => ({ ...row, [field]: unsupported })) });
    expect(component.canReview).toBe(true);
    component.input("m");
    // When
    const action = component.input(" ");
    // Then
    expect(action).toEqual({ ok: false, error: { code: "unsupported" } });
    expect(component.selectedTargets).toEqual([]);
    expect(component.canReview).toBe(false);
  },
);
test.each(["check", "version", "resources", "owner", "channel", "eligibility"] as const)(
  "invalidates confirmation after installation %s refresh", field => {
    // Given
    const snapshot = fixture(), component = reviewed(snapshot, true);
    const old = component.observation;
    const refreshed: SelectionSnapshot = { ...snapshot,
      readiness: field === "eligibility" ? unsupported : supported,
      installation: { ...snapshot.installation,
        ...(field === "check" ? { lastCheck: { checkedAt: 20, result: {
          kind: "update-available" as const, installedVersion: "1.0.0", availableVersion: "2.1.0", checkedAt: 20,
        } } } : {}),
        ...(field === "version" ? { installedVersion: { kind: "known" as const, version: "1.1.0" } } : {}),
        ...(field === "resources" ? { resourcesFingerprint: "changed" } : {}),
        ...(field === "owner" ? { owner: { kind: "native" as const, installerDigest: "new", prefix: "/fixture" } } : {}),
        ...(field === "channel" ? { channel: "beta" } : {}),
      } };
    // When
    component.refresh(refreshed);
    // Then
    expect(component.stage).toBe("choosing");
    expect(component.input("Enter", old)).toEqual({ ok: false, error: { code: "stale_selection" } });
    expect(component.input("Enter")?.ok).not.toBe(true);
  },
);
test.each(["paneGeneration", "socketEpoch", "turnGeneration", "session", "optionsRef", "root", "readiness"] as const)(
  "clears rather than transfers a selected target on %s drift", field => {
    // Given
    const snapshot = fixture(), component = reviewed(snapshot, true);
    const refreshed = { ...snapshot, targets: snapshot.targets.map(row => ({
      ...row, readiness: field === "readiness" ? unsupported : supported,
      target: { ...row.target, expectedBinding: { ...row.target.expectedBinding,
        ...(field === "paneGeneration" ? { paneGeneration: 2 } : {}),
        ...(field === "socketEpoch" ? { socketEpoch: "new" } : {}),
        ...(field === "turnGeneration" ? { turnGeneration: 2 } : {}),
        ...(field === "session" ? { session: { ...row.target.expectedBinding.session, fullId: "session:new" } } : {}),
        ...(field === "optionsRef" ? { optionsRef: "options:new" } : {}),
        ...(field === "root" ? { rootIncarnation: { ...row.target.expectedBinding.rootIncarnation, startIdentity: "new" } } : {}),
      } },
    })) };
    // When
    component.refresh(refreshed);
    // Then
    expect(component.selectedTargets).toEqual([]);
    expect(component.stage).toBe("choosing");
    expect(component.input("Enter")?.ok).not.toBe(true);
  },
);
test("preserves deliberate selection and confirmation on the same observation", () => {
  // Given
  const snapshot = fixture(), component = reviewed(snapshot, true), old = component.observation;
  // When
  component.refresh(structuredClone(snapshot));
  // Then
  expect(component.observation).toEqual(old);
  expect(component.stage).toBe("confirming");
  expect(component.selectedTargets).toEqual([target("socket:a")]);
});
test("disappeared target is not replaced by the remaining pane", () => {
  // Given
  const snapshot = fixture(), component = reviewed(snapshot, true);
  // When
  component.refresh({ ...snapshot, targets: snapshot.targets.slice(1) });
  // Then
  expect(component.selectedTargets).toEqual([]);
  expect(component.input("Enter")?.ok).not.toBe(true);
});
test("captures nested caller data and accessors before validation without changing payload later", () => {
  // Given
  const original = fixture();
  let accesses = 0;
  const input = { ...original, get installation() {
    accesses++; return accesses === 1 ? original.installation : { ...original.installation, installationId: "other" };
  } };
  const component = reviewed(input, true);
  // When
  Object.defineProperty(original.installation.owner, "prefix", { value: "/MUTATED" });
  Object.defineProperty(original.targets[0]?.target.expectedBinding.session ?? {}, "fullId", { value: "MUTATED" });
  const action = component.input("Enter");
  // Then
  expect(accesses).toBe(1);
  expect(action?.ok).toBe(true);
  if (!action?.ok) throw new TypeError("expected intent");
  expect(action.value.installation.owner).toEqual(installation.owner);
  expect(action.value.selectedTargets[0]?.expectedBinding.session.fullId).toBe("PRIVATE_SESSION");
});
test("rejects malformed exact bindings and conflicting physical pane observations", () => {
  // Given
  const snapshot = fixture(), first = snapshot.targets[0];
  if (!first) throw new TypeError("missing fixture");
  // When / Then
  expect(() => new SelectComponent({ ...snapshot, targets: [{ ...first,
    target: { ...first.target, expectedBinding: { ...first.target.expectedBinding, paneGeneration: -1 } } }] }))
    .toThrow(SelectionError);
  const duplicate = new SelectComponent({ ...snapshot, targets: [first, { ...first,
    target: { ...first.target, targetId: "other", expectedBinding: { ...first.target.expectedBinding, socketEpoch: "new" } } }] });
  duplicate.input("m");
  expect(duplicate.input(" ")).toEqual({ ok: false, error: { code: "stale_binding" } });
});
test.each(["ArrowDown", "PageDown", "ArrowUp"])("navigation %s revokes final confirmation", key => {
  // Given
  const component = reviewed(fixture(), true);
  // When
  component.input(key);
  // Then
  expect(component.stage).toBe("reviewing");
  expect(component.input("Enter")).toBeNull();
  expect(component.stage).toBe("confirming");
});
test("Escape backs out and cancels locally without emitting status or job actions", () => {
  // Given
  const component = reviewed(fixture(), true);
  // When
  const actions = [component.input("Escape"), component.input("Escape"), component.input("Escape"), component.input("Enter")];
  // Then
  expect(actions).toEqual([null, null, null, null]);
  expect(component.stage).toBe("cancelled");
});
test.each([120, 80, 2, 1])("sanitizes controls and protects privacy at %i columns", width => {
  // Given
  const snapshot = fixture();
  const enriched = { ...snapshot, token: "PRIVATE_TOKEN",
    installation: { ...snapshot.installation, channel: `한글频道${"경로".repeat(100)}\x1b]0;TITLE\x07\x1b[31m\u202e` },
  };
  const component = reviewed(enriched, true);
  // When
  const frame = component.render(width, width === 120 ? 40 : 24);
  const action = component.input("Enter");
  // Then
  expect(frame.split("\n").every(line => Bun.stringWidth(line) <= width)).toBe(true);
  expect(frame.split("\n").length).toBeLessThanOrEqual(width === 120 ? 40 : 24);
  expect(frame).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/);
  expect(frame).not.toContain("PRIVATE_");
  expect(frame).not.toContain("TITLE");
  expect(JSON.stringify(action)).not.toContain("PRIVATE_TOKEN");
  if (width >= 80) expect(frame).toContain("한글频道");
});
test.each([80, 120])("clips a wide grapheme crossing the %i column boundary", width => {
  // Given: the header prefix takes six cells before channel text.
  const snapshot = fixture();
  const component = new SelectComponent({ ...snapshot, installation: { ...snapshot.installation,
    channel: "x".repeat(width - 10) + "한" + "x".repeat(20) } });
  // When
  const frame = component.render(width, 24);
  // Then
  expect(frame.split("\n").every(line => Bun.stringWidth(line) <= width)).toBe(true);
});
test("removes short control fields without relying on truncation", () => {
  // Given
  const snapshot = fixture();
  const component = new SelectComponent({ ...snapshot,
    installation: { ...snapshot.installation, channel: "한글\u009b\u202e\x1b]0;TITLE\x07\x1b[31m" } });
  // When
  const frame = component.render(120, 40);
  // Then
  expect(frame.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
});
test("blocks identical duplicate observations rather than launching two targets", () => {
  // Given
  const snapshot = fixture(), first = snapshot.targets[0];
  if (!first) throw new TypeError("missing fixture");
  const component = new SelectComponent({ ...snapshot, targets: [first, structuredClone(first)] });
  component.input("m");
  // When
  const result = component.input(" ");
  // Then
  expect(result).toEqual({ ok: false, error: { code: "stale_binding" } });
  expect(component.selectedTargets).toEqual([]);
  expect(component.input("r")?.ok).toBe(false);
});
test("review exposes exactly one selected effect and leaves the other socket untouched", () => {
  // Given
  const component = new SelectComponent(fixture());
  component.input("m"); component.input(" ");
  // When
  const result = component.input("r");
  // Then
  expect(result).toBeNull();
  expect(component.stage).toBe("reviewing");
  expect(component.effects.restartTargets).toEqual([target("socket:a")]);
  expect(component.effects.installation.installationId).toBe("install:a");
  expect(component.input("Enter")).toBeNull();
  expect(component.stage).toBe("confirming");
});
test.each(["missing", "unknown", "unsupported"] as const)("does not promote %s update capability", kind => {
  // Given
  const component = new SelectComponent({ ...fixture(), update: { kind, reason: "not_verified" } });
  // When
  const result = component.input("r");
  // Then
  expect(result).toEqual({ ok: false, error: { code: "unsupported" } });
});
test.each(["absent", "unavailable", "up-to-date", "mismatch"] as const)("blocks %s check instead of selecting latest", kind => {
  // Given
  const snapshot = fixture();
  const lastCheck: Installation["lastCheck"] = kind === "absent" ? null
    : { checkedAt: 10, result: kind === "unavailable"
      ? { kind: "unavailable", checkedAt: 10, failure: { code: "verification_failed" } }
      : kind === "up-to-date" ? { kind: "up-to-date", checkedAt: 10, installedVersion: "1.0.0" }
        : { kind: "update-available", checkedAt: 11, installedVersion: "1.0.0", availableVersion: "2.0.0" } };
  const component = new SelectComponent({ ...snapshot, installation: { ...snapshot.installation, lastCheck } });
  // When
  const result = component.input("r");
  // Then
  expect(result).toEqual({ ok: false, error: { code: "stale_selection" } });
  expect(component.stage).toBe("choosing");
});
test("returned selections and effects cannot mutate the captured state", () => {
  // Given
  const component = new SelectComponent(fixture());
  // When / Then
  expect(Object.isFrozen(component.selectedTargets)).toBe(true);
  component.input("m"); component.input(" ");
  expect(Object.isFrozen(component.effects.restartTargets)).toBe(true);
  expect(Object.isFrozen(component.effects.installation.owner)).toBe(true);
  expect(() => Object.defineProperty(component.selectedTargets[0]?.expectedBinding ?? {}, "paneGeneration", { value: 999 }))
    .toThrow(TypeError);
  expect(component.selectedTargets[0]?.expectedBinding.paneGeneration).toBe(1);
});
test("scrolls target selection and review effects inside bounded height", () => {
  // Given
  const snapshot = fixture(), first = snapshot.targets[0];
  if (!first) throw new TypeError("missing fixture");
  const component = new SelectComponent({ ...snapshot, targets: Array.from({ length: 40 }, (_, i) => ({
    ...first, target: target("socket:a", `pane:${i}`),
  })) });
  component.render(80, 24); component.input("m");
  // When
  for (let i = 0; i < 40; i++) { component.input(" "); component.input("ArrowDown"); }
  const chosen = component.render(80, 24);
  component.input("r");
  for (let i = 0; i < 40; i++) component.input("PageDown");
  const review = component.render(80, 24);
  // Then
  expect(chosen).toContain("pane:39");
  expect(review).toContain("pane:39");
  expect(chosen.split("\n").length).toBe(24);
  expect(review.split("\n").length).toBe(24);
});
