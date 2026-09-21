import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { JSDOM } from "jsdom"
import { registerSource } from "./helpers/onboarding-source.mjs"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.example/", pretendToBeVisual: true })
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "Event", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
HTMLElement.prototype.scrollIntoView = () => {}
HTMLElement.prototype.getBoundingClientRect = () => ({ width: 1000, height: 700, top: 0, left: 0, right: 1000, bottom: 700 })
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
window.ResizeObserver = globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { NextIntlClientProvider } = await import("next-intl")
const editors = []
const models = []
globalThis.previewMonacoMock = {
  languages: { getLanguages: () => [], register() {}, setMonarchTokensProvider() {} },
  editor: {
    defineTheme() {}, setTheme() {},
    createModel(content) {
      const model = { content, disposed: false, dispose() { this.disposed = true }, validatePosition: x => x }
      models.push(model)
      return model
    },
    create(_host, options) {
      let change
      const editor = { model: null, options, disposed: false,
        getModel() { return this.model }, setModel(model) { this.model = model; change?.() },
        getValue() { return this.model?.content ?? "" },
        updateOptions(options) { this.options = { ...this.options, ...options } },
        onDidChangeModelContent(fn) { change = fn; return { dispose() {} } },
        focus() {}, dispose() { this.disposed = true },
      }
      editors.push(editor)
      return editor
    },
  },
}
const sourceHooks = registerSource()
const mockHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source
    if (specifier === "monaco-editor") source = "export const editor=globalThis.previewMonacoMock.editor; export const languages=globalThis.previewMonacoMock.languages"
    else if (specifier.startsWith("monaco-editor/")) source = "export {}"
    else if (specifier === "@/components/workspace-context") source = "export const useWorkspace=()=>({appendPathToComposer:()=>true})"
    if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
const { FilePreviewSurface } = await import("../src/components/file-preview-page.tsx")
const { FilesPanelBody } = await import("../src/components/panels/files-panel.tsx")
const { dashboardApi } = await import("../src/features/dashboard/api.ts")
const messages = JSON.parse(readFileSync(new URL("../messages/en.json", import.meta.url), "utf8"))
const textFile = (path) => ({ binary: false, path, name: path.split("/").at(-1), content: path, sha256: path, size: 10, truncated: false })
async function fixture(t, Component) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  t.after(async () => { await act(async () => root.unmount()); host.remove() })
  return { host, render: async props => act(async () => {
    root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC" }, h(Component, props)))
  }) }
}

test("rapid file switches reuse the editor, keep old content read-only, and ignore stale reads", async t => {
  const pending = new Map()
  t.mock.method(dashboardApi, "connectorFsReadText", async (_token, _connector, _root, path) =>
    new Promise(resolve => pending.set(path, resolve)))
  const f = await fixture(t, FilePreviewSurface)
  const props = { token: "fixture", connectorId: "connector", root: "/repo", mode: "embedded" }
  const start = editors.length
  await f.render({ ...props, initialPath: "/repo/a.ts" })
  await act(async () => pending.get("/repo/a.ts")(textFile("/repo/a.ts")))
  const editor = editors.at(-1)
  assert.equal(editors.length, start + 1)
  const node = f.host.querySelector(".aa-monaco-code-view")
  const oldModel = editor.model
  await f.render({ ...props, initialPath: "/repo/b.ts" })
  assert.equal(f.host.querySelector(".aa-monaco-code-view"), node)
  assert.equal(editor.getValue(), "/repo/a.ts")
  assert.equal(editor.options.readOnly, true)
  await f.render({ ...props, initialPath: "/repo/c.ts" })
  await act(async () => pending.get("/repo/c.ts")(textFile("/repo/c.ts")))
  await act(async () => pending.get("/repo/b.ts")(textFile("/repo/b.ts")))
  assert.equal(editor.getValue(), "/repo/c.ts")
  assert.equal(editor.disposed, false)
  assert.equal(oldModel.disposed, true)
  assert.equal(editors.length, start + 1)
})

