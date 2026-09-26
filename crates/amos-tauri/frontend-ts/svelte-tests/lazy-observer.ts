/**
 * A **controllable** `IntersectionObserver` for DOM tests (REQ-A587).
 *
 * happy-dom ships one, but it can never fire: there is no layout and no scroll, so an element
 * is never reported as intersecting. Any test that cares *whether* something was lazy-loaded —
 * rather than merely that the component mounted — has to drive the callback itself. That is what
 * this helper is: the test installs it, the component observes through it, and the test decides
 * which elements are "visible".
 *
 * Usage:
 * ```ts
 * const fake = installFakeObserver();
 * const { container } = render(Thing);
 * await tick();
 * fake.revealAll();          // or fake.reveal(2) to report only the first two
 * await tick();
 * ```
 */
import { vi } from "vitest";

export class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  static observed: Element[] = [];

  cb: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void;
  options: IntersectionObserverInit | undefined;
  disconnected = false;
  /** How many elements the component asked this observer to watch (before any reveal). */
  observedCount = 0;

  constructor(cb: FakeIntersectionObserver["cb"], options?: IntersectionObserverInit) {
    this.cb = cb;
    this.options = options;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(el: Element): void {
    FakeIntersectionObserver.observed.push(el);
    this.observedCount += 1;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  unobserve(): void {}

  takeRecords(): [] {
    return [];
  }

  /** Report the first `n` observed elements as visible (all of them when `n` is omitted). */
  reveal(n = Number.POSITIVE_INFINITY): void {
    const targets = FakeIntersectionObserver.observed.slice(0, n);
    for (const target of targets) this.cb([{ isIntersecting: true, target }]);
  }
}

/** Install a fresh observer (per test) and return the class, so the test can drive it. */
export function installFakeObserver(): typeof FakeIntersectionObserver {
  FakeIntersectionObserver.instances = [];
  FakeIntersectionObserver.observed = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  return FakeIntersectionObserver;
}

/** Every element currently observed by any instance (in observe order). */
export function observedElements(): Element[] {
  return FakeIntersectionObserver.observed;
}
