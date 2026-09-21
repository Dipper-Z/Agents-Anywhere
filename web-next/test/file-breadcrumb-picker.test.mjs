import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { registerSource } from "./helpers/onboarding-source.mjs"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.example/", pretendToBeVisual: true })
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "Event", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
HTMLElement.prototype.scrollIntoView = () => {}
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { NextIntlClientProvider } = await import("next-intl")
const hooks = registerSource()
const { FileBreadcrumbPicker } = await import("../src/components/panels/file-breadcrumb-picker.tsx")
hooks.deregister()
const messages = JSON.parse(readFileSync(new URL("../messages/en.json", import.meta.url), "utf8"))
const directory = { name: "src", path: "/repo/src", type: "directory" }
const sibling = { name: "docs", path: "/repo/docs", type: "directory" }
const file = { name: "a.ts", path: "/repo/src/a.ts", type: "file" }

async function mount(t, loadDirectory) {
  const selected = []
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: "en", timeZone: "UTC", messages },
    h(FileBreadcrumbPicker, { path: directory.path, label: "src", current: true, directory: true,
      caseInsensitivePaths: false, loadDirectory, onSelect: (entry) => selected.push(entry.path) }))))
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  return { selected, trigger: container.querySelector("button") }
}
const click = async (element) => { assert.ok(element); await act(async () => element.click()) }
const row = (path) => document.querySelector(`[data-fs-entry-path="${path}"]`)
const key = async (element, value) => act(async () => element.dispatchEvent(new window.KeyboardEvent("keydown", { key: value, bubbles: true })))

test("picker opens siblings, expands the current directory, and selects files", async (t) => {
  const calls = []
  const picker = await mount(t, async (path) => {
    calls.push(path)
    return { path, entries: path === "/repo" ? [directory, sibling] : [file] }
  })
  assert.deepEqual(calls, [])
  await click(picker.trigger)
  assert.deepEqual(calls, ["/repo", "/repo/src"])
  assert.ok(row(sibling.path))
  assert.equal(row(directory.path).getAttribute("aria-expanded"), "true")
  await click(row(file.path))
  assert.deepEqual(picker.selected, [file.path])
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test("arrow keys, chevrons and Enter on directories expand without selecting", async (t) => {
  const picker = await mount(t, async (path) => ({ path, entries: path === "/repo" ? [directory, sibling] : [file] }))
  await click(picker.trigger)
  await key(row(directory.path), "ArrowLeft")
  assert.equal(row(directory.path).getAttribute("aria-expanded"), "false")
  await key(row(directory.path), "ArrowRight")
  assert.equal(row(directory.path).getAttribute("aria-expanded"), "true")
  await click(row(directory.path).querySelector("[data-tree-toggle]"))
  assert.equal(row(directory.path).getAttribute("aria-expanded"), "false")
  assert.deepEqual(picker.selected, [])
  await key(row(sibling.path), "Enter")
  assert.equal(row(sibling.path).getAttribute("aria-expanded"), "true")
  assert.deepEqual(picker.selected, [])
  assert.ok(document.querySelector('[role="dialog"]'))
})

test("directory names allow browsing multiple levels before selecting a file", async (t) => {
  const nested = { name: "nested", path: "/repo/docs/nested", type: "directory" }
  const leaf = { name: "readme.md", path: "/repo/docs/nested/readme.md", type: "file" }
  const contents = {
    "/repo": [directory, sibling],
    "/repo/src": [file],
    "/repo/docs": [nested],
    "/repo/docs/nested": [leaf],
  }
  const picker = await mount(t, async (path) => ({ path, entries: contents[path] ?? [] }))
  await click(picker.trigger)
  await click(row(sibling.path).querySelector(".aa-file-tree-name"))
  await click(row(nested.path).querySelector(".aa-file-tree-name"))
  assert.ok(row(leaf.path))
  assert.ok(document.querySelector('[role="dialog"]'))
  assert.deepEqual(picker.selected, [])
  await click(row(nested.path))
  assert.equal(row(leaf.path), null)
  await click(row(nested.path))
  await click(row(leaf.path))
  assert.deepEqual(picker.selected, [leaf.path])
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test("closing a picker ignores its outstanding request after reopening", async (t) => {
  const pending = []
  const picker = await mount(t, (path) => new Promise((resolve) => pending.push({ path, resolve })))
  await click(picker.trigger)
  await click(picker.trigger)
  await click(picker.trigger)
  assert.equal(pending.length, 2)
  await act(async () => pending[1].resolve({ path: "/repo", entries: [sibling] }))
  await act(async () => pending[0].resolve({ path: "/repo", entries: [file] }))
  assert.ok(row(sibling.path))
  assert.equal(row(file.path), null)
})
