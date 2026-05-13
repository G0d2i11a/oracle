import { Script } from "node:vm";
import { describe, expect, test } from "vitest";
import { buildVisibleStopButtonExpressionForTest } from "../../src/browser/actions/stopButton.js";

type FakeRect = {
  width: number;
  height: number;
};

class FakeElement {
  readonly style: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();

  constructor(
    readonly tagName: string,
    public textContent = "",
    attrs: Record<string, string> = {},
    private readonly rect: FakeRect = { width: 32, height: 32 },
  ) {
    for (const [key, value] of Object.entries(attrs)) {
      this.attrs.set(key, value);
    }
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  getBoundingClientRect(): FakeRect {
    return this.rect;
  }
}

class FakeDocument {
  constructor(private readonly nodes: FakeElement[]) {}

  querySelectorAll(selector: string): FakeElement[] {
    return this.nodes.filter((node) => matchesSelectorList(node, selector));
  }
}

function matchesSelectorList(node: FakeElement, selector: string): boolean {
  return selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => matchesSimpleSelector(node, part));
}

function matchesSimpleSelector(node: FakeElement, selector: string): boolean {
  const tagMatch = selector.match(/^[a-z]+/i);
  if (tagMatch && node.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) {
    return false;
  }

  const attrMatches = [
    ...selector.matchAll(/\[([a-zA-Z0-9_-]+)([*^]?=)?(?:"([^"]*)"|'([^']*)'|([^\]]+))?\]/g),
  ];
  for (const match of attrMatches) {
    const attr = match[1] ?? "";
    const operator = match[2];
    const expected = match[3] ?? match[4] ?? match[5] ?? "";
    const actual = node.getAttribute(attr);
    if (!operator && actual == null) return false;
    if (operator === "=" && actual !== expected) return false;
    if (operator === "*=" && !String(actual ?? "").includes(expected)) return false;
  }

  if (selector === '[role="button"]') {
    return node.getAttribute("role") === "button";
  }

  return true;
}

function detectStopButton(nodes: FakeElement[]): boolean {
  const context = {
    document: new FakeDocument(nodes),
    HTMLElement: FakeElement,
    Set,
    Array,
    String,
    Number,
    window: {
      getComputedStyle: (node: FakeElement) => ({
        display: node.style.display ?? "block",
        visibility: node.style.visibility ?? "visible",
        opacity: node.style.opacity ?? "1",
      }),
    },
  };
  return new Script(
    `${buildVisibleStopButtonExpressionForTest()}; hasVisibleStopButton();`,
  ).runInNewContext(context) as boolean;
}

describe("visible stop button detection", () => {
  test("detects localized pause controls", () => {
    expect(detectStopButton([new FakeElement("button", "", { "aria-label": "暂停回答" })])).toBe(
      true,
    );
  });

  test("detects the stable stop-button data-testid", () => {
    expect(
      detectStopButton([new FakeElement("button", "", { "data-testid": "stop-button" })]),
    ).toBe(true);
  });

  test("ignores history and menu controls whose labels mention stop", () => {
    expect(
      detectStopButton([
        new FakeElement("button", "", {
          "aria-label": "Open conversation options for Stop button debugging",
        }),
      ]),
    ).toBe(false);
  });

  test("ignores hidden stop controls", () => {
    expect(
      detectStopButton([
        new FakeElement("button", "", { "aria-label": "Stop generating" }, { width: 0, height: 0 }),
      ]),
    ).toBe(false);
  });
});
