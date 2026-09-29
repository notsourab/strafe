import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map(),
  appWindow: {
    setSize: vi.fn(),
    center: vi.fn(),
    listen: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => tauri.appWindow,
  LogicalSize: class LogicalSize {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
  },
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

const defaultConfig = {
  shortcut: "Alt+Space",
  results_count: 4,
  brave_api_key: "test-key",
  click_outside_dismisses: true,
  scroll_speed: 3,
  theme: "auto",
  default_view: "text",
  shortcuts: {},
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe("app request lifecycle", () => {
  let config;
  let searchRequests;
  let pageRequests;
  let aiRequests;

  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<main id="app"></main>';
    document.documentElement.removeAttribute("data-theme");
    Element.prototype.scrollIntoView = vi.fn();

    config = { ...defaultConfig, shortcuts: {} };
    searchRequests = [];
    pageRequests = [];
    aiRequests = [];
    tauri.listeners.clear();
    tauri.invoke.mockReset();
    tauri.appWindow.setSize.mockReset().mockResolvedValue(undefined);
    tauri.appWindow.center.mockReset().mockResolvedValue(undefined);
    tauri.appWindow.listen.mockReset().mockImplementation((event, handler) => {
      tauri.listeners.set(event, handler);
      return Promise.resolve(() => {});
    });
    tauri.invoke.mockImplementation((command, args) => {
      if (command === "get_config") {
        return Promise.resolve({ ...config, shortcuts: { ...config.shortcuts } });
      }
      if (command === "search_query") {
        const request = { args, ...deferred() };
        searchRequests.push(request);
        return request.promise;
      }
      if (command === "get_ai_summary") {
        const request = { args, ...deferred() };
        aiRequests.push(request);
        return request.promise;
      }
      if (command === "fetch_single_page") {
        const request = { args, ...deferred() };
        pageRequests.push(request);
        return request.promise;
      }
      return Promise.resolve(undefined);
    });

  });

  async function loadApp() {
    await import("../src/main.ts");
    await flush();
    expect(document.querySelector(".search-input")).not.toBeNull();
  }

  afterEach(async () => {
    if (!document.querySelector(".settings-container")) {
      tauri.listeners.get("show-settings")?.();
      await flush();
    }
    document.querySelector(".settings-close")?.click();
    await flush();
    document.body.innerHTML = "";
  });

  function enter(input, query) {
    input.value = query;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }

  async function openSettings() {
    tauri.listeners.get("show-settings")();
    await flush();
    expect(document.querySelector(".settings-container")).not.toBeNull();
  }

  async function closeSettings() {
    document.querySelector(".settings-close").click();
    await flush();
    expect(document.querySelector(".search-input")).not.toBeNull();
  }

  async function resolveArticle(requestIndex, text) {
    const url = `https://example.com/article-${requestIndex}`;
    searchRequests[requestIndex].resolve([{ title: "Article", url, description: "" }]);
    await flush();
    expect(pageRequests[requestIndex].args).toEqual({ url });
    pageRequests[requestIndex].resolve({
      url,
      html: `<html><body><article><h1>Article</h1><p>${text.repeat(30)}</p></article></body></html>`,
      error: null,
    });
    await flush();
    expect(document.querySelector(".content-area")?.textContent).toContain(text);
  }

  it.each(["legacy", "empty", "whitespace"])("searches and reads with a %s Search-only configuration without requesting AI", async (setup) => {
    if (setup === "empty") config.brave_answers_api_key = "";
    if (setup === "whitespace") config.brave_answers_api_key = " \t ";
    await loadApp();

    enter(document.querySelector(".search-input"), "ordinary search");
    await flush();
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0].args).toEqual({ query: "ordinary search" });
    await resolveArticle(0, "Search-only users can read the complete fetched article. ");

    expect(document.querySelector(".tab.active")?.dataset.index).toBe("0");
    expect(document.querySelector(".error-message")).toBeNull();
    expect(document.querySelector(".ai-tab, .tab-hint")).toBeNull();
    expect(document.querySelector(".hints-bar")?.textContent).not.toContain("AI");
    for (const key of ["2", "l", "ArrowRight"]) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key }));
    }
    await flush();
    expect(document.querySelector(".tab.active")?.dataset.index).toBe("0");
    expect(document.querySelector(".ai-tab, .tab-hint")).toBeNull();
    expect(aiRequests).toHaveLength(0);
    expect(tauri.invoke.mock.calls.some(([command]) => command === "get_ai_summary")).toBe(false);
  });

  it.each([
    ["authentication error", "invalid-answers-key", "Brave Answers authentication failed (HTTP 401). Check the Brave Answers API key in Settings."],
    ["402 plan error", "search-plan-key", "Brave Answers access denied (HTTP 402). Check that your Answers key has an active Answers plan."],
    ["403 plan error", "search-plan-key", "Brave Answers access denied (HTTP 403). Check that your Answers key has an active Answers plan."],
  ])("keeps articles and new searches usable after an AI %s", async (_label, answersKey, message) => {
    config.brave_answers_api_key = answersKey;
    await loadApp();
    enter(document.querySelector(".search-input"), "first search");
    await flush();
    const articleText = "The fetched article remains available when Answers cannot generate an overview. ";
    await resolveArticle(0, articleText);
    expect(aiRequests).toHaveLength(1);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
    await flush();
    expect(aiRequests).toHaveLength(1);
    expect(aiRequests[0].args).toEqual({ query: "first search" });
    aiRequests[0].reject(message);
    await flush();

    expect(document.querySelector(".ai-tab.active")).not.toBeNull();
    expect(document.querySelector(".content-wrapper .error-message")?.textContent).toContain(message);
    expect(document.querySelector(".content-wrapper .retry-hint")?.textContent).toBe(
      "Check your Brave Answers API key and plan in Settings.",
    );
    expect(document.querySelector(".content-wrapper")?.textContent).not.toContain("Try a more general search query.");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));
    await flush();
    expect(document.querySelector(".content-area")?.textContent).toContain(articleText);
    expect(document.querySelector(".error-message")).toBeNull();
    expect(pageRequests).toHaveLength(1);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "/" }));
    await flush();
    expect(document.querySelector(".search-input")).not.toBeNull();
    enter(document.querySelector(".search-input"), "second search");
    await flush();
    expect(searchRequests).toHaveLength(2);
    expect(searchRequests[1].args).toEqual({ query: "second search" });
    await resolveArticle(1, "A new search still loads and displays another article. ");
    expect(document.querySelector(".error-message")).toBeNull();
    expect(document.querySelector(".ai-tab")).not.toBeNull();
    expect(aiRequests).toHaveLength(2);
  });

  it.each([
    ["AI first", "resolve"], ["AI first", "reject"],
    ["search first", "resolve"], ["search first", "reject"],
  ])("starts Search and Answers together and preserves the article when %s and AI %s", async (order, settlement) => {
    config.brave_answers_api_key = " answers-key ";
    await loadApp();
    enter(document.querySelector(".search-input"), "parallel search");
    await flush();
    expect(searchRequests).toHaveLength(1);
    expect(aiRequests).toHaveLength(1);
    expect(aiRequests[0].args).toEqual({ query: "parallel search" });
    expect(pageRequests).toHaveLength(0);
    const settleAI = async () => {
      if (settlement === "resolve") aiRequests[0].resolve("Overview ready");
      else aiRequests[0].reject("Overview request failed");
      await flush();
    };

    if (order === "AI first") {
      const loadingView = document.getElementById("app").innerHTML;
      await settleAI();
      expect(document.getElementById("app").innerHTML).toBe(loadingView);
    }
    const articleText = "The article stays in view while its overview is generated. ";
    await resolveArticle(0, articleText);
    const article = document.querySelector(".content-area");
    expect(document.querySelector(".ai-tab")).not.toBeNull();
    if (order === "search first") {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));
      await flush();
      expect(aiRequests).toHaveLength(1);
      const articleBeforeCompletion = document.querySelector(".content-area");
      await settleAI();
      expect(document.querySelector(".content-area")).toBe(articleBeforeCompletion);
    } else {
      expect(document.querySelector(".content-area")).toBe(article);
    }
    expect(document.querySelector(".tab.active")?.dataset.index).toBe("0");
    expect(document.querySelector(".content-area")?.textContent).toContain(articleText);
    document.querySelector(".ai-tab").click();
    expect(document.querySelector(".content-wrapper")?.textContent).toContain(
      settlement === "resolve" ? "Overview ready" : "Overview request failed",
    );
    expect(aiRequests).toHaveLength(1);
    if (settlement === "resolve") {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
      await flush();
      expect(aiRequests).toHaveLength(1);
    } else {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
      await flush();
      expect(aiRequests).toHaveLength(2);
      aiRequests[1].resolve("Retried overview");
      await flush();
      expect(document.querySelector(".ai-content")?.textContent).toContain("Retried overview");
    }
  });

  it.each(["add", "remove"])("refreshes Answers availability when Settings closes after key %s", async (change) => {
    if (change === "remove") config.brave_answers_api_key = "answers-key";
    await loadApp();
    await openSettings();
    config.brave_answers_api_key = change === "add" ? "answers-key" : "";
    await closeSettings();
    enter(document.querySelector(".search-input"), "updated settings");
    await flush();
    expect(aiRequests).toHaveLength(change === "add" ? 1 : 0);
    await resolveArticle(0, "Settings changes apply to the next search. ");
    expect(Boolean(document.querySelector(".ai-tab"))).toBe(change === "add");
  });

  it("opens aliases without Search or Answers even when an Answers key is configured", async () => {
    config.brave_answers_api_key = "answers-key";
    config.shortcuts = { docs: "https://example.com/docs" };
    await loadApp();
    enter(document.querySelector(".search-input"), "docs");
    await flush();
    expect(pageRequests).toHaveLength(1);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
    await flush();
    expect(searchRequests).toHaveLength(0);
    expect(aiRequests).toHaveLength(0);
    expect(document.querySelector(".ai-tab, .tab-hint")).toBeNull();
  });

  it.each([
    ["no results", "resolve"], ["no results", "reject"],
    ["search error", "resolve"], ["search error", "reject"],
  ])("preserves %s when background AI %s", async (searchOutcome, settlement) => {
    config.brave_answers_api_key = "answers-key";
    await loadApp();
    enter(document.querySelector(".search-input"), "unavailable search");
    await flush();
    expect(aiRequests).toHaveLength(1);
    if (searchOutcome === "no results") searchRequests[0].resolve([]);
    else searchRequests[0].reject("Search service failed");
    await flush();
    const errorView = document.getElementById("app").innerHTML;
    if (settlement === "resolve") aiRequests[0].resolve("Late overview");
    else aiRequests[0].reject("Overview failed");
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));
    await flush();
    expect(document.getElementById("app").innerHTML).toBe(errorView);
    expect(aiRequests).toHaveLength(1);
    expect(document.querySelector(".error-message")?.textContent).toContain(
      searchOutcome === "no results" ? "No results found" : "Search service failed",
    );
  });

  it.each(["toggle", "default", "alias"])("isolates raw content opened through %s", async (entry) => {
    if (entry === "default") config.default_view = "raw";
    if (entry === "alias") config.shortcuts = { docs: "https://example.com/docs" };
    await loadApp();
    enter(document.querySelector(".search-input"), entry === "alias" ? "docs" : "topic");
    await flush();
    if (entry !== "alias") {
      searchRequests[0].resolve([{ title: "Article", url: "https://example.com/docs", description: "" }]);
      await flush();
    }
    pageRequests[0].resolve({ url: "https://example.com/docs", html: '<html><body><script>parent.__TAURI__.core.invoke("attack")</script><p>Raw article</p></body></html>', error: null });
    await flush();
    if (entry === "toggle") document.dispatchEvent(new KeyboardEvent("keydown", { key: "w" }));

    const iframe = document.querySelector(".raw-view");
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute("sandbox").split(/\s+/)).not.toContain("allow-same-origin");
    expect(iframe.srcdoc).toContain("Raw article");
    expect(iframe.srcdoc).not.toContain('invoke("attack")');
  });

  it.each(["request", "resize"])("allows a new search during pending %s", async (stage) => {
    await loadApp();
    const resize = deferred();
    if (stage === "resize") tauri.appWindow.setSize.mockImplementationOnce(() => resize.promise);
    enter(document.querySelector(".search-input"), "old");
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "/" }));
    await flush();
    expect(document.querySelector(".search-input")).not.toBeNull();
    enter(document.querySelector(".search-input"), "new");
    await flush();
    resize.resolve();
    await flush();
    expect(searchRequests.at(-1).args.query).toBe("new");
  });

  it.each(["request", "resize"])("allows dismissal during pending %s", async (stage) => {
    await loadApp();
    const resize = deferred();
    if (stage === "resize") tauri.appWindow.setSize.mockImplementationOnce(() => resize.promise);
    enter(document.querySelector(".search-input"), "old");
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flush();
    expect(tauri.invoke).toHaveBeenCalledWith("dismiss_window");
    resize.resolve();
    await flush();
    expect(document.querySelector(".search-input")).not.toBeNull();
  });

  it("hands focus back through the native dismissal command on Escape", async () => {
    await loadApp();
    document.querySelector(".search-input").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    await flush();
    expect(tauri.invoke).toHaveBeenCalledWith("dismiss_window");
    expect(document.activeElement).not.toBe(document.querySelector(".search-input"));
  });

  it("discards a response arriving while dismissal is pending", async () => {
    await loadApp();
    enter(document.querySelector(".search-input"), "old");
    await flush();
    const hide = deferred();
    tauri.invoke.mockImplementationOnce((command) =>
      command === "dismiss_window" ? hide.promise : Promise.resolve(undefined)
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    searchRequests[0].resolve([{ title: "Old", url: "https://old.example", description: "" }]);
    await flush();
    expect(pageRequests).toHaveLength(0);
    hide.resolve();
    await flush();
  });

  it.each(["resolve", "reject"])("ignores old search %s after restarting with /", async (settlement) => {
    await loadApp();
    enter(document.querySelector(".search-input"), "old");
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "/" }));
    await flush();
    expect(document.querySelector(".search-input")).not.toBeNull();
    enter(document.querySelector(".search-input"), "new");
    await flush();
    searchRequests[1].resolve([]);
    await flush();
    const newerView = document.getElementById("app").innerHTML;
    if (settlement === "resolve") searchRequests[0].resolve([{ title: "Old", url: "https://old.example", description: "" }]);
    else searchRequests[0].reject("Old failure");
    await flush();
    expect(document.getElementById("app").innerHTML).toBe(newerView);
    expect(pageRequests).toHaveLength(0);
  });

  it.each([
    ["resolve", "new search"], ["reject", "new search"],
    ["resolve", "settings"], ["reject", "settings"],
    ["resolve", "dismissal"], ["reject", "dismissal"],
  ])("ignores old AI %s after %s", async (settlement, transition) => {
    config.brave_answers_api_key = "answers-key";
    await loadApp();
    enter(document.querySelector(".search-input"), "old");
    await flush();
    searchRequests[0].resolve([{ title: "Old", url: "https://old.example", description: "" }]);
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
    await flush();
    expect(aiRequests).toHaveLength(1);
    if (transition === "settings") await openSettings();
    else {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: transition === "dismissal" ? "Escape" : "/" }));
      await flush();
      if (transition === "new search") {
        enter(document.querySelector(".search-input"), "new");
        await flush();
        await resolveArticle(1, "Only the newer search can update this reader. ");
      }
    }
    const newerView = document.getElementById("app").innerHTML;
    if (settlement === "resolve") aiRequests[0].resolve("Old summary");
    else aiRequests[0].reject("Old failure");
    await flush();
    expect(document.getElementById("app").innerHTML).toBe(newerView);
    if (transition === "new search") {
      document.querySelector(".ai-tab").click();
      expect(document.querySelector(".loading-text")?.textContent).toContain("Generating AI Overview");
      aiRequests[1].resolve("Current summary");
      await flush();
      expect(document.querySelector(".ai-content")?.textContent).toContain("Current summary");
    }
  });

  it.each(["resolve", "reject"])("ignores AI %s while dismissal is pending", async (settlement) => {
    config.brave_answers_api_key = "answers-key";
    await loadApp();
    enter(document.querySelector(".search-input"), "dismissed search");
    await flush();
    await resolveArticle(0, "This article is being dismissed. ");
    document.querySelector(".ai-tab").click();
    const hide = deferred();
    tauri.invoke.mockImplementationOnce((command) =>
      command === "dismiss_window" ? hide.promise : Promise.resolve(undefined)
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    const dismissingView = document.getElementById("app").innerHTML;
    if (settlement === "resolve") aiRequests[0].resolve("Dismissed overview");
    else aiRequests[0].reject("Dismissed overview failure");
    await flush();
    expect(document.getElementById("app").innerHTML).toBe(dismissingView);
    hide.resolve();
    await flush();
    expect(document.querySelector(".search-input")).not.toBeNull();
  });

  it("replaces the search loading message when results arrive", async () => {
    await loadApp();
    enter(document.querySelector(".search-input"), "topic");
    await flush();
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Searching");
    searchRequests[0].resolve([{ title: "Result", url: "https://example.com", description: "" }]);
    await flush();
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(document.querySelectorAll(".reader-container")).toHaveLength(1);
  });

  it("reloads saved aliases when Settings closes", async () => {
    await loadApp();
    await openSettings();
    config.shortcuts = { docs: "https://example.com/docs" };
    await closeSettings();

    enter(document.querySelector(".search-input"), "docs");
    await flush();

    expect(pageRequests).toHaveLength(1);
    expect(pageRequests[0].args.url).toBe("https://example.com/docs");
    expect(searchRequests).toHaveLength(0);
    pageRequests[0].resolve({
      url: "https://example.com/docs",
      html: "<html><body><p>Documentation</p></body></html>",
      error: null,
    });
    await flush();
    expect(document.querySelector(".reader-container")).not.toBeNull();
  });

  it("treats inherited object properties as ordinary searches", async () => {
    await loadApp();
    enter(document.querySelector(".search-input"), "constructor");
    await flush();

    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0].args).toEqual({ query: "constructor" });
    expect(pageRequests).toHaveLength(0);
    searchRequests[0].resolve([]);
    await flush();
    expect(document.querySelector(".error-message")?.textContent).toContain("No results found");
  });

  it.each(["search", "alias"])(
    "keeps Settings open when an older %s finishes resizing",
    async (route) => {
      if (route === "alias") config.shortcuts = { docs: "https://example.com/docs" };
      await loadApp();
      const resize = deferred();
      tauri.appWindow.setSize.mockImplementationOnce(() => resize.promise);
      enter(document.querySelector(".search-input"), route === "alias" ? "docs" : "older search");
      await flush();
      await openSettings();

      resize.resolve();
      await flush();
      for (const request of searchRequests) request.resolve([]);
      await flush();

      expect(document.querySelector(".settings-container")).not.toBeNull();
      expect(searchRequests).toHaveLength(0);
      expect(pageRequests).toHaveLength(0);
    },
  );

  it.each(["resolve", "reject"])(
    "does not let an older %s search completion unlock a newer search",
    async (settlement) => {
      await loadApp();
      const firstInput = document.querySelector(".search-input");
      enter(firstInput, "old");
      await flush();
      expect(searchRequests).toHaveLength(1);

      await openSettings();
      await closeSettings();
      const newerInput = document.querySelector(".search-input");
      enter(newerInput, "new");
      await flush();
      expect(searchRequests).toHaveLength(2);

      if (settlement === "resolve") searchRequests[0].resolve([]);
      else searchRequests[0].reject(new Error("old request failed"));
      await flush();
      enter(newerInput, "must stay blocked");
      await flush();
      const requestCount = searchRequests.length;

      for (const request of searchRequests.slice(1)) request.resolve([]);
      await flush();
      expect(requestCount).toBe(2);
    },
  );

  it.each([
    ["result", "resolve"],
    ["result", "reject"],
    ["alias", "resolve"],
    ["alias", "reject"],
  ])("ignores a stale %s page %s after Settings opens", async (route, settlement) => {
    if (route === "alias") config.shortcuts = { docs: "https://example.com/docs" };
    await loadApp();
    enter(document.querySelector(".search-input"), route === "alias" ? "docs" : "topic");
    await flush();
    if (route === "result") {
      searchRequests[0].resolve([
        { title: "Example", url: "https://example.com/article", description: "" },
      ]);
      await flush();
    }
    expect(pageRequests).toHaveLength(1);
    await openSettings();

    if (settlement === "resolve") {
      pageRequests[0].resolve({
        url: pageRequests[0].args.url,
        html: "<html><body><article><p>Old page</p></article></body></html>",
        error: null,
      });
    } else {
      pageRequests[0].reject(new Error("old page failed"));
    }
    await flush();

    expect(document.querySelector(".settings-container")).not.toBeNull();
  });
});