test("resolved file switches preserve the tree and split panels without listing directories again", async t => {
  const listed = []
  t.mock.method(dashboardApi, "connectorFsList", async (_token, _connector, { path }) => {
    listed.push(path)
    return { result: { path, entries: path === "/repo"
      ? [{ type: "directory", path: "/repo/src", name: "src" }]
      : [{ type: "file", path: "/repo/src/nested.ts", name: "nested.ts" }] } }
  })
  t.mock.method(dashboardApi, "connectorFsReadText", async (_token, _connector, _root, path) => textFile(path))
  const f = await fixture(t, FilesPanelBody)
  const props = { token: "fixture", connectorId: "connector", root: "/repo", variant: "tab" }
  const file = name => ({ source: "workspace", name, path: `/repo/${name}`, root: "/repo", browsePath: "/repo" })
  await f.render({ ...props, initialFile: file("a.ts") })
  const panel = f.host.querySelector('[data-testid="files-preview"]')
  const tree = f.host.querySelector('[role="tree"]')
  assert.ok(panel)
  assert.ok(tree)
  const directory = f.host.querySelector('[data-fs-entry-path="/repo/src"]')
  await act(async () => directory.click())
  assert.equal(directory.getAttribute("aria-expanded"), "true")
  await f.render({ ...props, initialFile: file("b.ts") })
  assert.equal(f.host.querySelector('[data-testid="files-preview"]'), panel)
  assert.equal(f.host.querySelector('[role="tree"]'), tree)
  assert.deepEqual(listed, ["/repo", "/repo/src"])
  assert.equal(directory.getAttribute("aria-expanded"), "true")
  assert.ok(f.host.querySelector('[data-fs-entry-path="/repo/src/nested.ts"]'))
  assert.equal(editors.at(-1).getValue(), "/repo/b.ts")
})

test("a newly mounted preview inherits nested expansion from the fixed file tab", async t => {
  const directory = path => ({ type: "directory", path, name: path.split("/").at(-1) })
  const file = path => ({ type: "file", path, name: path.split("/").at(-1) })
  const listings = {
    "/repo": [directory("/repo/src"), directory("/repo/closed")],
    "/repo/src": [directory("/repo/src/nested")],
    "/repo/src/nested": [file("/repo/src/nested/b.ts")],
  }
  t.mock.method(dashboardApi, "connectorFsList", async (_token, _connector, { path }) =>
    ({ result: { path, entries: listings[path] ?? [] } }))
  t.mock.method(dashboardApi, "connectorFsReadText", async (_token, _connector, _root, path) => textFile(path))
  const props = { token: "fixture", connectorId: "connector", root: "/repo", variant: "tab" }
  const fixed = await fixture(t, FilesPanelBody)
  let opened
  await fixed.render({ ...props,
    initialFile: { source: "workspace", name: "a.ts", path: "/repo/a.ts", root: "/repo", browsePath: "/repo" },
    onOpenFilePreview: target => { opened = target },
  })
  for (const path of ["/repo/src", "/repo/src/nested"]) {
    await act(async () => fixed.host.querySelector(`[data-fs-entry-path="${path}"]`).click())
  }
  await act(async () => fixed.host.querySelector('[data-fs-entry-path="/repo/src/nested/b.ts"]').click())
  const preview = await fixture(t, FilesPanelBody)
  await preview.render({ ...props, initialFile: opened })
  for (const path of ["/repo/src", "/repo/src/nested"]) {
    assert.equal(preview.host.querySelector(`[data-fs-entry-path="${path}"]`).getAttribute("aria-expanded"), "true")
  }
  assert.equal(preview.host.querySelector('[data-fs-entry-path="/repo/closed"]').getAttribute("aria-expanded"), "false")
  assert.equal(preview.host.querySelector('[data-fs-entry-path="/repo/src/nested/b.ts"]').getAttribute("aria-selected"), "true")
  // Reusing an existing preview must also adopt the source tab's expansion.
  await act(async () => preview.host.querySelector('[data-fs-entry-path="/repo/src"]').click())
  await preview.render({ ...props, initialFile: { ...opened, browseExpandedPaths: [...opened.browseExpandedPaths] } })
  assert.equal(preview.host.querySelector('[data-fs-entry-path="/repo/src"]').getAttribute("aria-expanded"), "true")
})

test("breadcrumb file navigation reveals the new branch while preserving old expansion", async t => {
  const dir = path => ({ type: "directory", path, name: path.split("/").at(-1) })
  const listings = {
    "/repo": [dir("/repo/old"), dir("/repo/new")],
    "/repo/old": [],
    "/repo/new": [dir("/repo/new/nested")],
    "/repo/new/nested": [{ type: "file", path: "/repo/new/nested/report.md", name: "report.md" }],
  }
  t.mock.method(dashboardApi, "connectorFsList", async (_token, _connector, { path }) =>
    ({ result: { path, entries: listings[path] ?? [] } }))
  t.mock.method(dashboardApi, "connectorFsReadText", async (_token, _connector, _root, path) => textFile(path))
  const props = { token: "fixture", connectorId: "connector", root: "/repo", variant: "tab" }
  const old = { source: "workspace", root: "/repo", browsePath: "/repo", browseExpandedPaths: ["/repo/old"], path: "/repo/old/a.md", name: "a.md" }
  const target = { ...old, path: "/repo/new/nested/report.md", name: "report.md" }
  const preview = await fixture(t, FilesPanelBody)
  await preview.render({ ...props, initialFile: old })
  await preview.render({ ...props, initialFile: target })
  const fresh = await fixture(t, FilesPanelBody)
  await fresh.render({ ...props, initialFile: target })
  for (const f of [preview, fresh]) {
    for (const path of ["/repo/old", "/repo/new", "/repo/new/nested"]) {
      assert.equal(f.host.querySelector(`[data-fs-entry-path="${path}"]`).getAttribute("aria-expanded"), "true")
    }
    assert.equal(f.host.querySelector('[data-fs-entry-path="/repo/new/nested/report.md"]').getAttribute("aria-selected"), "true")
    // Users can still collapse a revealed branch after navigation.
    await act(async () => f.host.querySelector('[data-fs-entry-path="/repo/new"]').click())
    assert.equal(f.host.querySelector('[data-fs-entry-path="/repo/new"]').getAttribute("aria-expanded"), "false")
  }
})

