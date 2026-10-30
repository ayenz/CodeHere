import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

async function openNewRoom(page: Page): Promise<string> {
  await page.goto('/')
  await expect(page.locator('#editor')).not.toHaveAttribute('data-loading')
  return new URL(page.url()).pathname
}

async function typeCode(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click()
  await page.keyboard.insertText(text)
}

test('a new room gets its own URL and edits sync between people', async ({ page, browser }) => {
  const path = await openNewRoom(page)
  expect(path).toMatch(/^\/[A-Za-z0-9]{8}$/)

  const other = await browser.newPage()
  await other.goto(path)
  await expect(other.locator('#editor')).not.toHaveAttribute('data-loading')

  await typeCode(page, 'print("hello")')
  await expect(other.locator('.cm-content')).toContainText('print("hello")')
  // Each sees the other as an avatar.
  await expect(page.locator('#people .avatar')).toHaveCount(1)
  await expect(other.locator('#people .avatar')).toHaveCount(1)
  await expect(page.locator('#status')).toHaveText('Connected')
  await other.close()
})

test('language is detected automatically and can be formatted', async ({ page }) => {
  await openNewRoom(page)
  await typeCode(page, 'const greet=(name)=>{return `Hello ${name}`}\nfunction add(a,b){return a+b}\n')
  await expect(page.locator('#language option:checked')).toHaveText('Auto · JavaScript')
  await page.locator('#format').click()
  await expect(page.locator('.cm-content')).toContainText('function add(a, b) {')
  await expect(page.locator('#toast')).toHaveText('Formatted as JavaScript')
})

test('formatting is easy to find and explains when it cannot help', async ({ page }) => {
  await openNewRoom(page)
  await expect(page.locator('#format')).toBeVisible()
  await expect(page.locator('#format')).toHaveText('Format')

  // Plain prose: the button stays visible but says why it can't format.
  await typeCode(page, 'just some notes')
  await expect(page.locator('#format')).toHaveAttribute('aria-disabled', 'true')
  // aria-disabled keeps it clickable for people (it explains itself); Playwright needs force.
  await page.locator('#format').click({ force: true })
  await expect(page.locator('#toast')).toContainText("Formatting isn't available")

  // JavaScript: the keyboard shortcut formats.
  await page.locator('.cm-content').press('ControlOrMeta+a')
  await page.keyboard.insertText('const greet=(name)=>{return `Hello ${name}`}\nfunction add(a,b){return a+b}\nconsole.log(greet("x"))\n')
  await expect(page.locator('#language option:checked')).toHaveText('Auto · JavaScript')
  await expect(page.locator('#format')).toHaveAttribute('aria-disabled', 'false')
  await page.locator('.cm-content').press('Shift+Alt+KeyF')
  await expect(page.locator('.cm-content')).toContainText('function add(a, b) {')
})

test('keyboard shortcuts are listed in a dialog', async ({ page }) => {
  await openNewRoom(page)
  await page.locator('#shortcuts-button').click()
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('rowheader', { name: /Format the code/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // F1 works from inside the editor too.
  await page.locator('.cm-content').click()
  await page.keyboard.press('F1')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
})

test('view-only links can read but not edit', async ({ page, browser }) => {
  await openNewRoom(page)
  await typeCode(page, 'secret = 1')
  await page.locator('#share-button').click()
  const viewUrl = await page.locator('#share-view-url').inputValue()
  expect(viewUrl).toMatch(/\/v\/[A-Za-z0-9_-]+$/)

  const viewer = await browser.newPage()
  await viewer.goto(viewUrl)
  await expect(viewer.locator('.cm-content')).toContainText('secret = 1')
  await expect(viewer.locator('#banner')).toContainText('View only')
  await expect(viewer.locator('#format')).toBeHidden()
  await expect(viewer.locator('#share-edit')).toBeHidden()
  await viewer.locator('.cm-content').click()
  await viewer.keyboard.type('HACK')
  await expect(viewer.locator('.cm-content')).not.toContainText('HACK')
  await expect(page.locator('.cm-content')).not.toContainText('HACK')
  await viewer.close()
})

test('clicking a line number links to that line', async ({ page, browser }) => {
  const path = await openNewRoom(page)
  await typeCode(page, 'one\ntwo\nthree\nfour')
  await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^3$/ }).click()
  await expect(page).toHaveURL(new RegExp(`${path}#L3$`))
  await page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^4$/ }).click({ modifiers: ['Shift'] })
  await expect(page).toHaveURL(new RegExp(`${path}#L3-L4$`))

  const other = await browser.newPage()
  await other.goto(`${path}#L2`)
  await expect(other.locator('.cm-linked-line')).toHaveCount(1)
  await expect(other.locator('.cm-linked-line')).toHaveText('two')
  await other.close()
})

