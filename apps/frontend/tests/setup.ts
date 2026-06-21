import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!DOCTYPE html>', { url: 'http://localhost' })
const { window } = dom

Object.assign(global, {
  window: window,
  document: window.document,
  localStorage: window.localStorage,
  sessionStorage: window.sessionStorage,
})
