import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { localeMessages } from "./locales";
import monitorSemanticFixture from "./monitor-semantic-fixture.json";

type MessageTree = Record<string, unknown>;
type FixtureLocale = keyof typeof monitorSemanticFixture.locales;

function valueAtPath(tree: MessageTree, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as MessageTree)[key];
  }, tree);
}

function setValueAtPath(tree: MessageTree, path: string, nextValue: string): void {
  const segments = path.split(".");
  const finalKey = segments.pop();
  let target = tree;
  for (const segment of segments) target = target[segment] as MessageTree;
  if (finalKey) target[finalKey] = nextValue;
}

function leafPaths(tree: MessageTree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") return [path];
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    return leafPaths(value as MessageTree, path);
  });
}

function monitorSemanticErrors(locale: FixtureLocale, monitor: MessageTree): string[] {
  const errors: string[] = [];
  const approvedValues = monitorSemanticFixture.locales[locale];

  monitorSemanticFixture.paths.forEach((path, index) => {
    if (valueAtPath(monitor, path) !== approvedValues[index]) {
      errors.push(`${path} is not approved for ${locale}`);
    }
  });

  const digest = createHash("sha256").update(JSON.stringify(monitor)).digest("hex");
  if (digest !== monitorSemanticFixture.catalogDigests[locale]) {
    errors.push(`monitor catalog digest is not approved for ${locale}`);
  }
  return errors;
}

describe("monitor locale semantics", () => {
  it("matches the curated software-context fixture in every locale", () => {
    expect(Object.keys(monitorSemanticFixture.locales)).toEqual(Object.keys(localeMessages));
    expect(monitorSemanticFixture.paths).toEqual(
      leafPaths((localeMessages.en as MessageTree).monitor as MessageTree),
    );

    for (const [locale, messages] of Object.entries(localeMessages)) {
      const monitor = (messages as MessageTree).monitor as MessageTree;
      expect(monitorSemanticErrors(locale as FixtureLocale, monitor), locale).toEqual([]);
    }
  });

  it.each([
    ["de", "refreshing", "Erfrischend"],
    ["de", "live", "leben"],
    ["es", "openRun", "carrera abierta"],
    ["es", "live", "vivir"],
    ["fr", "openRuns", "Ouvrir les courses en direct et récentes"],
    ["fr", "live", "vivre"],
    ["he", "health.critical.label", "מדינה קריטית"],
    ["ja", "refreshing", "さわやか"],
    ["ja", "live", "生きる"],
    ["ar", "agentStates", "دول الوكيل"],
  ] as const)("rejects the reported wrong sense in %s monitor.%s", (locale, path, wrongSense) => {
    const messages = localeMessages[locale] as MessageTree;
    const monitor = structuredClone(messages.monitor) as MessageTree;
    setValueAtPath(monitor, path, wrongSense);

    expect(monitorSemanticErrors(locale, monitor)).toContain(`${path} is not approved for ${locale}`);
  });
});