test('people can follow someone else', async ({ page, browser }) => {
  const path = await openNewRoom(page)
  const other = await browser.newPage()
  await other.goto(path)
  await expect(page.locator('#people .avatar')).toHaveCount(1)
  await page.locator('#people .avatar').click()
  await expect(page.locator('#following')).toBeVisible()
  await expect(page.locator('#people .avatar')).toHaveAttribute('aria-pressed', 'true')
  await page.locator('#stop-following').click()
  await expect(page.locator('#following')).toBeHidden()
  await other.close()
})

test('editor settings apply and persist', async ({ page }) => {
  await openNewRoom(page)
  await page.locator('#settings-button').click()
  await page.locator('#setting-font-size').selectOption('18')
  await page.locator('#setting-wrap').check()
  await expect(page.locator('.cm-editor')).toHaveCSS('font-size', '18px')
  await expect(page.locator('.cm-content')).toHaveClass(/cm-lineWrapping/)
  await page.reload()
  await expect(page.locator('.cm-editor')).toHaveCSS('font-size', '18px')
})

test('documents cannot grow past MAX_DOC_CHARS', async ({ page }) => {
  await openNewRoom(page)
  await page.locator('.cm-content').click()
  await page.keyboard.insertText('x'.repeat(6000))
  await expect(page.locator('#toast')).toContainText('limited to 5,000 characters')
  await expect(page.locator('.cm-content')).not.toContainText('xxxxx')
})

test('the creator can delete a room and everyone sees it is gone', async ({ page, browser }) => {
  const path = await openNewRoom(page)
  await typeCode(page, 'bye')
  const other = await browser.newPage()
  await other.goto(path)
  await expect(other.locator('#delete-room')).toBeHidden() // only the creator's browser can delete

  await page.locator('#delete-room').click()
  await page.locator('#delete-dialog button[value=delete]').click()
  await expect(page.locator('#gone-title')).toHaveText('This room was deleted')
  await expect(other.locator('#gone-title')).toHaveText('This room was deleted')
  await other.close()

  // Opening the same URL again starts a fresh, empty room: the deleted code never comes back,
  // and the new room works and is saved like any other.
  await page.goto(path)
  await expect(page.locator('#editor')).not.toHaveAttribute('data-loading')
  await expect(page.locator('.cm-content')).not.toContainText('bye')
  await typeCode(page, 'hello again')
  await page.waitForTimeout(2500)
  await page.reload()
  await expect(page.locator('.cm-content')).toContainText('hello again')
})

test('the strict Content-Security-Policy blocks nothing the app needs', async ({ page, browser }) => {
  const violations: string[] = []
  const watch = (target: Page) =>
    target.on('console', (message) => {
      if (/Content Security Policy|Content-Security-Policy/i.test(message.text())) violations.push(message.text())
    })
  watch(page)
  const path = await openNewRoom(page)
  const response = await page.request.get(path)
  expect(response.headers()['content-security-policy']).toContain("script-src 'self'")

  // Exercise the lazily loaded parts: language detection, Prettier, a theme, Vim, presence.
  await typeCode(page, 'const greet=(name)=>{return `Hello ${name}`}\nconsole.log(greet("x"))\n')
  await expect(page.locator('#language option:checked')).toHaveText('Auto · JavaScript')
  await page.locator('#format').click()
  await expect(page.locator('.cm-content')).toContainText('const greet = (name) => {')
  await page.locator('#editor-theme').selectOption('dracula')
  await page.locator('#settings-button').click()
  await page.locator('#setting-keymap').selectOption('vim')
  const other = await browser.newPage()
  watch(other)
  await other.goto(path)
  await expect(page.locator('#people .avatar')).toHaveCount(1)
  await page.waitForTimeout(500)
  await other.close()
  expect(violations).toEqual([])
})

test('a missing view link shows a friendly page', async ({ page }) => {
  await page.goto('/v/doesNotExist123')
  await expect(page.locator('#gone-title')).toHaveText("This room doesn't exist")
})

test('the editor page has no serious accessibility violations', async ({ page }) => {
  await openNewRoom(page)
  await typeCode(page, 'let x = 1')
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
})