test("reused previews switch browsing roots and reject a stale directory response", async t => {
  const pending = new Map()
  const listed = []
  t.mock.method(dashboardApi, "connectorFsList", async (_token, _connector, { path }) => {
    listed.push(path)
    if (path === "/repo/slow") return new Promise(resolve => pending.set(path, resolve))
    return { result: { path, entries: [{ type: "file", path: `${path}/a.ts`, name: "a.ts" }] } }
  })
  t.mock.method(dashboardApi, "connectorFsReadText", async (_token, _connector, _root, path) => textFile(path))
  const f = await fixture(t, FilesPanelBody)
  const props = { token: "fixture", connectorId: "connector", root: "/repo", variant: "tab" }
  const target = browsePath => ({ source: "workspace", root: "/repo", browsePath, browseExpandedPaths: [], path: `${browsePath}/a.ts`, name: "a.ts" })
  await f.render({ ...props, initialFile: target("/repo/old") })
  await f.render({ ...props, initialFile: target("/repo/slow") })
  await f.render({ ...props, initialFile: target("/repo/new") })
  await act(async () => pending.get("/repo/slow")({ result: { path: "/repo/slow", entries: [] } }))
  assert.ok(f.host.querySelector('[data-fs-entry-path="/repo/new/a.ts"]'))
  assert.equal(f.host.querySelector('[data-fs-entry-path="/repo/old/a.ts"]'), null)
  assert.deepEqual(listed, ["/repo/old", "/repo/slow", "/repo/new"])
})

test("twenty preview switches keep one editor and do not reload the directory", async t => {
  let listings = 0
  let reads = 0
  t.mock.method(dashboardApi, "connectorFsList", async (_token, _connector, { path }) => {
    listings++
    return { result: { path, entries: [] } }
  })
  t.mock.method(dashboardApi, "connectorFsReadText", async (_token, _connector, _root, path) => {
    reads++
    return textFile(path)
  })
  const f = await fixture(t, FilesPanelBody)
  const beforeEditors = editors.length
  const beforeModels = models.length
  for (let index = 0; index <= 20; index++) {
    await f.render({ token: "fixture", connectorId: "connector", root: "/repo", variant: "tab",
      initialFile: { source: "workspace", root: "/repo", browsePath: "/repo", browseExpandedPaths: [], path: `/repo/${index}.ts`, name: `${index}.ts` },
    })
  }
  assert.equal(listings, 1)
  assert.equal(reads, 21)
  assert.equal(editors.length - beforeEditors, 1)
  assert.equal(models.slice(beforeModels).filter(model => !model.disposed).length, 1)
  t.diagnostic(`Initial open + 20 switches: ${listings} directory list, ${reads} text reads, 1 editor, 1 live model`)
})

test("Windows file browser starts at the project instead of the drive list", async t => {
  const root = "E:\\dsh-desktop\\开始测试DSHD"
  const filePath = `${root}\\README.md`
  const listed = []
  t.mock.method(dashboardApi, "connectorFsList", async (_token, _connector, request) => {
    listed.push(request)
    return { result: { path: request.path, entries: request.path === root
      ? [{ type: "file", path: filePath, name: "README.md" }]
      : [{ type: "directory", path: "C:/", name: "C:" }] } }
  })
  const f = await fixture(t, FilesPanelBody)
  await f.render({ token: "fixture", connectorId: "windows-connector", connectorDeviceOs: "windows", root, variant: "tab" })
  assert.deepEqual(listed, [{ root, path: root }])
  assert.ok([...f.host.querySelectorAll("[data-fs-entry-path]")].some(row => row.dataset.fsEntryPath === filePath))
  assert.equal(f.host.querySelector('[data-fs-entry-path="C:/"]'), null)
  assert.ok(f.host.textContent.includes("开始测试DSHD"))
  assert.equal(f.host.querySelector('[data-testid="files-preview"]'), null)
})

test.after(() => { mockHooks.deregister(); sourceHooks.deregister() })
